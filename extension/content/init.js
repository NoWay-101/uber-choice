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
