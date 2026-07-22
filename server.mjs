import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = join(process.cwd(), "public");
const NOVITA_URL = process.env.NOVITA_API_URL || "https://api.novita.ai/openai/v1/chat/completions";
const ACTIONLAYER_URL = (process.env.ACTIONLAYER_API_URL || "https://api.actionlayer.io").replace(/\/$/, "");
const VISION_MODEL = process.env.NOVITA_MODEL || "qwen/qwen3-vl-30b-a3b-instruct";
const BODY_LIMIT = 1_500_000;
const IMAGE_LIMIT = 1_000_000;
const RATE_LIMIT_WINDOW_MS = positiveInteger("DEMO_RATE_LIMIT_WINDOW_MS", 3_600_000);
const TRUST_PROXY = process.env.TRUST_PROXY === "true";

const rateLimits = {
  vision: {
    global: positiveInteger("DEMO_VISION_GLOBAL_LIMIT", 40),
    perIp: positiveInteger("DEMO_VISION_IP_LIMIT", 10)
  },
  research: {
    global: positiveInteger("DEMO_RESEARCH_GLOBAL_LIMIT", 20),
    perIp: positiveInteger("DEMO_RESEARCH_IP_LIMIT", 5)
  }
};

const rateBuckets = new Map();

function positiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const identitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["displayName", "brand", "model", "variant", "searchQuery", "confidence", "evidence", "needsConfirmation"],
  properties: {
    displayName: { type: "string" },
    brand: { type: ["string", "null"] },
    model: { type: ["string", "null"] },
    variant: { type: ["string", "null"] },
    searchQuery: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "array", maxItems: 5, items: { type: "string" } },
    needsConfirmation: { type: "boolean" }
  }
};

const decisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["offers", "chosenOfferId", "rejected", "summary", "cheapestAppearsAcceptable", "potentialSavingsUsd"],
  properties: {
    offers: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "merchant", "seller", "title", "variant", "itemPriceUsd", "shippingUsd", "totalUsd", "rating", "reviewCount", "returns", "marketplace", "url", "observedAt", "riskSignals"],
        properties: {
          id: { type: "string" },
          merchant: { type: "string" },
          seller: { type: ["string", "null"] },
          title: { type: "string" },
          variant: { type: ["string", "null"] },
          itemPriceUsd: { type: ["number", "null"], minimum: 0 },
          shippingUsd: { type: ["number", "null"], minimum: 0 },
          totalUsd: { type: "number", minimum: 0 },
          rating: { type: ["number", "null"], minimum: 0, maximum: 5 },
          reviewCount: { type: ["integer", "null"], minimum: 0 },
          returns: { type: ["string", "null"] },
          marketplace: { type: ["boolean", "null"] },
          url: { type: "string" },
          observedAt: { type: ["string", "null"] },
          riskSignals: { type: "array", maxItems: 4, items: { type: "string" } }
        }
      }
    },
    chosenOfferId: { type: ["string", "null"] },
    rejected: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["offerId", "reason", "evidence"],
        properties: {
          offerId: { type: "string" },
          reason: { type: "string" },
          evidence: { type: "array", maxItems: 3, items: { type: "string" } }
        }
      }
    },
    summary: { type: "string" },
    cheapestAppearsAcceptable: { type: "boolean" },
    potentialSavingsUsd: { type: ["number", "null"] }
  }
};

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(body);
}

function fail(res, error, fallbackStatus = 500) {
  const status = Number(error?.status || fallbackStatus);
  if (status === 429) {
    const retryAfterSeconds = Math.max(1, Number(error?.retryAfterSeconds) || 1);
    return json(res, status, {
      error: String(error?.message || "Public demo limit reached. Please retry later."),
      retryAfterSeconds
    }, { "retry-after": String(retryAfterSeconds) });
  }
  const message = status === 503
    ? String(error?.message || "Integration is not configured on the server.")
    : status >= 500
      ? "Upstream service error. Please retry."
      : String(error?.message || "Request failed.");
  json(res, status, { error: message });
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(",")[0]?.trim();
    if (first) return first.slice(0, 128);
  }
  return String(req.socket.remoteAddress || "unknown").slice(0, 128);
}

function activeBucket(key, now) {
  const current = rateBuckets.get(key);
  if (current && current.resetAt > now) return current;
  const fresh = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  rateBuckets.set(key, fresh);
  return fresh;
}

function enforceRateLimit(req, name) {
  const policy = rateLimits[name];
  const now = Date.now();
  const globalBucket = activeBucket(`${name}:global`, now);
  if (globalBucket.count >= policy.global) {
    const retryAfterSeconds = Math.ceil((globalBucket.resetAt - now) / 1000);
    throw Object.assign(new Error("Public demo limit reached. Please retry later."), {
      status: 429,
      retryAfterSeconds
    });
  }

  const ipBucket = activeBucket(`${name}:ip:${clientIp(req)}`, now);
  if (ipBucket.count >= policy.perIp) {
    const retryAfterSeconds = Math.ceil((ipBucket.resetAt - now) / 1000);
    throw Object.assign(new Error("Public demo limit reached. Please retry later."), {
      status: 429,
      retryAfterSeconds
    });
  }

  globalBucket.count += 1;
  ipBucket.count += 1;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error("Request is too large."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON."), { status: 400 });
  }
}

function requireKey(name) {
  const value = process.env[name];
  if (!value) throw Object.assign(new Error(`${name} is not configured on the server.`), { status: 503 });
  return value;
}

function extractJson(content) {
  if (typeof content !== "string") throw new Error("Model returned no content.");
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

async function novita(messages, schemaName, schema) {
  const apiKey = requireKey("NOVITA_API_KEY");
  const request = {
    model: VISION_MODEL,
    temperature: 0,
    messages,
    response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } }
  };
  let response = await fetch(NOVITA_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(45_000)
  });
  if (response.status === 400) {
    delete request.response_format;
    request.messages = [{ role: "system", content: "Return only valid JSON matching the requested shape. No markdown." }, ...messages];
    response = await fetch(NOVITA_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(45_000)
    });
  }
  if (!response.ok) throw Object.assign(new Error("Novita request failed."), { status: response.status });
  const payload = await response.json();
  return extractJson(payload?.choices?.[0]?.message?.content);
}

function sanitize(value, depth = 0) {
  if (depth > 7) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 12_000);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (Array.isArray(value)) return value.slice(-20).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (/password|secret|token|authorization|credential|card|cookie|session|otp/i.test(key)) continue;
      output[key] = sanitize(item, depth + 1);
    }
    return output;
  }
  return undefined;
}

async function actionLayer(path, options = {}) {
  const apiKey = requireKey("ACTIONLAYER_API_KEY");
  const response = await fetch(`${ACTIONLAYER_URL}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(35_000)
  });
  if (!response.ok) throw Object.assign(new Error("ActionLayer request failed."), { status: response.status });
  return response.json();
}

function ticketId(ticket) {
  return ticket?.id || ticket?.ticket_id || ticket?.ticketId;
}

async function getTicket(id) {
  if (!/^[a-zA-Z0-9_-]{4,160}$/.test(id)) throw Object.assign(new Error("Invalid ticket id."), { status: 400 });
  return actionLayer(`/tasks/${encodeURIComponent(id)}`);
}

function validateDecision(decision) {
  if (!decision || !Array.isArray(decision.offers) || decision.offers.length < 2) {
    throw Object.assign(new Error("No comparable US offers were found."), { status: 422 });
  }
  const ids = new Set();
  decision.offers = decision.offers.filter((offer) => {
    if (!offer || typeof offer.id !== "string" || ids.has(offer.id)) return false;
    if (!Number.isFinite(offer.totalUsd) || offer.totalUsd < 0) return false;
    try {
      const url = new URL(offer.url);
      if (!["http:", "https:"].includes(url.protocol)) return false;
    } catch { return false; }
    ids.add(offer.id);
    return true;
  });
  if (decision.offers.length < 2) throw Object.assign(new Error("No comparable US offers were found."), { status: 422 });
  if (decision.chosenOfferId !== null && !ids.has(decision.chosenOfferId)) decision.chosenOfferId = null;
  decision.rejected = (decision.rejected || []).filter((item) => ids.has(item.offerId));
  if (!decision.chosenOfferId) {
    decision.chosenOfferId = [...decision.offers].sort((a, b) => a.totalUsd - b.totalUsd)[0].id;
  }
  return decision;
}

async function serveStatic(req, res) {
  const requested = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 404, { error: "Not found." });
  try {
    const body = await readFile(filePath);
    const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" }[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(body);
  } catch {
    json(res, 404, { error: "Not found." });
  }
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      return json(res, 200, {
        ok: true,
        novitaConfigured: Boolean(process.env.NOVITA_API_KEY),
        actionLayerConfigured: Boolean(process.env.ACTIONLAYER_API_KEY)
      });
    }

    if (req.method === "POST" && req.url === "/api/vision") {
      enforceRateLimit(req, "vision");
      const { imageDataUrl } = await readJson(req);
      const match = typeof imageDataUrl === "string" && imageDataUrl.match(/^data:image\/(?:jpeg|jpg|png|webp);base64,(.+)$/s);
      if (!match) throw Object.assign(new Error("A JPEG, PNG, or WebP image is required."), { status: 400 });
      if (Buffer.byteLength(match[1], "base64") > IMAGE_LIMIT) throw Object.assign(new Error("Image must be under 1 MB."), { status: 413 });
      const identity = await novita([{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
          { type: "text", text: "Identify the physical consumer product as precisely as visible evidence supports. Never invent a brand, model, size, color, edition, or variant. Build a concise US shopping search query. Set needsConfirmation true when confidence is below 0.8 or model/variant is uncertain." }
        ]
      }], "product_identity", identitySchema);
      identity.confidence = Math.max(0, Math.min(1, Number(identity.confidence) || 0));
      identity.needsConfirmation = Boolean(identity.needsConfirmation || identity.confidence < 0.8 || !identity.model || !identity.variant);
      return json(res, 200, identity);
    }

    if (req.method === "POST" && req.url === "/api/research") {
      enforceRateLimit(req, "research");
      const { confirmedQuery } = await readJson(req);
      if (typeof confirmedQuery !== "string" || confirmedQuery.trim().length < 3 || confirmedQuery.length > 240) {
        throw Object.assign(new Error("Confirm a product search query first."), { status: 400 });
      }
      const goal = [
        "RESEARCH ONLY. Do not buy anything, spend money, sign in, create an account, add to cart, enter checkout, provide credentials, or request payment approval.",
        `Research current US-market listings for this exact product: ${confirmedQuery.trim()}.`,
        "Find 3 to 5 comparable, in-stock, new-condition offers. Use current public listing evidence only.",
        "For each offer report merchant, seller, exact title and variant, item price USD, shipping USD, total USD, rating, review count, return policy, marketplace status, direct URL, and observed time; use null for unknown facts.",
        "Include evidence that could justify accepting or rejecting the cheapest listing. Finish with JSON only."
      ].join("\n");
      const ticket = await actionLayer("/tasks", {
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        body: JSON.stringify({ goal, max_budget_usd: 25 })
      });
      const id = ticketId(ticket);
      if (!id) throw new Error("ActionLayer returned no ticket id.");
      return json(res, 200, { ticketId: id, state: ticket.state || "pending" });
    }

    const researchMatch = req.url?.match(/^\/api\/research\/([a-zA-Z0-9_-]{4,160})$/);
    if (req.method === "GET" && researchMatch) {
      const ticket = await getTicket(researchMatch[1]);
      const recentEvents = Array.isArray(ticket.events) ? ticket.events.slice(-8).map((event) => sanitize({
        type: event.type,
        toState: event.to_state,
        createdAt: event.created_at,
        payload: event.payload
      })) : [];
      return json(res, 200, {
        ticketId: ticketId(ticket) || researchMatch[1],
        state: ticket.state || "pending",
        reason: sanitize(ticket.reason || null),
        recentEvents
      });
    }

    if (req.method === "POST" && req.url === "/api/judge") {
      const { confirmedProduct, ticketId: id } = await readJson(req);
      if (typeof confirmedProduct !== "string" || confirmedProduct.length < 3) throw Object.assign(new Error("Product is required."), { status: 400 });
      const ticket = await getTicket(String(id || ""));
      if (ticket.state !== "completed") throw Object.assign(new Error("Research ticket is not complete."), { status: 409 });
      const evidence = sanitize({ result: ticket.result, reason: ticket.reason, events: ticket.events });
      const decision = await novita([
        {
          role: "system",
          content: "You are a cautious US shopping analyst. Extract only offers explicitly supported by the ActionLayer evidence. Never invent prices, URLs, ratings, reviews, return policies, merchants, or risk signals. Reject the cheapest offer only when observed evidence supports material risk. Otherwise choose it and set cheapestAppearsAcceptable true. Potential savings are hypothetical because no purchase occurs."
        },
        {
          role: "user",
          content: `Confirmed product: ${confirmedProduct}\n\nActionLayer live research evidence:\n${JSON.stringify(evidence)}`
        }
      ], "offer_decision", decisionSchema);
      return json(res, 200, validateDecision(decision));
    }

    if (req.method === "GET") return serveStatic(req, res);
    json(res, 404, { error: "Not found." });
  } catch (error) {
    fail(res, error, error?.status || 500);
  } finally {
    const path = req.url?.split("?")[0] || "/";
    console.log(`${req.method} ${path} ${Date.now() - started}ms`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`PRICE SNIPER running at http://127.0.0.1:${PORT}`);
  console.log(`Novita: ${process.env.NOVITA_API_KEY ? "configured" : "missing"} · ActionLayer: ${process.env.ACTIONLAYER_API_KEY ? "configured" : "missing"}`);
});
