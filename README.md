# OTO Shipping-Fee Cart Estimator — Backend Proxy

A small Express service that sits between a Shopify storefront and OTO's
delivery-fee API. The storefront cart calls **one** endpoint on this proxy
(`POST /api/shipping-estimate`); the proxy holds the OTO tokens server-side,
calls OTO, and returns a simplified list of carrier options.

> **Display-only estimate.** This does not change what Shopify charges at
> checkout. It shows shoppers an indicative shipping cost in the cart.

---

## Architecture

```
Cart page (Shopify theme)
    │  POST /api/shipping-estimate  { destinationCity, weightKg, totalDue? }
    ▼
oto-shipping-proxy  (this service, hosted on Railway)
    │  1. POST /rest/v2/refreshToken   (refresh_token ➜ 1-hour access_token, cached)
    │  2. POST /rest/v2/checkOTODeliveryFee   (Bearer access_token)
    ▼
OTO API (api.tryoto.com)
```

- The **refresh_token** and **access_token** live only in this service's
  environment / memory. They are never sent to the browser, never logged in
  plaintext, never committed.
- Access token is cached in memory and refreshed proactively (~every 55 min),
  plus a one-time retry if OTO returns 401/403 mid-request.

---

## Endpoints

| Method | Path                     | Purpose                                            |
| ------ | ------------------------ | -------------------------------------------------- |
| `GET`  | `/health`                | Liveness check. Returns `{ ok, service, originCity }`. |
| `POST` | `/api/shipping-estimate` | Public. Body `{ destinationCity, weightKg, totalDue? }`. Rate-limited + CORS-restricted. |

**Successful response:**

```json
{
  "originCity": "Dubai",
  "destinationCity": "Riyadh",
  "weightKg": 2.5,
  "options": [
    { "name": "Aramex", "price": 25.5, "codCharge": 10, "eta": "2-3 days", "logo": "https://…" }
  ]
}
```

`price` is the prepaid shipping price. `codCharge` is returned **separately** so
the storefront can show a "COD +X" note per carrier (see `INCLUDE_COD_IN_PRICE`).

---

## Environment variables

Copy `.env.example` → `.env` for local dev. See that file for the full list.
Key ones:

| Var                    | Notes                                                                 |
| ---------------------- | --------------------------------------------------------------------- |
| `OTO_REFRESH_TOKEN`    | **Secret.** Local `.env` (dev) or Railway Variables (prod). Never commit. |
| `ORIGIN_CITY`          | Warehouse city goods ship from. This store: `Dubai`.                  |
| `INCLUDE_COD_IN_PRICE` | `false` — we surface COD separately as a note, not folded into price. |
| `ALLOWED_ORIGINS`      | Comma-separated CORS allow-list of your storefront domains.           |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | Estimate-endpoint rate limit (default 30 / 60s).   |
| `GLOBAL_RATE_LIMIT_MAX` / `GLOBAL_RATE_LIMIT_WINDOW_MS` | Baseline all-route limit (default 120 / 60s; `/health` exempt). |
| `ESTIMATE_CACHE_TTL_MS` | In-memory cache for repeat lookups (default 120000; `0` disables).   |
| `OTO_TIMEOUT_MS`       | Per-request timeout on OTO calls (default 10000).                     |
| `OTO_MAX_RETRIES`      | Retries on transient OTO network failures/timeouts (default 2).       |
| `MAX_WEIGHT_KG`        | Reject `weightKg` above this before calling OTO (default 1000).       |
| `OTO_MOCK`             | `true` = return canned data with no token. **Local dev only.**        |

---

## Local development

```bash
npm install
cp .env.example .env        # then edit .env

# Option A — no OTO token yet: run against canned mock data
#   set OTO_MOCK=true in .env
npm run dev

# Option B — real OTO calls: put your real OTO_REFRESH_TOKEN in .env
#   (this file is gitignored) and leave OTO_MOCK unset/false
npm run dev
```

Smoke test:

```bash
curl http://localhost:3000/health

curl -X POST http://localhost:3000/api/shipping-estimate \
  -H "Content-Type: application/json" \
  -d '{"destinationCity":"Riyadh","weightKg":2.5,"totalDue":300}'
```

`npm run dev` uses Node's `--watch` (Node 18+), so edits reload automatically.

---

## Deployment (Railway)

This runs as its **own** Railway service — independent of any other project,
so its secrets and scaling stay isolated.

1. Push this repo to GitHub (or connect the local repo to Railway directly).
2. In Railway: **New → Deploy from GitHub repo** → pick this repo. It's its own
   service; do **not** add it to an existing service.
3. Railway auto-detects Node and runs `npm start`.
4. **Variables** tab → add:
   - `OTO_REFRESH_TOKEN` = *(paste your real token here, in the dashboard only)*
   - `ORIGIN_CITY` = `Dubai`
   - `INCLUDE_COD_IN_PRICE` = `false`
   - `ALLOWED_ORIGINS` = your storefront domains, comma-separated
     (e.g. `https://your-store.myshopify.com,https://www.your-store.com`)
   - Leave `OTO_MOCK` unset (mock must be OFF in production).
   - Do **not** set `PORT` — Railway injects it.
5. **Settings → Networking → Generate Domain** to get a public URL like
   `https://oto-shipping-proxy-production.up.railway.app`.
6. Verify: `curl https://<your-railway-domain>/health`.

> The `OTO_REFRESH_TOKEN` is only ever entered into Railway's Variables UI.
> It is never in this repo, never in a commit, never in a log line.

---

## Storefront integration

The cart-page widget (city selector + fetch call) lives in the Shopify theme,
in `sections/main-cart-footer.liquid` via a rendered snippet. It computes total
weight from `/cart.js` (`grams × quantity`, ÷ 1000 → kg) and POSTs
`{ destinationCity, weightKg }` to this proxy's Railway URL. See the theme repo.
