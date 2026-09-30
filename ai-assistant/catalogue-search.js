"use strict";

// Catalogue search for the AI assistant.
//
// Pure functions over the { categories, products } object that server.js's
// getCatalogue() already returns (the same data /api/products serves). Nothing
// here touches the database or the network, and nothing is ever invented: every
// value that leaves this module is copied from a real catalogue row.

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 10;

const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "for", "from", "i", "in", "me", "my", "need",
  "of", "on", "or", "some", "something", "the", "to", "want", "with", "you"
]);

function fold(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Very light stemming so "tomatoes"/"tomato" and "chips"/"chip" line up.
function stem(token) {
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 4 && token.endsWith("oes")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokens(text, { dropStopwords = false } = {}) {
  const out = [];
  for (const raw of fold(text).split(" ")) {
    if (!raw) continue;
    if (dropStopwords && STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

function productBrands(p) {
  return Array.isArray(p.brands) ? p.brands.map(b => String(b).trim()).filter(Boolean) : [];
}

function truncate(text, max) {
  const s = String(text || "").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// Compact shape handed to the model. No image path, nothing it doesn't need.
function toModelView(p) {
  const brands = productBrands(p);
  const out = {
    id: p.id,
    name: p.name,
    category: p.cat,
    price: p.price,
    requires_brand: brands.length > 0
  };
  if (brands.length) out.brands = brands;
  if (typeof p.old === "number" && p.old > p.price) out.was_price = p.old;
  if (p.tag) out.tag = p.tag;
  if (p.description) out.description = truncate(p.description, 160);
  return out;
}

// Shape sent to the browser to draw a product card. Built from the catalogue
// row by id — the model never supplies any of these values.
function toCard(p) {
  return {
    id: p.id,
    name: p.name,
    category: p.cat,
    price: p.price,
    oldPrice: typeof p.old === "number" && p.old > p.price ? p.old : null,
    image: p.image || "",
    tag: p.tag || "",
    description: truncate(p.description, 110),
    brands: productBrands(p)
  };
}

function findProduct(catalogue, id) {
  return catalogue.products.find(p => p.id === id) || null;
}

function listCategories(catalogue) {
  const counts = new Map();
  for (const p of catalogue.products) counts.set(p.cat, (counts.get(p.cat) || 0) + 1);
  const out = catalogue.categories.map(c => ({ name: c.name, product_count: counts.get(c.name) || 0 }));
  // A product whose category isn't in the categories table still shows up.
  for (const [name, n] of counts) {
    if (name && !out.some(c => c.name === name)) out.push({ name, product_count: n });
  }
  return out.filter(c => c.product_count > 0);
}

function resolveCategory(catalogue, wanted) {
  const w = fold(wanted);
  if (!w) return { name: null };
  const names = listCategories(catalogue).map(c => c.name);
  const byId = catalogue.categories.find(c => fold(c.id) === w);
  if (byId) return { name: byId.name };
  const exact = names.find(n => fold(n) === w);
  if (exact) return { name: exact };
  const wt = tokens(w, { dropStopwords: true });
  const loose = names.find(n => {
    const nt = tokens(n, { dropStopwords: true });
    return wt.length > 0 && wt.every(t => nt.includes(t));
  });
  return loose ? { name: loose } : { name: null, unknown: true, available: names };
}

function matchesBrand(p, wantedBrand) {
  const w = fold(wantedBrand);
  if (!w) return true;
  if (productBrands(p).some(b => fold(b) === w || fold(b).includes(w))) return true;
  // Most products carry their brand in the name ("Skippy Peanut Butter…").
  return (" " + fold(p.name) + " ").includes(" " + w + " ");
}

function scoreProduct(p, keywords) {
  const nameT = tokens(p.name);
  const brandT = productBrands(p).flatMap(b => tokens(b));
  const catT = tokens(p.cat);
  const descT = tokens(p.description);

  const fieldScore = (fieldTokens, k, exactPts, prefixPts) => {
    if (fieldTokens.includes(k)) return exactPts;
    if (k.length >= 4 && fieldTokens.some(t => t.startsWith(k) || (t.length >= 4 && k.startsWith(t)))) return prefixPts;
    return 0;
  };

  let total = 0;
  for (const k of keywords) {
    total += Math.max(
      fieldScore(nameT, k, 5, 3),
      fieldScore(brandT, k, 4, 2),
      fieldScore(catT, k, 2, 1),
      fieldScore(descT, k, 1, 0)
    );
  }
  return total;
}

/**
 * search(catalogue, criteria) — criteria:
 *   keywords   string[]  OR-matched search terms (the model may pass synonyms)
 *   category   string    category name or id
 *   brand      string
 *   min_price / max_price  number (GBP, inclusive)
 *   sort       "relevance" | "price_asc" | "price_desc"
 *   limit      number (default 6, max 10)
 */
function search(catalogue, criteria = {}) {
  const keywords = [];
  for (const kw of Array.isArray(criteria.keywords) ? criteria.keywords : []) {
    for (const t of tokens(kw, { dropStopwords: true })) if (!keywords.includes(t)) keywords.push(t);
  }
  const hasCategory = !!fold(criteria.category);
  const hasBrand = !!fold(criteria.brand);
  const hasMin = typeof criteria.min_price === "number";
  const hasMax = typeof criteria.max_price === "number";

  if (!keywords.length && !hasCategory && !hasBrand && !hasMin && !hasMax) {
    return { error: "Give at least one keyword, category, brand or price limit to search with." };
  }

  const notes = [];
  let pool = catalogue.products;

  if (hasCategory) {
    const cat = resolveCategory(catalogue, criteria.category);
    if (cat.unknown) {
      return { total_matches: 0, returned: 0, products: [], notes: ["That category does not exist."], available_categories: cat.available };
    }
    pool = pool.filter(p => p.cat === cat.name);
  }
  if (hasBrand) pool = pool.filter(p => matchesBrand(p, criteria.brand));
  if (hasMin) pool = pool.filter(p => p.price >= criteria.min_price - 1e-9);
  if (hasMax) pool = pool.filter(p => p.price <= criteria.max_price + 1e-9);

  let ranked;
  if (keywords.length) {
    ranked = pool
      .map(p => ({ p, score: scoreProduct(p, keywords) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || a.p.price - b.p.price || a.p.id - b.p.id);
  } else {
    ranked = pool.map(p => ({ p, score: 0 })).sort((a, b) => a.p.price - b.p.price || a.p.id - b.p.id);
  }

  if (criteria.sort === "price_asc") ranked.sort((a, b) => a.p.price - b.p.price || a.p.id - b.p.id);
  else if (criteria.sort === "price_desc") ranked.sort((a, b) => b.p.price - a.p.price || a.p.id - b.p.id);

  const limit = Math.min(Math.max(parseInt(criteria.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const shown = ranked.slice(0, limit).map(x => x.p);
  if (!ranked.length) notes.push("No products in the catalogue match these criteria.");

  return {
    total_matches: ranked.length,
    returned: shown.length,
    products: shown.map(toModelView),
    notes
  };
}

module.exports = {
  DEFAULT_LIMIT, MAX_LIMIT,
  search, findProduct, listCategories, resolveCategory, productBrands,
  toModelView, toCard, fold, tokens
};
