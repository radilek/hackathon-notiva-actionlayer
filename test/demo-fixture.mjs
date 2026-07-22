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
const upstream = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/novita") {
    const input = await body(req);
    const isVision = input.messages?.some((message) => Array.isArray(message.content));
    const content = isVision
      ? {
          displayName: "Logitech M185 Wireless Mouse", brand: "Logitech", model: "M185", variant: "Black / Grey",
          searchQuery: "Logitech M185 black grey wireless mouse", confidence: 0.96,
          evidence: ["Logitech wordmark", "M185 body shape", "Black shell with grey trim"], needsConfirmation: false
        }
      : {
          offers: [
            { id: "offer-risky", merchant: "Marketplace", seller: "QuickDealz", title: "Logitech M185 Wireless Mouse", variant: "Black / Grey", itemPriceUsd: 7.99, shippingUsd: 5, totalUsd: 12.99, rating: 2.1, reviewCount: 3, returns: "No returns", marketplace: true, url: "https://example.com/risky", observedAt: "2026-07-21T19:40:00Z", riskSignals: ["Only three seller reviews", "No returns", "Price materially below comparable offers"] },
            { id: "offer-fair", merchant: "US Retailer", seller: null, title: "Logitech M185 Wireless Mouse", variant: "Black / Grey", itemPriceUsd: 14.49, shippingUsd: 0, totalUsd: 14.49, rating: 4.7, reviewCount: 812, returns: "30 days", marketplace: false, url: "https://example.com/fair", observedAt: "2026-07-21T19:40:00Z", riskSignals: [] },
            { id: "offer-high", merchant: "Electronics Store", seller: null, title: "Logitech M185 Wireless Mouse", variant: "Black / Grey", itemPriceUsd: 17.99, shippingUsd: 0, totalUsd: 17.99, rating: 4.8, reviewCount: 1210, returns: "30 days", marketplace: false, url: "https://example.com/high", observedAt: "2026-07-21T19:40:00Z", riskSignals: [] }
          ],
          chosenOfferId: "offer-fair",
          rejected: [{ offerId: "offer-risky", reason: "Only 3 seller reviews, no returns, and a price far below comparable offers raise counterfeit risk.", evidence: ["3 seller reviews", "No returns", "$12.99 total"] }],
          summary: "I rejected the cheapest offer: the seller has only three reviews, offers no returns, and is priced far below comparable US listings. The $14.49 retailer offer is the best fair-price candidate.",
          cheapestAppearsAcceptable: false, potentialSavingsUsd: 3.5
        };
    return respond(res, 200, { choices: [{ message: { content: JSON.stringify(content) } }] });
  }

  if (req.method === "POST" && req.url === "/tasks") {
    await body(req);
    polls = 0;
    return respond(res, 200, { ticket_id: "tkt_fixture_001", state: "pending" });
  }

  if (req.method === "GET" && req.url === "/tasks/tkt_fixture_001") {
    polls += 1;
    if (polls < 2) return respond(res, 200, { ticket_id: "tkt_fixture_001", state: "pending", events: [{ type: "searching_us_market" }] });
    return respond(res, 200, {
      ticket_id: "tkt_fixture_001", state: "completed", reason: "Three comparable US listings found.",
      result: { offers: [{ merchant: "Marketplace", total_usd: 12.99, url: "https://example.com/risky" }, { merchant: "US Retailer", total_usd: 14.49, url: "https://example.com/fair" }, { merchant: "Electronics Store", total_usd: 17.99, url: "https://example.com/high" }] },
      events: [{ type: "research_completed" }]
    });
  }

  respond(res, 404, { error: "unexpected fixture route" });
});

upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const upstreamPort = upstream.address().port;
const appPort = Number(process.env.FIXTURE_PORT || 3100);
const app = spawn(process.execPath, ["server.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(appPort), NOVITA_API_KEY: "fixture-only", ACTIONLAYER_API_KEY: "fixture-only",
    NOVITA_API_URL: `http://127.0.0.1:${upstreamPort}/novita`, ACTIONLAYER_API_URL: `http://127.0.0.1:${upstreamPort}`
  },
  stdio: "inherit"
});

const shutdown = () => {
  app.kill("SIGTERM");
  upstream.close();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
app.on("exit", () => upstream.close());

console.log(`Fixture demo will be available at http://127.0.0.1:${appPort}`);
await once(app, "exit");
