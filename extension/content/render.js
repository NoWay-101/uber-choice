// Shift 2026 — Rendering (cards, grid, carousel, rows, winner, top picks, choices, popup)
(function (S) {
  "use strict";

  // ── Helpers ─────────────────────────────────────
  function buildItemUrl(dish) {
    const base = dish.store_action_url || "";
    if (!dish.item_uuid || !dish.store_uuid) return base;
    // Uber Eats quickView: modctx is a JSON with storeUuid, sectionUuid, subsectionUuid, itemUuid
    // The modctx value must be double-encoded (JSON → encodeURIComponent)
    const ctx = {
      storeUuid: dish.store_uuid,
      itemUuid: dish.item_uuid,
      showSeeDetailsCTA: true,
    };
    if (dish.section_uuid) ctx.sectionUuid = dish.section_uuid;
    if (dish.subsection_uuid) ctx.subsectionUuid = dish.subsection_uuid;
    const encodedCtx = encodeURIComponent(JSON.stringify(ctx));
    const sep = base.includes("?") ? "&" : "?";
    return base + sep + "mod=quickView&modctx=" + encodedCtx + "&ps=1";
  }

  function extractFeeAmount(feeStr) {
    if (!feeStr) return "";
    if (!/\d/.test(feeStr)) return "";
    const match = feeStr.match(/([\d.,]+)\s*\u20AC/);
    if (match) return match[1] + "\u00A0\u20AC livr.";
    return "";
  }

  S.buildCard = function (dish, index) {
    const price = dish.price != null ? dish.price.toFixed(2) + "\u00A0\u20AC" : "";
    const rawFee =
      dish.store_delivery_fee || S.storeFeeCache.get(dish.store_uuid) || "";
    const fee = extractFeeAmount(rawFee);
    const card = document.createElement("div");
    card.className = "shift-card";
    card.dataset.dishJson = JSON.stringify(dish);
    if (dish.store_action_url) card.dataset.actionurl = dish.store_action_url;
    if (dish.item_uuid) card.dataset.itemid = dish.item_uuid;
    card.style.setProperty("--i", index);
    card.innerHTML = `
      <div class="shift-card-img-wrap">
        ${dish.image_url ? `<img class="shift-card-img" src="${S.esc(dish.image_url)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=shift-card-img-placeholder>\u{1F37D}\u{FE0F}</div>'" />` : '<div class="shift-card-img-placeholder">\u{1F37D}\u{FE0F}</div>'}
        ${price ? `<div class="shift-card-price">${S.esc(price)}${fee ? ` <span class="shift-card-fee">+ ${S.esc(fee)}</span>` : ""}</div>` : ""}
      </div>
      <div class="shift-card-body">
        <div class="shift-card-name">${S.esc(dish.title || "")}</div>
        ${dish.description ? `<div class="shift-card-desc">${S.esc(dish.description)}</div>` : ""}
        <div class="shift-card-meta">
          <span>${S.esc(dish.store_name || "")}</span>
          ${dish.store_rating ? `<span class="shift-card-rating">\u2605 ${S.esc(dish.store_rating)}</span>` : ""}
          ${dish.store_eta ? `<span>${S.esc(dish.store_eta)}</span>` : ""}
          ${dish.google_rating ? `<span class="shift-card-google-rating">Google ${S.esc(String(dish.google_rating))}/5</span>` : ""}
        </div>
      </div>`;

    // Add Google reviews button if available
    if (dish.google_place && dish.google_review_count) {
      const btn = S.buildGoogleReviewsButton(dish.google_place);
      if (btn) card.querySelector(".shift-card-meta")?.appendChild(btn);
    }

    return card;
  };

  // ── Dish Cards (dispatcher) ─────────────────────
  S.renderDishCards = function (dishes, header) {
    if (!dishes?.length || !S.$stage) return;
    S.hideLoadingOverlay?.();
    if (S.flowTimeout) {
      clearTimeout(S.flowTimeout);
      S.flowTimeout = null;
    }

    // Save current state to history — only if real results are displayed (not progress/loading)
    if (S.$stage.children.length > 0 && S.$stage.querySelector(".shift-grid, .shift-carousel, .shift-restaurant-rows, .shift-winner-reveal, .shift-top-picks, .shift-choices")) {
      S.historyStack.push({
        stageHTML: S.$stage.innerHTML,
        responseHTML: S.$response ? S.$response.innerHTML : "",
      });
      S.updateBackButton();
    }

    S.$stage.innerHTML = "";
    if (S.$response) {
      S.$response.textContent = "";
      S.$response.classList.remove("streaming");
    }
    S.isStreaming = false;
    S.scrollTop();

    // Header text above cards (from LLM)
    if (header) {
      const h = document.createElement("div");
      h.className = "shift-results-header";
      h.textContent = header;
      S.$stage.appendChild(h);
    }

    if (dishes.length === 1) {
      renderWinner(dishes[0]);
    } else if (shouldRenderRestaurantRows(dishes)) {
      renderRestaurantRows(dishes);
    } else if (dishes.length <= 5) {
      renderCarousel(dishes);
    } else {
      renderGrid(dishes);
    }
  };

  // ── Restaurant rows ─────────────────────────────
  function shouldRenderRestaurantRows(dishes) {
    if (dishes.length < 2) return false;
    const groups = groupDishesByRestaurant(dishes);
    const hasRestaurantBundles = groups.some((group) => group.dishes.length > 1);
    if (!hasRestaurantBundles) return false;

    const prompt = (S.lastUserPrompt || "").toLowerCase();
    if (!prompt) return true;
    if (prompt.includes("humeur :") || prompt.includes("cuisines :"))
      return false;

    return (
      /(?:\bavec\b|,|\bet\b|\bpuis\b|\bplus\b|\baccompagn)/.test(prompt) ||
      hasRestaurantBundles
    );
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
      if (group.dishes.length >= 3) row.classList.add("full-width");
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

      function appendMeta(text, cls) {
        const span = document.createElement("span");
        span.textContent = text;
        if (cls) span.className = cls;
        meta.appendChild(span);
      }

      appendMeta(`${group.dishes.length} produit${group.dishes.length > 1 ? "s" : ""}`);
      if (group.store_rating) appendMeta(`\u2605 ${group.store_rating}`);
      if (group.store_eta) appendMeta(group.store_eta);

      // Google rating from cache or dish data
      const gPlace = S.getCachedGooglePlace(group.key, group.store_name)
        || group.dishes.find((d) => d.google_place)?.google_place || null;
      if (gPlace?.rating != null) {
        appendMeta(`Google ${gPlace.rating}/5`, "shift-restaurant-row-google-rating");
      }
      if (gPlace && Array.isArray(gPlace.reviews) && gPlace.reviews.length > 0) {
        const btn = S.buildGoogleReviewsButton(gPlace);
        if (btn) meta.appendChild(btn);
      }

      titleBlock.append(title, meta);

      header.appendChild(titleBlock);
      row.appendChild(header);

      const track = document.createElement("div");
      track.className = "shift-restaurant-row-track";
      group.dishes.forEach((dish, dishIndex) => {
        track.appendChild(S.buildCard(dish, dishIndex));
      });

      row.appendChild(track);
      wrap.appendChild(row);
    });

    S.$stage.appendChild(wrap);
  }

  // ── Carousel ────────────────────────────────────
  function renderCarousel(dishes) {
    const wrap = document.createElement("div");
    wrap.className = "shift-carousel";
    const prev = document.createElement("button");
    prev.className = "shift-carousel-arrow";
    prev.innerHTML = "\u2039";
    const track = document.createElement("div");
    track.className = "shift-carousel-track";
    const next = document.createElement("button");
    next.className = "shift-carousel-arrow";
    next.innerHTML = "\u203A";
    dishes.forEach((d, i) => track.appendChild(S.buildCard(d, i)));
    prev.addEventListener("click", () =>
      track.scrollBy({ left: -320, behavior: "smooth" })
    );
    next.addEventListener("click", () =>
      track.scrollBy({ left: 320, behavior: "smooth" })
    );
    wrap.append(prev, track, next);
    S.$stage.appendChild(wrap);
  }

  // ── Grid ────────────────────────────────────────
  function renderGrid(dishes) {
    const grid = document.createElement("div");
    grid.className = "shift-grid";

    const visible = dishes.slice(0, S.MAX_VISIBLE);
    const rest = dishes.slice(S.MAX_VISIBLE);

    visible.forEach((d, i) => grid.appendChild(S.buildCard(d, i)));
    S.$stage.appendChild(grid);

    if (rest.length > 0) {
      const loadMore = document.createElement("button");
      loadMore.className = "shift-load-more";
      loadMore.textContent = `Voir ${rest.length} autre${rest.length > 1 ? "s" : ""} plat${rest.length > 1 ? "s" : ""}`;
      loadMore.addEventListener("click", () => {
        loadMore.remove();
        rest.forEach((d, i) => {
          const card = S.buildCard(d, S.MAX_VISIBLE + i);
          grid.appendChild(card);
        });
      });
      S.$stage.appendChild(loadMore);
    }
  }

  // ── Winner ──────────────────────────────────────
  function renderWinner(dish) {
    const wrap = document.createElement("div");
    wrap.className = "shift-winner-reveal";
    const crown = document.createElement("div");
    crown.className = "shift-winner-crown";
    crown.textContent = "\u{1F451}";
    const card = S.buildCard(dish, 0);
    card.classList.add("shift-winner-card");
    const cta = document.createElement("button");
    cta.className = "shift-cta-order";
    cta.textContent = "Commander sur Uber Eats";
    cta.addEventListener("click", () => {
      if (dish.store_action_url) {
        sessionStorage.setItem("shift-active", "true");
        window.location.href = buildItemUrl(dish);
      }
    });
    wrap.append(crown, card, cta);
    S.$stage.appendChild(wrap);
  }

  // ── Top Picks (3 cards, pick 1) ─────────────────
  S.renderTopPicks = function (callId, title, dishes) {
    if (!S.$stage) return;
    S.$stage.innerHTML = "";
    if (S.$response) {
      S.$response.textContent = "";
      S.$response.classList.remove("streaming");
    }

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
      const card = S.buildCard(dish, i);
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
            type: "TOOL_RESULT",
            callId,
            result: { winner_index: i, winner_dish: dish },
          });
        }, 800);
      });
      arena.appendChild(card);
    });

    wrap.appendChild(arena);
    S.$stage.appendChild(wrap);
  };

  // ── Choices (clickable options — always multi-select) ──
  S.renderChoices = function (callId, title, options) {
    if (!S.$stage) return;
    S.hideLoadingOverlay?.();
    S.$stage.innerHTML = "";
    if (S.$response) {
      S.$response.textContent = "";
      S.$response.classList.remove("streaming");
    }

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
      btn.innerHTML = `${opt.icon ? `<span class="shift-choice-icon">${S.esc(opt.icon)}</span>` : ""}${S.esc(opt.label)}`;
      btn.addEventListener("click", () => {
        btn.classList.toggle("selected");
        if (sel.has(opt.value)) sel.delete(opt.value);
        else sel.add(opt.value);
      });
      row.appendChild(btn);
    });

    wrap.appendChild(row);

    // "Autre..." free text input
    const otherRow = document.createElement("div");
    otherRow.className = "shift-choices-other";
    const otherInput = document.createElement("input");
    otherInput.type = "text";
    otherInput.className = "shift-choices-other-input";
    otherInput.placeholder = "Autre chose ? Dis-moi...";
    otherRow.appendChild(otherInput);
    wrap.appendChild(otherRow);

    // Validate button
    const confirm = document.createElement("button");
    confirm.className = "shift-choice-confirm";
    confirm.textContent = "C'est parti";
    confirm.addEventListener("click", () => {
      const labels = [...sel];
      const otherText = otherInput.value.trim();
      if (otherText) labels.push(otherText);
      if (labels.length > 0) {
        chrome.runtime.sendMessage({
          type: "PIPELINE_RESULT",
          callId,
          result: { selected: labels, labels },
        });
      }
    });
    otherInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); confirm.click(); }
    });
    wrap.appendChild(confirm);

    S.$stage.appendChild(wrap);
  };

  // ── Dish Detail Popup ───────────────────────────
  S.openDishPopup = function (dish) {
    S.shiftRoot.querySelector(".shift-popup-overlay")?.remove();

    const price = dish.price != null ? dish.price.toFixed(2) + " \u20AC" : "";
    const rawFee =
      dish.store_delivery_fee || S.storeFeeCache.get(dish.store_uuid) || "";
    const fee = extractFeeAmount(rawFee);

    const overlay = document.createElement("div");
    overlay.className = "shift-popup-overlay";
    overlay.innerHTML = `
      <div class="shift-popup">
        <button class="shift-popup-close">\u2715</button>
        ${dish.image_url ? `<img class="shift-popup-img" src="${S.esc(dish.image_url)}" />` : ""}
        <div class="shift-popup-body">
          <h2 class="shift-popup-title">${S.esc(dish.title || "")}</h2>
          <div class="shift-popup-store">
            ${S.esc(dish.store_name || "")}
            ${dish.store_rating ? ` \u00B7 \u2605 ${S.esc(dish.store_rating)}` : ""}
            ${dish.store_eta ? ` \u00B7 ${S.esc(dish.store_eta)}` : ""}
          </div>
          ${dish.description ? `<p class="shift-popup-desc">${S.esc(dish.description)}</p>` : ""}
          <div class="shift-popup-pricing">
            ${price ? `<span class="shift-popup-price">${S.esc(price)}</span>` : ""}
            ${fee ? `<span class="shift-popup-fee">+ ${S.esc(fee)}</span>` : ""}
          </div>
          <button class="shift-popup-cta">Voir sur Uber Eats</button>
        </div>
      </div>
    `;

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.closest(".shift-popup-close")) {
        overlay.remove();
      }
    });

    overlay.querySelector(".shift-popup-cta").addEventListener("click", () => {
      if (dish.store_action_url) {
        sessionStorage.setItem("shift-active", "true");
        window.location.href = buildItemUrl(dish);
      }
    });

    S.shiftRoot.appendChild(overlay);
  };

})(window.Shift);
