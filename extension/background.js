// Shift 2026 - Service Worker (background.js)
// OpenAI streaming + tool calling orchestration

importScripts("config.js");

(function () {
  "use strict";

  // ── State ───────────────────────────────────────────
  const apiKey = CONFIG.API_KEY;
  const apiBase = CONFIG.API_BASE;
  let conversationHistory = [];
  const pendingToolCalls = new Map(); // callId → resolve function

  const MODEL = CONFIG.MODEL;

  // ── System Prompt ───────────────────────────────────
  const SYSTEM_PROMPT = `Tu es Shift, un assistant IA integre a Uber Eats qui aide les utilisateurs a trouver le plat parfait. Tu parles francais.

## Ce que tu peux faire
- Chercher des restaurants par type de cuisine ou de plat
- Explorer les menus des restaurants
- Comparer des plats similaires entre plusieurs restaurants (prix, description, restaurant)
- Recommander des plats selon les envies, contraintes (budget, regime, allergies) et preferences

## Comment tu fonctionnes
Tu as acces a l'API Uber Eats en temps reel via tes outils :
1. Cherche les restaurants pertinents avec search_restaurants
2. Explore les menus de plusieurs restaurants avec get_restaurant_menu (appelle-le plusieurs fois en parallele)
3. Compare les plats de facon SEMANTIQUE -- si l'utilisateur cherche "chevre miel", identifie les plats au chevre et miel meme si le nom exact ne correspond pas. Pareil pour "4 fromages", "quatre fromages", "4 cheese", etc.
4. Presente les resultats avec show_dish_cards pour que l'utilisateur puisse voir et cliquer

## Regles
- TOUJOURS utiliser show_dish_cards pour presenter des plats -- jamais les lister en texte brut
- Quand tu compares des plats, scanne au moins 5 restaurants avant de presenter
- Les prix dans l'API sont en CENTIMES -- convertis en euros (divise par 100) dans show_dish_cards
- Sois concis -- 1-2 phrases max avant/apres les cards
- Si tu ne trouves rien, suggere des termes alternatifs
- Appelle plusieurs get_restaurant_menu en PARALLELE pour aller plus vite
- "montre-moi", "compare", "trouve" = signal pour scanner plusieurs restaurants

## Style
- Decontracte mais efficace
- Reponses courtes
- Pas de blabla inutile`;

  // ── Tool Definitions ────────────────────────────────
  const TOOLS = [
    {
      type: "function",
      function: {
        name: "search_restaurants",
        description:
          "Search for restaurants on Uber Eats matching a query. Returns restaurants with name, rating, ETA, delivery fee, UUID. Use to find restaurants serving a specific dish or cuisine.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Search query: dish name, cuisine type, or restaurant name (e.g. 'pizza', 'quatre fromages', 'sushi')",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_restaurant_menu",
        description:
          "Get the full menu of a specific restaurant. Returns all menu items with title, description, price (in cents), section, image URL. Use after search_restaurants to inspect dishes.",
        parameters: {
          type: "object",
          properties: {
            store_uuid: {
              type: "string",
              description: "Restaurant UUID from search_restaurants results",
            },
            store_name: {
              type: "string",
              description: "Restaurant name (for context)",
            },
          },
          required: ["store_uuid"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "show_dish_cards",
        description:
          "Display dish comparison cards to the user. ALWAYS use this to present dishes instead of listing them as text. Each card shows image, name, price, restaurant, rating, ETA. User can click to navigate to the restaurant.",
        parameters: {
          type: "object",
          properties: {
            dishes: {
              type: "array",
              description: "Dishes to display as cards",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  price: {
                    type: "number",
                    description: "Price in EUROS (not cents)",
                  },
                  description: { type: "string" },
                  image_url: { type: "string" },
                  store_name: { type: "string" },
                  store_uuid: { type: "string" },
                  store_action_url: { type: "string" },
                  store_rating: { type: "string" },
                  store_eta: { type: "string" },
                  store_delivery_fee: { type: "string" },
                },
                required: ["title", "store_name"],
              },
            },
          },
          required: ["dishes"],
        },
      },
    },
  ];

  // ── Init ────────────────────────────────────────────
  async function init() {
    const data = await chrome.storage.local.get(["conversation"]);
    conversationHistory = data.conversation || [];
  }

  async function saveConversation() {
    await chrome.storage.local.set({ conversation: conversationHistory });
  }

  init();

  // ── Message Listener ────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const tabId = sender.tab?.id;

    switch (msg.type) {
      case "CONTENT_READY":
        sendToTab(tabId, {
          type: "CONVERSATION_HISTORY",
          messages: conversationHistory,
        });
        break;

      case "CHAT_MESSAGE":
        handleChat(msg.text, tabId);
        break;

      case "TOOL_RESULT":
        const resolve = pendingToolCalls.get(msg.callId);
        if (resolve) {
          resolve({ callId: msg.callId, data: msg.result });
          pendingToolCalls.delete(msg.callId);
        }
        break;

      case "RESET_CONVERSATION":
        conversationHistory = [];
        chrome.storage.local.remove("conversation");
        break;
    }

    return true; // keep channel open
  });

  function sendToTab(tabId, msg) {
    if (tabId) chrome.tabs.sendMessage(tabId, msg);
  }

  // ── Chat Handler ────────────────────────────────────
  async function handleChat(text, tabId) {
    conversationHistory.push({ role: "user", content: text });

    let continueLoop = true;

    while (continueLoop) {
      try {
        const response = await fetch(
          `${apiBase}/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: MODEL,
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                ...conversationHistory,
              ],
              tools: TOOLS,
              stream: true,
            }),
          }
        );

        if (!response.ok) {
          const errText = await response.text();
          sendToTab(tabId, {
            type: "ERROR",
            message: `OpenAI ${response.status}: ${errText.substring(0, 200)}`,
          });
          return;
        }

        const { textContent, toolCalls, finishReason } = await processStream(
          response,
          tabId
        );

        if (finishReason === "tool_calls" && toolCalls.length > 0) {
          // Add assistant message with tool calls to history
          const assistantMsg = {
            role: "assistant",
            content: textContent || null,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            })),
          };
          conversationHistory.push(assistantMsg);

          // Execute all tool calls
          const results = await executeToolCalls(toolCalls, tabId);

          // Add tool results to history
          for (const result of results) {
            conversationHistory.push({
              role: "tool",
              tool_call_id: result.callId,
              content: JSON.stringify(result.data),
            });
          }

          // Loop continues with next OpenAI call
        } else {
          // Normal text response, done
          if (textContent) {
            conversationHistory.push({
              role: "assistant",
              content: textContent,
            });
          }
          sendToTab(tabId, { type: "STREAM_DONE" });
          continueLoop = false;
        }
      } catch (e) {
        console.error("[Shift BG] Error:", e);
        sendToTab(tabId, {
          type: "ERROR",
          message: e.message || "Unknown error",
        });
        continueLoop = false;
      }
    }

    await saveConversation();
  }

  // ── Process SSE Stream ──────────────────────────────
  async function processStream(response, tabId) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let textContent = "";
    let toolCalls = [];
    let finishReason = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (_) {
          continue;
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        // Text content
        if (delta?.content) {
          textContent += delta.content;
          sendToTab(tabId, { type: "STREAM_DELTA", text: delta.content });
        }

        // Tool calls (accumulate chunks)
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: "",
                function: { name: "", arguments: "" },
              };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name)
              toolCalls[idx].function.name = tc.function.name;
            if (tc.function?.arguments)
              toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    }

    return { textContent, toolCalls: toolCalls.filter(Boolean), finishReason };
  }

  // ── Execute Tool Calls ──────────────────────────────
  async function executeToolCalls(toolCalls, tabId) {
    const results = await Promise.all(
      toolCalls.map(async (tc) => {
        let args;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch (_) {
          return { callId: tc.id, data: { error: "Invalid tool arguments" } };
        }

        // show_dish_cards is a UI-only tool — no API call needed
        if (tc.function.name === "show_dish_cards") {
          sendToTab(tabId, { type: "DISH_CARDS", dishes: args.dishes || [] });
          return {
            callId: tc.id,
            data: { displayed: true, count: (args.dishes || []).length },
          };
        }

        // API-calling tools: delegate to content script
        sendToTab(tabId, {
          type: "TOOL_STATUS",
          name: tc.function.name,
          args,
        });

        return new Promise((resolve) => {
          pendingToolCalls.set(tc.id, resolve);
          sendToTab(tabId, {
            type: "EXECUTE_TOOL",
            callId: tc.id,
            name: tc.function.name,
            args,
          });

          // Safety timeout (15s)
          setTimeout(() => {
            if (pendingToolCalls.has(tc.id)) {
              pendingToolCalls.delete(tc.id);
              resolve({
                callId: tc.id,
                data: { error: "Tool call timed out" },
              });
            }
          }, 15000);
        });
      })
    );

    return results;
  }

  console.log("[Shift 2026] Background service worker loaded");
})();
