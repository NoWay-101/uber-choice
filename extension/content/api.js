// Shift 2026 — Uber Eats API
(function (S) {
  "use strict";
  const UE = { "Content-Type": "application/json", "x-csrf-token": "x" };

  S.ueFeedSearch = async function (query) {
    const res = await fetch("/_p/api/getFeedV1?localeCode=fr-en", {
      method: "POST",
      headers: UE,
      credentials: "include",
      body: JSON.stringify({
        cacheKey: "",
        feedSessionCount: { announcementCount: 0, announcementLabel: "" },
        userQuery: query || "",
        date: "",
        startTime: 0,
        endTime: 0,
        carouselId: "",
        sortAndFilters: [],
        billboardUuid: "",
        feedProvider: "",
        promotionUuid: "",
        targetingStoreTag: "",
        venueUUID: "",
        selectedSectionUUID: "",
        favorites: "",
        vertical: "",
        searchSource: "",
        searchType: "",
        keyName: "",
        serializedRequestContext: "",
        isUserInitiatedRefresh: false,
      }),
    });
    if (!res.ok) throw new Error(`getFeedV1: ${res.status}`);
    const data = await res.json();
    return (data?.data?.feedItems || [])
      .filter((i) => i.type === "REGULAR_STORE")
      .map((i) => {
        const s = i.store;
        if (!s) return null;
        let eta = null,
          fee = null;
        for (const m of s.meta || []) {
          if (m.badgeType === "ETD") eta = m.text;
          else if (m.badgeType === "FARE")
            fee = m.badgeData?.fare?.deliveryFee || m.text;
        }
        const store = {
          uuid: s.storeUuid,
          title: s.title?.text || "?",
          rating: s.rating?.text || null,
          eta,
          deliveryFee: fee,
          actionUrl: s.actionUrl || null,
        };
        if (store.uuid && fee) S.storeFeeCache.set(store.uuid, fee);
        return store;
      })
      .filter(Boolean);
  };

  S.ueGetStore = async function (uuid) {
    const res = await fetch("/_p/api/getStoreV1?localeCode=fr-en", {
      method: "POST",
      headers: UE,
      credentials: "include",
      body: JSON.stringify({
        storeUuid: uuid,
        diningMode: "DELIVERY",
        time: { asap: true },
        cbType: "EATER_ENDORSED",
      }),
    });
    if (!res.ok) throw new Error(`getStoreV1: ${res.status}`);
    const d = (await res.json())?.data || {};
    const items = [],
      seen = new Set();
    for (const [sectionUuid, entries] of Object.entries(d.catalogSectionsMap || {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const sip = entry?.payload?.standardItemsPayload;
        if (!sip) continue;
        const subsectionUuid = sip.uuid || "";
        for (const item of sip.catalogItems || []) {
          if (seen.has(item.uuid) || item.isSoldOut || item.isAvailable === false)
            continue;
          seen.add(item.uuid);
          items.push({
            title: item.title,
            price: item.price,
            desc: (item.itemDescription || "").slice(0, 80),
            section: sip.title || "",
            img: item.imageUrl || null,
            uuid: item.uuid,
            sectionUuid,
            subsectionUuid,
          });
        }
      }
    }
    return {
      title: d.title,
      uuid: d.uuid,
      rating: d.rating,
      etaRange: d.etaRange,
      priceBucket: d.priceBucket,
      actionUrl: `/store/${d.slug}/${d.uuid}?diningMode=DELIVERY`,
      items,
    };
  };
  // ── Pipeline: Search + deduplicate across multiple terms ──
  S.searchAndRank = async function (terms) {
    console.log("[Shift] searchAndRank:", terms);
    const t0 = Date.now();
    const allStores = new Map();
    for (const term of terms) {
      try {
        const results = await S.ueFeedSearch(term);
        for (const store of results) {
          if (store.uuid && !allStores.has(store.uuid)) {
            allStores.set(store.uuid, store);
          }
        }
      } catch (e) {
        console.warn("[Shift] Search failed for:", term, e);
      }
    }
    // Sort by rating (descending), take top 30
    const topStores = [...allStores.values()]
      .sort((a, b) => parseFloat(b.rating || "0") - parseFloat(a.rating || "0"))
      .slice(0, 30);

    console.log("[Shift] Found", topStores.length, "stores in", Date.now() - t0, "ms");

    // Enrich with Google Places (non-blocking)
    try {
      const enriched = await S.enrichRestaurantsWithGooglePlaces(topStores);
      console.log("[Shift] Enrichment done in", Date.now() - t0, "ms total");
      return enriched;
    } catch (e) {
      console.warn("[Shift] Google enrichment failed, continuing without:", e);
      return topStores;
    }
  };

  // ── Pipeline: Fetch menus + compress ────────────
  S.fetchAndCompress = async function (restaurants) {
    const stores = [];
    // Fetch all menus in parallel
    const results = await Promise.allSettled(
      restaurants.map((r) => S.ueGetStore(r.uuid))
    );

    for (let idx = 0; idx < results.length; idx++) {
      if (results[idx].status !== "fulfilled") continue;
      const storeData = results[idx].value;
      const restaurant = restaurants[idx];
      if (!storeData?.items?.length) continue;
      stores.push({
        title: storeData.title || restaurant.title,
        uuid: storeData.uuid || restaurant.uuid,
        rating: restaurant.rating,
        eta: restaurant.eta,
        deliveryFee: restaurant.deliveryFee,
        actionUrl: storeData.actionUrl || restaurant.actionUrl,
        items: storeData.items,
        // Google Places data (from enrichment step)
        googlePlace: restaurant.googlePlace || null,
        googleRating: restaurant.googleRating || null,
        googleUserRatingCount: restaurant.googleUserRatingCount || null,
        googleReviews: restaurant.googleReviews || [],
      });
    }

    // Cache the full data for later resolution
    S.menuCache = stores;

    // Build compressed text for LLM
    const lines = [];
    stores.forEach((store, si) => {
      const fee = extractFeeShort(store.deliveryFee);
      lines.push(`[Store "${store.title}" r:${store.rating || "?"} eta:${store.eta || "?"} ${fee ? "fee:" + fee : ""}]`);
      store.items.forEach((item, ii) => {
        const price = item.price != null ? (item.price / 100).toFixed(2) : "?";
        const desc = item.desc ? `|${item.desc}` : "";
        lines.push(`${ii}|${item.title}|${price}€|${item.section}${desc}`);
      });
      lines.push(""); // blank line between stores
    });

    return lines.join("\n");
  };

  function extractFeeShort(feeStr) {
    if (!feeStr) return "";
    const match = feeStr.match(/([\d.,]+)\s*€/);
    return match ? match[1] + "€" : "";
  }

  // ── Pipeline: Resolve LLM selection → full dish objects ──
  S.resolveSelection = function (selection) {
    if (!S.menuCache || !selection?.length) return [];
    const dishes = [];
    for (const pick of selection) {
      const store = S.menuCache[pick.s];
      if (!store) continue;
      const item = store.items[pick.i];
      if (!item) continue;
      dishes.push({
        title: item.title,
        price: item.price != null ? item.price / 100 : null,
        description: item.desc || "",
        image_url: item.img || null,
        store_name: store.title,
        store_uuid: store.uuid,
        store_action_url: store.actionUrl,
        store_rating: store.rating,
        store_eta: store.eta,
        store_delivery_fee: store.deliveryFee,
        item_uuid: item.uuid,
        section_uuid: item.sectionUuid || "",
        subsection_uuid: item.subsectionUuid || "",
        // Google Places
        google_rating: store.googleRating || null,
        google_review_count: store.googleUserRatingCount || null,
        google_reviews: store.googleReviews || [],
        google_place: store.googlePlace || null,
      });
    }
    return dishes;
  };
})(window.Shift);
