// Shift 2026 — Initialization + SPA navigation watcher
(function (S) {
  "use strict";

  // ── Chrome Message Handler ──────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    // Compare messages must work even without shiftRoot (native UE modals)
    if (!S.shiftRoot && !msg.type.startsWith("COMPARE") && !msg.type.startsWith("PROGRESS_COMPARE")
        && msg.type !== "GET_CACHED_MENUS" && msg.type !== "SEARCH_RESTAURANTS"
        && msg.type !== "FETCH_MENUS" && msg.type !== "PIPELINE_RESULT") return true;
    switch (msg.type) {
      // Pipeline messages (background ↔ content)
      case "SEARCH_RESTAURANTS":
        handleSearch(msg.callId, msg.terms);
        break;
      case "FETCH_MENUS":
        handleFetchMenus(msg.callId, msg.restaurants);
        break;
      case "RESOLVE_DISHES":
        handleResolveDishes(msg.selection, msg.header);
        break;
      case "PROGRESS":
        S.showProgress(msg.step, msg.count);
        break;
      // Streaming
      case "STREAM_DELTA":
        S.appendStream(msg.text);
        break;
      case "STREAM_DONE":
        S.finalizeStream();
        break;
      // UI renders (kept for backward compat)
      case "DISH_CARDS":
        S.renderDishCards(msg.dishes);
        break;
      case "SHOW_TOP_PICKS":
        S.renderTopPicks(msg.callId, msg.title, msg.dishes);
        break;
      case "SHOW_CHOICES":
        S.renderChoices(msg.callId, msg.title, msg.options, msg.allowMultiple);
        break;
      case "UPDATE_PLACEHOLDERS":
        if (msg.placeholders?.length && S.$bottomPlaceholder) {
          S.activeBottomPlaceholders = msg.placeholders;
          S.stopPlaceholderRotation();
          S.backspaceAndType(S.$bottomPlaceholder, S.pickRandom(msg.placeholders));
          S.startPlaceholderRotation(S.$bottomPlaceholder, msg.placeholders);
        }
        break;
      case "ERROR":
        S.showError(msg.message);
        break;
      // Compare pipeline messages
      case "GET_CACHED_MENUS":
        handleGetCachedMenus(msg.callId);
        break;
      case "COMPARE_RESULTS":
        handleCompareResults(msg.referenceDish, msg.selection, msg.msg);
        break;
      case "COMPARE_ERROR":
        S.hideCompareLoading();
        S.showCompareError(msg.message);
        break;
      case "PROGRESS_COMPARE":
        S.showCompareProgress(msg.step);
        break;
    }
    return true;
  });

  // ── Pipeline Handlers ───────────────────────────
  async function handleSearch(callId, terms) {
    try {
      const restaurants = await S.searchAndRank(terms);
      S.restaurantList = restaurants;
      chrome.runtime.sendMessage({
        type: "PIPELINE_RESULT",
        callId,
        result: { restaurants },
      });
    } catch (e) {
      chrome.runtime.sendMessage({
        type: "PIPELINE_RESULT",
        callId,
        result: { error: e.message },
      });
    }
  }

  async function handleFetchMenus(callId, restaurants) {
    try {
      const compressed = await S.fetchAndCompress(restaurants);
      chrome.runtime.sendMessage({
        type: "PIPELINE_RESULT",
        callId,
        result: { compressed },
      });
    } catch (e) {
      chrome.runtime.sendMessage({
        type: "PIPELINE_RESULT",
        callId,
        result: { error: e.message },
      });
    }
  }

  function handleResolveDishes(selection, header) {
    const allDishes = S.resolveSelection(selection);
    // Filter out dishes without images
    const dishes = allDishes.filter((d) => d.image_url);
    if (dishes.length) {
      S.renderDishCards(dishes, header);
    } else {
      S.showError("Aucun plat trouvé.");
    }
  }

  // ── Compare Pipeline Handlers ───────────────────
  function handleGetCachedMenus(callId) {
    if (!S.menuCache?.length) {
      chrome.runtime.sendMessage({ type: "PIPELINE_RESULT", callId, result: { compressed: null } });
      return;
    }
    // Rebuild compressed text from cached menu data
    const lines = [];
    S.menuCache.forEach((store, si) => {
      const fee = store.deliveryFee ? extractFeeShort(store.deliveryFee) : "";
      lines.push(`[Store "${store.title}" r:${store.rating || "?"} eta:${store.eta || "?"} ${fee ? "fee:" + fee : ""}]`);
      store.items.forEach((item, ii) => {
        const price = item.price != null ? (item.price / 100).toFixed(2) : "?";
        lines.push(`${ii}|${item.title}|${price}\u20AC|${item.section}`);
      });
      lines.push("");
    });
    chrome.runtime.sendMessage({
      type: "PIPELINE_RESULT",
      callId,
      result: { compressed: lines.join("\n") },
    });
  }

  function extractFeeShort(feeStr) {
    if (!feeStr) return "";
    const match = feeStr.match(/([\d.,]+)\s*\u20AC/);
    return match ? match[1] + "\u20AC" : "";
  }

  function handleCompareResults(referenceDish, selection, msg) {
    const compareDishes = S.resolveSelection(selection);
    // Filter out dishes from the same restaurant as reference
    const filtered = compareDishes.filter((d) => d.store_uuid !== referenceDish.store_uuid);
    if (filtered.length) {
      S.renderCompareView(referenceDish, filtered, msg);
    } else if (compareDishes.length) {
      S.renderCompareView(referenceDish, compareDishes, msg);
    } else {
      S.hideCompareLoading();
      S.showCompareError("Aucune alternative trouvée.");
    }
  }

  // ── Init ────────────────────────────────────────
  let initRetries = 0;

  function init() {
    const injected = S.injectUI();

    if (!injected) {
      // On store pages with quickView params, skip retries and trigger immediately
      if (getPageType() === "store") {
        tryOpenQuickView();
        chrome.runtime.sendMessage({ type: "CONTENT_READY" });
        return;
      }

      if (S.shiftRoot) {
        S.shiftRoot.style.display = "none";
        if (S.feedEl) S.feedEl.style.display = "";
        S.shiftActive = false;
      }

      if (++initRetries < 15) {
        setTimeout(init, 500);
        return;
      }
      console.log("[Shift 2026] Not on feed page");
      chrome.runtime.sendMessage({ type: "CONTENT_READY" });
      return;
    }

    S.initVoice();

    if (sessionStorage.getItem("shift-active") === "true") {
      sessionStorage.removeItem("shift-active");
      S.activate();
    }

    chrome.runtime.sendMessage({ type: "CONTENT_READY" });
    console.log("[Shift 2026] Injected");
  }

  // ── QuickView on Store Pages ─────────────────────
  function tryOpenQuickView() {
    const url = new URL(window.location.href);
    if (!url.pathname.includes("/store/")) return;
    if (url.searchParams.get("mod") !== "quickView") return;

    const modctx = url.searchParams.get("modctx");
    if (!modctx) return;

    let ctx;
    try { ctx = JSON.parse(decodeURIComponent(modctx)); } catch (e) { return; }
    if (!ctx.itemUuid) return;

    // Clean URL to prevent re-triggering
    url.searchParams.delete("mod");
    url.searchParams.delete("modctx");
    url.searchParams.delete("ps");
    history.replaceState(null, "", url.toString());

    waitForItemAndClick(ctx.itemUuid);
  }

  function waitForItemAndClick(itemUuid) {
    const TIMEOUT = 10000;
    const POLL_INTERVAL = 200;
    const start = Date.now();

    function findAndClick() {
      // Uber Eats menu items are rendered as <a> elements whose href contains the itemUuid
      const links = document.querySelectorAll('main a[href*="' + itemUuid + '"]');
      if (links.length) {
        links[0].click();
        console.log("[Shift 2026] QuickView triggered for item", itemUuid);
        return;
      }

      // Also try buttons/elements with data attributes containing the UUID
      const els = document.querySelectorAll('[data-item-uuid="' + itemUuid + '"], [data-testid*="' + itemUuid + '"]');
      if (els.length) {
        els[0].click();
        console.log("[Shift 2026] QuickView triggered via data attr for item", itemUuid);
        return;
      }

      if (Date.now() - start < TIMEOUT) {
        setTimeout(findAndClick, POLL_INTERVAL);
      } else {
        console.log("[Shift 2026] QuickView timeout — item not found in DOM", itemUuid);
      }
    }

    findAndClick();
  }

  // ── SPA Navigation Detection ────────────────────
  function getPageType() {
    const p = window.location.pathname;
    if (p.includes("/store/")) return "store";
    if (p.includes("/feed") || p === "/" || p.match(/^\/[a-z]{2}(-[a-z]{2})?\/?$/))
      return "feed";
    return "other";
  }

  function resetState() {
    S.hideLoadingOverlay?.();
    if (S.flowTimeout) {
      clearTimeout(S.flowTimeout);
      S.flowTimeout = null;
    }
    if (S.shiftRoot && S.shiftRoot.parentElement) S.shiftRoot.remove();
    if (S.inlineBar && S.inlineBar.parentElement) S.inlineBar.remove();
    S.shiftRoot = null;
    S.inlineBar = null;
    S.feedEl = null;
    S.$experience = null;
    S.$response = null;
    S.$stage = null;
    S.$loadingOverlay = null;
    S.$loadingFact = null;
    S.shiftActive = false;
    S.isStreaming = false;
    initRetries = 0;
  }

  function watchUrlChanges() {
    setTimeout(() => {
      let lastType = getPageType();
      setInterval(() => {
        // Re-inject inline bar if Uber Eats re-rendered the feed
        if (S.feedEl && S.inlineBar && !document.body.contains(S.inlineBar)) {
          S.inlineBar = null;
          S.injectInlineInput();
        }

        // If init gave up but we're on a feed page, keep retrying
        if (!S.shiftRoot && getPageType() === "feed") {
          const injected = S.injectUI();
          if (injected) {
            S.initVoice();
            chrome.runtime.sendMessage({ type: "CONTENT_READY" });
            console.log("[Shift 2026] Late injection succeeded");
          }
        }

        const currentType = getPageType();
        if (currentType !== lastType) {
          lastType = currentType;
          console.log("[Shift 2026] Page type changed:", currentType);
          resetState();
          if (currentType === "store") {
            tryOpenQuickView();
          }
          setTimeout(init, 800);
        }
      }, 500);
    }, 3000);
  }

  // ── Native UE Item Modal Observer ───────────────
  function getStoreInfoFromPage() {
    const path = window.location.pathname;
    const storeMatch = path.match(/\/store\/([^/]+)\/([a-f0-9-]+)/);
    const uuid = storeMatch ? storeMatch[2] : null;
    const slug = storeMatch ? storeMatch[1] : null;

    // Try to get store name from page heading
    const heading = document.querySelector('h1, [data-testid="store-title"]');
    const name = heading?.textContent?.trim() || (slug ? slug.replace(/-/g, " ") : "");

    // Try to get rating
    const ratingEl = document.querySelector('[data-testid="store-rating"], [aria-label*="rating"]');
    const rating = ratingEl?.textContent?.match(/([\d.]+)/)?.[1] || null;

    // Try to get ETA
    const etaEl = document.querySelector('[data-testid="store-eta"]');
    const eta = etaEl?.textContent?.trim() || null;

    return {
      uuid,
      name,
      rating,
      eta,
      actionUrl: path,
    };
  }

  function extractDishFromNativeModal(dialog) {
    // Find the item title — usually the first prominent heading inside the dialog
    const titleEl = dialog.querySelector('h1, h2, h3, [data-testid*="title"], [data-testid*="name"]');
    const title = titleEl?.textContent?.trim() || "";
    if (!title) return null;

    // Find price — match both "12,90 €" (fr) and "€12.90" (en)
    let price = null;
    const priceMatch = dialog.textContent.match(/([\d]+[.,]\d{2})\s*\u20AC|\u20AC\s*([\d]+[.,]\d{2})/);
    if (priceMatch) {
      const raw = priceMatch[1] || priceMatch[2];
      price = parseFloat(raw.replace(",", "."));
    }

    // Find image
    const img = dialog.querySelector('img[src*="cloudfront"], img[src*="uber"], img[src*="tbcdn"], picture img');
    const imageUrl = img?.src || null;

    // Find description
    const descEl = dialog.querySelector('p, [data-testid*="description"]');
    const description = descEl?.textContent?.trim() || "";

    // Get store info from page
    const store = getStoreInfoFromPage();

    return {
      title,
      price,
      description: description.length > 120 ? description.slice(0, 120) : description,
      image_url: imageUrl,
      store_name: store.name,
      store_uuid: store.uuid,
      store_action_url: store.actionUrl,
      store_rating: store.rating,
      store_eta: store.eta,
      store_delivery_fee: null,
      item_uuid: null,
      section_uuid: "",
      subsection_uuid: "",
      google_rating: null,
      google_review_count: null,
      google_reviews: [],
      google_place: null,
    };
  }

  function tryInjectNativeCompareButton(dialog) {
    // Already injected?
    if (dialog.querySelector(".shift-native-compare-btn")) return;

    // Check if this looks like an item detail modal (has price + image)
    // Match both "12,90 €" (fr) and "€12.90" (en) formats
    const hasPrice = /\d+[.,]\d{2}\s*\u20AC|\u20AC\s*\d+[.,]\d{2}/.test(dialog.textContent);
    const hasImage = dialog.querySelector('img[src*="cloudfront"], img[src*="uber"], img[src*="tbcdn"], picture img');
    if (!hasPrice || !hasImage) return;

    const dish = extractDishFromNativeModal(dialog);
    if (!dish || !dish.title) return;

    // Find the add-to-cart button and insert criteria buttons ABOVE it
    const actionArea = dialog.querySelector('button[data-testid*="add"], button[data-testid*="cart"], [data-testid*="action"]');
    const target = actionArea?.parentElement || dialog.querySelector('footer, [role="footer"]') || dialog;

    const wrap = document.createElement("div");
    wrap.className = "shift-native-compare-wrap";

    const label = document.createElement("div");
    label.className = "shift-native-compare-label";
    label.textContent = "Trouver mieux ailleurs ?";
    wrap.appendChild(label);

    const mainBtn = document.createElement("button");
    mainBtn.className = "shift-native-compare-main";
    mainBtn.innerHTML = `${S.COMPARE_MAIN.icon} ${S.COMPARE_MAIN.label}`;
    mainBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      S.openCompareView(dish, S.COMPARE_MAIN.key);
    });
    wrap.appendChild(mainBtn);

    const row = document.createElement("div");
    row.className = "shift-native-compare-row";

    S.COMPARE_CRITERIA.forEach((c) => {
      const btn = document.createElement("button");
      btn.className = "shift-native-compare-btn";
      btn.innerHTML = `${c.icon} ${c.label}`;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        S.openCompareView(dish, c.key);
      });
      row.appendChild(btn);
    });

    wrap.appendChild(row);

    if (actionArea) {
      actionArea.parentElement.insertBefore(wrap, actionArea);
    } else {
      target.appendChild(wrap);
    }

    console.log("[Shift 2026] Compare button injected into native UE modal for:", dish.title);
  }

  function observeNativeItemModals() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          const dialogs = node.matches?.('[role="dialog"]') ? [node] :
            [...(node.querySelectorAll?.('[role="dialog"]') || [])];
          for (const dialog of dialogs) {
            // Small delay to let UE finish rendering the modal content
            setTimeout(() => tryInjectNativeCompareButton(dialog), 500);
          }
          // Also check if the node itself is inside a dialog (UE sometimes adds content after dialog)
          const parentDialog = node.closest?.('[role="dialog"]');
          if (parentDialog && !parentDialog.querySelector(".shift-native-compare-btn")) {
            setTimeout(() => tryInjectNativeCompareButton(parentDialog), 500);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Start observing immediately on all pages
  observeNativeItemModals();

  // ── Boot ────────────────────────────────────────
  if (document.readyState === "complete") {
    init();
    watchUrlChanges();
  } else {
    window.addEventListener("load", () => {
      init();
      watchUrlChanges();
    });
  }
})(window.Shift);
