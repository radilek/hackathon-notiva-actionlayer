# PRICE SNIPER

One-page hackathon demo: photograph an object, identify it with live Novita Vision, research current US offers through a live ActionLayer ticket, and ask Novita to judge only the returned evidence. The app intentionally has no purchase, reply, credential, OTP, cart, checkout, or payment endpoint.

## Run

Requires Node.js 22+ and freshly rotated API keys. The keys previously pasted into chat should be treated as compromised.

1. Copy `.env.example` to `.env.local`.
2. Set `NOVITA_API_KEY` and `ACTIONLAYER_API_KEY` locally. Never commit them.
3. Run `npm start`.
4. Open `http://127.0.0.1:3000` and allow camera access, or upload a photo.

## Live flow and contracts

- `POST /api/vision` accepts a base64 image under 1 MB and returns a best-effort identity. Confidence below 0.8 or an unknown model/variant requires editable human confirmation.
- `POST /api/research` creates an ActionLayer research-only ticket with a `$0` execution budget. Its goal explicitly forbids buying, spending, login, account creation, cart, checkout, credentials, or payment approval.
- `GET /api/research/:ticketId` returns only sanitized ticket status and recent events. There is deliberately no reply endpoint.
- `POST /api/judge` reloads the completed ticket server-side, then asks Novita to extract and judge only evidence-backed offers. Invalid URLs, prices, and offer IDs are rejected.

## Truth and safety guardrails

- “Photograph anything” means best-effort identification, never a guaranteed exact SKU.
- Offers are shown only after a completed live ActionLayer result. There are no fixtures or synthetic fallback offers.
- The cheapest offer is rejected only when the live evidence contains a defensible risk signal. Otherwise the UI says it appears acceptable.
- `Potential savings` is hypothetical. The demo never says `bought`, `paid`, `saved`, or `real money moved`.
- Final state: `PURCHASE CANDIDATE READY · Checkout intentionally disabled · No payment made`.
- API keys remain server-side and server logs contain only method, path, latency, and configuration status.

## Demo script

Opening: “Show me an object. Novita identifies it, ActionLayer researches the live US market, and Novita judges which offer it trusts.”

Closing: “A script can sort a known list. This agent interpreted an object, researched unfamiliar offers, judged the evidence, and stopped safely at the purchase boundary. Live perception. Open judgment. Zero dollars moved.”

## Acceptance

- `npm run check` succeeds.
- `/api/health` reports both integrations configured without exposing either key.
- Upload or camera reaches a live Novita identity or a human-confirm step.
- A live ActionLayer ticket ID and sanitized progress are visible.
- Displayed offers come only from the completed ticket and pass server validation.
- Timeout/error states disclose failure and never substitute synthetic offers.
- Browser network traffic never contains either API key.
