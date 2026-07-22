import { readFile } from "node:fs/promises";

const base = (process.env.LIVE_DEMO_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const fixture = new URL("./fixtures/logitech-m185.jpg", import.meta.url);

async function request(path, options) {
  const response = await fetch(`${base}${path}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${payload.error || response.status}`);
  return payload;
}

async function post(path, payload) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

const health = await request("/api/health");
if (!health.ok || !health.novitaConfigured || !health.actionLayerConfigured) {
  throw new Error("Both live integrations must be configured before the live check.");
}

const image = await readFile(fixture);
const imageDataUrl = `data:image/jpeg;base64,${image.toString("base64")}`;
const identity = await post("/api/vision", { imageDataUrl });
if (!identity.displayName || !identity.searchQuery) throw new Error("Live Vision returned no usable identity.");
console.log(`Vision: ${identity.displayName} (${Math.round(Number(identity.confidence || 0) * 100)}% confidence)`);

const confirmedQuery = identity.searchQuery.trim();
const research = await post("/api/research", { confirmedQuery });
if (!research.ticketId) throw new Error("ActionLayer returned no live ticket ID.");
console.log(`ActionLayer: ticket ${research.ticketId} created`);

const deadline = Date.now() + 90_000;
let ticket;
while (Date.now() < deadline) {
  ticket = await request(`/api/research/${encodeURIComponent(research.ticketId)}`);
  console.log(`ActionLayer: ${ticket.state}`);
  if (ticket.state === "completed") break;
  if (["failed", "cancelled", "blocked_on_user"].includes(ticket.state)) {
    throw new Error(`ActionLayer live ticket ended as ${ticket.state}.`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

if (ticket?.state !== "completed") throw new Error("ActionLayer live ticket did not complete within 90 seconds.");
const decision = await post("/api/judge", { confirmedProduct: confirmedQuery, ticketId: research.ticketId });
if (!Array.isArray(decision.offers) || decision.offers.length < 2 || !decision.chosenOfferId) {
  throw new Error("Live judgment returned fewer than two validated offers.");
}

console.log(`PASS live Novita → ActionLayer → Novita flow with ${decision.offers.length} validated offers; no payment made`);
