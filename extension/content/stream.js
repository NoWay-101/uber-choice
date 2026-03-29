// Shift 2026 — Streaming, flow control, pipeline progress
(function (S) {
  "use strict";

  S.appendStream = function (text) {
    if (!S.$response) return;
    if (!S.isStreaming) {
      S.$response.textContent = "";
      S.$response.classList.add("streaming");
      S.isStreaming = true;
    }
    S.$response.textContent += text;
  };

  S.finalizeStream = function () {
    if (!S.$response) return;
    if (S.flowTimeout) {
      clearTimeout(S.flowTimeout);
      S.flowTimeout = null;
    }
    S.$response.classList.remove("streaming");
    S.$response.innerHTML = S.$response.textContent.replace(
      /\*\*(.+?)\*\*/g,
      "<strong>$1</strong>"
    );
    S.isStreaming = false;
  };

  function shuffleFacts(facts) {
    const shuffled = facts.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  function getNextFact() {
    const facts = Array.isArray(S.LOADING_MARKETING_FACTS)
      ? S.LOADING_MARKETING_FACTS
      : [];
    if (!facts.length) return "";

    if (!S.loadingFactQueue.length) {
      S.loadingFactQueue = shuffleFacts(facts);
      if (
        S.loadingFactQueue.length > 1 &&
        S.loadingFactQueue[0] === S.loadingFactLast
      ) {
        const swapIndex = S.loadingFactQueue.findIndex(
          (fact) => fact !== S.loadingFactLast
        );
        if (swapIndex > 0) {
          [S.loadingFactQueue[0], S.loadingFactQueue[swapIndex]] = [
            S.loadingFactQueue[swapIndex],
            S.loadingFactQueue[0],
          ];
        }
      }
    }

    const fact = S.loadingFactQueue.shift() || "";
    S.loadingFactLast = fact;
    return fact;
  }

  function renderLoadingFact(text) {
    if (!S.$loadingFact) return;
    // Fade out, swap text, fade in
    S.$loadingFact.classList.remove("is-visible");
    setTimeout(() => {
      S.$loadingFact.textContent = text;
      S.$loadingFact.classList.add("is-visible");
    }, 250);
  }

  S.showLoadingOverlay = function () {
    if (!S.$loadingOverlay) return;
    if (S.isLoadingOverlayVisible && !S.$loadingOverlay.hidden) return;
    if (S.loadingFactsTimer) {
      clearInterval(S.loadingFactsTimer);
      S.loadingFactsTimer = null;
    }

    S.isLoadingOverlayVisible = true;
    S.loadingFactQueue = [];
    S.loadingFactLast = "";
    S.$loadingOverlay.hidden = false;
    // Always show the first fact (index 0) first, then shuffle the rest
    const facts = Array.isArray(S.LOADING_MARKETING_FACTS) ? S.LOADING_MARKETING_FACTS : [];
    if (facts.length > 0) {
      renderLoadingFact(facts[0]);
      S.loadingFactLast = facts[0];
    }

    S.loadingFactsTimer = setInterval(() => {
      if (!S.isLoadingOverlayVisible) return;
      renderLoadingFact(getNextFact());
    }, 5000);
  };

  S.hideLoadingOverlay = function () {
    if (S.loadingFactsTimer) {
      clearInterval(S.loadingFactsTimer);
      S.loadingFactsTimer = null;
    }
    S.isLoadingOverlayVisible = false;
    S.loadingFactQueue = [];
    if (S.$loadingOverlay) S.$loadingOverlay.hidden = true;
  };

  // ── Pipeline Progress ───────────────────────────
  const PROGRESS_LABELS = {
    thinking: "Analyse de ta demande...",
    searching: "Recherche des restaurants...",
    scanning: "Scan des menus...",
    selecting: "Sélection des meilleurs plats...",
  };

  S.showProgress = function (step, count) {
    if (!S.$stage) return;
    S.showLoadingOverlay();
    // Reset + restart timeout — pipeline is active but we need a safety net
    if (S.flowTimeout) clearTimeout(S.flowTimeout);
    S.flowTimeout = setTimeout(() => {
      // Only show "not found" if no real content was rendered
      const hasResults = S.$stage && S.$stage.querySelector(".shift-grid, .shift-carousel, .shift-restaurant-rows, .shift-winner-reveal, .shift-choices, .shift-top-picks");
      if (S.isLoadingOverlayVisible && !hasResults) {
        S.isStreaming = false;
        S.hideLoadingOverlay();
        if (S.$stage) S.$stage.innerHTML = "";
        if (S.$response) { S.$response.textContent = ""; S.$response.classList.remove("streaming"); }
        const retry = document.createElement("div");
        retry.className = "shift-retry";
        retry.innerHTML = `<p>La recherche n'a pas abouti</p><button class="shift-retry-btn">R\u00E9essayer</button>`;
        retry.querySelector("button").addEventListener("click", () => { retry.remove(); S.startFlow(S.lastFlowText); });
        if (S.$stage) S.$stage.appendChild(retry);
      }
    }, 45000); // 45s — pipeline with Google + 15 menus + LLM can take a while
    let label = PROGRESS_LABELS[step] || "Chargement...";
    if (step === "scanning" && count) {
      label = `Scan de ${count} restaurants...`;
    }

    let container = S.$stage.querySelector(".shift-progress");
    if (!container) {
      S.$stage.innerHTML = "";
      container = document.createElement("div");
      container.className = "shift-progress";
      S.$stage.appendChild(container);
    }

    // Replace last step or add new one
    const existing = container.querySelector(".shift-progress-step:last-child");
    if (existing) {
      existing.innerHTML = `<span class="shift-progress-dot done"></span>${S.esc(existing.dataset.label || "")}`;
    }

    const el = document.createElement("div");
    el.className = "shift-progress-step";
    el.dataset.label = label;
    el.innerHTML = `<span class="shift-progress-dot"></span>${S.esc(label)}`;
    container.appendChild(el);
  };

  S.showError = function (msg) {
    S.hideLoadingOverlay();
    S.finalizeStream();
    console.error("[Shift Error]", msg);
    const target = S.$stage || S.$response;
    if (!target) return;
    const el = document.createElement("div");
    el.className = "shift-error";
    el.textContent = msg;
    target.appendChild(el);
  };

  S.startFlow = function (text) {
    if (!S.$experience) return;
    S.lastUserPrompt = text || "";
    S.lastFlowText = text;
    // Activate: hide feed, show results panel
    S.activate();
    S.$response.textContent = "";
    S.$response.classList.remove("streaming");
    S.$stage.innerHTML = "";
    S.isStreaming = true;
    S.showLoadingOverlay();
    S.scrollTop();

    if (S.flowTimeout) clearTimeout(S.flowTimeout);

    S.flowTimeout = setTimeout(() => {
      if (
        S.isLoadingOverlayVisible &&
        S.$stage &&
        S.$stage.children.length === 0
      ) {
        S.isStreaming = false;
        S.hideLoadingOverlay();
        S.$response.textContent = "";
        S.$response.classList.remove("streaming");
        const retry = document.createElement("div");
        retry.className = "shift-retry";
        retry.innerHTML = `<p>La recherche n'a pas abouti</p><button class="shift-retry-btn">R\u00E9essayer</button>`;
        retry.querySelector("button").addEventListener("click", () => {
          retry.remove();
          S.startFlow(S.lastFlowText);
        });
        S.$stage.appendChild(retry);
      }
    }, 45000); // 45s safety timeout

    chrome.runtime.sendMessage({ type: "CHAT_MESSAGE", text });
  };

  // sendText is no longer needed — the inline bar handles its own submission.
  // Kept as a no-op for safety in case it's called from voice.js.
  S.sendText = function () {};

  S.resetAll = function () {
    chrome.runtime.sendMessage({ type: "RESET_CONVERSATION" });
    S.menuCache = null;
    S.searchContext = null;
    S.restaurantList = null;
    S.historyStack = [];
    if (S.$response) {
      S.$response.textContent = "";
      S.$response.classList.remove("streaming");
    }
    if (S.$stage) S.$stage.innerHTML = "";
    S.hideLoadingOverlay();
    S.isStreaming = false;
    S.updateBackButton();
    // Go back to the feed
    S.deactivate();
  };

  // ── History Back ────────────────────────────────
  S.goBack = function () {
    if (S.historyStack.length > 0) {
      // Restore previous results
      const prev = S.historyStack.pop();
      if (S.$stage) S.$stage.innerHTML = prev.stageHTML;
      if (S.$response) S.$response.innerHTML = prev.responseHTML;
      S.$response?.classList.remove("streaming");
      S.isStreaming = false;
      S.scrollTop();
      // Tell background to also pop its searchContext
      chrome.runtime.sendMessage({ type: "HISTORY_BACK" });
    } else {
      // No history → go back to feed
      S.resetAll();
    }
  };

  // updateBackButton no longer needed — button is always visible
  S.updateBackButton = function () {};
})(window.Shift);
