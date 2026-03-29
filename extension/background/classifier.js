// Shift 2026 — Query classifier (no LLM needed)

const MOOD_SEARCHES = {
  reconfort: ["comfort food", "gratin", "pates", "soupe"],
  leger: ["salade", "poke bowl", "healthy", "wrap"],
  festif: ["tapas", "cocktail", "brunch", "planche"],
  rapide: ["fast food", "sandwich", "wrap", "kebab"],
  gourmand: ["burger", "dessert", "pizza", "brunch"],
};

const FOOD_KEYWORDS = new Set([
  "pizza", "burger", "sushi", "kebab", "tacos", "poke", "bowl",
  "pasta", "pates", "ramen", "noodle", "curry", "naan",
  "salade", "wrap", "sandwich", "panini", "croque",
  "poulet", "chicken", "boeuf", "steak", "poisson", "saumon",
  "frites", "nuggets", "tenders", "wings",
  "dessert", "cookie", "brownie", "tiramisu", "glace", "gateau",
  "chevre", "mozzarella", "cheddar", "fromage",
  "vegan", "veggie", "vegetarien", "halal", "casher",
  "thai", "japonais", "chinois", "indien", "mexicain", "italien",
  "asiatique", "libanais", "grec", "coreen",
  "brunch", "petit-dejeuner", "breakfast",
  "coca", "boisson", "jus", "smoothie", "cafe", "the",
  "healthy", "light", "bio", "sans gluten",
]);

const FOLLOWUP_PATTERNS = /^(moins|plus|autre|sans |avec |pas de |encore|pareil|meme |different|change|et aussi|aussi )/i;

const MULTI_ITEM_PATTERNS = /\b(avec|et|puis|plus|accompagn)/i;

function classify(text) {
  const raw = text.trim();
  const lower = raw.toLowerCase();

  // 1. Parse structured UI input: "Humeur : X" / "Cuisines : X"
  const moodMatch = lower.match(/humeur\s*:\s*(.+?)(?:\.|$)/);
  const catMatch = lower.match(/cuisines?\s*:\s*(.+?)(?:\.|$)/);

  if (moodMatch || catMatch) {
    const terms = [];
    if (moodMatch) {
      const moods = moodMatch[1].split(",").map((s) => s.trim());
      for (const m of moods) {
        const searches = MOOD_SEARCHES[m];
        if (searches) terms.push(...searches);
        else terms.push(m);
      }
    }
    if (catMatch) {
      const cats = catMatch[1].split(",").map((s) => s.trim());
      terms.push(...cats);
    }
    return { type: "DIRECT", terms, raw };
  }

  // 2. Follow-up detection
  if (FOLLOWUP_PATTERNS.test(lower)) {
    return { type: "FOLLOWUP", terms: [], raw };
  }

  // 3. Known mood
  for (const [mood, searches] of Object.entries(MOOD_SEARCHES)) {
    if (lower === mood || lower.includes(mood)) {
      return { type: "MOOD", terms: [...searches], raw };
    }
  }

  // 4. Direct food query — check if any word matches food keywords
  const words = lower.split(/[\s,.']+/);
  const matched = words.filter((w) => FOOD_KEYWORDS.has(w));
  if (matched.length > 0) {
    // Multi-item? Split into separate search terms
    if (MULTI_ITEM_PATTERNS.test(lower)) {
      // Extract food terms as separate searches
      return { type: "DIRECT", terms: matched, raw, multiItem: true };
    }
    return { type: "DIRECT", terms: [raw], raw };
  }

  // 5. Freeform — needs LLM to expand
  return { type: "FREEFORM", terms: [], raw };
}
