// Shift 2026 — Shared state across content modules
(function () {
  "use strict";
  const S = (window.Shift = {});

  // DOM references
  S.feedEl = null;
  S.shiftRoot = null;
  S.$experience = null;
  S.$response = null;
  S.$stage = null;
  S.$loadingOverlay = null;
  S.$loadingFact = null;
  S.inlineBar = null;
  S.activeVoiceInput = null;

  // State flags
  S.shiftActive = false;
  S.isStreaming = false;
  S.isLoadingOverlayVisible = false;
  S.lastUserPrompt = "";

  // Timers
  S.typewriterTimer = null;
  S.rotationTimer = null;
  S.flowTimeout = null;
  S.loadingFactsTimer = null;
  S.lastFlowText = "";
  S.loadingFactQueue = [];
  S.loadingFactLast = "";

  // API cache
  S.storeFeeCache = new Map();

  // Pipeline cache (for menu resolution + follow-ups)
  S.menuCache = null;       // full fetched store data (with images, desc, uuid)
  S.searchContext = null;    // {query, compressed, shownDishes} for follow-ups
  S.restaurantList = null;   // last search results

  // History stack for back navigation
  S.historyStack = [];

  // Google Places cache
  S.googlePlacesById = new Map();
  S.googlePlacesByUuid = new Map();
  S.googlePlacesByName = new Map();
})();
