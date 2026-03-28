// Shift 2026 - Content Script
// Guided food discovery — injected into Uber Eats DOM
(function () {
  "use strict";

  // ═══════════════════════════════════════════════════
  // SECTION 1: Uber Eats API
  // ═══════════════════════════════════════════════════

  const UE = { "Content-Type": "application/json", "x-csrf-token": "x" };

  // Cache delivery fees by store UUID (from feed search)
  const storeFeeCache = new Map();

  async function ueFeedSearch(query) {
    const res = await fetch("/_p/api/getFeedV1?localeCode=fr-en", {
      method: "POST", headers: UE, credentials: "include",
      body: JSON.stringify({
        cacheKey: "", feedSessionCount: { announcementCount: 0, announcementLabel: "" },
        userQuery: query || "", date: "", startTime: 0, endTime: 0,
        carouselId: "", sortAndFilters: [], billboardUuid: "", feedProvider: "",
        promotionUuid: "", targetingStoreTag: "", venueUUID: "",
        selectedSectionUUID: "", favorites: "", vertical: "",
        searchSource: "", searchType: "", keyName: "",
        serializedRequestContext: "", isUserInitiatedRefresh: false,
      }),
    });
    if (!res.ok) throw new Error(`getFeedV1: ${res.status}`);
    const data = await res.json();
    return (data?.data?.feedItems || [])
      .filter((i) => i.type === "REGULAR_STORE")
      .map((i) => {
        const s = i.store; if (!s) return null;
        let eta = null, fee = null;
        for (const m of s.meta || []) {
          if (m.badgeType === "ETD") eta = m.text;
          else if (m.badgeType === "FARE") fee = m.badgeData?.fare?.deliveryFee || m.text;
        }
        const store = { uuid: s.storeUuid, title: s.title?.text || "?", rating: s.rating?.text || null, eta, deliveryFee: fee, actionUrl: s.actionUrl || null };
        // Cache fee for later use in cards
        if (store.uuid && fee) storeFeeCache.set(store.uuid, fee);
        return store;
      }).filter(Boolean);
  }

  async function ueGetStore(uuid) {
    const res = await fetch("/_p/api/getStoreV1?localeCode=fr-en", {
      method: "POST", headers: UE, credentials: "include",
      body: JSON.stringify({ storeUuid: uuid, diningMode: "DELIVERY", time: { asap: true }, cbType: "EATER_ENDORSED" }),
    });
    if (!res.ok) throw new Error(`getStoreV1: ${res.status}`);
    const d = (await res.json())?.data || {};
    const items = [], seen = new Set();
    for (const entries of Object.values(d.catalogSectionsMap || {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const sip = entry?.payload?.standardItemsPayload; if (!sip) continue;
        for (const item of sip.catalogItems || []) {
          if (seen.has(item.uuid) || item.isSoldOut || item.isAvailable === false) continue;
          seen.add(item.uuid);
          items.push({ title: item.title, price: item.price, desc: (item.itemDescription || "").slice(0, 80), section: sip.title || "", img: item.imageUrl || null, uuid: item.uuid });
        }
      }
    }
    return { title: d.title, uuid: d.uuid, rating: d.rating, etaRange: d.etaRange, priceBucket: d.priceBucket, actionUrl: `/store/${d.slug}/${d.uuid}?diningMode=DELIVERY`, items };
  }

  // ═══════════════════════════════════════════════════
  // SECTION 2: Chrome Message Handler
  // ═══════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg) => {
    if (!shiftRoot) return true; // not injected yet, ignore UI messages
    switch (msg.type) {
      case "STREAM_DELTA": appendStream(msg.text); break;
      case "STREAM_DONE": finalizeStream(); break;
      case "EXECUTE_TOOL": executeTool(msg.callId, msg.name, msg.args); break;
      case "TOOL_STATUS": showToolStatus(msg.name, msg.args); break;
      case "DISH_CARDS": renderDishCards(msg.dishes); break;
      case "SHOW_TOP_PICKS": renderTopPicks(msg.callId, msg.title, msg.dishes); break;
      case "SHOW_CHOICES": renderChoices(msg.callId, msg.title, msg.options, msg.allowMultiple); break;
      case "ERROR": showError(msg.message); break;
      case "CONVERSATION_HISTORY": /* skip restore — always start fresh */ break;
    }
    return true;
  });

  async function executeTool(callId, name, args) {
    try {
      let result;
      if (name === "search_restaurants") result = await ueFeedSearch(args.query);
      else if (name === "get_restaurant_menu") result = await ueGetStore(args.store_uuid);
      else result = { error: `Unknown tool: ${name}` };
      chrome.runtime.sendMessage({ type: "TOOL_RESULT", callId, result });
    } catch (e) {
      chrome.runtime.sendMessage({ type: "TOOL_RESULT", callId, result: { error: e.message } });
    }
  }

  // ═══════════════════════════════════════════════════
  // SECTION 3: UI — Inject into Uber Eats
  // ═══════════════════════════════════════════════════

  let feedEl = null, shiftRoot = null, shiftActive = false, isStreaming = false;
  let lastUserPrompt = "";
  let $welcome, $experience, $response, $stage, $textInput, $fab;
  let inlineBar = null, activeVoiceInput = null;
  let typewriterTimer = null;

  const CATEGORY_PLACEHOLDERS = {
    pizza: [
      "J'aimerais une <b>pizza</b> avec de la mozza di buffala...",
      "Une <b>pizza</b> pepperoni bien fromagée...",
      "Une <b>pizza</b> quatre fromages croustillante...",
    ],
    burger: [
      "Un smash <b>burger</b> bien juteux avec du cheddar...",
      "Un <b>burger</b> classique bacon-cheese fondant...",
      "Un double <b>burger</b> avec sauce maison...",
    ],
    sushi: [
      "Un plateau de <b>sushi</b> california rolls et sashimi...",
      "Des <b>sushi</b> saumon avocat bien frais...",
      "Un menu <b>sushi</b> mixte avec edamame...",
    ],
    asiatique: [
      "Un bo bun frais avec des nems croustillants...",
      "Un pad thaï aux crevettes bien <b>asiatique</b>...",
      "Des raviolis vapeur et riz cantonais...",
    ],
    mexicain: [
      "Des tacos al pastor avec guacamole maison...",
      "Un burrito <b>mexicain</b> poulet bien garni...",
      "Des quesadillas fromage et pico de gallo...",
    ],
    italien: [
      "Des penne all'arrabbiata bien relevées...",
      "Un risotto crémeux aux champignons <b>italien</b>...",
      "Des lasagnes maison avec bolognaise fondante...",
    ],
    indien: [
      "Un butter chicken bien crémeux avec du naan...",
      "Un tikka masala <b>indien</b> avec riz basmati...",
      "Des samosas croustillants et dal onctueux...",
    ],
    poulet: [
      "Du <b>poulet</b> croustillant avec une sauce barbecue...",
      "Des tenders de <b>poulet</b> avec frites maison...",
      "Un <b>poulet</b> rôti bien doré avec légumes grillés...",
    ],
    healthy: [
      "Une salade bowl avec avocat et saumon grillé...",
      "Un buddha bowl <b>healthy</b> quinoa et légumes...",
      "Un açaï bowl <b>healthy</b> avec granola et fruits...",
    ],
    kebab: [
      "Un <b>kebab</b> galette avec sauce blanche et harissa...",
      "Un <b>kebab</b> assiette avec frites et salade...",
      "Un durum <b>kebab</b> bien garni sauce samouraï...",
    ],
    "poke bowl": [
      "Un <b>poke bowl</b> saumon mangue et edamame...",
      "Un <b>poke bowl</b> thon avocat sauce sésame...",
      "Un <b>poke bowl</b> crevettes et ananas frais...",
    ],
    dessert: [
      "Un fondant au chocolat avec coeur coulant...",
      "Une crème brûlée onctueuse en <b>dessert</b>...",
      "Un tiramisu maison bien café en <b>dessert</b>...",
    ],
  };
  const DEFAULT_PLACEHOLDER = [
    "<b>Pizza</b> chèvre miel, un truc réconfortant, <b>sushi</b>...",
    "Un bon <b>burger</b>, des <b>sushi</b>, ou autre chose ?",
    "Envie de <b>thaï</b>, de <b>mexicain</b>, ou de comfort food ?",
  ];

  function tokenize(html) {
    const tokens = [];
    let i = 0;
    while (i < html.length) {
      if (html[i] === '<') {
        const end = html.indexOf('>', i);
        tokens.push(html.slice(i, end + 1));
        i = end + 1;
      } else {
        tokens.push(html[i]);
        i++;
      }
    }
    return tokens;
  }

  let lastPlaceholder = null;

  function pickRandom(arr) {
    if (arr.length <= 1) return arr[0];
    let pick;
    do {
      pick = arr[Math.floor(Math.random() * arr.length)];
    } while (pick === lastPlaceholder);
    lastPlaceholder = pick;
    return pick;
  }

  const CATEGORIES = [
    { label: "Pizza", value: "pizza", emoji: "\u{1F355}" },
    { label: "Burger", value: "burger", emoji: "\u{1F354}" },
    { label: "Sushi", value: "sushi", emoji: "\u{1F363}" },
    { label: "Asiatique", value: "asiatique", emoji: "\u{1F35C}" },
    { label: "Mexicain", value: "mexicain", emoji: "\u{1F32E}" },
    { label: "Italien", value: "italien", emoji: "\u{1F35D}" },
    { label: "Indien", value: "indien", emoji: "\u{1F35B}" },
    { label: "Poulet", value: "poulet", emoji: "\u{1F357}" },
    { label: "Healthy", value: "healthy", emoji: "\u{1F957}" },
    { label: "Kebab", value: "kebab", emoji: "\u{1F959}" },
    { label: "Poke", value: "poke bowl", emoji: "\u{1F96E}" },
    { label: "Dessert", value: "dessert", emoji: "\u{1F370}" },
  ];

  const MOODS = [
    { label: "Reconfort", value: "reconfort", emoji: "\u{1F6CB}\u{FE0F}" },
    { label: "Leger", value: "leger", emoji: "\u{1F331}" },
    { label: "Festif", value: "festif", emoji: "\u{1F389}" },
    { label: "Rapide", value: "rapide", emoji: "\u{26A1}" },
    { label: "Gourmand", value: "gourmand", emoji: "\u{1F929}" },
  ];

  function injectUI() {
    if (shiftRoot) return true; // already injected

    // Only inject on feed pages — detect by DOM structure:
    // Feed has: wrapper > sidebar(~186px wide) + feed(~974px wide)
    // Store pages have a completely different structure
    const main = document.querySelector("main#main-content");
    if (!main) return false;
    const wrapper = main.children[0];
    if (!wrapper || wrapper.children.length < 2) return false;

    // Check that first child is the narrow sidebar DIV (~186px) and second is the wide feed
    const sidebar = wrapper.children[0];
    const feed = wrapper.children[1];
    // Sidebar must be a visible DIV element (not a script tag) with width ~186px
    if (sidebar.tagName !== "DIV") return false;
    const sidebarW = sidebar.getBoundingClientRect().width;
    const feedW = feed.getBoundingClientRect().width;
    if (sidebarW < 100 || sidebarW > 250 || feedW < 500) return false;
    // Extra safety: wrapper should have exactly 2 main children on the feed page
    if (wrapper.children.length > 4) return false;

    feedEl = feed;

    shiftRoot = document.createElement("div");
    shiftRoot.id = "shift-root";
    shiftRoot.className = "shift-root";
    shiftRoot.style.display = "none";

    // Stop events from bubbling UP into Uber Eats handlers (bubble phase, not capture)
    ["click", "mousedown", "mouseup", "keydown", "keyup", "input", "focus", "blur", "submit"].forEach(evt => {
      shiftRoot.addEventListener(evt, (e) => e.stopPropagation());
    });

    const catHTML = CATEGORIES.map(c =>
      `<button class="shift-category" data-value="${c.value}"><span class="shift-category-emoji">${c.emoji}</span><span class="shift-category-label">${c.label}</span></button>`
    ).join("");

    const moodHTML = MOODS.map(m =>
      `<button class="shift-mood" data-value="${m.value}"><span class="shift-mood-emoji">${m.emoji}</span><span class="shift-mood-label">${m.label}</span></button>`
    ).join("");

    shiftRoot.innerHTML = `
      <div class="shift-welcome" id="shiftWelcome">
        <h1 class="shift-title">Qu'est-ce qui te ferait plaisir ?</h1>
        <div class="shift-main-input" id="shiftMainInput">
          <input type="text" id="shiftTextInput" placeholder="" />
          <span class="shift-fake-placeholder" id="shiftPlaceholder"></span>
          <button class="shift-mic-btn" id="shiftMic" title="Dicte ta commande">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
          </button>
          <button class="shift-send-btn" id="shiftSend">\u2192</button>
        </div>
        <div class="shift-divider"><span>ou laisse-toi guider</span></div>
        <p class="shift-section-label">Une humeur ?</p>
        <div class="shift-mood-row" id="shiftMoods">${moodHTML}</div>
        <p class="shift-section-label">Un type de cuisine ?</p>
        <div class="shift-category-grid" id="shiftCategories">${catHTML}</div>
        <button class="shift-confirm-btn" id="shiftConfirm" style="display:none">C'est parti !</button>
      </div>
      <div class="shift-experience" id="shiftExperience" style="display:none">
        <div class="shift-scroll-area" id="shiftScrollArea">
          <div class="shift-response" id="shiftResponse"></div>
          <div class="shift-stage" id="shiftStage"></div>
        </div>
        <div class="shift-bottom-bar" id="shiftBottomBar">
          <button class="shift-action-pill" id="shiftRestart">\u21BB</button>
          <div class="shift-bottom-input">
            <input type="text" id="shiftBottomText" placeholder="Affine, demande autre chose..." />
            <button class="shift-send-btn" id="shiftBottomSend">\u2192</button>
          </div>
        </div>
      </div>
    `;

    wrapper.appendChild(shiftRoot);

    $welcome = shiftRoot.querySelector("#shiftWelcome");
    $experience = shiftRoot.querySelector("#shiftExperience");
    $response = shiftRoot.querySelector("#shiftResponse");
    $stage = shiftRoot.querySelector("#shiftStage");
    $textInput = shiftRoot.querySelector("#shiftTextInput");
    const $welcomePlaceholder = shiftRoot.querySelector("#shiftPlaceholder");

    // Start typewriter on welcome input + auto-rotation
    typewriterPlaceholder($welcomePlaceholder, pickRandom(DEFAULT_PLACEHOLDER));
    startPlaceholderRotation($welcomePlaceholder, DEFAULT_PLACEHOLDER);

    // Show/hide fake placeholder based on input content
    $textInput.addEventListener("input", () => {
      if ($textInput.value.length > 0) {
        $welcomePlaceholder.style.display = "none";
        stopPlaceholderRotation();
      } else {
        $welcomePlaceholder.style.display = "";
        startPlaceholderRotation($welcomePlaceholder, DEFAULT_PLACEHOLDER);
      }
    });
    $textInput.addEventListener("blur", () => {
      if ($textInput.value.length === 0) {
        $welcomePlaceholder.style.display = "";
      }
    });

    // ── Multi-select for moods AND categories ────────
    const selected = new Set();
    const $confirm = shiftRoot.querySelector("#shiftConfirm");

    function toggleSelection(btn, value) {
      if (selected.has(value)) {
        selected.delete(value);
        btn.classList.remove("selected");
      } else {
        selected.add(value);
        btn.classList.add("selected");
      }
      $confirm.style.display = selected.size > 0 ? "" : "none";
    }

    shiftRoot.querySelector("#shiftMoods").addEventListener("click", (e) => {
      const btn = e.target.closest(".shift-mood"); if (!btn) return;
      toggleSelection(btn, "mood:" + btn.dataset.value);
    });

    shiftRoot.querySelector("#shiftCategories").addEventListener("click", (e) => {
      const btn = e.target.closest(".shift-category"); if (!btn) return;
      toggleSelection(btn, "cat:" + btn.dataset.value);
    });

    $confirm.addEventListener("click", () => {
      const moods = [], cats = [];
      for (const v of selected) {
        if (v.startsWith("mood:")) moods.push(v.slice(5));
        else if (v.startsWith("cat:")) cats.push(v.slice(4));
      }
      selected.clear();
      shiftRoot.querySelectorAll(".selected").forEach(b => b.classList.remove("selected"));
      $confirm.style.display = "none";

      let prompt = "";
      if (moods.length > 0) prompt += `Humeur : ${moods.join(", ")}. `;
      if (cats.length > 0) prompt += `Cuisines : ${cats.join(", ")}. `;
      prompt += "Trouve les meilleurs plats qui correspondent.";
      startFlow(prompt);
    });

    // Text input
    shiftRoot.querySelector("#shiftSend").addEventListener("click", () => sendText());
    $textInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); sendText(); }
    });

    // Mic
    shiftRoot.querySelector("#shiftMic").addEventListener("click", () => {
      activeVoiceInput = $textInput;
      toggleMic();
    });

    // Card clicks → open detail popup
    $stage.addEventListener("click", (e) => {
      const card = e.target.closest(".shift-card");
      if (!card || card.closest(".shift-top-picks-arena")) return;
      // Don't open popup if clicking inside a popup already
      if (card.closest(".shift-popup")) return;
      try {
        const dish = JSON.parse(card.dataset.dishJson);
        if (dish) openDishPopup(dish);
      } catch (_) {}
    });

    // Bottom bar input
    const $bottomText = shiftRoot.querySelector("#shiftBottomText");
    shiftRoot.querySelector("#shiftBottomSend").addEventListener("click", () => {
      const text = $bottomText.value.trim();
      if (!text || isStreaming) return;
      $bottomText.value = "";
      lastUserPrompt = text;
      $response.textContent = "";
      $response.classList.add("streaming");
      $stage.innerHTML = "";
      isStreaming = true;
      chrome.runtime.sendMessage({ type: "CHAT_MESSAGE", text });
    });
    $bottomText.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        shiftRoot.querySelector("#shiftBottomSend").click();
      }
    });

    // Restart
    shiftRoot.querySelector("#shiftRestart").addEventListener("click", resetAll);

    // Inject inline input bar into the feed
    injectInlineInput();

    return true;
  }

  // ── Inline Input Bar (in-feed) ──────────────────────
  function findCategorySection(feed) {
    const categoryNames = CATEGORIES.map(c => c.label.toLowerCase());
    for (const child of feed.children) {
      const text = (child.textContent || "").toLowerCase();
      let matches = 0;
      for (const name of categoryNames) {
        if (text.includes(name)) matches++;
      }
      if (matches >= 3) return child;
    }
    // Fallback: insert after the 3rd child
    return feed.children[2] || feed.lastElementChild;
  }

  let rotationTimer = null;

  function typewriterPlaceholder(overlay, text, speed = 30) {
    if (typewriterTimer) { clearInterval(typewriterTimer); typewriterTimer = null; }

    const tokens = tokenize(text);
    let i = 0;
    overlay.innerHTML = "";
    overlay.style.display = "";
    typewriterTimer = setInterval(() => {
      if (i < tokens.length) {
        i++;
        overlay.innerHTML = tokens.slice(0, i).join("");
      } else {
        clearInterval(typewriterTimer);
        typewriterTimer = null;
      }
    }, speed);
  }

  function startPlaceholderRotation(overlay, placeholders, intervalMs = 8000) {
    if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null; }
    if (placeholders.length <= 1) return;
    rotationTimer = setInterval(() => {
      if (overlay.style.display === "none") return;
      backspaceAndType(overlay, pickRandom(placeholders));
    }, intervalMs);
  }

  function stopPlaceholderRotation() {
    if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null; }
  }

  function backspaceAndType(overlay, newText, speed = 15) {
    if (typewriterTimer) { clearInterval(typewriterTimer); typewriterTimer = null; }

    let visibleLen = overlay.textContent.length;

    // Backspace phase — strip visible characters from the end
    typewriterTimer = setInterval(() => {
      if (visibleLen > 0) {
        visibleLen--;
        // Rebuild: take only visibleLen chars worth of the original tokens
        const fullText = overlay.textContent;
        const trimmed = fullText.slice(0, visibleLen);
        overlay.textContent = trimmed;
      } else {
        clearInterval(typewriterTimer);
        typewriterTimer = null;
        // Type phase
        typewriterPlaceholder(overlay, newText, 30);
      }
    }, speed);
  }

  function createInlineInput() {
    const bar = document.createElement("div");
    bar.className = "shift-inline-bar";
    bar.id = "shiftInlineBar";
    bar.innerHTML = `
      <p class="shift-inline-label">\u2728 Besoin d'aide pour choisir ?</p>
      <div class="shift-main-input">
        <input type="text" id="shiftInlineText" placeholder="" />
        <span class="shift-fake-placeholder" id="shiftInlinePlaceholder"></span>
        <button class="shift-mic-btn" id="shiftInlineMic" title="Dicte ta commande">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        </button>
        <button class="shift-send-btn" id="shiftInlineSend">\u2192</button>
      </div>
    `;
    return bar;
  }

  function injectInlineInput() {
    if (inlineBar && document.body.contains(inlineBar)) return;
    if (!feedEl) return;

    const anchor = findCategorySection(feedEl);
    if (!anchor) return;

    inlineBar = createInlineInput();
    anchor.insertAdjacentElement("afterend", inlineBar);

    const inlineInput = inlineBar.querySelector("#shiftInlineText");
    const inlinePlaceholder = inlineBar.querySelector("#shiftInlinePlaceholder");

    // Start typewriter effect on load + auto-rotation
    let currentInlinePlaceholders = DEFAULT_PLACEHOLDER;
    typewriterPlaceholder(inlinePlaceholder, pickRandom(DEFAULT_PLACEHOLDER));
    startPlaceholderRotation(inlinePlaceholder, currentInlinePlaceholders);

    // Show/hide fake placeholder based on input content
    inlineInput.addEventListener("input", () => {
      if (inlineInput.value.length > 0) {
        inlinePlaceholder.style.display = "none";
        stopPlaceholderRotation();
      } else {
        inlinePlaceholder.style.display = "";
        startPlaceholderRotation(inlinePlaceholder, currentInlinePlaceholders);
      }
    });
    inlineInput.addEventListener("blur", () => {
      if (inlineInput.value.length === 0) {
        inlinePlaceholder.style.display = "";
      }
    });

    // Listen for category clicks on the Uber Eats category bar
    if (anchor) {
      anchor.addEventListener("click", (e) => {
        const link = e.target.closest("a, button");
        if (!link) return;
        const clickedText = (link.textContent || "").trim().toLowerCase();
        for (const [key, placeholders] of Object.entries(CATEGORY_PLACEHOLDERS)) {
          if (clickedText.includes(key) || key.includes(clickedText)) {
            currentInlinePlaceholders = placeholders;
            backspaceAndType(inlinePlaceholder, pickRandom(placeholders));
            stopPlaceholderRotation();
            startPlaceholderRotation(inlinePlaceholder, placeholders);
            return;
          }
        }
      });
    }

    inlineBar.querySelector("#shiftInlineSend").addEventListener("click", () => {
      const text = inlineInput.value.trim();
      if (!text || isStreaming) return;
      inlineInput.value = "";
      inlinePlaceholder.style.display = "";
      activate();
      startFlow(text);
    });

    inlineInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        inlineBar.querySelector("#shiftInlineSend").click();
      }
    });

    inlineBar.querySelector("#shiftInlineMic").addEventListener("click", () => {
      activeVoiceInput = inlineInput;
      toggleMic();
    });
  }

  function activate() {
    if (!feedEl || !shiftRoot) return;
    feedEl.style.display = "none";
    shiftRoot.style.display = "";
    shiftActive = true;
  }

  function deactivate() {
    if (!feedEl || !shiftRoot) return;
    feedEl.style.display = "";
    shiftRoot.style.display = "none";
    shiftActive = false;
  }

  // ── Flow Control ────────────────────────────────────
  let flowTimeout = null;
  let lastFlowText = "";

  function startFlow(text) {
    if (!$welcome || !$experience) return;
    lastUserPrompt = text || "";
    lastFlowText = text;
    $welcome.style.display = "none";
    $experience.style.display = "";
    $response.textContent = "Recherche en cours...";
    $response.classList.add("streaming");
    $stage.innerHTML = "";
    isStreaming = true;
    scrollTop();

    // Clear any previous timeout
    if (flowTimeout) clearTimeout(flowTimeout);

    // Safety timeout: if nothing comes back in 20s, show retry
    flowTimeout = setTimeout(() => {
      if (isStreaming && $stage && $stage.children.length === 0 && !$response.textContent.includes("Erreur")) {
        isStreaming = false;
        $response.textContent = "";
        $response.classList.remove("streaming");
        const retry = document.createElement("div");
        retry.className = "shift-retry";
        retry.innerHTML = `<p>La recherche n'a pas abouti</p><button class="shift-retry-btn">R\u00E9essayer</button>`;
        retry.querySelector("button").addEventListener("click", () => {
          retry.remove();
          startFlow(lastFlowText);
        });
        $stage.appendChild(retry);
      }
    }, 20000);

    chrome.runtime.sendMessage({ type: "CHAT_MESSAGE", text });
  }

  function sendText() {
    const text = $textInput.value.trim();
    if (!text || isStreaming) return;
    $textInput.value = "";
    const overlay = shiftRoot?.querySelector("#shiftPlaceholder");
    if (overlay) overlay.style.display = "";
    startFlow(text);
  }

  function resetAll() {
    chrome.runtime.sendMessage({ type: "RESET_CONVERSATION" });
    if ($welcome) $welcome.style.display = "";
    if ($experience) $experience.style.display = "none";
    if ($response) { $response.textContent = ""; $response.classList.remove("streaming"); }
    if ($stage) $stage.innerHTML = "";
    isStreaming = false;
  }

  // ── Streaming ───────────────────────────────────────
  function appendStream(text) {
    if (!$response) return;
    if (!isStreaming) {
      $response.textContent = "";
      $response.classList.add("streaming");
      isStreaming = true;
    }
    $response.textContent += text;
  }

  function finalizeStream() {
    if (!$response) return;
    if (flowTimeout) { clearTimeout(flowTimeout); flowTimeout = null; }
    $response.classList.remove("streaming");
    $response.innerHTML = $response.textContent.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    isStreaming = false;
  }

  // ── Tool Status (stacked progress) ──────────────────
  function showToolStatus(name, args) {
    if (!$stage) return;
    let label = "Recherche...";
    if (name === "search_restaurants") label = `Recherche "${args.query || ""}"...`;
    else if (name === "get_restaurant_menu") label = `Scan ${args.store_name || ""}...`;

    let container = $stage.querySelector(".shift-progress");
    if (!container) {
      $stage.innerHTML = "";
      container = document.createElement("div");
      container.className = "shift-progress";
      $stage.appendChild(container);
    }
    const step = document.createElement("div");
    step.className = "shift-progress-step";
    step.innerHTML = `<span class="shift-progress-dot"></span>${esc(label)}`;
    container.appendChild(step);
  }

  // ── Card Builder ────────────────────────────────────
  function extractFeeAmount(feeStr) {
    if (!feeStr) return "";
    // Must contain a digit — ignore priceBucket like "€€"
    if (!/\d/.test(feeStr)) return "";
    // Extract just the price part from "2.49 € Delivery Fee" or "2.49 €"
    const match = feeStr.match(/([\d.,]+)\s*\u20AC/);
    if (match) return match[1] + "\u00A0\u20AC livr.";
    return "";
  }

  function buildCard(dish, index) {
    const price = dish.price != null ? dish.price.toFixed(2) + "\u00A0\u20AC" : "";
    // Try dish fee, then cached fee from feed search
    const rawFee = dish.store_delivery_fee || storeFeeCache.get(dish.store_uuid) || "";
    const fee = extractFeeAmount(rawFee);
    const card = document.createElement("div");
    card.className = "shift-card";
    card.dataset.dishJson = JSON.stringify(dish);
    if (dish.store_action_url) card.dataset.actionurl = dish.store_action_url;
    if (dish.item_uuid) card.dataset.itemid = dish.item_uuid;
    card.style.setProperty("--i", index);
    card.innerHTML = `
      <div class="shift-card-img-wrap">
        ${dish.image_url ? `<img class="shift-card-img" src="${esc(dish.image_url)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=shift-card-img-placeholder>\u{1F37D}\u{FE0F}</div>'" />` : '<div class="shift-card-img-placeholder">\u{1F37D}\u{FE0F}</div>'}
        ${price ? `<div class="shift-card-price">${esc(price)}${fee ? ` <span class="shift-card-fee">+ ${esc(fee)}</span>` : ""}</div>` : ""}
      </div>
      <div class="shift-card-body">
        <div class="shift-card-name">${esc(dish.title || "")}</div>
        ${dish.description ? `<div class="shift-card-desc">${esc(dish.description)}</div>` : ""}
        <div class="shift-card-meta">
          <span>${esc(dish.store_name || "")}</span>
          ${dish.store_rating ? `<span class="shift-card-rating">\u2605 ${esc(dish.store_rating)}</span>` : ""}
          ${dish.store_eta ? `<span>${esc(dish.store_eta)}</span>` : ""}
        </div>
      </div>`;
    return card;
  }

  // ── Render: Dish Cards ──────────────────────────────
  const MAX_VISIBLE = 9;

  function renderDishCards(dishes) {
    if (!dishes?.length || !$stage) return;
    if (flowTimeout) { clearTimeout(flowTimeout); flowTimeout = null; }
    $stage.innerHTML = "";
    if ($response) { $response.textContent = ""; $response.classList.remove("streaming"); }
    isStreaming = false;
    scrollTop();

    if (dishes.length === 1) {
      renderWinner(dishes[0]);
    } else if (shouldRenderRestaurantRows(dishes)) {
      renderRestaurantRows(dishes);
    } else if (dishes.length <= 5) {
      renderCarousel(dishes);
    } else {
      renderGrid(dishes);
    }
  }

  function scrollTop() {
    const area = shiftRoot?.querySelector("#shiftScrollArea");
    if (area) area.scrollTo({ top: 0, behavior: "smooth" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function shouldRenderRestaurantRows(dishes) {
    if (dishes.length < 2) return false;
    const groups = groupDishesByRestaurant(dishes);
    const hasRestaurantBundles = groups.some((group) => group.dishes.length > 1);
    if (!hasRestaurantBundles) return false;

    const prompt = (lastUserPrompt || "").toLowerCase();
    if (!prompt) return true;
    if (prompt.includes("humeur :") || prompt.includes("cuisines :")) return false;

    return /(?:\bavec\b|,|\bet\b|\bpuis\b|\bplus\b|\baccompagn)/.test(prompt) || hasRestaurantBundles;
  }

  function groupDishesByRestaurant(dishes) {
    const groups = new Map();
    dishes.forEach((dish, index) => {
      const key = dish.store_uuid || dish.store_name || `store-${index}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          firstIndex: index,
          store_name: dish.store_name || "Restaurant",
          store_rating: dish.store_rating,
          store_eta: dish.store_eta,
          store_action_url: dish.store_action_url,
          dishes: [],
        });
      }
      groups.get(key).dishes.push(dish);
    });
    return [...groups.values()].sort((a, b) => a.firstIndex - b.firstIndex);
  }

  function renderRestaurantRows(dishes) {
    const groups = groupDishesByRestaurant(dishes);
    const wrap = document.createElement("div");
    wrap.className = "shift-restaurant-rows";

    groups.forEach((group, groupIndex) => {
      const row = document.createElement("section");
      row.className = "shift-restaurant-row";
      row.style.setProperty("--i", groupIndex);

      const header = document.createElement("div");
      header.className = "shift-restaurant-row-header";

      const titleBlock = document.createElement("div");
      titleBlock.className = "shift-restaurant-row-title-block";

      const title = document.createElement("div");
      title.className = "shift-restaurant-row-title";
      title.textContent = group.store_name || "Restaurant";

      const meta = document.createElement("div");
      meta.className = "shift-restaurant-row-meta";
      const metaParts = [];
      if (group.store_rating) metaParts.push(`★ ${group.store_rating}`);
      if (group.store_eta) metaParts.push(group.store_eta);
      metaParts.push(`${group.dishes.length} produit${group.dishes.length > 1 ? "s" : ""}`);
      meta.textContent = metaParts.join(" • ");

      titleBlock.append(title, meta);

      const summary = document.createElement("div");
      summary.className = "shift-restaurant-row-summary";
      summary.textContent = group.dishes.map((dish) => dish.title).join(" • ");

      header.append(titleBlock, summary);
      row.appendChild(header);

      const track = document.createElement("div");
      track.className = "shift-restaurant-row-track";
      group.dishes.forEach((dish, dishIndex) => {
        track.appendChild(buildCard(dish, dishIndex));
      });

      row.appendChild(track);
      wrap.appendChild(row);
    });

    $stage.appendChild(wrap);
  }

  function renderCarousel(dishes) {
    const wrap = document.createElement("div");
    wrap.className = "shift-carousel";
    const prev = document.createElement("button");
    prev.className = "shift-carousel-arrow"; prev.innerHTML = "\u2039";
    const track = document.createElement("div");
    track.className = "shift-carousel-track";
    const next = document.createElement("button");
    next.className = "shift-carousel-arrow"; next.innerHTML = "\u203A";
    dishes.forEach((d, i) => track.appendChild(buildCard(d, i)));
    prev.addEventListener("click", () => track.scrollBy({ left: -320, behavior: "smooth" }));
    next.addEventListener("click", () => track.scrollBy({ left: 320, behavior: "smooth" }));
    wrap.append(prev, track, next);
    $stage.appendChild(wrap);
  }

  function renderGrid(dishes) {
    const grid = document.createElement("div");
    grid.className = "shift-grid";

    const visible = dishes.slice(0, MAX_VISIBLE);
    const rest = dishes.slice(MAX_VISIBLE);

    visible.forEach((d, i) => grid.appendChild(buildCard(d, i)));
    $stage.appendChild(grid);

    if (rest.length > 0) {
      const loadMore = document.createElement("button");
      loadMore.className = "shift-load-more";
      loadMore.textContent = `Voir ${rest.length} autre${rest.length > 1 ? "s" : ""} plat${rest.length > 1 ? "s" : ""}`;
      loadMore.addEventListener("click", () => {
        loadMore.remove();
        rest.forEach((d, i) => {
          const card = buildCard(d, MAX_VISIBLE + i);
          grid.appendChild(card);
        });
      });
      $stage.appendChild(loadMore);
    }
  }

  // ── Render: Winner ──────────────────────────────────
  function renderWinner(dish) {
    const wrap = document.createElement("div");
    wrap.className = "shift-winner-reveal";
    const crown = document.createElement("div");
    crown.className = "shift-winner-crown";
    crown.textContent = "\u{1F451}";
    const card = buildCard(dish, 0);
    card.classList.add("shift-winner-card");
    const cta = document.createElement("button");
    cta.className = "shift-cta-order";
    cta.textContent = "Commander sur Uber Eats";
    cta.addEventListener("click", () => {
      if (dish.store_action_url) {
        sessionStorage.setItem("shift-active", "true");
        window.location.href = dish.store_action_url;
      }
    });
    wrap.append(crown, card, cta);
    $stage.appendChild(wrap);
  }

  // ── Render: Top Picks (3 cards, pick 1) ─────────────
  function renderTopPicks(callId, title, dishes) {
    if (!$stage) return;
    $stage.innerHTML = "";
    if ($response) { $response.textContent = ""; $response.classList.remove("streaming"); }

    const wrap = document.createElement("div");
    wrap.className = "shift-top-picks";

    const header = document.createElement("div");
    header.className = "shift-top-picks-title";
    header.textContent = title || "Lequel te fait envie ?";
    wrap.appendChild(header);

    const arena = document.createElement("div");
    arena.className = "shift-top-picks-arena";

    let picked = false;
    dishes.slice(0, 3).forEach((dish, i) => {
      const card = buildCard(dish, i);
      card.addEventListener("click", () => {
        if (picked) return;
        picked = true;
        card.classList.add("shift-winner");
        const badge = document.createElement("div");
        badge.className = "shift-winner-badge";
        badge.textContent = "\u2713";
        card.style.position = "relative";
        card.appendChild(badge);
        arena.querySelectorAll(".shift-card").forEach((c) => {
          if (c !== card) c.classList.add("shift-loser");
        });
        setTimeout(() => {
          chrome.runtime.sendMessage({
            type: "TOOL_RESULT", callId,
            result: { winner_index: i, winner_dish: dish },
          });
        }, 800);
      });
      arena.appendChild(card);
    });

    wrap.appendChild(arena);
    $stage.appendChild(wrap);
  }

  // ── Render: Choices (clickable options) ──────────────
  function renderChoices(callId, title, options, allowMultiple) {
    if (!$stage) return;
    $stage.innerHTML = "";
    if ($response) { $response.textContent = ""; $response.classList.remove("streaming"); }

    const wrap = document.createElement("div");
    wrap.className = "shift-choices";

    const h = document.createElement("div");
    h.className = "shift-choices-title";
    h.textContent = title;
    wrap.appendChild(h);

    const row = document.createElement("div");
    row.className = "shift-choices-options";

    const sel = new Set();

    options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.className = "shift-choice";
      btn.innerHTML = `${opt.icon ? `<span class="shift-choice-icon">${esc(opt.icon)}</span>` : ""}${esc(opt.label)}`;

      btn.addEventListener("click", () => {
        if (allowMultiple) {
          btn.classList.toggle("selected");
          if (sel.has(opt.value)) sel.delete(opt.value);
          else sel.add(opt.value);
        } else {
          btn.classList.add("selected");
          chrome.runtime.sendMessage({
            type: "TOOL_RESULT", callId,
            result: { selected: [opt.value], labels: [opt.label] },
          });
        }
      });
      row.appendChild(btn);
    });

    wrap.appendChild(row);

    if (allowMultiple) {
      const confirm = document.createElement("button");
      confirm.className = "shift-choice-confirm";
      confirm.textContent = "Valider";
      confirm.addEventListener("click", () => {
        if (sel.size > 0) {
          chrome.runtime.sendMessage({
            type: "TOOL_RESULT", callId,
            result: { selected: [...sel] },
          });
        }
      });
      wrap.appendChild(confirm);
    }

    $stage.appendChild(wrap);
  }

  // ── Error ───────────────────────────────────────────
  function showError(msg) {
    finalizeStream();
    console.error("[Shift Error]", msg);
    const target = $stage || $response;
    if (!target) return;
    const el = document.createElement("div");
    el.className = "shift-error";
    el.textContent = msg;
    target.appendChild(el);
  }

  // ── Restore Conversation ────────────────────────────
  function restoreConversation(messages) {
    if (!messages?.length || !$welcome) return;
    $welcome.style.display = "none";
    $experience.style.display = "";
    let lastText = null, lastDishes = null, lastUserText = null;
    for (const m of messages) {
      if (m.role === "user" && m.content) lastUserText = m.content;
      if (m.role === "assistant" && m.content) lastText = m.content;
      if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) {
          if (tc.function?.name === "show_dish_cards") {
            try { lastDishes = JSON.parse(tc.function.arguments).dishes; } catch (_) {}
          }
        }
      }
    }
    if (lastUserText) lastUserPrompt = lastUserText;
    if (lastText && $response) $response.innerHTML = lastText.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    if (lastDishes?.length) renderDishCards(lastDishes);
  }

  // ── Voice Input ─────────────────────────────────────
  let recognition = null, isListening = false;

  function initVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    recognition = new SR();
    recognition.lang = "fr-FR";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (e) => {
      const transcript = Array.from(e.results).map(r => r[0].transcript).join("");
      const target = activeVoiceInput || $textInput;
      if (target) target.value = transcript;
      if (e.results[0].isFinal) {
        stopMic();
        if (activeVoiceInput && activeVoiceInput.id === "shiftInlineText") {
          activeVoiceInput.value = "";
          activate();
        }
        startFlow(transcript);
      }
    };
    recognition.onend = () => stopMic();
    recognition.onerror = () => stopMic();
  }

  function toggleMic() { isListening ? stopMic() : startMic(); }

  function getOverlayForInput(input) {
    if (input && input.id === "shiftInlineText") {
      return inlineBar?.querySelector("#shiftInlinePlaceholder");
    }
    return shiftRoot?.querySelector("#shiftPlaceholder");
  }

  function startMic() {
    if (!recognition || isListening) return;
    isListening = true;
    recognition.start();
    // Highlight the correct mic button
    const isInline = activeVoiceInput && activeVoiceInput.id === "shiftInlineText";
    const btn = isInline ? inlineBar?.querySelector("#shiftInlineMic") : shiftRoot?.querySelector("#shiftMic");
    if (btn) btn.classList.add("listening");
    const overlay = getOverlayForInput(activeVoiceInput || $textInput);
    if (overlay) {
      if (typewriterTimer) { clearInterval(typewriterTimer); typewriterTimer = null; }
      overlay.innerHTML = "Je t'\u00e9coute...";
    }
  }

  function stopMic() {
    if (!recognition) return;
    isListening = false;
    try { recognition.stop(); } catch (_) {}
    // Reset both mic buttons
    shiftRoot?.querySelector("#shiftMic")?.classList.remove("listening");
    inlineBar?.querySelector("#shiftInlineMic")?.classList.remove("listening");
    const overlay = getOverlayForInput(activeVoiceInput || $textInput);
    if (overlay) {
      typewriterPlaceholder(overlay, pickRandom(DEFAULT_PLACEHOLDER));
    }
    activeVoiceInput = null;
  }

  // ── Dish Detail Popup ────────────────────────────────
  function openDishPopup(dish) {
    // Remove existing popup if any
    shiftRoot.querySelector(".shift-popup-overlay")?.remove();

    const price = dish.price != null ? dish.price.toFixed(2) + " \u20AC" : "";
    const rawFee = dish.store_delivery_fee || storeFeeCache.get(dish.store_uuid) || "";
    const fee = extractFeeAmount(rawFee);

    const overlay = document.createElement("div");
    overlay.className = "shift-popup-overlay";
    overlay.innerHTML = `
      <div class="shift-popup">
        <button class="shift-popup-close">\u2715</button>
        ${dish.image_url ? `<img class="shift-popup-img" src="${esc(dish.image_url)}" />` : ""}
        <div class="shift-popup-body">
          <h2 class="shift-popup-title">${esc(dish.title || "")}</h2>
          <div class="shift-popup-store">
            ${esc(dish.store_name || "")}
            ${dish.store_rating ? ` \u00B7 \u2605 ${esc(dish.store_rating)}` : ""}
            ${dish.store_eta ? ` \u00B7 ${esc(dish.store_eta)}` : ""}
          </div>
          ${dish.description ? `<p class="shift-popup-desc">${esc(dish.description)}</p>` : ""}
          <div class="shift-popup-pricing">
            ${price ? `<span class="shift-popup-price">${esc(price)}</span>` : ""}
            ${fee ? `<span class="shift-popup-fee">+ ${esc(fee)}</span>` : ""}
          </div>
          <button class="shift-popup-cta">Voir sur Uber Eats</button>
        </div>
      </div>
    `;

    // Close on overlay click or X
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.closest(".shift-popup-close")) {
        overlay.remove();
      }
    });

    // CTA → navigate to store
    overlay.querySelector(".shift-popup-cta").addEventListener("click", () => {
      if (dish.store_action_url) {
        sessionStorage.setItem("shift-active", "true");
        const itemId = dish.item_uuid;
        const navUrl = itemId ? dish.store_action_url + "&mod=quickView&modctx=" + encodeURIComponent(itemId) : dish.store_action_url;
        window.location.href = navUrl;
      }
    });

    shiftRoot.appendChild(overlay);
  }

  // ── Helpers ─────────────────────────────────────────
  function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  // ═══════════════════════════════════════════════════
  // SECTION 4: Init
  // ═══════════════════════════════════════════════════

  let initRetries = 0;

  function init() {
    const injected = injectUI();

    if (!injected) {
      // On non-feed pages, hide shift-root if it exists from a previous navigation
      if (shiftRoot) {
        shiftRoot.style.display = "none";
        if (feedEl) feedEl.style.display = "";
        shiftActive = false;
      }

      if (++initRetries < 15) { setTimeout(init, 500); return; }
      console.log("[Shift 2026] Not on feed page");
      chrome.runtime.sendMessage({ type: "CONTENT_READY" });
      return;
    }

    initVoice();

    if (sessionStorage.getItem("shift-active") === "true") {
      sessionStorage.removeItem("shift-active");
      activate();
    }

    chrome.runtime.sendMessage({ type: "CONTENT_READY" });
    console.log("[Shift 2026] Injected");
  }

  // SPA navigation detection — only react when page TYPE changes (feed ↔ store)
  function getPageType() {
    const p = window.location.pathname;
    if (p.includes("/store/")) return "store";
    if (p.includes("/feed") || p.match(/^\/[a-z]{2}\/?$/)) return "feed";
    return "other";
  }

  function watchUrlChanges() {
    // Wait 3s before starting to watch — let the page settle after initial load
    setTimeout(() => {
      let lastType = getPageType();
      setInterval(() => {
        // Re-inject inline bar if Uber Eats re-rendered the feed
        if (feedEl && inlineBar && !document.body.contains(inlineBar)) {
          inlineBar = null;
          injectInlineInput();
        }
        const currentType = getPageType();
        if (currentType !== lastType) {
          lastType = currentType;
          console.log("[Shift 2026] Page type changed:", currentType);
          if (shiftRoot && shiftRoot.parentElement) shiftRoot.remove();
          if (inlineBar && inlineBar.parentElement) inlineBar.remove();
          shiftRoot = null;
          inlineBar = null;
          feedEl = null;
          $welcome = null;
          $experience = null;
          $response = null;
          $stage = null;
          $textInput = null;
          shiftActive = false;
          isStreaming = false;
          initRetries = 0;
          setTimeout(init, 800);
        }
      }, 500);
    }, 3000);
  }

  if (document.readyState === "complete") { init(); watchUrlChanges(); }
  else window.addEventListener("load", () => { init(); watchUrlChanges(); });
})();
