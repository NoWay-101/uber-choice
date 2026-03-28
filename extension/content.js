// Shift 2026 - Content Script
// Guided food discovery — injected into Uber Eats DOM
(function () {
  "use strict";

  // ═══════════════════════════════════════════════════
  // SECTION 1: Uber Eats API
  // ═══════════════════════════════════════════════════

  const UE = { "Content-Type": "application/json", "x-csrf-token": "x" };

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
        return { uuid: s.storeUuid, title: s.title?.text || "?", rating: s.rating?.text || null, eta, deliveryFee: fee, actionUrl: s.actionUrl || null };
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
          <button class="shift-mic-btn" id="shiftMic" title="Dicte ta commande">\u{1F3A4}</button>
          <input type="text" id="shiftTextInput" placeholder="Pizza chevre miel, un truc reconfortant, sushi..." />
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
    shiftRoot.querySelector("#shiftMic").addEventListener("click", toggleMic);

    // Card clicks → navigate to store page with item hash
    $stage.addEventListener("click", (e) => {
      const card = e.target.closest(".shift-card[data-actionurl]");
      if (!card || card.closest(".shift-top-picks-arena")) return;
      const url = card.dataset.actionurl;
      const itemId = card.dataset.itemid;
      if (url) {
        sessionStorage.setItem("shift-active", "true");
        // Add item UUID to URL so we can try to open it
        const navUrl = itemId ? url + "&mod=quickView&modctx=" + encodeURIComponent(itemId) : url;
        window.location.href = navUrl;
      }
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

    return true;
  }

  // ── FAB ─────────────────────────────────────────────
  function createFAB() {
    const existing = document.querySelector(".shift-fab");
    if (existing) return existing;
    const fab = document.createElement("button");
    fab.className = "shift-fab";
    fab.innerHTML = "\u2728 Aide-moi";
    fab.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!feedEl || !shiftRoot) {
        // Not on feed page → navigate to feed
        sessionStorage.setItem("shift-active", "true");
        window.location.href = "/feed";
        return;
      }
      if (shiftActive) deactivate();
      else activate();
    });
    document.body.appendChild(fab);
    return fab;
  }

  function activate() {
    if (!feedEl || !shiftRoot) return;
    feedEl.style.display = "none";
    shiftRoot.style.display = "";
    shiftActive = true;
    if ($fab) {
      $fab.innerHTML = "\u25A6 Retour au feed";
      $fab.classList.add("active");
    }
  }

  function deactivate() {
    if (!feedEl || !shiftRoot) return;
    feedEl.style.display = "";
    shiftRoot.style.display = "none";
    shiftActive = false;
    if ($fab) {
      $fab.innerHTML = "\u2728 Aide-moi";
      $fab.classList.remove("active");
    }
  }

  // ── Flow Control ────────────────────────────────────
  function startFlow(text) {
    if (!$welcome || !$experience) return;
    lastUserPrompt = text || "";
    $welcome.style.display = "none";
    $experience.style.display = "";
    $response.textContent = "";
    $response.classList.add("streaming");
    $stage.innerHTML = "";
    isStreaming = true;
    scrollTop();
    chrome.runtime.sendMessage({ type: "CHAT_MESSAGE", text });
  }

  function sendText() {
    const text = $textInput.value.trim();
    if (!text || isStreaming) return;
    $textInput.value = "";
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
  function buildCard(dish, index) {
    const price = dish.price != null ? dish.price.toFixed(2) + "\u00A0\u20AC" : "";
    const card = document.createElement("div");
    card.className = "shift-card";
    if (dish.store_action_url) card.dataset.actionurl = dish.store_action_url;
    if (dish.item_uuid) card.dataset.itemid = dish.item_uuid;
    card.style.setProperty("--i", index);
    card.innerHTML = `
      <div class="shift-card-img-wrap">
        ${dish.image_url ? `<img class="shift-card-img" src="${esc(dish.image_url)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=shift-card-img-placeholder>\u{1F37D}\u{FE0F}</div>'" />` : '<div class="shift-card-img-placeholder">\u{1F37D}\u{FE0F}</div>'}
        ${price ? `<div class="shift-card-price">${esc(price)}</div>` : ""}
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
    $stage.innerHTML = "";
    if ($response) { $response.textContent = ""; $response.classList.remove("streaming"); }
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
      if ($textInput) $textInput.value = transcript;
      if (e.results[0].isFinal) {
        stopMic();
        startFlow(transcript);
      }
    };
    recognition.onend = () => stopMic();
    recognition.onerror = () => stopMic();
  }

  function toggleMic() { isListening ? stopMic() : startMic(); }

  function startMic() {
    if (!recognition || isListening) return;
    isListening = true;
    recognition.start();
    const btn = shiftRoot?.querySelector("#shiftMic");
    if (btn) btn.classList.add("listening");
    if ($textInput) $textInput.placeholder = "Je t'ecoute...";
  }

  function stopMic() {
    if (!recognition) return;
    isListening = false;
    try { recognition.stop(); } catch (_) {}
    const btn = shiftRoot?.querySelector("#shiftMic");
    if (btn) btn.classList.remove("listening");
    if ($textInput) $textInput.placeholder = "Pizza chevre miel, un truc reconfortant, sushi...";
  }

  // ── Helpers ─────────────────────────────────────────
  function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  // ═══════════════════════════════════════════════════
  // SECTION 4: Init
  // ═══════════════════════════════════════════════════

  let initRetries = 0;

  function init() {
    // Always create FAB first, on ANY page
    if (!$fab) $fab = createFAB();

    const injected = injectUI();

    if (!injected) {
      // On non-feed pages, hide shift-root if it exists from a previous navigation
      if (shiftRoot) {
        shiftRoot.style.display = "none";
        if (feedEl) feedEl.style.display = "";
        shiftActive = false;
        if ($fab) { $fab.innerHTML = "\u2728 Aide-moi"; $fab.classList.remove("active"); }
      }

      if (++initRetries < 15) { setTimeout(init, 500); return; }
      console.log("[Shift 2026] FAB only (not on feed)");
      chrome.runtime.sendMessage({ type: "CONTENT_READY" });
      return;
    }

    initVoice();

    const isFeed = /\/(feed|fr\/feed|fr-en\/feed|fr\/?)(\?|$)/.test(window.location.pathname);
    if (isFeed || sessionStorage.getItem("shift-active") === "true") {
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
        const currentType = getPageType();
        if (currentType !== lastType) {
          lastType = currentType;
          console.log("[Shift 2026] Page type changed:", currentType);
          if (shiftRoot && shiftRoot.parentElement) shiftRoot.remove();
          shiftRoot = null;
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
