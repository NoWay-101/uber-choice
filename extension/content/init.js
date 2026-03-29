// Shift 2026 — Initialization + SPA navigation watcher
(function (S) {
  "use strict";

  // ── Chrome Message Handler ──────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (!S.shiftRoot) return true;
    switch (msg.type) {
      // Pipeline messages (background ↔ content)
      case "SEARCH_RESTAURANTS":
        handleSearch(msg.callId, msg.terms);
        break;
      case "FETCH_MENUS":
        handleFetchMenus(msg.callId, msg.restaurants);
        break;
      case "RESOLVE_DISHES":
        handleResolveDishes(msg.selection);
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

  function handleResolveDishes(selection) {
    const dishes = S.resolveSelection(selection);
    if (dishes.length) {
      S.renderDishCards(dishes);
    } else {
      S.showError("Aucun plat trouvé.");
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
    S.$loadingCard = null;
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
