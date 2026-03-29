// Shift 2026 — Background main (deterministic pipeline + single LLM call)
(function () {
  "use strict";

  const apiKey = CONFIG.API_KEY;
  const apiBase = CONFIG.API_BASE;
  const MODEL = CONFIG.MODEL;
  const pendingCalls = new Map();
  let searchContext = null;

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
        break;
      case "GOOGLE_ENRICH":
        handleGoogleEnrich(msg).then((result) => {
          sendToTab(tabId, { type: "GOOGLE_ENRICH_RESULT", ...result });
        });
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
      console.error("[Shift BG] No tabId for CHAT_MESSAGE, trying activeTabId");
      tabId = activeTabId;
    }
    if (!tabId) {
      console.error("[Shift BG] No tab to communicate with");
      return;
    }
    try {
      const classified = classify(text);

      // Step 1: Resolve search terms
      let terms;
      if (classified.type === "FOLLOWUP" && searchContext) {
        return handleFollowup(text, tabId);
      } else if (classified.type === "FREEFORM") {
        sendToTab(tabId, { type: "PROGRESS", step: "thinking" });
        terms = await expandQuery(text);
        if (!terms?.length) terms = [text];
      } else {
        terms = classified.terms;
      }

      // Step 2: Search restaurants (content script calls Uber Eats API)
      sendToTab(tabId, { type: "PROGRESS", step: "searching" });
      const searchResult = await callContentScript(tabId, "SEARCH_RESTAURANTS", { terms }, 15000);
      if (searchResult.error || !searchResult.restaurants?.length) {
        sendToTab(tabId, { type: "ERROR", message: "Aucun restaurant trouvé pour cette recherche." });
        return;
      }

      // Step 3: Fetch menus in parallel (content script)
      sendToTab(tabId, { type: "PROGRESS", step: "scanning", count: searchResult.restaurants.length });
      const menuResult = await callContentScript(
        tabId,
        "FETCH_MENUS",
        { restaurants: searchResult.restaurants },
        30000
      );
      if (menuResult.error || !menuResult.compressed) {
        sendToTab(tabId, { type: "ERROR", message: "Impossible de charger les menus." });
        return;
      }

      // Step 4: Single LLM call — dish selection
      sendToTab(tabId, { type: "PROGRESS", step: "selecting" });
      const multiItem = classified.multiItem
        ? "\nL'utilisateur veut un repas complet — privilegie les restos couvrant plusieurs items."
        : "";
      const llmResult = await callLLM(
        DISH_SELECT_PROMPT + multiItem,
        `Demande: "${text}"\n\n${menuResult.compressed}`
      );

      if (!llmResult?.dishes?.length) {
        sendToTab(tabId, { type: "ERROR", message: "Pas de plats trouvés pour cette recherche." });
        return;
      }

      // Save context for follow-ups
      searchContext = {
        query: text,
        compressed: menuResult.compressed,
        shownDishes: llmResult.dishes,
      };

      // Step 5: Send selection to content script for resolution + render
      if (llmResult.msg) {
        sendToTab(tabId, { type: "STREAM_DELTA", text: llmResult.msg });
        sendToTab(tabId, { type: "STREAM_DONE" });
      }
      sendToTab(tabId, {
        type: "RESOLVE_DISHES",
        selection: llmResult.dishes,
      });
    } catch (e) {
      console.error("[Shift BG]", e);
      sendToTab(tabId, { type: "ERROR", message: e.message || "Erreur inconnue" });
    }
  }

  // ── Follow-up Handler ───────────────────────────
  async function handleFollowup(text, tabId) {
    try {
      sendToTab(tabId, { type: "PROGRESS", step: "selecting" });

      const shownList = (searchContext.shownDishes || [])
        .map((d) => `- s${d.s} i${d.i}${d.why ? ": " + d.why : ""}`)
        .join("\n");

      const userMsg = `Demande initiale: "${searchContext.query}"
Plats deja montres:
${shownList}

Nouveau critere: "${text}"

${searchContext.compressed}`;

      const llmResult = await callLLM(FOLLOWUP_PROMPT, userMsg);

      if (!llmResult?.dishes?.length) {
        sendToTab(tabId, { type: "ERROR", message: "Pas de plats trouvés pour ce critère." });
        return;
      }

      searchContext.shownDishes = llmResult.dishes;

      if (llmResult.msg) {
        sendToTab(tabId, { type: "STREAM_DELTA", text: llmResult.msg });
        sendToTab(tabId, { type: "STREAM_DONE" });
      }
      sendToTab(tabId, {
        type: "RESOLVE_DISHES",
        selection: llmResult.dishes,
      });
    } catch (e) {
      console.error("[Shift BG followup]", e);
      sendToTab(tabId, { type: "ERROR", message: e.message || "Erreur" });
    }
  }

  // ── LLM Calls ──────────────────────────────────
  async function expandQuery(text) {
    const result = await callLLM(QUERY_EXPAND_PROMPT, text);
    return result?.terms || [];
  }

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
