// Shift 2026 — Google Places matching, enrichment, cache + reviews modal UI
(function (S) {
  "use strict";

  const NAME_STOP_WORDS = new Set([
    "restaurant", "resto", "le", "la", "les", "de", "du", "des",
    "and", "et", "the", "chez",
  ]);
  const REVIEWS_INITIAL_BATCH = 2;
  const REVIEWS_BATCH_SIZE = 2;
  let cachedPageLocationHref = "";
  let cachedPageLocation = undefined;

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
  S.getCachedGooglePlace = function (uuid, name, placeId) {
    if (placeId && S.googlePlacesById.has(placeId)) return S.googlePlacesById.get(placeId);
    if (uuid && S.googlePlacesByUuid.has(uuid)) return S.googlePlacesByUuid.get(uuid);
    const n = normalizePlaceName(name);
    if (n && S.googlePlacesByName.has(n)) return S.googlePlacesByName.get(n);
    return null;
  };

  function cachePlace(store, place) {
    if (!place) return;
    if (place.id) S.googlePlacesById.set(place.id, place);
    const uuid = store?.uuid || store?.store_uuid;
    if (uuid) S.googlePlacesByUuid.set(uuid, place);
    const name = normalizePlaceName(store?.title || store?.store_name || store?.name);
    if (name) S.googlePlacesByName.set(name, place);
    const gName = normalizePlaceName(place.name);
    if (gName) S.googlePlacesByName.set(gName, place);
  }

  function mergeGooglePlace(basePlace, nextPlace) {
    if (!basePlace) return nextPlace || null;
    if (!nextPlace) return basePlace;
    return {
      ...basePlace,
      ...nextPlace,
      reviews: Array.isArray(nextPlace.reviews) && nextPlace.reviews.length
        ? nextPlace.reviews
        : Array.isArray(basePlace.reviews) ? basePlace.reviews : [],
    };
  }

  // ── Location ────────────────────────────────────
  function isValidCoordinatePair(latitude, longitude) {
    return Number.isFinite(latitude)
      && Number.isFinite(longitude)
      && Math.abs(latitude) <= 90
      && Math.abs(longitude) <= 180;
  }

  function buildLocation(latitude, longitude, source) {
    if (!isValidCoordinatePair(latitude, longitude)) return null;
    return { latitude, longitude, source };
  }

  function parseLocationCandidate(candidate, source) {
    if (!candidate || typeof candidate !== "object") return null;
    const latitude = Number(
      candidate.latitude ?? candidate.lat ?? candidate.centerLat ?? candidate.y
    );
    const longitude = Number(
      candidate.longitude ?? candidate.lng ?? candidate.lon ?? candidate.centerLng ?? candidate.x
    );
    return buildLocation(latitude, longitude, source);
  }

  function extractCoordinatesFromText(text, source) {
    if (!text) return null;
    const patterns = [
      /"latitude"\s*:\s*(-?\d+(?:\.\d+)?)[^]*?"longitude"\s*:\s*(-?\d+(?:\.\d+)?)/i,
      /"lat"\s*:\s*(-?\d+(?:\.\d+)?)[^]*?"lng"\s*:\s*(-?\d+(?:\.\d+)?)/i,
      /"lng"\s*:\s*(-?\d+(?:\.\d+)?)[^]*?"lat"\s*:\s*(-?\d+(?:\.\d+)?)/i,
      /latitude[=:"\s]+(-?\d+(?:\.\d+)?)[^]*?longitude[=:"\s]+(-?\d+(?:\.\d+)?)/i,
      /lat[=:"\s]+(-?\d+(?:\.\d+)?)[^]*?lng[=:"\s]+(-?\d+(?:\.\d+)?)/i,
    ];
    for (const [index, pattern] of patterns.entries()) {
      const match = text.match(pattern);
      if (!match) continue;
      const first = Number(match[1]);
      const second = Number(match[2]);
      const location = index === 2
        ? buildLocation(second, first, source)
        : buildLocation(first, second, source);
      if (location) return location;
    }
    return null;
  }

  function extractLocationFromSearchParams() {
    try {
      const url = new URL(window.location.href);
      const pl = url.searchParams.get("pl");
      if (pl) {
        try {
          // pl= can be URL-encoded before base64
          const decoded = decodeURIComponent(pl);
          const parsed = parseLocationCandidate(JSON.parse(atob(decoded)), "url-pl");
          if (parsed) return parsed;
        } catch (_) {}
        try {
          // Or just plain base64
          const parsed = parseLocationCandidate(JSON.parse(atob(pl)), "url-pl");
          if (parsed) return parsed;
        } catch (_) {}
      }

      const candidates = [
        [url.searchParams.get("lat"), url.searchParams.get("lng")],
        [url.searchParams.get("latitude"), url.searchParams.get("longitude")],
        [url.searchParams.get("centerLat"), url.searchParams.get("centerLng")],
      ];
      for (const [latitudeValue, longitudeValue] of candidates) {
        const location = buildLocation(Number(latitudeValue), Number(longitudeValue), "url");
        if (location) return location;
      }
    } catch (_) {}
    return null;
  }

  function findLocationInObject(value, source, depth) {
    if (!value || depth > 5) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const nestedLocation = findLocationInObject(item, source, depth + 1);
        if (nestedLocation) return nestedLocation;
      }
      return null;
    }
    if (typeof value !== "object") return null;

    const directLocation = parseLocationCandidate(value, source);
    if (directLocation) return directLocation;

    for (const nestedValue of Object.values(value)) {
      const nestedLocation = findLocationInObject(nestedValue, source, depth + 1);
      if (nestedLocation) return nestedLocation;
    }
    return null;
  }

  function extractLocationFromStorage(storage, source) {
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        const value = storage.getItem(key);
        if (!value) continue;

        const rawLocation = extractCoordinatesFromText(value, source);
        if (rawLocation) return rawLocation;

        try {
          const parsed = JSON.parse(value);
          const parsedLocation = findLocationInObject(parsed, source, 0);
          if (parsedLocation) return parsedLocation;
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  function extractLocationFromScripts() {
    try {
      const scripts = document.querySelectorAll("script");
      for (const script of scripts) {
        const text = script.textContent || "";
        const rawLocation = extractCoordinatesFromText(text, "script");
        if (rawLocation) return rawLocation;

        const type = script.getAttribute("type") || "";
        if (!type.includes("json")) continue;

        try {
          const parsed = JSON.parse(text);
          const parsedLocation = findLocationInObject(parsed, "script-json", 0);
          if (parsedLocation) return parsedLocation;
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  function extractLocationFromCookies() {
    try {
      const match = document.cookie.match(/uev2\.loc=([^;]*)/);
      if (!match) return null;
      const json = JSON.parse(decodeURIComponent(match[1]));
      // uev2.loc has latitude/longitude at root level
      const loc = parseLocationCandidate(json, "cookie-uev2.loc");
      if (loc) return loc;
      // Also check nested address
      if (json.address) {
        const addrLoc = parseLocationCandidate(json.address, "cookie-uev2.loc.address");
        if (addrLoc) return addrLoc;
      }
    } catch (_) {}
    return null;
  }

  function getPageLocation() {
    if (cachedPageLocationHref !== window.location.href) {
      cachedPageLocationHref = window.location.href;
      cachedPageLocation = undefined;
    }
    if (cachedPageLocation !== undefined) return cachedPageLocation;
    cachedPageLocation = extractLocationFromSearchParams()
      || extractLocationFromCookies()
      || extractLocationFromStorage(window.localStorage, "localStorage")
      || extractLocationFromStorage(window.sessionStorage, "sessionStorage")
      || extractLocationFromScripts()
      || null;
    if (cachedPageLocation) {
      console.log("[Shift Google] Location found via", cachedPageLocation.source, ":", cachedPageLocation.latitude, cachedPageLocation.longitude);
    } else {
      console.warn("[Shift Google] No location found anywhere");
    }
    return cachedPageLocation;
  }

  // ── Enrichment ──────────────────────────────────
  // No persistent disable — always try (background will return disabled:true if no key)

  S.enrichRestaurantsWithGooglePlaces = async function (restaurants) {
    if (!restaurants?.length) return restaurants;

    const location = getPageLocation();
    if (!location) {
      console.log("[Shift Google] No location, skipping");
      return restaurants;
    }

    try {
      console.log("[Shift Google] Enriching", restaurants.length, "restaurants at", location.latitude, location.longitude);
      const storeNames = restaurants
        .filter((r) => !S.getCachedGooglePlace(r.uuid, r.title))
        .map((r) => r.title)
        .slice(0, 10);

      const response = await new Promise((resolve) => {
        let resolved = false;
        const handler = (msg) => {
          if (msg.type === "GOOGLE_ENRICH_RESULT" && !resolved) {
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            console.log("[Shift Google] Got response:", msg.disabled ? "disabled" : (msg.places?.length || 0) + " places");
            resolve(msg);
          }
        };
        chrome.runtime.onMessage.addListener(handler);
        chrome.runtime.sendMessage({
          type: "GOOGLE_ENRICH",
          location: location || null,
          radius: 3500,
          limit: 30,
          storeNames,
          languageCode: "fr",
          regionCode: "FR",
        });
        // Timeout after 10s — Google API can be slow with text searches
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            console.warn("[Shift Google] Timeout after 10s");
            resolve({ places: [] });
          }
        }, 10000);
      });

      if (response.disabled) {
        console.log("[Shift Google] Disabled (no API key in background)");
        return restaurants;
      }

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

  S.fetchGooglePlaceDetails = async function (googlePlace) {
    if (!googlePlace?.resourceName && !googlePlace?.id) return googlePlace;

    const cached = S.getCachedGooglePlace(null, googlePlace.name, googlePlace.id);
    if (cached?.reviews?.length) return mergeGooglePlace(googlePlace, cached);

    const requestId = `gpd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const response = await new Promise((resolve) => {
      const handler = (msg) => {
        if (msg.type === "GOOGLE_PLACE_DETAILS_RESULT" && msg.requestId === requestId) {
          chrome.runtime.onMessage.removeListener(handler);
          resolve(msg);
        }
      };
      chrome.runtime.onMessage.addListener(handler);
      chrome.runtime.sendMessage({
        type: "GOOGLE_PLACE_DETAILS",
        requestId,
        placeId: googlePlace.id || null,
        resourceName: googlePlace.resourceName || null,
        languageCode: "fr",
        regionCode: "FR",
      });
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(handler);
        resolve({ place: null });
      }, 5000);
    });

    const merged = mergeGooglePlace(googlePlace, response.place);
    cachePlace(null, merged);
    return merged;
  };

  // ── Reviews Modal ───────────────────────────────
  S.openReviewsModal = async function (button) {
    const modal = S.shiftRoot?.querySelector("#shiftReviewsModal");
    if (!modal || !button?.dataset?.googlePlace) return;

    let gPlace;
    try { gPlace = JSON.parse(decodeURIComponent(button.dataset.googlePlace)); } catch (_) { return; }

    const cachedPlace = S.getCachedGooglePlace(null, gPlace.name, gPlace.id);
    if (cachedPlace) gPlace = mergeGooglePlace(gPlace, cachedPlace);

    modal.querySelector("#shiftReviewsTitle").textContent = gPlace?.name || "Restaurant";
    modal.querySelector("#shiftReviewsSummary").textContent = [
      gPlace?.rating != null ? `Google ${gPlace.rating}/5` : null,
      gPlace?.userRatingCount != null ? `${Number(gPlace.userRatingCount).toLocaleString("fr-FR")} avis` : null,
    ].filter(Boolean).join(" \u2022 ");

    const initialReviews = Array.isArray(gPlace?.reviews) ? gPlace.reviews : [];
    modal._reviews = initialReviews;
    modal._visibleCount = Math.min(REVIEWS_INITIAL_BATCH, initialReviews.length);
    if (initialReviews.length) {
      renderReviewsList(modal);
    } else {
      modal.querySelector("#shiftReviewsList").innerHTML = '<div class="shift-reviews-empty">Chargement des avis Google...</div>';
      modal.querySelector("#shiftReviewsActions").hidden = true;
    }

    const requestToken = `reviews_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    modal._requestToken = requestToken;
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add("is-open"));

    if (initialReviews.length || (!gPlace?.resourceName && !gPlace?.id)) return;

    const detailedPlace = await S.fetchGooglePlaceDetails(gPlace);
    if (modal._requestToken !== requestToken) return;

    const reviews = Array.isArray(detailedPlace?.reviews) ? detailedPlace.reviews : [];
    modal.querySelector("#shiftReviewsTitle").textContent = detailedPlace?.name || gPlace?.name || "Restaurant";
    modal.querySelector("#shiftReviewsSummary").textContent = [
      detailedPlace?.rating != null ? `Google ${detailedPlace.rating}/5` : null,
      detailedPlace?.userRatingCount != null ? `${Number(detailedPlace.userRatingCount).toLocaleString("fr-FR")} avis` : null,
    ].filter(Boolean).join(" \u2022 ");
    modal._reviews = reviews;
    modal._visibleCount = Math.min(REVIEWS_INITIAL_BATCH, reviews.length);
    renderReviewsList(modal);
  };

  S.closeReviewsModal = function () {
    const modal = S.shiftRoot?.querySelector("#shiftReviewsModal");
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.hidden = true;
    modal._requestToken = null;
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
