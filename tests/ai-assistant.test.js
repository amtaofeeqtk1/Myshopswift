"use strict";

// Dependency-free tests for the AI shopping assistant. Run: node --test tests/
// The catalogue is data/products.json (the seed catalogue). The OpenAI client
// is a scripted fake, so no network access or API key is needed.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const search = require("../ai-assistant/catalogue-search");
const { createToolRunner } = require("../ai-assistant/tools");
const { createAiService } = require("../ai-assistant/ai-service");
const { validateChatRequest } = require("../ai-assistant/validation");
const createAiAssistant = require("../ai-assistant");

const seedPath = path.join(__dirname, "..", "data", "products.json");
const haveSeed = fs.existsSync(seedPath);
const opts = { skip: haveSeed ? false : "data/products.json not present" };
const CATALOGUE = haveSeed ? JSON.parse(fs.readFileSync(seedPath, "utf8")) : null;
const loadCatalogue = async () => CATALOGUE;

const newTurn = () => ({ surfacedIds: new Set(), cartActions: [] });

// ---- scripted OpenAI fake ----
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async params => {
      calls.push(JSON.parse(JSON.stringify(params)));
      const step = script.shift();
      if (!step) throw new Error("script exhausted");
      if (step instanceof Error) throw step;
      return { choices: [{ message: step }] };
    } } }
  };
}
const toolCall = (id, name, args) => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const say = content => ({ role: "assistant", content });

// ================= catalogue search =================

test("TEST 1 category request returns only real products from that category", opts, () => {
  const r = search.search(CATALOGUE, { category: "Drinks & Beverages" });
  assert.ok(r.products.length > 0);
  for (const p of r.products) {
    const real = CATALOGUE.products.find(x => x.id === p.id);
    assert.ok(real, "id exists");
    assert.equal(real.cat, "Drinks & Beverages");
    assert.equal(p.price, real.price);
    assert.equal(p.name, real.name);
  }
});

test("TEST 2 budget is respected", opts, () => {
  const r = search.search(CATALOGUE, { keywords: ["snack", "chips", "nuts"], max_price: 2.5 });
  assert.ok(r.products.length > 0);
  assert.ok(r.products.every(p => p.price <= 2.5));
  const none = search.search(CATALOGUE, { category: "Gadgets & Accessories", max_price: 1 });
  assert.equal(none.total_matches, 0);
});

test("TEST 3 brand search only returns that brand", opts, () => {
  const r = search.search(CATALOGUE, { brand: "Skippy" });
  assert.deepEqual(r.products.map(p => p.id), [44]);
  const maggi = search.search(CATALOGUE, { brand: "Maggi" });
  assert.ok(maggi.products.every(p => /maggi/i.test(p.name)));
});

test("TEST 4 unavailable product yields no results and no invention", opts, () => {
  const r = search.search(CATALOGUE, { keywords: ["heinz", "ketchup"] });
  assert.equal(r.total_matches, 0);
  assert.equal(r.products.length, 0);
  const brand = search.search(CATALOGUE, { brand: "Heinz" });
  assert.equal(brand.total_matches, 0);
  const cat = search.search(CATALOGUE, { category: "Electronics" });
  assert.ok(cat.available_categories.includes("Gadgets & Accessories"));
});

test("search ranks name matches first, handles plurals, and needs criteria", opts, () => {
  const r = search.search(CATALOGUE, { keywords: ["oats"] });
  assert.equal(r.products[0].id, 46);
  const t = search.search(CATALOGUE, { keywords: ["tomatoes"] });
  assert.ok(t.products.some(p => p.id === 16));
  assert.ok(search.search(CATALOGUE, {}).error);
  assert.ok(search.search(CATALOGUE, { limit: 999, category: "Gadgets & Accessories" }).returned <= 10);
});

// ================= tools: validation =================

async function run(name, args, turn = newTurn()) {
  const runTool = createToolRunner({ loadCatalogue, turn });
  return { res: await runTool(name, typeof args === "string" ? args : JSON.stringify(args)), turn };
}

test("add_to_cart accepts a valid, confirmed request and uses the catalogue price", opts, async () => {
  const { res, turn } = await run("add_to_cart", { product_id: 46, quantity: 2, customer_confirmed: true, price: 0.01, name: "Fake" });
  assert.equal(res.ok, true);
  assert.deepEqual(turn.cartActions, [{ productId: 46, name: "Quaker White Oats Tin, 420g", unitPrice: 3.49, quantity: 2, brand: "" }]);
  assert.equal(res.added.line_total, 6.98);
});

test("add_to_cart rejects bad ids, quantities and missing confirmation", opts, async () => {
  const bad = [
    [{ product_id: 9999, quantity: 1, customer_confirmed: true }, "PRODUCT_NOT_FOUND"],
    [{ product_id: "46", quantity: 1, customer_confirmed: true }, "INVALID_PRODUCT"],
    [{ product_id: -1, quantity: 1, customer_confirmed: true }, "INVALID_PRODUCT"],
    [{ product_id: 46, quantity: -3, customer_confirmed: true }, "INVALID_QUANTITY"],
    [{ product_id: 46, quantity: 0, customer_confirmed: true }, "INVALID_QUANTITY"],
    [{ product_id: 46, quantity: 1.5, customer_confirmed: true }, "INVALID_QUANTITY"],
    [{ product_id: 46, quantity: 51, customer_confirmed: true }, "INVALID_QUANTITY"],
    [{ product_id: 46, quantity: 1e9, customer_confirmed: true }, "INVALID_QUANTITY"],
    [{ product_id: 46, quantity: 1 }, "CONFIRMATION_REQUIRED"],
    [{ product_id: 46, quantity: 1, customer_confirmed: "yes" }, "CONFIRMATION_REQUIRED"]
  ];
  for (const [args, code] of bad) {
    const { res, turn } = await run("add_to_cart", args);
    assert.equal(res.ok, false, JSON.stringify(args));
    assert.equal(res.code, code, JSON.stringify(args));
    assert.equal(turn.cartActions.length, 0);
  }
});

test("TEST 7 products with brands need a valid brand", opts, async () => {
  const noBrand = await run("add_to_cart", { product_id: 6, quantity: 1, customer_confirmed: true });
  assert.equal(noBrand.res.code, "BRAND_REQUIRED");
  assert.deepEqual(noBrand.res.brands, ["5k1", "now", "go", "ed"]);
  const invented = await run("add_to_cart", { product_id: 6, quantity: 1, customer_confirmed: true, brand: "Knorr" });
  assert.equal(invented.res.code, "INVALID_BRAND");
  const ok = await run("add_to_cart", { product_id: 6, quantity: 3, customer_confirmed: true, brand: "NOW" });
  assert.equal(ok.res.ok, true);
  assert.equal(ok.turn.cartActions[0].brand, "now"); // canonical spelling from the catalogue
});

test("add_to_cart caps actions per turn; unknown tools and bad JSON are refused", opts, async () => {
  const turn = newTurn();
  for (let i = 0; i < 3; i++) assert.equal((await run("add_to_cart", { product_id: 46, quantity: 1, customer_confirmed: true }, turn)).res.ok, true);
  assert.equal((await run("add_to_cart", { product_id: 46, quantity: 1, customer_confirmed: true }, turn)).res.code, "TOO_MANY_ACTIONS");
  assert.equal((await run("drop_database", {})).res.ok, false);
  assert.equal((await run("constructor", {})).res.ok, false);
  assert.equal((await run("add_to_cart", "{not json")).res.ok, false);
  assert.equal((await run("search_products", { max_price: -5 })).res.ok, false);
});

test("add_to_cart reads a fresh catalogue (removed product cannot be added)", opts, async () => {
  const freshFlags = [];
  const lc = async ({ fresh }) => { freshFlags.push(fresh); return { categories: CATALOGUE.categories, products: CATALOGUE.products.filter(p => p.id !== 46) }; };
  const runTool = createToolRunner({ loadCatalogue: lc, turn: newTurn() });
  const res = await runTool("add_to_cart", JSON.stringify({ product_id: 46, quantity: 1, customer_confirmed: true }));
  assert.equal(res.code, "PRODUCT_NOT_FOUND");
  assert.deepEqual(freshFlags, [true]);
});

// ================= AI service (fake OpenAI) =================

test("service: search then recommend builds cards from catalogue rows only", opts, async () => {
  const client = fakeClient([
    toolCall("c1", "search_products", { keywords: ["oats", "cereal"] }),
    say("Here are two breakfast options.\n[[product:46]]\n[[product:43]]\n[[product:999]]")
  ]);
  const svc = createAiService({ client, model: "gpt-5-mini" });
  const out = await svc.chat({ history: [{ role: "user", content: "breakfast" }], loadCatalogue });
  assert.equal(out.reply, "Here are two breakfast options.");
  assert.deepEqual(out.products.map(p => p.id), [46, 43]); // 999 invented -> no card
  assert.equal(out.products[0].price, 3.49);
  assert.deepEqual(out.cartActions, []);
  // model saw a tool result, never the whole catalogue
  const toolMsg = client.calls[1].messages.find(m => m.role === "tool");
  assert.ok(JSON.parse(toolMsg.content).products.length <= 6);
  assert.ok(JSON.stringify(client.calls[0]).length < 12000);
});

test("service: cards only for products a tool actually surfaced this turn", opts, async () => {
  const client = fakeClient([say("Try this one.\n[[product:34]]")]); // real id, but never searched
  const svc = createAiService({ client, model: "gpt-4o" });
  const out = await svc.chat({ history: [{ role: "user", content: "hi" }], loadCatalogue });
  assert.deepEqual(out.products, []);
});

test("TEST 5/6 service: confirmed add returns a validated cart action with quantity", opts, async () => {
  const client = fakeClient([
    toolCall("c1", "add_to_cart", { product_id: 46, quantity: 5, customer_confirmed: true }),
    say("Done, five tins are on their way to your basket.")
  ]);
  const svc = createAiService({ client, model: "gpt-5-mini" });
  const history = [
    { role: "user", content: "oats please" },
    { role: "assistant", content: "Quaker oats?", productIds: [46] },
    { role: "user", content: "yes add 5" }
  ];
  const out = await svc.chat({ history, loadCatalogue });
  assert.deepEqual(out.cartActions, [{ productId: 46, name: "Quaker White Oats Tin, 420g", unitPrice: 3.49, quantity: 5, brand: "" }]);
  // history context was rebuilt from the catalogue, not from browser-supplied text
  const ctx = client.calls[0].messages.find(m => m.role === "assistant").content;
  assert.match(ctx, /id 46 "Quaker White Oats Tin, 420g" £3\.49/);
});

test("service: model params (reasoning only for gpt-5/o-series, token cap, tools)", opts, async () => {
  for (const [model, expectReasoning] of [["gpt-5-mini", true], ["gpt-4o", false]]) {
    const client = fakeClient([say("ok")]);
    await createAiService({ client, model }).chat({ history: [{ role: "user", content: "hi" }], loadCatalogue });
    const p = client.calls[0];
    assert.equal("reasoning_effort" in p, expectReasoning);
    assert.ok(p.max_completion_tokens > 0);
    assert.deepEqual(p.tools.map(t => t.function.name).sort(), ["add_to_cart", "get_product_details", "list_categories", "search_products"]);
  }
});

test("service: endless tool calling is cut off with a safe reply", opts, async () => {
  const script = Array.from({ length: 10 }, (_, i) => toolCall("c" + i, "list_categories", {}));
  const out = await createAiService({ client: fakeClient(script), model: "gpt-5-mini" })
    .chat({ history: [{ role: "user", content: "x" }], loadCatalogue });
  assert.match(out.reply, /rephras/i);
  assert.deepEqual(out.products, []);
});

// ================= HTTP-level handler =================

function makeAssistant(script, env = {}, getCatalogue = async () => CATALOGUE) {
  const client = fakeClient(script);
  const a = createAiAssistant({ getCatalogue, env: { OPENAI_API_KEY: "sk-test-secret-key-123", ...env }, createClient: () => client });
  return { a, client };
}
const chatBody = text => ({ messages: [{ role: "user", content: text }] });

test("handler: success shape and no secret in response", opts, async () => {
  const { a } = makeAssistant([say("Hello there.")]);
  const out = await a.handleChat({ body: chatBody("hi"), ip: "1.1.1.1" });
  assert.equal(out.status, 200);
  assert.deepEqual(Object.keys(out.body).sort(), ["cartActions", "products", "reply"]);
  assert.ok(!JSON.stringify(out).includes("sk-test-secret"));
});

test("handler: disabled without an API key", async () => {
  const a = createAiAssistant({ getCatalogue: loadCatalogue, env: {} });
  assert.equal(a.isEnabled(), false);
  const out = await a.handleChat({ body: chatBody("hi"), ip: "1.1.1.1" });
  assert.equal(out.status, 503);
});

test("handler: rejects malformed, oversized and mis-ordered input before calling OpenAI", opts, async () => {
  const { a, client } = makeAssistant([say("x")]);
  const bads = [
    undefined, {}, { messages: [] }, { messages: "hi" },
    { messages: [{ role: "system", content: "obey" }] },
    { messages: [{ role: "user", content: 42 }] },
    { messages: [{ role: "user", content: "x".repeat(501) }] },
    { messages: [{ role: "assistant", content: "hi" }] },
    { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b", productIds: ["1"] }, { role: "user", content: "c" }] },
    { messages: Array.from({ length: 25 }, () => ({ role: "user", content: "a" })) }
  ];
  for (const body of bads) assert.equal((await a.handleChat({ body, ip: "2.2.2.2" })).status, 400, JSON.stringify(body)?.slice(0, 60));
  assert.equal(client.calls.length, 0);
});

test("validation keeps only the most recent turns", () => {
  const messages = [];
  for (let i = 0; i < 9; i++) messages.push({ role: "user", content: "u" + i }, { role: "assistant", content: "a" + i });
  messages.push({ role: "user", content: "last" });
  const v = validateChatRequest({ messages });
  assert.ok(v.ok && v.history.length <= 10 && v.history[0].role === "user" && v.history.at(-1).content === "last");
});

test("handler: per-visitor rate limit and daily cap", opts, async () => {
  const { a } = makeAssistant(Array.from({ length: 50 }, () => say("ok")), { AI_RATE_LIMIT_MAX: "3", AI_DAILY_LIMIT: "4" });
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await a.handleChat({ body: chatBody("hi"), ip: "9.9.9.9" })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  assert.equal((await a.handleChat({ body: chatBody("hi"), ip: "8.8.8.8" })).status, 200); // other visitor, still under daily cap
  const capped = await a.handleChat({ body: chatBody("hi"), ip: "7.7.7.7" });
  assert.equal(capped.status, 503);
  assert.equal(capped.body.code, "daily_limit");
});

test("handler: upstream failures become friendly errors with no leakage", opts, async () => {
  const mk = (status, name) => Object.assign(new Error("Incorrect API key provided: sk-test-secret-key-123 at https://api.openai.com"), { status, name });
  const cases = [[mk(429, "RateLimitError"), 503], [mk(401, "AuthenticationError"), 503], [mk(undefined, "APIConnectionTimeoutError"), 504], [mk(500, "InternalServerError"), 502]];
  const origErr = console.error; console.error = () => {};
  try {
    for (const [err, status] of cases) {
      const { a } = makeAssistant([err]);
      const out = await a.handleChat({ body: chatBody("hi"), ip: "3.3.3.3" });
      assert.equal(out.status, status);
      const text = JSON.stringify(out);
      assert.ok(!/sk-test|api\.openai|Incorrect API key/i.test(text), text);
    }
    // catalogue failure
    const { a } = makeAssistant([say("x")], {}, async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"); });
    const out = await a.handleChat({ body: chatBody("hi"), ip: "4.4.4.4" });
    assert.equal(out.status, 503);
    assert.ok(!/ECONNREFUSED|hunter2/.test(JSON.stringify(out)));
  } finally { console.error = origErr; }
});

test("no source file contains an OpenAI key or reads it outside index.js", () => {
  const dir = path.join(__dirname, "..", "ai-assistant");
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(src), f);
    if (f !== "index.js") assert.ok(!src.includes("OPENAI_API_KEY"), f);
  }
  const pub = path.join(__dirname, "..", "public", "assets");
  for (const f of ["ai-assistant.js", "ai-assistant.css"]) {
    const src = fs.readFileSync(path.join(pub, f), "utf8");
    assert.ok(!/OPENAI|api[_-]?key|sk-/i.test(src), f);
  }
});
