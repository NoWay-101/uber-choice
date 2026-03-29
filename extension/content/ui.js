// Shift 2026 — UI injection (main panel + inline input bar)
(function (S) {
  "use strict";

  S.injectUI = function () {
    if (S.shiftRoot) return true;

    const main = document.querySelector("main#main-content");
    if (!main) return false;

    // Find the feed container: the widest direct child of the wrapper
    // Works regardless of sidebar width or number of children
    const wrapper = main.children[0];
    if (!wrapper || wrapper.children.length < 2) return false;

    // Pick the widest visible DIV child as the feed
    let feed = null;
    let maxW = 0;
    for (const child of wrapper.children) {
      if (child.tagName !== "DIV") continue;
      const w = child.getBoundingClientRect().width;
      if (w > maxW) { maxW = w; feed = child; }
    }
    if (!feed || maxW < 300) return false;

    // Sanity check: feed should have multiple children (restaurant cards/sections)
    if (feed.children.length < 3) return false;

    // Make sure we're not on a store page (store pages have a different structure)
    if (window.location.pathname.includes("/store/")) return false;

    S.feedEl = feed;

    S.shiftRoot = document.createElement("div");
    S.shiftRoot.id = "shift-root";
    S.shiftRoot.className = "shift-root";
    S.shiftRoot.style.display = "none";

    ["click", "mousedown", "mouseup", "keydown", "keyup", "input", "focus", "blur", "submit"].forEach((evt) => {
      S.shiftRoot.addEventListener(evt, (e) => e.stopPropagation());
    });

    // No more welcome screen — the inline bar in the feed is the entry point.
    // shiftRoot only contains the experience (results) view.
    S.shiftRoot.innerHTML = `
      <div class="shift-experience" id="shiftExperience">
        <div class="shift-scroll-area" id="shiftScrollArea">
          <div class="shift-response" id="shiftResponse"></div>
          <div class="shift-stage" id="shiftStage"></div>
        </div>
        <div class="shift-loading-overlay" id="shiftLoadingOverlay" hidden>
          <div class="shift-loading-dialog" role="status" aria-live="polite">
            <div class="shift-loading-card">
              <p class="shift-loading-fact" id="shiftLoadingFact"></p>
            </div>
          </div>
        </div>
        <div class="shift-bottom-bar" id="shiftBottomBar">
          <button class="shift-action-pill" id="shiftRestart" title="Retour au feed">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1"/></svg>
          </button>
          <button class="shift-action-pill" id="shiftBack" title="Retour">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div class="shift-main-input">
            <input type="text" id="shiftBottomText" placeholder="" />
            <span class="shift-fake-placeholder" id="shiftBottomPlaceholder"></span>
            <button class="shift-mic-btn" id="shiftBottomMic" title="Dicte ta commande">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="23"/>
                <line x1="8" y1="23" x2="16" y2="23"/>
              </svg>
            </button>
            <button class="shift-send-btn" id="shiftBottomSend">\u2192</button>
          </div>
        </div>
      </div>
      <div class="shift-reviews-modal" id="shiftReviewsModal" hidden>
        <div class="shift-reviews-backdrop" data-close-reviews="true"></div>
        <div class="shift-reviews-dialog" role="dialog" aria-modal="true" aria-labelledby="shiftReviewsTitle">
          <button type="button" class="shift-reviews-close" id="shiftReviewsClose" aria-label="Fermer les avis">\u00D7</button>
          <div class="shift-reviews-header">
            <div class="shift-reviews-eyebrow">Avis Google</div>
            <div class="shift-reviews-title" id="shiftReviewsTitle"></div>
            <div class="shift-reviews-summary" id="shiftReviewsSummary"></div>
          </div>
          <div class="shift-reviews-list" id="shiftReviewsList"></div>
          <div class="shift-reviews-actions" id="shiftReviewsActions">
            <button type="button" class="shift-reviews-more" id="shiftReviewsMore">Voir plus d'avis</button>
          </div>
        </div>
      </div>
    `;

    wrapper.appendChild(S.shiftRoot);

    S.$experience = S.shiftRoot.querySelector("#shiftExperience");
    S.$response = S.shiftRoot.querySelector("#shiftResponse");
    S.$stage = S.shiftRoot.querySelector("#shiftStage");
    S.$loadingOverlay = S.shiftRoot.querySelector("#shiftLoadingOverlay");
    S.$loadingFact = S.shiftRoot.querySelector("#shiftLoadingFact");

    // Google reviews modal listeners
    S.shiftRoot.querySelector("#shiftReviewsClose").addEventListener("click", S.closeReviewsModal);
    S.shiftRoot.querySelector("#shiftReviewsMore").addEventListener("click", S.showMoreReviews);
    S.shiftRoot.querySelector("#shiftReviewsModal").addEventListener("click", (e) => {
      if (e.target.closest("[data-close-reviews='true']")) S.closeReviewsModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") S.closeReviewsModal();
    });

    // Card clicks -> open detail popup or Google reviews
    S.$stage.addEventListener("click", (e) => {
      // Google reviews button click
      const reviewsBtn = e.target.closest(".shift-card-google-reviews-button");
      if (reviewsBtn) { e.preventDefault(); e.stopPropagation(); S.openReviewsModal(reviewsBtn); return; }

      // Compare button clicks — handled by their own listeners via stopPropagation
      if (e.target.closest(".shift-card-compare-pill, .shift-card-compare-main")) return;

      const card = e.target.closest(".shift-card");
      if (!card || card.closest(".shift-top-picks-arena")) return;
      if (card.closest(".shift-popup")) return;
      try {
        const dish = JSON.parse(card.dataset.dishJson);
        if (dish) S.openDishPopup(dish);
      } catch (_) {}
    });

    // Bottom bar input
    const $bottomText = S.shiftRoot.querySelector("#shiftBottomText");
    S.$bottomPlaceholder = S.shiftRoot.querySelector("#shiftBottomPlaceholder");

    $bottomText.addEventListener("input", () => {
      if ($bottomText.value.length > 0) {
        S.$bottomPlaceholder.style.display = "none";
        S.stopPlaceholderRotation();
      } else {
        S.$bottomPlaceholder.style.display = "";
        S.startPlaceholderRotation(S.$bottomPlaceholder, S.activeBottomPlaceholders || S.DEFAULT_BOTTOM_PLACEHOLDERS);
      }
    });
    $bottomText.addEventListener("blur", () => {
      if ($bottomText.value.length === 0) {
        S.$bottomPlaceholder.style.display = "";
      }
    });

    S.shiftRoot.querySelector("#shiftBottomSend").addEventListener("click", () => {
      const text = $bottomText.value.trim();
      if (!text || S.isStreaming) return;
      $bottomText.value = "";
      S.$bottomPlaceholder.style.display = "";
      S.stopPlaceholderRotation();
      S.startFlow(text);
    });
    $bottomText.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        S.shiftRoot.querySelector("#shiftBottomSend").click();
      }
    });

    // Bottom bar mic
    S.shiftRoot.querySelector("#shiftBottomMic").addEventListener("click", () => {
      S.activeVoiceInput = $bottomText;
      S.toggleMic();
    });

    // Restart → go back to feed
    S.shiftRoot.querySelector("#shiftRestart").addEventListener("click", S.resetAll);
    S.shiftRoot.querySelector("#shiftBack").addEventListener("click", S.goBack);

    // Inject inline input bar into the feed
    S.injectInlineInput();

    return true;
  };

  // ── Inline Input Bar (in-feed) ──────────────────
  function findCategorySection(feed) {
    const categoryNames = S.CATEGORIES.map((c) => c.label.toLowerCase());
    for (const child of feed.children) {
      const text = (child.textContent || "").toLowerCase();
      let matches = 0;
      for (const name of categoryNames) {
        if (text.includes(name)) matches++;
      }
      if (matches >= 3) return child;
    }
    return feed.children[2] || feed.lastElementChild;
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

  S.injectInlineInput = function () {
    if (S.inlineBar && document.body.contains(S.inlineBar)) return;
    if (!S.feedEl) return;

    const anchor = findCategorySection(S.feedEl);
    if (!anchor) return;

    S.inlineBar = createInlineInput();
    anchor.insertAdjacentElement("afterend", S.inlineBar);

    const inlineInput = S.inlineBar.querySelector("#shiftInlineText");
    const inlinePlaceholder = S.inlineBar.querySelector("#shiftInlinePlaceholder");

    let currentInlinePlaceholders = S.DEFAULT_PLACEHOLDER;
    S.typewriterPlaceholder(inlinePlaceholder, S.pickRandom(S.DEFAULT_PLACEHOLDER));
    S.startPlaceholderRotation(inlinePlaceholder, currentInlinePlaceholders);

    inlineInput.addEventListener("input", () => {
      if (inlineInput.value.length > 0) {
        inlinePlaceholder.style.display = "none";
        S.stopPlaceholderRotation();
      } else {
        inlinePlaceholder.style.display = "";
        S.startPlaceholderRotation(inlinePlaceholder, currentInlinePlaceholders);
      }
    });
    inlineInput.addEventListener("blur", () => {
      if (inlineInput.value.length === 0) {
        inlinePlaceholder.style.display = "";
      }
    });

    if (anchor) {
      anchor.addEventListener("click", (e) => {
        const link = e.target.closest("a, button");
        if (!link) return;
        const clickedText = (link.textContent || "").trim().toLowerCase();
        for (const [key, placeholders] of Object.entries(S.CATEGORY_PLACEHOLDERS)) {
          if (clickedText.includes(key) || key.includes(clickedText)) {
            currentInlinePlaceholders = placeholders;
            S.backspaceAndType(inlinePlaceholder, S.pickRandom(placeholders));
            S.stopPlaceholderRotation();
            S.startPlaceholderRotation(inlinePlaceholder, placeholders);
            return;
          }
        }
      });
    }

    S.inlineBar.querySelector("#shiftInlineSend").addEventListener("click", () => {
      const text = inlineInput.value.trim();
      if (!text || S.isStreaming) return;
      inlineInput.value = "";
      inlinePlaceholder.style.display = "";
      S.activate();
      S.startFlow(text);
    });

    inlineInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        S.inlineBar.querySelector("#shiftInlineSend").click();
      }
    });

    S.inlineBar.querySelector("#shiftInlineMic").addEventListener("click", () => {
      S.activeVoiceInput = inlineInput;
      S.toggleMic();
    });
  };

  S.activate = function () {
    if (!S.feedEl || !S.shiftRoot) return;
    S.feedEl.style.display = "none";
    S.shiftRoot.style.display = "";
    S.shiftActive = true;
    // Stop inline placeholder, start bottom bar placeholder
    S.stopPlaceholderRotation();
    if (S.$bottomPlaceholder) {
      var ph = S.activeBottomPlaceholders || S.DEFAULT_BOTTOM_PLACEHOLDERS;
      S.typewriterPlaceholder(S.$bottomPlaceholder, S.pickRandom(ph));
      S.startPlaceholderRotation(S.$bottomPlaceholder, ph);
    }
  };

  S.deactivate = function () {
    if (!S.feedEl || !S.shiftRoot) return;
    S.stopPlaceholderRotation();
    S.activeBottomPlaceholders = null;
    S.feedEl.style.display = "";
    S.shiftRoot.style.display = "none";
    S.shiftActive = false;
  };
})(window.Shift);
