"use strict";

// Request validation for POST /api/ai-assistant. Anything that doesn't fit is
// rejected before it can cost an OpenAI call.

const MAX_MESSAGES_ACCEPTED = 24;   // what the browser may send
const MAX_MESSAGES_KEPT = 10;       // what we forward to the model (most recent)
const MAX_USER_CHARS = 500;
const MAX_ASSISTANT_CHARS = 1600;
const MAX_TOTAL_CHARS = 8000;
const MAX_PRODUCT_IDS_PER_MESSAGE = 6;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function clean(text) {
  return text.replace(CONTROL_CHARS, "").trim();
}

/**
 * validateChatRequest(body) ->
 *   { ok: true, history }  history = [{ role, content, productIds? }] ending in a user message
 *   { ok: false, error }   error is safe to show the customer
 */
function validateChatRequest(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    return { ok: false, error: "Please type a message." };
  }
  const raw = body.messages;
  if (raw.length === 0) return { ok: false, error: "Please type a message." };
  if (raw.length > MAX_MESSAGES_ACCEPTED) return { ok: false, error: "This conversation is too long. Please start a new chat." };

  const history = [];
  let total = 0;
  for (const m of raw) {
    if (!m || typeof m !== "object") return { ok: false, error: "Something was wrong with that message." };
    if (m.role !== "user" && m.role !== "assistant") return { ok: false, error: "Something was wrong with that message." };
    if (typeof m.content !== "string") return { ok: false, error: "Something was wrong with that message." };

    const content = clean(m.content);
    const limit = m.role === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS;
    if (!content) return { ok: false, error: "Please type a message." };
    if (content.length > limit) {
      return { ok: false, error: m.role === "user" ? `Please keep your message under ${MAX_USER_CHARS} characters.` : "This conversation is too long. Please start a new chat." };
    }
    total += content.length;

    const entry = { role: m.role, content };
    if (m.role === "assistant" && m.productIds !== undefined) {
      if (!Array.isArray(m.productIds) || m.productIds.length > MAX_PRODUCT_IDS_PER_MESSAGE ||
          !m.productIds.every(id => Number.isInteger(id) && id > 0 && id < 1e9)) {
        return { ok: false, error: "Something was wrong with that message." };
      }
      entry.productIds = m.productIds;
    }
    history.push(entry);
  }
  if (total > MAX_TOTAL_CHARS) return { ok: false, error: "This conversation is too long. Please start a new chat." };
  if (history[history.length - 1].role !== "user") return { ok: false, error: "Please type a message." };

  // Keep the most recent turns, and make sure we start on a customer message.
  let kept = history.slice(-MAX_MESSAGES_KEPT);
  while (kept.length && kept[0].role !== "user") kept = kept.slice(1);
  return { ok: true, history: kept };
}

module.exports = { validateChatRequest, MAX_USER_CHARS, MAX_MESSAGES_KEPT };
