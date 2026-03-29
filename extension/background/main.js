// Shift 2026 — Background main (conversational agent pipeline)
(function () {
  "use strict";

  const apiKey = CONFIG.API_KEY;
  const apiBase = CONFIG.API_BASE;
  const MODEL = CONFIG.MODEL;
  const pendingCalls = new Map();
  let searchContext = null;
  let searchContextHistory = [];
  let conversationTurns = []; // short history for multi-turn dialogue

  // ── Track active tab ─────────────────────────────
  let activeTabId = null;

  // ── Message Listener ────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender) => {
    const tabId = sender.tab?.id || activeTabId;
    if (sender.tab?.id) activeTabId = sender.tab.id;
    switch (msg.type) {
      case "CONTENT_READY":
        if (sender.tab?.id) activeTabId = sender.tab.id;
        break;
      case "CHAT_MESSAGE":
        handleChat(msg.text, tabId);
        break;
      case "PIPELINE_RESULT": {
        const resolve = pendingCalls.get(msg.callId);
        if (resolve) {
          resolve(msg.result);
          pendingCalls.delete(msg.callId);
        }
        break;
      }
      case "RESET_CONVERSATION":
        searchContext = null;
        searchContextHistory = [];
        conversationTurns = [];
        break;
      case "HISTORY_BACK":
        if (searchContextHistory.length > 0) {
          searchContext = searchContextHistory.pop();
        }
        // Also pop last conversation turn
        if (conversationTurns.length > 0) conversationTurns.pop();
        break;
      case "GOOGLE_ENRICH":
        handleGoogleEnrich(msg).then((result) => {
          sendToTab(tabId, { type: "GOOGLE_ENRICH_RESULT", ...result });
        });
        break;
      case "GOOGLE_PLACE_DETAILS":
        handleGooglePlaceDetails(msg).then((result) => {
          sendToTab(tabId, { type: "GOOGLE_PLACE_DETAILS_RESULT", ...result });
        });
        break;
      case "COMPARE_DISHES":
        handleCompare(msg.dish, msg.criteria, tabId);
        break;
    }
    return true;
  });

  function sendToTab(tabId, msg) {
    if (!tabId) return;
    try {
      chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    } catch (_) {}
  }

  function callContentScript(tabId, type, data, timeoutMs) {
    const callId = "c_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
    return new Promise((resolve) => {
      pendingCalls.set(callId, resolve);
      sendToTab(tabId, { type, callId, ...data });
      setTimeout(() => {
        if (pendingCalls.has(callId)) {
          pendingCalls.delete(callId);
          resolve({ error: "Timeout" });
        }
      }, timeoutMs || 20000);
    });
  }

  // ── Main Pipeline ───────────────────────────────
  async function handleChat(text, tabId) {
    if (!tabId) {
      tabId = activeTabId;
    }
    if (!tabId) {
      console.error("[Shift BG] No tab to communicate with");
      return;
    }
    try {
      const classified = classify(text);
      console.log("[Shift BG] classify:", text, "→", classified.type, classified.terms);

      // Follow-ups reuse existing menus
      if (classified.type === "FOLLOWUP" && searchContext) {
        conversationTurns.push({ role: "user", text });
        return runAgent(tabId, text, searchContext.compressed, true);
      }

      // Start fresh conversation
      conversationTurns = [{ role: "user", text }];

      // FREEFORM queries (vague: "je sais pas", "un truc") → ask LLM first, no search
      if (classified.type === "FREEFORM") {
        sendToTab(tabId, { type: "PROGRESS", step: "thinking" });
        await runAgent(tabId, text, "", false);
        return;
      }

      // DIRECT/MOOD → search + fetch menus first, then agent
      const terms = classified.terms;

      sendToTab(tabId, { type: "PROGRESS", step: "searching" });
      console.log("[Shift BG] Searching with terms:", terms);
      const searchResult = await callContentScript(tabId, "SEARCH_RESTAURANTS", { terms }, 20000);
      console.log("[Shift BG] Search result:", searchResult.error || `${searchResult.restaurants?.length} restaurants`);
      if (searchResult.error || !searchResult.restaurants?.length) {
        sendToTab(tabId, { type: "ERROR", message: "Aucun restaurant trouvé pour cette recherche." });
        return;
      }

      sendToTab(tabId, { type: "PROGRESS", step: "scanning", count: searchResult.restaurants.length });
      console.log("[Shift BG] Fetching menus for", searchResult.restaurants.length, "restaurants");
      const menuResult = await callContentScript(
        tabId, "FETCH_MENUS",
        { restaurants: searchResult.restaurants },
        45000
      );
      console.log("[Shift BG] Menu result:", menuResult.error || `${menuResult.compressed?.length} chars`);
      if (menuResult.error || !menuResult.compressed) {
        sendToTab(tabId, { type: "ERROR", message: "Impossible de charger les menus." });
        return;
      }

      const multiItem = classified.multiItem
        ? "\nNote: l'utilisateur veut un repas complet — privilegie les restos couvrant plusieurs items."
        : "";
      await runAgent(tabId, text + multiItem, menuResult.compressed, false);

    } catch (e) {
      console.error("[Shift BG]", e);
      sendToTab(tabId, { type: "ERROR", message: e.message || "Erreur inconnue" });
    }
  }

  // ── Agent Conversation Loop ─────────────────────
  async function runAgent(tabId, userText, compressed, isFollowup) {
    const MAX_TURNS = 7;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      sendToTab(tabId, { type: "PROGRESS", step: "selecting" });

      // Build user message with conversation history
      let userMsg;
      if (turn === 0 && !isFollowup) {
        userMsg = `Demande: "${userText}"\n\n${compressed}`;
      } else if (isFollowup && turn === 0) {
        const shownList = (searchContext?.shownDishes || [])
          .map((d) => `- s${d.s} i${d.i}${d.why ? ": " + d.why : ""}`)
          .join("\n");
        userMsg = `Demande initiale: "${searchContext?.query || ""}"\nPlats deja montres:\n${shownList}\n\nNouveau message: "${userText}"\n\n${compressed}`;
      } else {
        // Subsequent turns — include conversation history, menus already known
        const history = conversationTurns
          .slice(-4) // max 4 recent turns
          .map((t) => `${t.role === "user" ? "User" : "Toi"}: ${t.text}`)
          .join("\n");
        userMsg = `[Menus deja fournis]\n\nHistorique:\n${history}\n\n${compressed}`;
      }

      console.log("[Shift BG] Agent turn", turn, "calling LLM...");
      const result = await callLLM(AGENT_PROMPT, userMsg);
      console.log("[Shift BG] Agent result:", result?.action, result?.msg || "");
      if (!result?.action) {
        sendToTab(tabId, { type: "ERROR", message: "Pas de réponse du LLM." });
        return;
      }

      switch (result.action) {
        case "dishes": {
          if (!result.dishes?.length) {
            sendToTab(tabId, { type: "ERROR", message: "Pas de plats pertinents trouvés." });
            return;
          }
          conversationTurns.push({ role: "assistant", text: result.msg || "Voici mes suggestions" });

          // Save context
          if (searchContext) searchContextHistory.push({ ...searchContext });
          searchContext = {
            query: conversationTurns.find((t) => t.role === "user")?.text || userText,
            compressed,
            shownDishes: result.dishes,
          };

          if (result.msg) {
            sendToTab(tabId, { type: "STREAM_DELTA", text: result.msg });
            sendToTab(tabId, { type: "STREAM_DONE" });
          }
          sendToTab(tabId, { type: "RESOLVE_DISHES", selection: result.dishes, header: result.header || "" });
          if (result.placeholders?.length) {
            sendToTab(tabId, { type: "UPDATE_PLACEHOLDERS", placeholders: result.placeholders });
          }
          return; // done
        }

        case "question": {
          conversationTurns.push({ role: "assistant", text: `Question: ${result.title}` });

          // Show choices and wait for user response
          const choiceResult = await callContentScript(tabId, "SHOW_CHOICES", {
            title: result.title || "Que préfères-tu ?",
            options: result.options || [],
            allowMultiple: result.allowMultiple || false,
          }, 60000);

          if (choiceResult.error) {
            sendToTab(tabId, { type: "ERROR", message: "Pas de réponse." });
            return;
          }

          // Add user response to conversation
          const selectedLabels = choiceResult.labels || choiceResult.selected || [];
          const userResponse = Array.isArray(selectedLabels) ? selectedLabels.join(", ") : String(selectedLabels);
          conversationTurns.push({ role: "user", text: userResponse });
          userText = userResponse;

          // Continue loop — LLM will get the response and decide next action
          continue;
        }

        case "message": {
          conversationTurns.push({ role: "assistant", text: result.msg || "" });
          if (result.msg) {
            sendToTab(tabId, { type: "STREAM_DELTA", text: result.msg });
            sendToTab(tabId, { type: "STREAM_DONE" });
          }
          return; // done
        }

        case "refine_search": {
          if (!result.terms?.length) {
            sendToTab(tabId, { type: "ERROR", message: "Pas de termes de recherche." });
            return;
          }
          conversationTurns.push({ role: "assistant", text: result.msg || "Nouvelle recherche..." });
          if (result.msg) {
            sendToTab(tabId, { type: "STREAM_DELTA", text: result.msg });
          }

          // Re-search with new terms
          sendToTab(tabId, { type: "PROGRESS", step: "searching" });
          const searchResult = await callContentScript(tabId, "SEARCH_RESTAURANTS", { terms: result.terms }, 15000);
          if (searchResult.error || !searchResult.restaurants?.length) {
            sendToTab(tabId, { type: "STREAM_DONE" });
            sendToTab(tabId, { type: "ERROR", message: "Toujours rien trouvé." });
            return;
          }

          sendToTab(tabId, { type: "PROGRESS", step: "scanning", count: searchResult.restaurants.length });
          const menuResult = await callContentScript(
            tabId, "FETCH_MENUS",
            { restaurants: searchResult.restaurants },
            30000
          );
          if (menuResult.error || !menuResult.compressed) {
            sendToTab(tabId, { type: "STREAM_DONE" });
            sendToTab(tabId, { type: "ERROR", message: "Impossible de charger les menus." });
            return;
          }

          // Update compressed for next turn
          compressed = menuResult.compressed;
          continue; // loop again with new menus
        }

        default:
          sendToTab(tabId, { type: "ERROR", message: "Réponse inattendue." });
          return;
      }
    }

    // Max turns reached
    sendToTab(tabId, { type: "ERROR", message: "Trop de tours de conversation." });
  }

  // ── Compare Handler ─────────────────────────────
  const CRITERIA_INSTRUCTIONS = {
    healthy: "L'utilisateur cherche une alternative PLUS SAINE / HEALTHY. Privilegie les plats legers, salades, bowls, grilles, peu de friture, riches en legumes ou proteines maigres.",
    cheaper: "L'utilisateur cherche une alternative MOINS CHERE. Trie par prix croissant et privilegie le meilleur rapport qualite-prix.",
    faster: "L'utilisateur cherche une alternative PLUS RAPIDE. Privilegie les restaurants avec le temps de livraison (eta) le plus court.",
    default: "L'utilisateur cherche des alternatives comparables.",
  };

  async function handleCompare(dish, criteria, tabId) {
    try {
      // Always do a fresh search based on the dish type — cached menus may be from a different search
      sendToTab(tabId, { type: "PROGRESS_COMPARE", step: "searching" });

      // Ask LLM what to search for to find similar dishes
      const expandResult = await callLLM(
        "L'utilisateur veut comparer ce plat avec des alternatives similaires dans d'autres restaurants. Donne 2-3 termes de recherche Uber Eats pour trouver des restaurants qui servent ce type de plat. JSON: {\"terms\":[...]}",
        `${dish.title}${dish.description ? " — " + dish.description : ""}`
      );
      let terms = expandResult?.terms || [];
      if (!terms.length) terms = [dish.title];
      console.log("[Shift BG compare] Searching with terms:", terms);

      const searchResult = await callContentScript(tabId, "SEARCH_RESTAURANTS", { terms }, 20000);
      if (searchResult.error || !searchResult.restaurants?.length) {
        sendToTab(tabId, { type: "COMPARE_ERROR", message: "Aucun restaurant trouvé pour la comparaison." });
        return;
      }

      sendToTab(tabId, { type: "PROGRESS_COMPARE", step: "scanning", count: searchResult.restaurants.length });
      const menuResult = await callContentScript(tabId, "FETCH_MENUS", { restaurants: searchResult.restaurants }, 45000);
      if (menuResult.error || !menuResult.compressed) {
        sendToTab(tabId, { type: "COMPARE_ERROR", message: "Impossible de charger les menus." });
        return;
      }

      // LLM call with comparison prompt + criteria
      sendToTab(tabId, { type: "PROGRESS_COMPARE", step: "selecting" });
      const priceStr = dish.price != null ? dish.price.toFixed(2) + "\u20AC" : "?";
      const descStr = dish.description ? `\nDescription: ${dish.description}` : "";
      const criteriaText = CRITERIA_INSTRUCTIONS[criteria] || CRITERIA_INSTRUCTIONS.default;
      const refInfo = `Plat de reference: "${dish.title}" (${priceStr}) chez "${dish.store_name}"${descStr}\n\nCritere: ${criteriaText}`;
      const llmResult = await callLLM(COMPARE_PROMPT, `${refInfo}\n\n${menuResult.compressed}`);

      if (!llmResult?.dishes?.length) {
        sendToTab(tabId, { type: "COMPARE_ERROR", message: "Pas d'alternatives trouvées." });
        return;
      }

      sendToTab(tabId, {
        type: "COMPARE_RESULTS",
        referenceDish: dish,
        selection: llmResult.dishes,
        msg: llmResult.msg || "",
      });
    } catch (e) {
      console.error("[Shift BG compare]", e);
      sendToTab(tabId, { type: "COMPARE_ERROR", message: e.message || "Erreur de comparaison" });
    }
  }

  // ── LLM Call ───────────────────────────────────
  async function callLLM(systemPrompt, userMessage) {
    const response = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    try {
      return JSON.parse(content);
    } catch (_) {
      console.error("[Shift BG] Invalid JSON from LLM:", content);
      return null;
    }
  }

  console.log("[Shift 2026] Background loaded");
})();
