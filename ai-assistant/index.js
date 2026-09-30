"use strict";

// AI Shopping Assistant — server entry point.
//
//   const aiAssistant = require("./ai-assistant")({ getCatalogue });
//   app.use("/api/ai-assistant", aiAssistant.router());
//
// Needs OPENAI_API_KEY (server-side env only). Without it the assistant simply
// reports itself as disabled and the storefront hides the widget — nothing else
// on the site is affected. Any failure to start is caught and logged here so it
// can never stop server.js from booting.

const { validateChatRequest } = require("./validation");
const { createAiService, AssistantError } = require("./ai-service");

const CATALOGUE_TTL_MS = 30 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_CONCURRENT = 10;

function intFromEnv(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = function createAiAssistant({ getCatalogue, env = process.env, createClient } = {}) {
  const apiKey = (env.OPENAI_API_KEY || "").trim();
  const model = (env.OPENAI_MODEL || "").trim() || "gpt-6-luna";
  const perUserLimit = intFromEnv(env.AI_RATE_LIMIT_MAX, 30);   // messages per 15 min per visitor
  const dailyLimit = intFromEnv(env.AI_DAILY_LIMIT, 1500);      // messages per day, whole site

  // ---- OpenAI client (server-side only) ----
  let service = null;
  if (apiKey || createClient) {
    try {
      const client = createClient
        ? createClient()
        : new (require("openai"))({ apiKey, timeout: 25 * 1000, maxRetries: 1 });
      service = createAiService({ client, model });
    } catch (err) {
      console.error("[ai-assistant] Disabled — could not start OpenAI client:", err.message);
    }
  } else {
    console.warn("NOTE: OPENAI_API_KEY not set — the AI shopping assistant is disabled.");
  }

  // ---- Catalogue access: short cache for searches, fresh read for cart actions ----
  let cache = null; // { at, data }
  let inflight = null;
  async function loadCatalogue({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && cache && now - cache.at < CATALOGUE_TTL_MS) return cache.data;
    if (!inflight) {
      inflight = Promise.resolve(getCatalogue())
        .then(data => { cache = { at: Date.now(), data }; return data; })
        .finally(() => { inflight = null; });
    }
    try {
      return await inflight;
    } catch (err) {
      if (!fresh && cache) return cache.data; // serve slightly stale search data rather than fail
      console.error("[ai-assistant] Catalogue load failed:", err.message);
      throw new AssistantError(503, "We couldn't load the product catalogue just now. Please try again in a moment.", "catalogue_unavailable");
    }
  }

  // ---- Cost control: per-visitor sliding window, daily site-wide cap, concurrency cap ----
  const hits = new Map(); // key -> { count, windowStart }
  let day = new Date().toISOString().slice(0, 10);
  let dayCount = 0;
  let active = 0;

  function checkLimits(key) {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== day) { day = today; dayCount = 0; }
    if (dayCount >= dailyLimit) return { ok: false, status: 503, error: "The shopping assistant has reached its limit for today. Please browse the catalogue directly.", code: "daily_limit" };
    if (active >= MAX_CONCURRENT) return { ok: false, status: 503, error: "The assistant is very busy right now. Please try again in a moment.", code: "busy", retryAfter: 5 };

    const entry = hits.get(key);
    if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
      hits.set(key, { count: 1, windowStart: now });
    } else {
      entry.count++;
      if (entry.count > perUserLimit) {
        const retryAfter = Math.ceil((entry.windowStart + RATE_WINDOW_MS - now) / 1000);
        return { ok: false, status: 429, error: "You've sent a lot of messages. Please wait a few minutes and try again.", code: "rate_limited", retryAfter };
      }
    }
    dayCount++;
    return { ok: true };
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, e] of hits) if (now - e.windowStart > RATE_WINDOW_MS) hits.delete(k);
  }, RATE_WINDOW_MS).unref();

  /**
   * handleChat({ body, ip, userId }) -> { status, body, headers? }
   * Framework-independent so it can be tested without Express.
   */
  async function handleChat({ body, ip, userId }) {
    if (!service) return { status: 503, body: { error: "The shopping assistant is not available right now.", code: "disabled" } };

    const parsed = validateChatRequest(body);
    if (!parsed.ok) return { status: 400, body: { error: parsed.error, code: "invalid_request" } };

    const limit = checkLimits(userId ? `u:${userId}` : `ip:${ip || "unknown"}`);
    if (!limit.ok) {
      return {
        status: limit.status,
        body: { error: limit.error, code: limit.code },
        headers: limit.retryAfter ? { "Retry-After": String(limit.retryAfter) } : undefined
      };
    }

    active++;
    try {
      const result = await service.chat({ history: parsed.history, loadCatalogue });
      return { status: 200, body: result };
    } catch (err) {
      if (err instanceof AssistantError) return { status: err.status, body: { error: err.publicMessage, code: err.code } };
      console.error("[ai-assistant] Unexpected error:", err && err.name, err && err.message);
      return { status: 500, body: { error: "Something went wrong on our side. Please try again.", code: "internal" } };
    } finally {
      active--;
    }
  }

  function router() {
    const express = require("express");
    const r = express.Router();
    r.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
    r.get("/status", (req, res) => res.json({ enabled: !!service }));
    r.post("/", async (req, res) => {
      const out = await handleChat({ body: req.body, ip: req.ip, userId: req.user && req.user.id });
      if (out.headers) res.set(out.headers);
      res.status(out.status).json(out.body);
    });
    return r;
  }

  return { router, handleChat, isEnabled: () => !!service, loadCatalogue };
};
