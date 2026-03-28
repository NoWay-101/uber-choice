// Shift 2026 - Content Script
// Guided food discovery — injected into Uber Eats DOM
(function () {
  "use strict";

  // ═══════════════════════════════════════════════════
  // SECTION 1: Uber Eats API
  // ═══════════════════════════════════════════════════

  const UE = { "Content-Type": "application/json", "x-csrf-token": "x" };
  const GOOGLE_SEARCH_RADIUS_METERS = 3500;
  const GOOGLE_SEARCH_LIMIT = 30;
  const REVIEWS_MODAL_INITIAL_BATCH_SIZE = 2;
  const REVIEWS_MODAL_BATCH_SIZE = 2;
  const NAME_STOP_WORDS = new Set([
    "restaurant",
    "resto",
    "le",
    "la",
    "les",
    "de",
    "du",
    "des",
    "and",
    "et",
    "the",
    "chez",
  ]);
  const googlePlacesByStoreUuid = new Map();
  const googlePlacesByStoreName = new Map();
  const googlePlacesByQuery = new Map();
  let pageLocationPromise = null;

  function normalizePlaceName(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function getMeaningfulTokens(value) {
    return normalizePlaceName(value)
      .split(" ")
      .filter(
        (token) => token && token.length > 1 && !NAME_STOP_WORDS.has(token)
      );
  }

  function computeTokenOverlapScore(leftValue, rightValue) {
    const leftTokens = getMeaningfulTokens(leftValue);
    const rightTokens = getMeaningfulTokens(rightValue);

    if (leftTokens.length === 0 || rightTokens.length === 0) {
      return 0;
    }

    const rightSet = new Set(rightTokens);
    const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
    return overlap / Math.max(leftTokens.length, rightTokens.length);
  }

  function extractStoreSlugLabel(actionUrl) {
    if (!actionUrl) {
      return "";
    }

    try {
      const url = new URL(actionUrl, window.location.origin);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "store" || !parts[1]) {
        return "";
      }

      return decodeURIComponent(parts[1]).replace(/-/g, " ");
    } catch (_) {
      return "";
    }
  }

  function getStoreNameCandidates(store) {
    const rawCandidates = [
      store?.title,
      store?.store_name,
      store?.name,
      extractStoreSlugLabel(store?.actionUrl || store?.store_action_url),
    ];
    const seen = new Set();
    const candidates = [];

    for (const value of rawCandidates) {
      const normalized = normalizePlaceName(value);
      if (!normalized || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      candidates.push(String(value).trim());
    }

    return candidates;
  }

  function getGooglePlaceTypes(place) {
    return Array.from(
      new Set(
        [place?.primaryType, ...(Array.isArray(place?.types) ? place.types : [])]
          .filter(Boolean)
          .map((value) => String(value))
      )
    );
  }

  function isFoodServicePlace(place) {
    return getGooglePlaceTypes(place).some(
      (type) =>
        type === "restaurant" ||
        type === "meal_takeaway" ||
        type === "meal_delivery" ||
        type === "cafe" ||
        type === "food" ||
        type.endsWith("_restaurant")
    );
  }

  function computePlaceMatchScore(store, googlePlace) {
    const placeNames = [googlePlace?.name, googlePlace?.displayName?.text].filter(Boolean);
    let bestScore = 0;

    for (const storeName of getStoreNameCandidates(store)) {
      for (const placeName of placeNames) {
        const normalizedStore = normalizePlaceName(storeName);
        const normalizedPlace = normalizePlaceName(placeName);

        if (!normalizedStore || !normalizedPlace) {
          continue;
        }

        let score = 0;
        if (normalizedStore === normalizedPlace) {
          score = 1;
        } else if (
          normalizedStore.includes(normalizedPlace) ||
          normalizedPlace.includes(normalizedStore)
        ) {
          score = 0.92;
        } else {
          score = computeTokenOverlapScore(normalizedStore, normalizedPlace);
        }

        if (isFoodServicePlace(googlePlace)) {
          score += 0.08;
        }

        if (score > bestScore) {
          bestScore = score;
        }
      }
    }

    return Math.min(bestScore, 1);
  }

  function getCachedGooglePlace(storeUuid, storeName) {
    if (storeUuid && googlePlacesByStoreUuid.has(storeUuid)) {
      return googlePlacesByStoreUuid.get(storeUuid);
    }

    const normalizedStoreName = normalizePlaceName(storeName);
    if (normalizedStoreName && googlePlacesByStoreName.has(normalizedStoreName)) {
      return googlePlacesByStoreName.get(normalizedStoreName);
    }

    return null;
  }

  function cacheGooglePlaceForStore(store, googlePlace) {
    if (!googlePlace) {
      return;
    }

    if (store?.uuid) {
      googlePlacesByStoreUuid.set(store.uuid, googlePlace);
    }

    if (store?.store_uuid) {
      googlePlacesByStoreUuid.set(store.store_uuid, googlePlace);
    }

    const storeName = normalizePlaceName(
      store?.title || store?.store_name || store?.name
    );
    if (storeName) {
      googlePlacesByStoreName.set(storeName, googlePlace);
    }

    const googleName = normalizePlaceName(googlePlace.name);
    if (googleName) {
      googlePlacesByStoreName.set(googleName, googlePlace);
    }
  }

  function enrichRestaurantWithGooglePlace(store, googlePlace) {
    if (!googlePlace) {
      return store;
    }

    cacheGooglePlaceForStore(store, googlePlace);

    return {
      ...store,
      googlePlace,
      googleRating: googlePlace.rating ?? googlePlace.note ?? null,
      googleUserRatingCount: googlePlace.userRatingCount ?? null,
      googleReviews: Array.isArray(googlePlace.reviews) ? googlePlace.reviews : [],
    };
  }

  function selectBestGooglePlace(store, googlePlaces) {
    let bestPlace = null;
    let bestScore = 0;

    for (const googlePlace of googlePlaces) {
      const score = computePlaceMatchScore(store, googlePlace);
      if (score > bestScore) {
        bestScore = score;
        bestPlace = googlePlace;
      }
    }

    return bestScore >= 0.42 ? bestPlace : null;
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response);
      });
    });
  }

  function isValidCoordinatePair(latitude, longitude) {
    return (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180
    );
  }

  function buildLocation(latitude, longitude, source) {
    if (!isValidCoordinatePair(latitude, longitude)) {
      return null;
    }

    return { latitude, longitude, source };
  }

  function parseLocationCandidate(candidate, source) {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }

    const latitude = Number(
      candidate.latitude ?? candidate.lat ?? candidate.centerLat ?? candidate.y
    );
    const longitude = Number(
      candidate.longitude ??
        candidate.lng ??
        candidate.lon ??
        candidate.centerLng ??
        candidate.x
    );

    return buildLocation(latitude, longitude, source);
  }

  function extractCoordinatesFromText(text, source) {
    if (!text) {
      return null;
    }

    const patterns = [
      /"latitude"\s*:\s*(-?\d+(?:\.\d+)?)[^]*?"longitude"\s*:\s*(-?\d+(?:\.\d+)?)/i,
      /"lat"\s*:\s*(-?\d+(?:\.\d+)?)[^]*?"lng"\s*:\s*(-?\d+(?:\.\d+)?)/i,
      /"lng"\s*:\s*(-?\d+(?:\.\d+)?)[^]*?"lat"\s*:\s*(-?\d+(?:\.\d+)?)/i,
      /latitude[=:"\s]+(-?\d+(?:\.\d+)?)[^]*?longitude[=:"\s]+(-?\d+(?:\.\d+)?)/i,
      /lat[=:"\s]+(-?\d+(?:\.\d+)?)[^]*?lng[=:"\s]+(-?\d+(?:\.\d+)?)/i,
    ];

    for (const [index, pattern] of patterns.entries()) {
      const match = text.match(pattern);
      if (!match) {
        continue;
      }

      const first = Number(match[1]);
      const second = Number(match[2]);
      const location =
        index === 2
          ? buildLocation(second, first, source)
          : buildLocation(first, second, source);

      if (location) {
        return location;
      }
    }

    return null;
  }

  function extractLocationFromSearchParams() {
    const url = new URL(window.location.href);
    const candidates = [
      [url.searchParams.get("lat"), url.searchParams.get("lng")],
      [url.searchParams.get("latitude"), url.searchParams.get("longitude")],
      [url.searchParams.get("centerLat"), url.searchParams.get("centerLng")],
    ];

    for (const [latitudeValue, longitudeValue] of candidates) {
      const location = buildLocation(
        Number(latitudeValue),
        Number(longitudeValue),
        "url"
      );
      if (location) {
        return location;
      }
    }

    return null;
  }

  function findLocationInObject(value, source, depth = 0) {
    if (!value || depth > 5) {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const nestedLocation = findLocationInObject(item, source, depth + 1);
        if (nestedLocation) {
          return nestedLocation;
        }
      }
      return null;
    }

    if (typeof value !== "object") {
      return null;
    }

    const directLocation = parseLocationCandidate(value, source);
    if (directLocation) {
      return directLocation;
    }

    for (const nestedValue of Object.values(value)) {
      const nestedLocation = findLocationInObject(
        nestedValue,
        source,
        depth + 1
      );
      if (nestedLocation) {
        return nestedLocation;
      }
    }

    return null;
  }

  function extractLocationFromStorage(storage, source) {
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        const value = storage.getItem(key);
        if (!value) {
          continue;
        }

        const rawLocation = extractCoordinatesFromText(value, source);
        if (rawLocation) {
          return rawLocation;
        }

        try {
          const parsed = JSON.parse(value);
          const parsedLocation = findLocationInObject(parsed, source);
          if (parsedLocation) {
            return parsedLocation;
          }
        } catch (_) {}
      }
    } catch (_) {}

    return null;
  }

  function extractLocationFromScripts() {
    const scripts = document.querySelectorAll("script");

    for (const script of scripts) {
      const text = script.textContent || "";
      const rawLocation = extractCoordinatesFromText(text, "script");
      if (rawLocation) {
        return rawLocation;
      }

      const type = script.getAttribute("type") || "";
      if (!type.includes("json")) {
        continue;
      }

      try {
        const parsed = JSON.parse(text);
        const parsedLocation = findLocationInObject(parsed, "script-json");
        if (parsedLocation) {
          return parsedLocation;
        }
      } catch (_) {}
    }

    return null;
  }

  function getCurrentPageLocation() {
    if (pageLocationPromise) {
      return pageLocationPromise;
    }

    pageLocationPromise = Promise.resolve(
      extractLocationFromSearchParams() ||
        extractLocationFromStorage(window.localStorage, "localStorage") ||
        extractLocationFromStorage(window.sessionStorage, "sessionStorage") ||
        extractLocationFromScripts()
    );

    return pageLocationPromise;
  }

  function buildLocationCacheKey(location) {
    if (!location) {
      return "none";
    }

    return [
      Number(location.latitude).toFixed(2),
      Number(location.longitude).toFixed(2),
    ].join(",");
  }

  function buildStoreQueryVariants(store) {
    const baseVariants = getStoreNameCandidates(store);
    const seen = new Set();
    const variants = [];

    for (const variant of baseVariants) {
      const trimmed = String(variant || "").trim();
      const normalized = normalizePlaceName(trimmed);
      if (!normalized || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      variants.push(trimmed);

      const restaurantVariant = `${trimmed} restaurant`;
      const normalizedRestaurantVariant = normalizePlaceName(restaurantVariant);
      if (!seen.has(normalizedRestaurantVariant)) {
        seen.add(normalizedRestaurantVariant);
        variants.push(restaurantVariant);
      }
    }

    return variants.slice(0, 4);
  }

  function mergeGooglePlaces(placeGroups) {
    const placesById = new Map();

    for (const placeGroup of placeGroups) {
      for (const place of placeGroup) {
        if (!place?.id || placesById.has(place.id)) {
          continue;
        }

        placesById.set(place.id, place);
      }
    }

    return Array.from(placesById.values());
  }

  async function searchGooglePlaceByText(query, location) {
    const cacheKey = `${normalizePlaceName(query)}|${buildLocationCacheKey(
      location
    )}`;

    if (googlePlacesByQuery.has(cacheKey)) {
      return googlePlacesByQuery.get(cacheKey);
    }

    const payload = await sendRuntimeMessage({
      type: "SEARCH_GOOGLE_PLACE_BY_TEXT",
      query,
      location,
      radius: GOOGLE_SEARCH_RADIUS_METERS,
      limit: 5,
      languageCode: "fr",
      regionCode: "FR",
    });

    const places = Array.isArray(payload?.places) ? payload.places : [];
    googlePlacesByQuery.set(cacheKey, places);
    return places;
  }

  async function findGooglePlaceCandidatesForStore(store, location) {
    const queryVariants = buildStoreQueryVariants(store);
    const placeGroups = [];

    for (const queryVariant of queryVariants) {
      const places = await searchGooglePlaceByText(queryVariant, location);
      if (places.length > 0) {
        placeGroups.push(places);
      }
    }

    if (placeGroups.length === 0 && location) {
      for (const queryVariant of queryVariants) {
        const places = await searchGooglePlaceByText(queryVariant, null);
        if (places.length > 0) {
          placeGroups.push(places);
        }
      }
    }

    return mergeGooglePlaces(placeGroups);
  }

  async function enrichRestaurantsWithGooglePlaces(restaurants) {
    if (!Array.isArray(restaurants) || restaurants.length === 0) {
      return restaurants;
    }

    const pageLocation = await getCurrentPageLocation();

    try {
      let nearbyPlaces = [];

      if (pageLocation) {
        const payload = await sendRuntimeMessage({
          type: "ENRICH_WITH_GOOGLE_PLACES",
          location: pageLocation,
          radius: GOOGLE_SEARCH_RADIUS_METERS,
          limit: GOOGLE_SEARCH_LIMIT,
          languageCode: "fr",
          regionCode: "FR",
        });
        nearbyPlaces = Array.isArray(payload?.places) ? payload.places : [];
      }

      return Promise.all(
        restaurants.map(async (store) => {
          let googlePlace = selectBestGooglePlace(store, nearbyPlaces);

          if (!googlePlace) {
            const textPlaces = await findGooglePlaceCandidatesForStore(
              store,
              pageLocation
            );
            googlePlace = selectBestGooglePlace(store, textPlaces);
          }

          return enrichRestaurantWithGooglePlace(store, googlePlace);
        })
      );
    } catch (error) {
      console.warn("[Shift] Google Places enrichment failed", error);
      return restaurants;
    }
  }

  function rememberGooglePlacesFromRestaurants(restaurants) {
    if (!Array.isArray(restaurants)) {
      return;
    }

    for (const restaurant of restaurants) {
      if (restaurant?.googlePlace) {
        cacheGooglePlaceForStore(restaurant, restaurant.googlePlace);
      }
    }
  }

  function rememberGooglePlacesFromToolPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return;
    }

    if (Array.isArray(payload)) {
      rememberGooglePlacesFromRestaurants(payload);
      return;
    }

    if (payload.googlePlace) {
      cacheGooglePlaceForStore(payload, payload.googlePlace);
    }

    if (Array.isArray(payload.restaurants)) {
      rememberGooglePlacesFromRestaurants(payload.restaurants);
    }
  }

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
      case "CONVERSATION_HISTORY": restoreConversation(msg.messages); break;
    }
    return true;
  });

  async function executeTool(callId, name, args) {
    try {
      let result;
      if (name === "search_restaurants") {
        const restaurants = await ueFeedSearch(args.query);
        result = await enrichRestaurantsWithGooglePlaces(restaurants);
        rememberGooglePlacesFromRestaurants(result);
      } else if (name === "get_restaurant_menu") {
        result = await ueGetStore(args.store_uuid);
        const googlePlace = getCachedGooglePlace(
          result?.uuid,
          result?.title || args.store_name
        );
        if (googlePlace) {
          result = { ...result, googlePlace };
          cacheGooglePlaceForStore(result, googlePlace);
        }
      } else {
        result = { error: `Unknown tool: ${name}` };
      }
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
  let $welcome, $experience, $response, $stage, $textInput, $fab, $reviewsModal;

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
        <div class="shift-response" id="shiftResponse"></div>
        <div class="shift-stage" id="shiftStage"></div>
        <div class="shift-bottom-bar" id="shiftBottomBar">
          <button class="shift-action-pill" id="shiftRestart">\u21BB</button>
          <div class="shift-bottom-input">
            <input type="text" id="shiftBottomText" placeholder="Affine, demande autre chose..." />
            <button class="shift-send-btn" id="shiftBottomSend">\u2192</button>
          </div>
        </div>
      </div>
      <div class="shift-reviews-modal" id="shiftReviewsModal" hidden>
        <div class="shift-reviews-backdrop" data-close-reviews="true"></div>
        <div class="shift-reviews-dialog" role="dialog" aria-modal="true" aria-labelledby="shiftReviewsTitle">
          <button type="button" class="shift-reviews-close" id="shiftReviewsClose" aria-label="Fermer les avis">×</button>
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

    wrapper.appendChild(shiftRoot);

    $welcome = shiftRoot.querySelector("#shiftWelcome");
    $experience = shiftRoot.querySelector("#shiftExperience");
    $response = shiftRoot.querySelector("#shiftResponse");
    $stage = shiftRoot.querySelector("#shiftStage");
    $textInput = shiftRoot.querySelector("#shiftTextInput");
    $reviewsModal = shiftRoot.querySelector("#shiftReviewsModal");

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
      const reviewsButton = e.target.closest(".shift-card-google-reviews-button");
      if (reviewsButton) {
        e.preventDefault();
        e.stopPropagation();
        openReviewsModal(reviewsButton);
        return;
      }

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
    shiftRoot.querySelector("#shiftReviewsClose").addEventListener("click", closeReviewsModal);
    shiftRoot.querySelector("#shiftReviewsMore").addEventListener("click", showMoreReviews);
    $reviewsModal.addEventListener("click", (e) => {
      if (e.target.closest("[data-close-reviews='true']")) {
        closeReviewsModal();
      }
    });
    document.addEventListener("keydown", handleReviewsModalKeydown);

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
    const $actions = shiftRoot.querySelector("#shiftActions") || shiftRoot.querySelector("#shiftBottomBar");
    if ($actions) $actions.style.display = "";
    isStreaming = true;
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
    closeReviewsModal();
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
          ${dish.store_eta ? `<span>${esc(dish.store_eta)}</span>` : ""}
        </div>
      </div>`;
    return card;
  }

  // ── Render: Dish Cards ──────────────────────────────
  function renderDishCards(dishes) {
    if (!dishes?.length || !$stage) return;
    $stage.innerHTML = "";
    if ($response) { $response.textContent = ""; $response.classList.remove("streaming"); }

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
      const googlePlace =
        getCachedGooglePlace(group.key, group.store_name) ||
        group.dishes.find((dish) => dish.googlePlace)?.googlePlace ||
        null;

      appendMetaPart(meta, `${group.dishes.length} produit${group.dishes.length > 1 ? "s" : ""}`);

      if (group.store_rating) appendMetaPart(meta, `★ ${group.store_rating}`);
      if (group.store_eta) appendMetaPart(meta, group.store_eta);

      if (googlePlace?.rating != null || googlePlace?.note != null) {
        appendMetaPart(
          meta,
          `Google ${googlePlace.rating ?? googlePlace.note}/5`,
          "shift-restaurant-row-google-rating"
        );
      }

      if (Array.isArray(googlePlace?.reviews) && googlePlace.reviews.length > 0) {
        meta.appendChild(buildGoogleReviewsButton(googlePlace));
      }

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
    dishes.forEach((d, i) => grid.appendChild(buildCard(d, i)));
    $stage.appendChild(grid);
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
      if (m.role === "tool" && m.content) {
        try {
          rememberGooglePlacesFromToolPayload(JSON.parse(m.content));
        } catch (_) {}
      }
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
  function openReviewsModal(button) {
    if (!$reviewsModal) {
      return;
    }

    const rawGooglePlace = button?.dataset?.googlePlace;
    if (!rawGooglePlace) {
      return;
    }

    let googlePlace;
    try {
      googlePlace = JSON.parse(decodeURIComponent(rawGooglePlace));
    } catch (_) {
      return;
    }

    const titleEl = $reviewsModal.querySelector("#shiftReviewsTitle");
    const summaryEl = $reviewsModal.querySelector("#shiftReviewsSummary");
    const reviews = Array.isArray(googlePlace?.reviews) ? googlePlace.reviews : [];

    titleEl.textContent = googlePlace?.name || "Restaurant";
    summaryEl.textContent = [
      googlePlace?.rating != null ? `Google ${googlePlace.rating}/5` : null,
      googlePlace?.userRatingCount != null
        ? `${Number(googlePlace.userRatingCount).toLocaleString("fr-FR")} avis`
        : null,
    ]
      .filter(Boolean)
      .join(" • ");

    $reviewsModal._reviews = reviews;
    $reviewsModal._visibleReviewCount = Math.min(
      REVIEWS_MODAL_INITIAL_BATCH_SIZE,
      reviews.length
    );
    renderReviewsModalList();

    $reviewsModal.hidden = false;
    requestAnimationFrame(() => $reviewsModal.classList.add("is-open"));
  }

  function closeReviewsModal() {
    if (!$reviewsModal) {
      return;
    }

    $reviewsModal.classList.remove("is-open");
    $reviewsModal.hidden = true;
    $reviewsModal._reviews = [];
    $reviewsModal._visibleReviewCount = 0;
  }

  function handleReviewsModalKeydown(e) {
    if (e.key === "Escape" && $reviewsModal && !$reviewsModal.hidden) {
      closeReviewsModal();
    }
  }

  function renderGoogleReviewItem(review, index) {
    const authorName = review?.author?.name || "Avis Google";
    const metadata = [
      review?.rating != null ? `★ ${review.rating}` : null,
      review?.relativePublishTimeDescription || null,
    ]
      .filter(Boolean)
      .join(" • ");
    const reviewText =
      review?.text || review?.originalText || "Avis indisponible";

    return `
      <article class="shift-reviews-item" data-review-index="${index}">
        <div class="shift-reviews-item-meta">
          ${esc(authorName)}
          ${metadata ? ` • ${esc(metadata)}` : ""}
        </div>
        <div class="shift-reviews-item-text">${esc(reviewText)}</div>
      </article>
    `;
  }

  function renderReviewsModalList() {
    if (!$reviewsModal) {
      return;
    }

    const listEl = $reviewsModal.querySelector("#shiftReviewsList");
    const actionsEl = $reviewsModal.querySelector("#shiftReviewsActions");
    const moreButton = $reviewsModal.querySelector("#shiftReviewsMore");
    const reviews = Array.isArray($reviewsModal._reviews)
      ? $reviewsModal._reviews
      : [];
    const visibleCount = Number($reviewsModal._visibleReviewCount) || 0;
    const visibleReviews = reviews.slice(0, visibleCount);

    listEl.innerHTML =
      visibleReviews.length > 0
        ? visibleReviews
            .map((review, index) => renderGoogleReviewItem(review, index))
            .join("")
        : '<div class="shift-reviews-empty">Aucun avis detaille disponible.</div>';

    const hasMore = visibleCount < reviews.length;
    actionsEl.hidden = !hasMore;
    moreButton.hidden = !hasMore;

    if (hasMore) {
      moreButton.textContent = `Voir plus d'avis (${reviews.length - visibleCount})`;
    }
  }

  function showMoreReviews() {
    if (!$reviewsModal) {
      return;
    }

    const reviews = Array.isArray($reviewsModal._reviews)
      ? $reviewsModal._reviews
      : [];

    if (reviews.length === 0) {
      return;
    }

    const previousVisibleCount =
      Number($reviewsModal._visibleReviewCount) || 0;

    $reviewsModal._visibleReviewCount = Math.min(
      reviews.length,
      previousVisibleCount + REVIEWS_MODAL_BATCH_SIZE
    );
    renderReviewsModalList();

    requestAnimationFrame(() => {
      const listEl = $reviewsModal.querySelector("#shiftReviewsList");
      const nextReview = listEl?.querySelector(
        `[data-review-index="${previousVisibleCount}"]`
      );

      if (nextReview) {
        nextReview.scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (listEl) {
        listEl.scrollTo({ top: listEl.scrollHeight, behavior: "smooth" });
      }
    });
  }

  function appendMetaPart(container, text, className = "") {
    const item = document.createElement("span");
    item.textContent = text;
    if (className) {
      item.className = className;
    }
    container.appendChild(item);
  }

  function buildGoogleReviewsButton(googlePlace) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "shift-card-google-reviews-button";
    button.dataset.googlePlace = encodeURIComponent(JSON.stringify(googlePlace));
    button.textContent =
      googlePlace?.userRatingCount != null
        ? `Lire les avis (${Number(googlePlace.userRatingCount).toLocaleString("fr-FR")})`
        : "Lire les avis";
    return button;
  }

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
