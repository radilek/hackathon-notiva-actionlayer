import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

function respond(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

let polls = 0;
const calls = [];
const upstream = createServer(async (req, res) => {
  calls.push(`${req.method} ${req.url}`);
  if (req.method === "POST" && req.url === "/novita") {
    const input = await body(req);
    const isVision = input.messages?.some((message) => Array.isArray(message.content));
    const content = isVision
      ? {
          displayName: "Logitech M185 Wireless Mouse", brand: "Logitech", model: "M185", variant: "Black",
          searchQuery: "Logitech M185 black wireless mouse", confidence: 0.94,
          evidence: ["Logitech wordmark", "M185 label"], needsConfirmation: false
        }
      : {
          offers: [
            { id: "offer-risky", merchant: "Marketplace", seller: "Tiny Seller", title: "Logitech M185", variant: "Black", itemPriceUsd: 7.99, shippingUsd: 5, totalUsd: 12.99, rating: 2.1, reviewCount: 3, returns: "No returns", marketplace: true, url: "https://example.com/risky", observedAt: "2026-07-21T19:40:00Z", riskSignals: ["Three seller reviews", "No returns"] },
            { id: "offer-fair", merchant: "US Retailer", seller: null, title: "Logitech M185", variant: "Black", itemPriceUsd: 14.49, shippingUsd: 0, totalUsd: 14.49, rating: 4.7, reviewCount: 812, returns: "30 days", marketplace: false, url: "https://example.com/fair", observedAt: "2026-07-21T19:40:00Z", riskSignals: [] }
          ],
          chosenOfferId: "offer-fair",
          rejected: [{ offerId: "offer-risky", reason: "Low seller trust and no returns", evidence: ["3 reviews", "No returns"] }],
          summary: "I rejected the cheapest offer because its seller history and return policy raise risk.",
          cheapestAppearsAcceptable: false, potentialSavingsUsd: null
        };
    return respond(res, 200, { choices: [{ message: { content: JSON.stringify(content) } }] });
  }
  if (req.method === "POST" && req.url === "/tasks") {
    const input = await body(req);
    if (input.max_budget_usd !== 25 || !input.goal.includes("Do not buy anything")) return respond(res, 400, { detail: "unsafe task" });
    return respond(res, 200, { ticket_id: "tkt_smoke_001", state: "pending" });
  }
  if (req.method === "GET" && req.url === "/tasks/tkt_smoke_001") {
    polls += 1;
    if (polls === 1) return respond(res, 200, { ticket_id: "tkt_smoke_001", state: "pending", events: [{ type: "research_started" }] });
    return respond(res, 200, {
      ticket_id: "tkt_smoke_001", state: "completed", reason: "Three comparable listings found.",
      result: { offers: [{ merchant: "Marketplace", total_usd: 12.99, url: "https://example.com/risky" }, { merchant: "US Retailer", total_usd: 14.49, url: "https://example.com/fair" }] },
      events: [{ type: "research_completed" }]
    });
  }
  respond(res, 404, { error: "unexpected mock route" });
});

upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const upstreamPort = upstream.address().port;
const appPort = upstreamPort + 1;
const app = spawn(process.execPath, ["server.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(appPort), NOVITA_API_KEY: "test-only", ACTIONLAYER_API_KEY: "test-only",
    NOVITA_API_URL: `http://127.0.0.1:${upstreamPort}/novita`, ACTIONLAYER_API_URL: `http://127.0.0.1:${upstreamPort}`
  },
  stdio: ["ignore", "pipe", "pipe"]
});

const base = `http://127.0.0.1:${appPort}`;
try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const post = async (path, payload) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const output = await response.json();
    if (!response.ok) throw new Error(`${path}: ${output.error || response.status}`);
    return output;
  };
  const identity = await post("/api/vision", { imageDataUrl: "data:image/jpeg;base64,/9j/2Q==" });
  if (identity.model !== "M185") throw new Error("Vision contract failed");
  const research = await post("/api/research", { confirmedQuery: identity.searchQuery });
  const first = await (await fetch(`${base}/api/research/${research.ticketId}`)).json();
  const second = await (await fetch(`${base}/api/research/${research.ticketId}`)).json();
  if (first.state !== "pending" || second.state !== "completed") throw new Error("ActionLayer polling contract failed");
  const decision = await post("/api/judge", { confirmedProduct: identity.searchQuery, ticketId: research.ticketId });
  if (decision.chosenOfferId !== "offer-fair" || decision.rejected[0]?.offerId !== "offer-risky") throw new Error("Judgment contract failed");
  if (calls.some((call) => /reply|checkout|purchase|cancel/.test(call))) throw new Error("Transactional route was called");
  console.log("PASS vision → research ticket → poll → evidence-based judgment; no transaction route called");
} finally {
  app.kill("SIGTERM");
  upstream.close();
}
