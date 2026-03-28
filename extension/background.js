// Shift 2026 - Service Worker (background.js)
// OpenAI streaming + tool calling orchestration

importScripts("config.js");

(function () {
  "use strict";

  const apiKey = CONFIG.API_KEY;
  const apiBase = CONFIG.API_BASE;
  let conversationHistory = [];
  const pendingToolCalls = new Map();
  const MODEL = CONFIG.MODEL;

  // ── System Prompt ───────────────────────────────────
  const SYSTEM_PROMPT = `Tu es un assistant de decouverte de plats integre a Uber Eats. Tu GUIDES l'utilisateur vers son plat ideal en un minimum d'echanges. Tu parles francais, tu tutoies.

## Tes outils
- search_restaurants : chercher des restos par query
- get_restaurant_menu : recuperer le menu d'un resto (appelle en parallele sur plusieurs restos)
- show_dish_cards : afficher des plats (en grid si plusieurs, en mode "gagnant" si 1 seul)
- show_top_picks : afficher 3 plats cote a cote pour que l'utilisateur choisisse son prefere (1 clic)
- show_choices : afficher des boutons cliquables pour poser une question (PAS de texte qui attend une reponse)

## Flow guide -- ULTRA IMPORTANT
1. L'utilisateur clique sur un mood ou une categorie. Tu recois ca comme message texte.
2. Si c'est un mood vague (reconfort, festif, etc.), utilise show_choices pour proposer 3-4 sous-categories. UNE SEULE fois max.
3. Si c'est une categorie precise (pizza, sushi, etc.), cherche DIRECTEMENT.
4. Scanne 5 restos en parallele avec get_restaurant_menu.
5. Appelle show_dish_cards avec TOUS les plats pertinents trouves. C'est tout. Pas de top 3, pas de show_top_picks.

## Regles STRICTES
- Utilise show_choices pour poser des questions. JAMAIS de texte qui attend une reponse tapee.
- Prix API en CENTIMES -> convertir en EUROS (diviser par 100) dans show_dish_cards.
- Matching SEMANTIQUE : "chevre miel" = plats avec chevre ET miel meme si le nom est different.
- Texte ULTRA court : 5-10 mots max. Le UI parle pour toi.
- Maximum 1 show_choices entre le choix initial et les resultats.
- Appelle get_restaurant_menu en PARALLELE (5 restos a la fois).
- Quand l'utilisateur selectionne PLUSIEURS categories (ex: "pizza, burger"), cherche dans TOUTES et compare les meilleurs de chaque.
- Quand l'utilisateur demande PLUSIEURS produits pour une seule commande (ex: "pizza avec coca et cookie"), privilegie les restos capables de couvrir le panier complet et renvoie plusieurs plats du MEME resto dans show_dish_cards.
- Va VITE. Cherche, scanne, affiche. Pas d'etape intermediaire inutile.`;

  // ── Tool Definitions ────────────────────────────────
  const TOOLS = [
    {
      type: "function",
      function: {
        name: "search_restaurants",
        description:
          "Search Uber Eats restaurants by query. Returns name, rating, ETA, delivery fee, UUID.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Dish name, cuisine type, or restaurant name",
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
          "Get full menu of a restaurant. Returns items with title, description, price (cents), section, image URL.",
        parameters: {
          type: "object",
          properties: {
            store_uuid: { type: "string", description: "Restaurant UUID" },
            store_name: { type: "string", description: "Restaurant name" },
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
          "Display dish cards. If 1 dish: shows as winner reveal. If multiple dishes come from the same restaurant, the UI groups them on one restaurant row. ALWAYS use for presenting dishes visually.",
        parameters: {
          type: "object",
          properties: {
            dishes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  price: { type: "number", description: "Price in EUROS" },
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
    {
      type: "function",
      function: {
        name: "show_top_picks",
        description:
          "Present exactly 3 dishes side by side for the user to pick their favorite in ONE click. Use this as the final selection step after scanning menus. The user clicks their preferred dish and the winner is returned to you. Then call show_dish_cards with that single winner dish.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Title like 'Nos 3 meilleures trouvailles'",
            },
            dishes: {
              type: "array",
              description: "Exactly 3 dishes to compare",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  price: { type: "number", description: "Price in EUROS" },
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
    {
      type: "function",
      function: {
        name: "show_choices",
        description:
          "Present clickable options to the user. Use this INSTEAD of asking text questions. The user clicks one option and the result is returned to you. Use for sub-categories, moods, preferences, dietary constraints.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Question to display, e.g. 'Plutot quoi ?'",
            },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  icon: { type: "string", description: "Emoji (optional)" },
                  value: { type: "string", description: "Value returned on click" },
                },
                required: ["label", "value"],
              },
              description: "2-6 clickable options",
            },
            allow_multiple: {
              type: "boolean",
              description: "If true, user can select multiple before confirming",
            },
          },
          required: ["title", "options"],
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
  chrome.runtime.onMessage.addListener((msg, sender) => {
    const tabId = sender.tab?.id;
    switch (msg.type) {
      case "CONTENT_READY":
        sendToTab(tabId, { type: "CONVERSATION_HISTORY", messages: conversationHistory });
        break;
      case "CHAT_MESSAGE":
        handleChat(msg.text, tabId);
        break;
      case "TOOL_RESULT": {
        const resolve = pendingToolCalls.get(msg.callId);
        if (resolve) {
          resolve({ callId: msg.callId, data: msg.result });
          pendingToolCalls.delete(msg.callId);
        }
        break;
      }
      case "RESET_CONVERSATION":
        conversationHistory = [];
        chrome.storage.local.remove("conversation");
        break;
    }
    return true;
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
        const response = await fetch(`${apiBase}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: "system", content: SYSTEM_PROMPT }, ...conversationHistory],
            tools: TOOLS,
            stream: true,
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          sendToTab(tabId, { type: "ERROR", message: `API ${response.status}: ${errText.substring(0, 200)}` });
          return;
        }

        const { textContent, toolCalls, finishReason } = await processStream(response, tabId);

        if (finishReason === "tool_calls" && toolCalls.length > 0) {
          conversationHistory.push({
            role: "assistant",
            content: textContent || null,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id, type: "function",
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
          });
          const results = await executeToolCalls(toolCalls, tabId);
          for (const r of results) {
            conversationHistory.push({ role: "tool", tool_call_id: r.callId, content: JSON.stringify(r.data) });
          }
        } else {
          if (textContent) conversationHistory.push({ role: "assistant", content: textContent });
          sendToTab(tabId, { type: "STREAM_DONE" });
          continueLoop = false;
        }
      } catch (e) {
        console.error("[Shift BG]", e);
        sendToTab(tabId, { type: "ERROR", message: e.message || "Unknown error" });
        continueLoop = false;
      }
    }
    await saveConversation();
  }

  // ── Process SSE Stream ──────────────────────────────
  async function processStream(response, tabId) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", textContent = "", finishReason = null;
    const toolCalls = [];

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
        try { parsed = JSON.parse(data); } catch (_) { continue; }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (choice.delta?.content) {
          textContent += choice.delta.content;
          sendToTab(tabId, { type: "STREAM_DELTA", text: choice.delta.content });
        }
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index;
            if (!toolCalls[idx]) toolCalls[idx] = { id: "", function: { name: "", arguments: "" } };
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    }
    return { textContent, toolCalls: toolCalls.filter(Boolean), finishReason };
  }

  // ── Execute Tool Calls ──────────────────────────────
  async function executeToolCalls(toolCalls, tabId) {
    return Promise.all(
      toolCalls.map(async (tc) => {
        let args;
        try { args = JSON.parse(tc.function.arguments); }
        catch (_) { return { callId: tc.id, data: { error: "Invalid arguments" } }; }

        // UI-only: show_dish_cards (instant)
        if (tc.function.name === "show_dish_cards") {
          sendToTab(tabId, { type: "DISH_CARDS", dishes: args.dishes || [] });
          return { callId: tc.id, data: { displayed: true, count: (args.dishes || []).length } };
        }

        // UI + wait: show_top_picks (waits for user pick)
        if (tc.function.name === "show_top_picks") {
          return new Promise((resolve) => {
            pendingToolCalls.set(tc.id, resolve);
            sendToTab(tabId, {
              type: "SHOW_TOP_PICKS",
              callId: tc.id,
              title: args.title || "Lequel te fait envie ?",
              dishes: args.dishes || [],
            });
            setTimeout(() => {
              if (pendingToolCalls.has(tc.id)) {
                pendingToolCalls.delete(tc.id);
                resolve({ callId: tc.id, data: { error: "No selection" } });
              }
            }, 60000);
          });
        }

        // UI + wait: show_choices (waits for user click)
        if (tc.function.name === "show_choices") {
          return new Promise((resolve) => {
            pendingToolCalls.set(tc.id, resolve);
            sendToTab(tabId, {
              type: "SHOW_CHOICES",
              callId: tc.id,
              title: args.title || "",
              options: args.options || [],
              allowMultiple: args.allow_multiple || false,
            });
            setTimeout(() => {
              if (pendingToolCalls.has(tc.id)) {
                pendingToolCalls.delete(tc.id);
                resolve({ callId: tc.id, data: { error: "No selection" } });
              }
            }, 60000);
          });
        }

        // API tools: delegate to content script
        sendToTab(tabId, { type: "TOOL_STATUS", name: tc.function.name, args });
        return new Promise((resolve) => {
          pendingToolCalls.set(tc.id, resolve);
          sendToTab(tabId, { type: "EXECUTE_TOOL", callId: tc.id, name: tc.function.name, args });
          setTimeout(() => {
            if (pendingToolCalls.has(tc.id)) {
              pendingToolCalls.delete(tc.id);
              resolve({ callId: tc.id, data: { error: "Timeout" } });
            }
          }, 15000);
        });
      })
    );
  }

  console.log("[Shift 2026] Background loaded");
})();
