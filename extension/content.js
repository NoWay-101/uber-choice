// Shift 2026 - Content Script
// Chat UI (Shadow DOM) + Uber Eats API executor + message relay
(function () {
  "use strict";

  // ═══════════════════════════════════════════════════
  // SECTION 1: Uber Eats API
  // ═══════════════════════════════════════════════════

  const UE_HEADERS = {
    "Content-Type": "application/json",
    "x-csrf-token": "x",
  };

  async function ueFeedSearch(query) {
    const res = await fetch("/_p/api/getFeedV1?localeCode=fr-en", {
      method: "POST",
      headers: UE_HEADERS,
      credentials: "include",
      body: JSON.stringify({
        cacheKey: "",
        feedSessionCount: { announcementCount: 0, announcementLabel: "" },
        userQuery: query || "",
        date: "",
        startTime: 0,
        endTime: 0,
        carouselId: "",
        sortAndFilters: [],
        billboardUuid: "",
        feedProvider: "",
        promotionUuid: "",
        targetingStoreTag: "",
        venueUUID: "",
        selectedSectionUUID: "",
        favorites: "",
        vertical: "",
        searchSource: "",
        searchType: "",
        keyName: "",
        serializedRequestContext: "",
        isUserInitiatedRefresh: false,
      }),
    });
    if (!res.ok) throw new Error(`getFeedV1: ${res.status}`);
    const data = await res.json();
    const feedItems = data?.data?.feedItems || [];
    return feedItems
      .filter((i) => i.type === "REGULAR_STORE")
      .map((i) => {
        const s = i.store;
        if (!s) return null;
        const meta = s.meta || [];
        let eta = null,
          deliveryFee = null;
        for (const m of meta) {
          if (m.badgeType === "ETD") eta = m.text;
          else if (m.badgeType === "FARE")
            deliveryFee = m.badgeData?.fare?.deliveryFee || m.text;
        }
        return {
          uuid: s.storeUuid,
          title: s.title?.text || "?",
          rating: s.rating?.text || null,
          eta,
          deliveryFee,
          actionUrl: s.actionUrl || null,
        };
      })
      .filter(Boolean);
  }

  async function ueGetStore(storeUuid) {
    const res = await fetch("/_p/api/getStoreV1?localeCode=fr-en", {
      method: "POST",
      headers: UE_HEADERS,
      credentials: "include",
      body: JSON.stringify({
        storeUuid,
        diningMode: "DELIVERY",
        time: { asap: true },
        cbType: "EATER_ENDORSED",
      }),
    });
    if (!res.ok) throw new Error(`getStoreV1: ${res.status}`);
    const data = await res.json();
    const d = data?.data || {};
    const items = [];
    const csm = d.catalogSectionsMap || {};
    const seen = new Set();
    for (const entries of Object.values(csm)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const sip = entry?.payload?.standardItemsPayload;
        if (!sip) continue;
        for (const item of sip.catalogItems || []) {
          if (seen.has(item.uuid)) continue;
          seen.add(item.uuid);
          if (item.isSoldOut || item.isAvailable === false) continue;
          items.push({
            title: item.title,
            price: item.price,
            desc: (item.itemDescription || "").slice(0, 80),
            section: sip.title || "",
            img: item.imageUrl || null,
            uuid: item.uuid,
          });
        }
      }
    }
    return {
      title: d.title,
      uuid: d.uuid,
      rating: d.rating,
      etaRange: d.etaRange,
      priceBucket: d.priceBucket,
      actionUrl: `/store/${d.slug}/${d.uuid}?diningMode=DELIVERY`,
      items,
    };
  }

  // ═══════════════════════════════════════════════════
  // SECTION 2: Chrome Message Handler
  // ═══════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "STREAM_DELTA":
        appendStreamChunk(msg.text);
        break;

      case "STREAM_DONE":
        finalizeStream();
        break;

      case "EXECUTE_TOOL":
        executeTool(msg.callId, msg.name, msg.args);
        break;

      case "TOOL_STATUS":
        showToolStatus(msg.name, msg.args);
        break;

      case "DISH_CARDS":
        renderDishCards(msg.dishes);
        break;

      case "ERROR":
        showError(msg.message);
        break;

      case "CONVERSATION_HISTORY":
        restoreConversation(msg.messages);
        break;
    }
    return true;
  });

  async function executeTool(callId, name, args) {
    try {
      let result;
      if (name === "search_restaurants") {
        result = await ueFeedSearch(args.query);
      } else if (name === "get_restaurant_menu") {
        result = await ueGetStore(args.store_uuid);
      } else {
        result = { error: `Unknown tool: ${name}` };
      }
      chrome.runtime.sendMessage({ type: "TOOL_RESULT", callId, result });
    } catch (e) {
      chrome.runtime.sendMessage({
        type: "TOOL_RESULT",
        callId,
        result: { error: e.message },
      });
    }
  }

  // ═══════════════════════════════════════════════════
  // SECTION 3: UI Rendering
  // ═══════════════════════════════════════════════════

  // ── Shadow DOM ──────────────────────────────────────
  const host = document.createElement("div");
  host.id = "shift-2026";
  const shadow = host.attachShadow({ mode: "closed" });

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("styles.css");
  shadow.appendChild(link);

  const root = document.createElement("div");
  root.innerHTML = `
    <button class="shift-toggle" id="toggle">Shift</button>
    <div class="shift-panel" id="panel">
      <div class="shift-header">
        <h2>Shift</h2>
        <div class="shift-header-actions">
          <button class="shift-new-chat" id="newChat" title="Nouvelle conversation">+</button>
          <button class="shift-close" id="close">&times;</button>
        </div>
      </div>
      <div class="shift-messages" id="messages"></div>
      <div class="shift-input-area">
        <div class="shift-suggestions" id="suggestions">
          <button class="shift-chip" data-q="Meilleur quatre fromages du coin">4 Fromages</button>
          <button class="shift-chip" data-q="Trouve-moi un bon burger pas trop cher">Burger</button>
          <button class="shift-chip" data-q="Compare les pizzas chevre miel">Chevre miel</button>
          <button class="shift-chip" data-q="Sushi frais et bien note">Sushi</button>
        </div>
        <div class="shift-input-row">
          <textarea id="chatInput" rows="1" placeholder="Qu'est-ce qui te ferait plaisir ?"></textarea>
          <button class="shift-send" id="sendBtn">&#9654;</button>
        </div>
      </div>
    </div>
  `;
  shadow.appendChild(root);

  // ── DOM refs ────────────────────────────────────────
  const $ = (s) => shadow.querySelector(s);
  const $toggle = $("#toggle");
  const $panel = $("#panel");
  const $close = $("#close");
  const $newChat = $("#newChat");
  const $messages = $("#messages");
  const $suggestions = $("#suggestions");
  const $input = $("#chatInput");
  const $send = $("#sendBtn");

  let currentStreamEl = null;
  let isStreaming = false;

  // ── Events ──────────────────────────────────────────
  $toggle.addEventListener("click", () => $panel.classList.toggle("open"));
  $close.addEventListener("click", () => $panel.classList.remove("open"));

  $newChat.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "RESET_CONVERSATION" });
    $messages.innerHTML = "";
    $suggestions.style.display = "flex";
    currentStreamEl = null;
    isStreaming = false;
  });

  $send.addEventListener("click", () => sendMessage());
  $input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  $input.addEventListener("input", () => {
    $input.style.height = "auto";
    $input.style.height = Math.min($input.scrollHeight, 120) + "px";
  });

  $suggestions.addEventListener("click", (e) => {
    const chip = e.target.closest(".shift-chip");
    if (!chip) return;
    $input.value = chip.dataset.q;
    sendMessage();
  });

  $messages.addEventListener("click", (e) => {
    const card = e.target.closest(".dish-card");
    if (!card) return;
    const url = card.dataset.actionurl;
    if (url) {
      // Save panel state so it reopens after navigation
      sessionStorage.setItem("shift-panel-open", "true");
      window.location.href = url;
    }
  });

  // ── Send Message ────────────────────────────────────
  function sendMessage() {
    const text = $input.value.trim();
    if (!text || isStreaming) return;

    $input.value = "";
    $input.style.height = "auto";
    $suggestions.style.display = "none";

    addMessage("user", text);
    chrome.runtime.sendMessage({ type: "CHAT_MESSAGE", text });

    // Prepare assistant bubble for streaming
    currentStreamEl = addMessage("assistant", "");
    currentStreamEl.classList.add("streaming");
    isStreaming = true;
    scrollToBottom();
  }

  // ── Stream Handling ─────────────────────────────────
  function appendStreamChunk(text) {
    if (!currentStreamEl) {
      currentStreamEl = addMessage("assistant", "");
      currentStreamEl.classList.add("streaming");
      isStreaming = true;
    }
    const contentEl = currentStreamEl.querySelector(".msg-content");
    contentEl.textContent += text;
    scrollToBottom();
  }

  function finalizeStream() {
    if (currentStreamEl) {
      currentStreamEl.classList.remove("streaming");
      // Simple markdown: **bold**
      const contentEl = currentStreamEl.querySelector(".msg-content");
      contentEl.innerHTML = contentEl.textContent.replace(
        /\*\*(.+?)\*\*/g,
        "<strong>$1</strong>"
      );
    }
    currentStreamEl = null;
    isStreaming = false;
  }

  // ── Tool Status ─────────────────────────────────────
  function showToolStatus(name, args) {
    let label = "Recherche en cours...";
    if (name === "search_restaurants") {
      label = `Recherche "${args.query || ""}"...`;
    } else if (name === "get_restaurant_menu") {
      label = `Scan du menu ${args.store_name || ""}...`;
    }

    // If we're streaming, insert status before the current stream bubble
    const el = document.createElement("div");
    el.className = "tool-status";
    el.textContent = label;

    if (currentStreamEl) {
      $messages.insertBefore(el, currentStreamEl);
    } else {
      $messages.appendChild(el);
    }
    scrollToBottom();
  }

  // ── Dish Cards ──────────────────────────────────────
  function renderDishCards(dishes) {
    if (!dishes || dishes.length === 0) return;

    const container = document.createElement("div");
    container.className = "dish-cards-container";

    for (const dish of dishes) {
      const price =
        dish.price != null ? dish.price.toFixed(2) + " EUR" : "";
      const actionUrl = dish.store_action_url || "";

      const card = document.createElement("div");
      card.className = "dish-card";
      card.dataset.actionurl = actionUrl;
      card.innerHTML = `
        ${dish.image_url ? `<img class="dish-img" src="${esc(dish.image_url)}" loading="lazy" />` : '<div class="dish-img-placeholder">&#x1F37D;</div>'}
        <div class="dish-info">
          <div class="dish-name">${esc(dish.title || "")}</div>
          <div class="dish-store">
            ${esc(dish.store_name || "")}
            ${dish.store_rating ? ` · ★ ${esc(dish.store_rating)}` : ""}
            ${dish.store_eta ? ` · ${esc(dish.store_eta)}` : ""}
          </div>
          ${dish.description ? `<div class="dish-desc">${esc(dish.description)}</div>` : ""}
        </div>
        <div class="dish-price">${esc(price)}</div>
      `;
      container.appendChild(card);
    }

    // Insert cards before the current streaming bubble, or at the end
    if (currentStreamEl) {
      $messages.insertBefore(container, currentStreamEl);
    } else {
      $messages.appendChild(container);
    }
    scrollToBottom();
  }

  // ── Error ───────────────────────────────────────────
  function showError(message) {
    finalizeStream();
    const el = document.createElement("div");
    el.className = "msg-error";
    el.textContent = message;
    $messages.appendChild(el);
    scrollToBottom();
  }

  // ── Restore Conversation ────────────────────────────
  function restoreConversation(messages) {
    if (!messages || messages.length === 0) return;

    $suggestions.style.display = "none";

    for (const msg of messages) {
      if (msg.role === "user") {
        addMessage("user", msg.content);
      } else if (msg.role === "assistant") {
        // Restore text content
        if (msg.content) {
          const el = addMessage("assistant", msg.content);
          const contentEl = el.querySelector(".msg-content");
          contentEl.innerHTML = msg.content.replace(
            /\*\*(.+?)\*\*/g,
            "<strong>$1</strong>"
          );
        }
        // Restore dish cards from tool calls
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.function?.name === "show_dish_cards") {
              try {
                const args = JSON.parse(tc.function.arguments);
                if (args.dishes) renderDishCards(args.dishes);
              } catch (_) {}
            }
          }
        }
      }
      // Skip tool result messages in display
    }
    scrollToBottom();
  }

  // ── Helpers ─────────────────────────────────────────
  function addMessage(role, text) {
    const el = document.createElement("div");
    el.className = `msg msg-${role}`;
    el.innerHTML = `<div class="msg-content">${esc(text)}</div>`;
    $messages.appendChild(el);
    return el;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      $messages.scrollTop = $messages.scrollHeight;
    });
  }

  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // ═══════════════════════════════════════════════════
  // SECTION 4: Initialization
  // ═══════════════════════════════════════════════════

  function mount() {
    document.body.appendChild(host);

    // Reopen panel if we navigated from a dish card click
    if (sessionStorage.getItem("shift-panel-open") === "true") {
      $panel.classList.add("open");
      sessionStorage.removeItem("shift-panel-open");
    }

    chrome.runtime.sendMessage({ type: "CONTENT_READY" });
    console.log("[Shift 2026] Content script ready");
  }

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
