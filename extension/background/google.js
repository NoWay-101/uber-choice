// Shift 2026 — Google Places API (runs in service worker)

const GOOGLE_MAPS_API_KEY = (typeof CONFIG !== "undefined" && CONFIG.GOOGLE_MAPS_API_KEY) || "";
const GOOGLE_MAPS_API_URL = "https://places.googleapis.com/v1/places:searchNearby";
const GOOGLE_TEXT_SEARCH_API_URL = "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_PLACE_DETAILS_API_URL = "https://places.googleapis.com/v1/";
const GOOGLE_MAX_REVIEWS = 5;
const GOOGLE_NEARBY_TYPE_GROUPS = [
  ["restaurant"],
  ["meal_takeaway", "meal_delivery", "cafe"],
];
const GOOGLE_FIELD_MASK = [
  "places.id", "places.name", "places.displayName", "places.formattedAddress",
  "places.location", "places.rating", "places.userRatingCount", "places.reviews",
  "places.primaryType", "places.primaryTypeDisplayName", "places.types",
  "places.priceLevel", "places.googleMapsUri", "places.websiteUri", "places.businessStatus",
].join(",");
const GOOGLE_PLACE_DETAILS_FIELD_MASK = [
  "id", "name", "displayName", "formattedAddress",
  "location", "rating", "userRatingCount", "reviews",
  "primaryType", "primaryTypeDisplayName", "types",
  "priceLevel", "googleMapsUri", "websiteUri", "businessStatus",
].join(",");

function mapGoogleReview(review) {
  return {
    id: review.name || null,
    rating: review.rating ?? null,
    relativePublishTimeDescription: review.relativePublishTimeDescription || null,
    publishTime: review.publishTime || null,
    text: review.text?.text || review.originalText?.text || null,
    originalText: review.originalText?.text || null,
    googleMapsUri: review.googleMapsUri || null,
    author: review.authorAttribution ? {
      name: review.authorAttribution.displayName || null,
      profileUri: review.authorAttribution.uri || null,
      photoUri: review.authorAttribution.photoUri || null,
    } : null,
  };
}

function mapGooglePlace(place) {
  return {
    id: place.id || null,
    resourceName: place.name || null,
    name: place.displayName?.text || null,
    address: place.formattedAddress || null,
    location: place.location ? {
      latitude: place.location.latitude,
      longitude: place.location.longitude,
    } : null,
    rating: place.rating ?? null,
    userRatingCount: place.userRatingCount ?? null,
    primaryType: place.primaryType || null,
    primaryTypeLabel: place.primaryTypeDisplayName?.text || null,
    types: Array.isArray(place.types) ? place.types : [],
    priceLevel: place.priceLevel || null,
    businessStatus: place.businessStatus || null,
    googleMapsUri: place.googleMapsUri || null,
    websiteUri: place.websiteUri || null,
    reviews: Array.isArray(place.reviews)
      ? place.reviews.slice(0, GOOGLE_MAX_REVIEWS).map(mapGoogleReview)
      : [],
  };
}

async function executeGooglePlacesSearch(url, body) {
  if (!GOOGLE_MAPS_API_KEY) return [];
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": GOOGLE_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.warn("[Shift Google] API error:", data?.error?.message || res.status);
    return [];
  }
  return Array.isArray(data.places) ? data.places.map(mapGooglePlace) : [];
}

async function fetchGooglePlaceDetails(resourceName, languageCode, regionCode) {
  if (!GOOGLE_MAPS_API_KEY || !resourceName) return null;

  const url = new URL(resourceName, GOOGLE_PLACE_DETAILS_API_URL);
  if (languageCode) url.searchParams.set("languageCode", languageCode);
  if (regionCode) url.searchParams.set("regionCode", regionCode);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": GOOGLE_PLACE_DETAILS_FIELD_MASK,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.warn("[Shift Google] Place details error:", data?.error?.message || res.status);
    return null;
  }
  return data?.id ? mapGooglePlace(data) : null;
}

function dedupePlaces(places) {
  const byId = new Map();
  for (const p of places) {
    if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
  }
  return [...byId.values()];
}

async function googleNearbySearch(location, radius, limit, languageCode, regionCode) {
  if (!GOOGLE_MAPS_API_KEY || !location) return [];
  const allPlaces = [];
  for (const includedTypes of GOOGLE_NEARBY_TYPE_GROUPS) {
    try {
      const places = await executeGooglePlacesSearch(GOOGLE_MAPS_API_URL, {
        includedTypes,
        maxResultCount: limit || 20,
        locationRestriction: {
          circle: {
            center: { latitude: location.latitude, longitude: location.longitude },
            radius: radius || 3500,
          },
        },
        languageCode: languageCode || "fr",
        regionCode: regionCode || "FR",
      });
      allPlaces.push(...places);
    } catch (e) {
      console.warn("[Shift Google] Nearby search failed for types:", includedTypes, e);
    }
  }
  return dedupePlaces(allPlaces);
}

async function googleTextSearch(query, location, languageCode, regionCode) {
  if (!GOOGLE_MAPS_API_KEY || !query) return [];
  try {
    const body = {
      textQuery: query,
      languageCode: languageCode || "fr",
      regionCode: regionCode || "FR",
      maxResultCount: 5,
    };
    if (location) {
      body.locationBias = {
        circle: {
          center: { latitude: location.latitude, longitude: location.longitude },
          radius: 5000,
        },
      };
    }
    return await executeGooglePlacesSearch(GOOGLE_TEXT_SEARCH_API_URL, body);
  } catch (e) {
    console.warn("[Shift Google] Text search failed:", e);
    return [];
  }
}

async function googleTextSearchBatch(storeNames, location, languageCode, regionCode) {
  if (!Array.isArray(storeNames) || !storeNames.length) return {};

  const settled = await Promise.allSettled(
    storeNames.map(async (name) => ({
      name,
      results: await googleTextSearch(name, location, languageCode, regionCode),
    }))
  );

  const textSearchResults = {};
  for (const entry of settled) {
    if (entry.status !== "fulfilled") continue;
    if (entry.value.results.length) {
      textSearchResults[entry.value.name] = entry.value.results;
    }
  }
  return textSearchResults;
}

async function handleGoogleEnrich(msg) {
  console.log("[Shift Google BG] handleGoogleEnrich called, key:", GOOGLE_MAPS_API_KEY ? "present" : "MISSING");
  if (!GOOGLE_MAPS_API_KEY) {
    return { places: [], disabled: true };
  }
  try {
    console.log("[Shift Google BG] Nearby search at", msg.location?.latitude, msg.location?.longitude);
    const nearbyPlaces = await googleNearbySearch(
      msg.location, msg.radius || 3500, msg.limit || 30,
      msg.languageCode || "fr", msg.regionCode || "FR"
    );
    console.log("[Shift Google BG] Nearby found:", nearbyPlaces.length, "places");

    // Text search for stores not found in nearby
    const textSearchResults = {};
    if (Array.isArray(msg.storeNames) && msg.storeNames.length > 0) {
      console.log("[Shift Google BG] Text searching", msg.storeNames.length, "stores");
      for (const name of msg.storeNames) {
        try {
          const results = await googleTextSearch(name, msg.location);
          if (results.length) textSearchResults[name] = results;
        } catch (_) {}
      }
      console.log("[Shift Google BG] Text search done, found matches for", Object.keys(textSearchResults).length, "stores");
    }

    return { places: nearbyPlaces, textSearchResults };
  } catch (e) {
    console.error("[Shift Google BG] Enrichment failed:", e);
    return { places: [], error: e.message };
  }
}

async function handleGooglePlaceDetails(msg) {
  if (!GOOGLE_MAPS_API_KEY) {
    return { place: null, disabled: true, requestId: msg.requestId || null };
  }
  try {
    const resourceName = msg.resourceName || (msg.placeId ? `places/${msg.placeId}` : "");
    const place = await fetchGooglePlaceDetails(
      resourceName,
      msg.languageCode || "fr",
      msg.regionCode || "FR"
    );
    return { place, requestId: msg.requestId || null };
  } catch (e) {
    console.warn("[Shift Google] Place details failed:", e);
    return { place: null, requestId: msg.requestId || null, error: e.message };
  }
}
