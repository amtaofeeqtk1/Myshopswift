"use strict";

// Controlled tools the AI model may call. This file is the ONLY thing standing
// between the model and the catalogue / cart: the model can ask, but every
// argument is validated here against the live catalogue before anything
// happens. The model never supplies a price, name or image — those are always
// read from the catalogue row.

const catalogue = require("./catalogue-search");

const MAX_QTY_PER_ADD = 50;          // one "add to cart" action
const MAX_CART_ACTIONS_PER_TURN = 3; // one chat request can queue at most this many
const MAX_TOOL_CALLS_PER_ROUND = 4;

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "Search the real MyShopSwift catalogue. Use this before recommending anything. " +
        "Pass several related keywords (synonyms, ingredients, product types) to cast a useful net. " +
        "Returns only products that exist, with their real prices.",
      parameters: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            maxItems: 8,
            description: "Search terms, e.g. [\"oats\", \"cereal\"]. Matched against name, brand, category and description."
          },
          category: { type: "string", description: "Exact category name from list_categories (optional)." },
          brand: { type: "string", description: "Brand name to restrict results to (optional)." },
          min_price: { type: "number", description: "Minimum price in GBP (optional)." },
          max_price: { type: "number", description: "Maximum price in GBP (optional)." },
          sort: { type: "string", enum: ["relevance", "price_asc", "price_desc"], description: "Default relevance." },
          limit: { type: "integer", minimum: 1, maximum: 10, description: "Default 6." }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_product_details",
      description: "Get the full details of one product by its id (as returned by search_products).",
      parameters: {
        type: "object",
        properties: { product_id: { type: "integer" } },
        required: ["product_id"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_categories",
      description: "List the catalogue's categories and how many products each holds. Use it to understand what the shop sells.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  },
  {
    type: "function",
    function: {
      name: "add_to_cart",
      description:
        "Add a product to the customer's basket. ONLY call this after you have told the customer exactly what will be added " +
        "(product, quantity, price) and they have agreed in their most recent message. If the product requires a brand, " +
        "the customer must have chosen one of its listed brands. The server validates everything; you cannot set prices.",
      parameters: {
        type: "object",
        properties: {
          product_id: { type: "integer" },
          quantity: { type: "integer", minimum: 1, maximum: MAX_QTY_PER_ADD },
          brand: { type: "string", description: "Required when the product has brands; must be one of them exactly." },
          customer_confirmed: {
            type: "boolean",
            description: "true only if the customer explicitly agreed to this exact addition in their latest message."
          }
        },
        required: ["product_id", "quantity", "customer_confirmed"],
        additionalProperties: false
      }
    }
  }
];

function isPositiveInt(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function parseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function optionalNumber(v) {
  if (v === undefined || v === null || v === "") return { ok: true, value: undefined };
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100000) return { ok: false };
  return { ok: true, value: v };
}

/**
 * createToolRunner({ loadCatalogue, turn })
 *   loadCatalogue({ fresh }) -> { categories, products }
 *   turn  — per-request state the tools write to:
 *           { surfacedIds: Set<number>, cartActions: [] }
 * Returns runTool(name, rawArguments) -> plain JSON-able result. Never throws
 * for bad model input; it returns { ok:false, error } so the model can recover.
 */
function createToolRunner({ loadCatalogue, turn }) {
  async function searchProducts(args) {
    const min = optionalNumber(args.min_price);
    const max = optionalNumber(args.max_price);
    if (!min.ok || !max.ok) return { ok: false, error: "min_price and max_price must be non-negative numbers." };
    if (args.keywords !== undefined && !Array.isArray(args.keywords)) return { ok: false, error: "keywords must be an array of strings." };
    const keywords = (args.keywords || []).filter(k => typeof k === "string").slice(0, 8).map(k => k.slice(0, 60));

    const cat = await loadCatalogue({ fresh: false });
    const result = catalogue.search(cat, {
      keywords,
      category: typeof args.category === "string" ? args.category.slice(0, 80) : "",
      brand: typeof args.brand === "string" ? args.brand.slice(0, 80) : "",
      min_price: min.value,
      max_price: max.value,
      sort: ["relevance", "price_asc", "price_desc"].includes(args.sort) ? args.sort : "relevance",
      limit: args.limit
    });
    if (result.error) return { ok: false, error: result.error };
    for (const p of result.products) turn.surfacedIds.add(p.id);
    return { ok: true, ...result };
  }

  async function getProductDetails(args) {
    if (!isPositiveInt(args.product_id)) return { ok: false, error: "product_id must be a positive integer." };
    const cat = await loadCatalogue({ fresh: false });
    const p = catalogue.findProduct(cat, args.product_id);
    if (!p) return { ok: false, error: "No product with that id exists in the catalogue." };
    turn.surfacedIds.add(p.id);
    return { ok: true, product: catalogue.toModelView(p) };
  }

  async function listCategories() {
    const cat = await loadCatalogue({ fresh: false });
    return { ok: true, categories: catalogue.listCategories(cat) };
  }

  async function addToCart(args) {
    if (!isPositiveInt(args.product_id)) return { ok: false, code: "INVALID_PRODUCT", error: "product_id must be a positive integer." };
    if (!isPositiveInt(args.quantity) || args.quantity > MAX_QTY_PER_ADD) {
      return { ok: false, code: "INVALID_QUANTITY", error: `quantity must be a whole number from 1 to ${MAX_QTY_PER_ADD}.` };
    }
    if (args.customer_confirmed !== true) {
      return { ok: false, code: "CONFIRMATION_REQUIRED", error: "The customer has not confirmed. Tell them exactly what you would add (product, quantity, price) and ask them to confirm." };
    }
    if (turn.cartActions.length >= MAX_CART_ACTIONS_PER_TURN) {
      return { ok: false, code: "TOO_MANY_ACTIONS", error: "Too many additions in one message. Ask the customer to continue in a new message." };
    }

    // Always validate against a fresh read — never a cached copy — so a product
    // the shop just removed or repriced can't slip through.
    const cat = await loadCatalogue({ fresh: true });
    const p = catalogue.findProduct(cat, args.product_id);
    if (!p) return { ok: false, code: "PRODUCT_NOT_FOUND", error: "That product is not currently in the catalogue." };
    if (typeof p.price !== "number" || !Number.isFinite(p.price) || p.price < 0) {
      return { ok: false, code: "PRODUCT_UNAVAILABLE", error: "That product cannot be added right now." };
    }

    const brands = catalogue.productBrands(p);
    let brand = "";
    if (brands.length) {
      const supplied = typeof args.brand === "string" ? args.brand.trim() : "";
      if (!supplied) {
        return { ok: false, code: "BRAND_REQUIRED", error: `This product needs a brand. Ask the customer to choose one of: ${brands.join(", ")}.`, brands };
      }
      const match = brands.find(b => b === supplied) || brands.find(b => b.toLowerCase() === supplied.toLowerCase());
      if (!match) {
        return { ok: false, code: "INVALID_BRAND", error: `"${supplied.slice(0, 40)}" is not an available brand. Options: ${brands.join(", ")}.`, brands };
      }
      brand = match;
    }

    const action = {
      productId: p.id,
      name: p.name,
      unitPrice: p.price, // for display only; the storefront re-reads the price from its own catalogue
      quantity: args.quantity,
      brand
    };
    turn.cartActions.push(action);
    turn.surfacedIds.add(p.id);
    return {
      ok: true,
      added: { ...action, line_total: Math.round(p.price * args.quantity * 100) / 100 },
      note: "This will be added to the customer's basket as soon as your reply is delivered."
    };
  }

  const handlers = {
    search_products: searchProducts,
    get_product_details: getProductDetails,
    list_categories: listCategories,
    add_to_cart: addToCart
  };

  return async function runTool(name, rawArguments) {
    const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : null;
    if (!handler) return { ok: false, error: "Unknown tool." };
    const args = parseArgs(rawArguments);
    if (!args) return { ok: false, error: "Arguments must be a JSON object." };
    return handler(args);
  };
}

module.exports = { TOOL_DEFINITIONS, createToolRunner, MAX_QTY_PER_ADD, MAX_CART_ACTIONS_PER_TURN, MAX_TOOL_CALLS_PER_ROUND };
