// MyShopSwift — Cloudinary client (server-side only)
//
// Talks to Cloudinary's REST Upload API with Node's built-in fetch/FormData,
// so no new npm dependency is needed. The API secret is read from the
// environment here and is only ever used to sign requests on the server — the
// browser never sees it, and never talks to Cloudinary directly: uploads go
// browser -> this server (validated) -> Cloudinary.
//
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET   (required)
//   CLOUDINARY_FOLDER                                                  (optional, default "myshopswift")
//
// This module can upload and look at assets. It deliberately has NO delete /
// destroy / rename call: images are retained in Cloudinary unless someone
// removes them by hand in the Cloudinary console.

const crypto = require("crypto");

// ---------- configuration ----------

function loadConfig(env = process.env) {
  const cloudName = (env.CLOUDINARY_CLOUD_NAME || "").trim();
  const apiKey = (env.CLOUDINARY_API_KEY || "").trim();
  const apiSecret = (env.CLOUDINARY_API_SECRET || "").trim();
  const folder = (env.CLOUDINARY_FOLDER || "myshopswift").trim().replace(/^\/+|\/+$/g, "") || "myshopswift";

  const problems = [];
  if (cloudName && !/^[A-Za-z0-9_-]+$/.test(cloudName)) problems.push("CLOUDINARY_CLOUD_NAME may only contain letters, numbers, - and _");
  if (apiKey && !/^\d+$/.test(apiKey)) problems.push("CLOUDINARY_API_KEY should be the numeric API key from the Cloudinary console");
  if (!/^[A-Za-z0-9_\-/]+$/.test(folder)) problems.push("CLOUDINARY_FOLDER may only contain letters, numbers, -, _ and /");

  return {
    configured: !!(cloudName && apiKey && apiSecret) && problems.length === 0,
    cloudName, apiKey, apiSecret, folder, problems
  };
}

// ---------- signing ----------

// Cloudinary's rule: take every parameter sent EXCEPT file, api_key, cloud_name,
// resource_type (and the signature itself), sort by name, join as name=value
// with &, append the API secret, SHA-1 the result.
function signParams(params, apiSecret) {
  const toSign = Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(toSign + apiSecret).digest("hex");
}

// ---------- upload ----------

// Turns Cloudinary/network failures into a small set of codes the rest of the
// app (and the admin's error message) can rely on. Raw provider text is never
// passed to the browser: it can describe signatures/accounts.
function classifyFailure(status, body) {
  const raw = body && body.error && body.error.message ? String(body.error.message) : "";
  if (status === 401 || status === 403 || /invalid signature|invalid api|unknown api key|cloud_name|api_key/i.test(raw)) {
    return { code: "auth", message: "Image storage rejected the server's credentials. Check the Cloudinary settings." };
  }
  if (status === 420 || status === 429) return { code: "rate_limited", message: "Image storage is busy. Wait a minute and try again." };
  if (status === 400 && /format|invalid image|not allowed|unsupported/i.test(raw)) {
    return { code: "rejected", message: "That image was not accepted by the image storage service. Try a different JPG, PNG or WebP." };
  }
  if (status >= 500) return { code: "unavailable", message: "The image storage service is having problems. Please try again shortly." };
  return { code: "failed", message: "The image could not be stored. Please try again." };
}

// Uploads one image buffer. Never throws. Returns
//   { ok: true, publicId, secureUrl, bytes, format, width, height, existing }
// or { ok: false, code, message }.
// `overwrite` is always false: re-uploading the same public_id returns the
// asset that is already there (existing: true) instead of replacing it or
// creating a duplicate — that is what makes migration retries safe.
async function uploadImage({ buffer, publicId, filename, allowedFormats }, config, { fetchImpl = globalThis.fetch, timeoutMs = 45000 } = {}) {
  if (!config || !config.configured) return { ok: false, code: "not_configured", message: "Image storage isn't configured on the server yet." };
  if (typeof fetchImpl !== "function") return { ok: false, code: "no_fetch", message: "Server needs Node 18 or newer." };

  const signed = {
    allowed_formats: (allowedFormats || ["jpg", "png", "webp"]).join(","),
    overwrite: "false",
    public_id: publicId,
    timestamp: String(Math.floor(Date.now() / 1000))
  };
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename || "upload");
  form.append("api_key", config.apiKey);
  for (const [k, v] of Object.entries(signed)) form.append(k, v);
  form.append("signature", signParams(signed, config.apiSecret));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/image/upload`, {
      method: "POST", body: form, signal: controller.signal
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* non-JSON body */ }
    if (res.ok && json && json.public_id && json.secure_url) {
      return {
        ok: true,
        publicId: json.public_id,
        secureUrl: json.secure_url,
        bytes: Number(json.bytes) || null,
        format: json.format || null,
        width: Number(json.width) || null,
        height: Number(json.height) || null,
        existing: json.existing === true || json.existing === "true" || json.existing === "True"
      };
    }
    const c = classifyFailure(res.status, json);
    return { ok: false, code: c.code, message: c.message, status: res.status };
  } catch (error) {
    if (error && error.name === "AbortError") return { ok: false, code: "timeout", message: "The image storage service took too long to respond. Please try again." };
    return { ok: false, code: "network", message: "Could not reach the image storage service. Please try again." };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- delivery URLs ----------

// Adds a delivery transformation to a Cloudinary URL, e.g. withTransformation(url, "f_auto,q_auto,c_limit,w_640").
// Only touches plain "…/image/upload/v123/…" URLs; anything else (legacy paths,
// URLs that already carry a transformation) is returned unchanged.
function withTransformation(url, transformation) {
  if (typeof url !== "string") return url;
  const m = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(v\d+\/.+)$/.exec(url);
  return m ? m[1] + transformation + "/" + m[2] : url;
}

// Checks that an uploaded asset can actually be fetched from Cloudinary's
// delivery network: HTTP 200 and an image content-type.
async function verifyDelivery(url, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const attempt = async method => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method, signal: controller.signal, redirect: "follow" });
      const type = (res.headers && res.headers.get ? res.headers.get("content-type") : "") || "";
      if (method === "GET" && res.body && res.body.cancel) { try { await res.body.cancel(); } catch (e) { /* ignore */ } }
      return { status: res.status, contentType: type };
    } finally { clearTimeout(timer); }
  };
  try {
    let r = await attempt("HEAD");
    if (r.status === 405 || r.status === 403 || r.status === 501) r = await attempt("GET");
    if (r.status === 200 && /^image\//i.test(r.contentType)) return { ok: true, status: r.status, contentType: r.contentType };
    return { ok: false, error: `Delivery check failed (HTTP ${r.status}${r.contentType ? ", " + r.contentType : ""})` };
  } catch (error) {
    return { ok: false, error: error && error.name === "AbortError" ? "Delivery check timed out" : "Delivery check could not connect" };
  }
}

module.exports = { loadConfig, signParams, uploadImage, classifyFailure, withTransformation, verifyDelivery };
