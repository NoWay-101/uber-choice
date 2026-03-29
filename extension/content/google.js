// Shift 2026 — Google Places matching, enrichment, cache + reviews modal UI
(function (S) {
  "use strict";

  const NAME_STOP_WORDS = new Set([
    "restaurant", "resto", "le", "la", "les", "de", "du", "des",
    "and", "et", "the", "chez",
  ]);
  const REVIEWS_INITIAL_BATCH = 2;
  const REVIEWS_BATCH_SIZE = 2;

  // ── Name Matching ───────────────────────────────
  function normalizePlaceName(value) {
    return String(value || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  }

  function getMeaningfulTokens(value) {
    return normalizePlaceName(value).split(" ")
      .filter((t) => t && t.length > 1 && !NAME_STOP_WORDS.has(t));
  }

  function tokenOverlapScore(a, b) {
    const ta = getMeaningfulTokens(a);
    const tb = getMeaningfulTokens(b);
    if (!ta.length || !tb.length) return 0;
    const setB = new Set(tb);
    const overlap = ta.filter((t) => setB.has(t)).length;
    return overlap / Math.max(ta.length, tb.length);
  }

  function extractSlugLabel(actionUrl) {
    if (!actionUrl) return "";
    try {
      const parts = new URL(actionUrl, window.location.origin).pathname.split("/").filter(Boolean);
      return parts[0] === "store" && parts[1] ? decodeURIComponent(parts[1]).replace(/-/g, " ") : "";
    } catch (_) { return ""; }
  }

  function getStoreCandidates(store) {
    const raw = [store?.title, store?.store_name, store?.name, extractSlugLabel(store?.actionUrl || store?.store_action_url)];
    const seen = new Set();
    return raw.filter((v) => { const n = normalizePlaceName(v); if (!n || seen.has(n)) return false; seen.add(n); return true; }).map((v) => String(v).trim());
  }

  function isFoodPlace(place) {
    const types = [place?.primaryType, ...(Array.isArray(place?.types) ? place.types : [])].filter(Boolean);
    return types.some((t) => t === "restaurant" || t === "meal_takeaway" || t === "meal_delivery" || t === "cafe" || t === "food" || t.endsWith("_restaurant"));
  }

  function placeMatchScore(store, place) {
    const placeNames = [place?.name, place?.displayName?.text].filter(Boolean);
    let best = 0;
    for (const sn of getStoreCandidates(store)) {
      for (const pn of placeNames) {
        const ns = normalizePlaceName(sn), np = normalizePlaceName(pn);
        if (!ns || !np) continue;
        let score = 0;
        if (ns === np) score = 1;
        else if (ns.includes(np) || np.includes(ns)) score = 0.92;
        else score = tokenOverlapScore(ns, np);
        if (isFoodPlace(place)) score += 0.08;
        if (score > best) best = score;
      }
    }
    return Math.min(best, 1);
  }

  function selectBestPlace(store, places) {
    let bestPlace = null, bestScore = 0;
    for (const p of places) {
      const s = placeMatchScore(store, p);
      if (s > bestScore) { bestScore = s; bestPlace = p; }
    }
    return bestScore >= 0.42 ? bestPlace : null;
  }

  // ── Cache ───────────────────────────────────────
  S.getCachedGooglePlace = function (uuid, name) {
    if (uuid && S.googlePlacesByUuid.has(uuid)) return S.googlePlacesByUuid.get(uuid);
    const n = normalizePlaceName(name);
    if (n && S.googlePlacesByName.has(n)) return S.googlePlacesByName.get(n);
    return null;
  };

  function cachePlace(store, place) {
    if (!place) return;
    const uuid = store?.uuid || store?.store_uuid;
    if (uuid) S.googlePlacesByUuid.set(uuid, place);
    const name = normalizePlaceName(store?.title || store?.store_name || store?.name);
    if (name) S.googlePlacesByName.set(name, place);
    const gName = normalizePlaceName(place.name);
    if (gName) S.googlePlacesByName.set(gName, place);
  }

  // ── Location ────────────────────────────────────
  function getPageLocation() {
    // Extract lat/lng from Uber Eats pl= param (base64 JSON)
    try {
      const url = new URL(window.location.href);
      const pl = url.searchParams.get("pl");
      if (pl) {
        const json = JSON.parse(atob(pl));
        if (json.latitude && json.longitude) return { latitude: json.latitude, longitude: json.longitude };
      }
    } catch (_) {}

    // Fallback: try meta tags or script data
    try {
      const scripts = document.querySelectorAll("script");
      for (const s of scripts) {
        const m = s.textContent?.match(/"latitude"\s*:\s*(-?\d+\.?\d*)[^]*?"longitude"\s*:\s*(-?\d+\.?\d*)/);
        if (m) return { latitude: parseFloat(m[1]), longitude: parseFloat(m[2]) };
      }
    } catch (_) {}

    return null;
  }

  // ── Enrichment ──────────────────────────────────
  S.enrichRestaurantsWithGooglePlaces = async function (restaurants) {
    if (!restaurants?.length) return restaurants;

    const location = getPageLocation();
    if (!location) {
      console.log("[Shift Google] No location found, skipping enrichment");
      return restaurants;
    }

    try {
      // Collect store names for text search fallback
      const storeNames = restaurants
        .filter((r) => !S.getCachedGooglePlace(r.uuid, r.title))
        .map((r) => r.title)
        .slice(0, 10);

      // Ask background to call Google Places API
      const response = await new Promise((resolve) => {
        const handler = (msg) => {
          if (msg.type === "GOOGLE_ENRICH_RESULT") {
            chrome.runtime.onMessage.removeListener(handler);
            resolve(msg);
          }
        };
        chrome.runtime.onMessage.addListener(handler);
        chrome.runtime.sendMessage({
          type: "GOOGLE_ENRICH",
          location,
          radius: 3500,
          limit: 30,
          storeNames,
          languageCode: "fr",
          regionCode: "FR",
        });
        // Timeout after 5s — don't block the pipeline
        setTimeout(() => {
          chrome.runtime.onMessage.removeListener(handler);
          resolve({ places: [] });
        }, 5000);
      });

      if (response.disabled) return restaurants;

      const nearbyPlaces = response.places || [];
      const textResults = response.textSearchResults || {};

      return restaurants.map((store) => {
        // Check cache first
        let gPlace = S.getCachedGooglePlace(store.uuid, store.title);
        if (gPlace) return enrichStore(store, gPlace);

        // Match from nearby results
        gPlace = selectBestPlace(store, nearbyPlaces);

        // Fallback: text search results
        if (!gPlace && textResults[store.title]) {
          gPlace = selectBestPlace(store, textResults[store.title]);
        }

        if (gPlace) cachePlace(store, gPlace);
        return enrichStore(store, gPlace);
      });
    } catch (e) {
      console.warn("[Shift Google] Enrichment failed:", e);
      return restaurants;
    }
  };

  function enrichStore(store, gPlace) {
    if (!gPlace) return store;
    cachePlace(store, gPlace);
    return {
      ...store,
      googlePlace: gPlace,
      googleRating: gPlace.rating ?? null,
      googleUserRatingCount: gPlace.userRatingCount ?? null,
      googleReviews: Array.isArray(gPlace.reviews) ? gPlace.reviews : [],
    };
  }

  // ── Reviews Button Builder ──────────────────────
  S.buildGoogleReviewsButton = function (googlePlace) {
    if (!googlePlace) return null;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "shift-card-google-reviews-button";
    btn.dataset.googlePlace = encodeURIComponent(JSON.stringify(googlePlace));
    btn.textContent = googlePlace.userRatingCount != null
      ? `Lire les avis (${Number(googlePlace.userRatingCount).toLocaleString("fr-FR")})`
      : "Lire les avis";
    return btn;
  };

  // ── Reviews Modal ───────────────────────────────
  S.openReviewsModal = function (button) {
    const modal = S.shiftRoot?.querySelector("#shiftReviewsModal");
    if (!modal || !button?.dataset?.googlePlace) return;

    let gPlace;
    try { gPlace = JSON.parse(decodeURIComponent(button.dataset.googlePlace)); } catch (_) { return; }

    const reviews = Array.isArray(gPlace?.reviews) ? gPlace.reviews : [];
    modal.querySelector("#shiftReviewsTitle").textContent = gPlace?.name || "Restaurant";
    modal.querySelector("#shiftReviewsSummary").textContent = [
      gPlace?.rating != null ? `Google ${gPlace.rating}/5` : null,
      gPlace?.userRatingCount != null ? `${Number(gPlace.userRatingCount).toLocaleString("fr-FR")} avis` : null,
    ].filter(Boolean).join(" \u2022 ");

    modal._reviews = reviews;
    modal._visibleCount = Math.min(REVIEWS_INITIAL_BATCH, reviews.length);
    renderReviewsList(modal);

    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add("is-open"));
  };

  S.closeReviewsModal = function () {
    const modal = S.shiftRoot?.querySelector("#shiftReviewsModal");
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.hidden = true;
    modal._reviews = [];
    modal._visibleCount = 0;
  };

  S.showMoreReviews = function () {
    const modal = S.shiftRoot?.querySelector("#shiftReviewsModal");
    if (!modal || !modal._reviews?.length) return;
    const prev = modal._visibleCount || 0;
    modal._visibleCount = Math.min(modal._reviews.length, prev + REVIEWS_BATCH_SIZE);
    renderReviewsList(modal);
    requestAnimationFrame(() => {
      const list = modal.querySelector("#shiftReviewsList");
      const next = list?.querySelector(`[data-review-index="${prev}"]`);
      if (next) next.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  function renderReviewsList(modal) {
    const listEl = modal.querySelector("#shiftReviewsList");
    const actionsEl = modal.querySelector("#shiftReviewsActions");
    const moreBtn = modal.querySelector("#shiftReviewsMore");
    const reviews = modal._reviews || [];
    const visible = reviews.slice(0, modal._visibleCount || 0);

    listEl.innerHTML = visible.length > 0
      ? visible.map((r, i) => renderReviewItem(r, i)).join("")
      : '<div class="shift-reviews-empty">Aucun avis d\u00e9taill\u00e9 disponible.</div>';

    const hasMore = (modal._visibleCount || 0) < reviews.length;
    actionsEl.hidden = !hasMore;
    moreBtn.hidden = !hasMore;
    if (hasMore) moreBtn.textContent = `Voir plus d'avis (${reviews.length - modal._visibleCount})`;
  }

  function renderReviewItem(review, index) {
    const author = review?.author?.name || "Avis Google";
    const meta = [
      review?.rating != null ? `\u2605 ${review.rating}` : null,
      review?.relativePublishTimeDescription || null,
    ].filter(Boolean).join(" \u2022 ");
    const text = review?.text || review?.originalText || "Avis indisponible";
    return `
      <article class="shift-reviews-item" data-review-index="${index}">
        <div class="shift-reviews-item-meta">${S.esc(author)}${meta ? ` \u2022 ${S.esc(meta)}` : ""}</div>
        <div class="shift-reviews-item-text">${S.esc(text)}</div>
      </article>`;
  }
})(window.Shift);
