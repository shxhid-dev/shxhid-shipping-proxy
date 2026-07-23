import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';

import { checkOTODeliveryFee, startProactiveRefresh, getTokenStatus } from './otoClient.js';

const app = express();
app.disable('x-powered-by'); // don't advertise the framework
// Railway sits behind a single edge proxy that appends the real client IP to
// X-Forwarded-For. trust proxy: 1 reads that correctly. Do NOT use `true`
// (permissive) — it would let clients spoof their IP past the rate limiter.
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const ORIGIN_CITY = process.env.ORIGIN_CITY || 'Dubai';
const INCLUDE_COD_IN_PRICE = String(process.env.INCLUDE_COD_IN_PRICE).toLowerCase() === 'true';
const STARTED_AT = Date.now();

// Input bounds — reject obviously bad payloads before they reach OTO.
const MAX_CITY_LEN = 100;
const MAX_WEIGHT_KG = Number(process.env.MAX_WEIGHT_KG) || 1000;

// Short-lived in-memory cache for estimates. OTO fees for the same route and
// weight don't change second-to-second, so caching cuts upstream calls, speeds
// up repeat lookups, and shields us from OTO's own rate limits. Display-only
// estimate, so a couple of minutes of staleness is fine. Set TTL=0 to disable.
const CACHE_TTL_MS = Number.isFinite(Number(process.env.ESTIMATE_CACHE_TTL_MS))
  ? Number(process.env.ESTIMATE_CACHE_TTL_MS)
  : 120_000;
const CACHE_MAX_ENTRIES = 500;
const estimateCache = new Map(); // key -> { at, value }

// ── CORS: restrict to the storefront domain(s) ──────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Allow same-origin / server-to-server / curl (no Origin header).
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0) {
      // No allow-list configured yet: permit, but warn loudly in logs.
      console.warn('[cors] ALLOWED_ORIGINS is empty — allowing all origins. Set it before going live.');
      return callback(null, true);
    }
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  methods: ['POST', 'GET', 'OPTIONS'],
};

// ── Lightweight request logging (no secrets, no bodies) ─────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[req] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

app.use(cors(corsOptions));
app.use(express.json({ limit: '16kb' }));

// ── Rate limiting ────────────────────────────────────────────────────────
const rateLimitMessage = { error: 'Too many requests, please slow down.' };

// Baseline limiter across every route (except health) as blanket abuse
// protection. Health is skipped so Railway's probes are never throttled.
const globalLimiter = rateLimit({
  windowMs: Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS) || 60_000,
  max: Number(process.env.GLOBAL_RATE_LIMIT_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
  message: rateLimitMessage,
});
app.use(globalLimiter);

// Stricter limiter specifically for the public estimate endpoint.
const estimateLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: Number(process.env.RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMessage,
});

// ── Health check (handy for Railway) ────────────────────────────────────────
app.get('/health', (_req, res) => {
  const token = getTokenStatus();
  res.json({
    ok: true,
    service: 'oto-shipping-proxy',
    originCity: ORIGIN_CITY,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    tokenConfigured: token.configured,
    tokenReady: token.hasAccessToken,
  });
});

// ── Public storefront endpoint ──────────────────────────────────────────────
// POST /api/shipping-estimate  { destinationCity, weightKg, totalDue? }
app.post('/api/shipping-estimate', estimateLimiter, async (req, res) => {
  try {
    const { destinationCity, weightKg, totalDue } = req.body || {};

    if (!destinationCity || typeof destinationCity !== 'string') {
      return res.status(400).json({ error: 'destinationCity (string) is required.' });
    }
    const city = destinationCity.trim();
    if (city.length === 0 || city.length > MAX_CITY_LEN) {
      return res.status(400).json({ error: `destinationCity must be 1–${MAX_CITY_LEN} characters.` });
    }

    const weight = Number(weightKg);
    if (!Number.isFinite(weight) || weight <= 0) {
      return res.status(400).json({ error: 'weightKg must be a positive number.' });
    }
    if (weight > MAX_WEIGHT_KG) {
      return res.status(400).json({ error: `weightKg must not exceed ${MAX_WEIGHT_KG}.` });
    }

    let due;
    if (totalDue != null) {
      due = Number(totalDue);
      if (!Number.isFinite(due) || due < 0) {
        return res.status(400).json({ error: 'totalDue, if provided, must be a non-negative number.' });
      }
    }

    const cacheKey = `${city.toLowerCase()}|${weight}|${due ?? ''}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      return res.json({ originCity: ORIGIN_CITY, destinationCity: city, weightKg: weight, options: cached, cached: true });
    }

    const raw = await checkOTODeliveryFee({
      originCity: ORIGIN_CITY,
      destinationCity: city,
      weight,
      totalDue: due,
    });

    const options = mapDeliveryOptions(raw);
    // Only cache non-empty results — an empty list may be a transient upstream
    // hiccup and we don't want to pin "no options" for the whole TTL.
    if (options.length > 0) cacheSet(cacheKey, options);

    return res.json({ originCity: ORIGIN_CITY, destinationCity: city, weightKg: weight, options, cached: false });
  } catch (err) {
    console.error('[estimate] error:', err.message);
    // Never leak tokens or internal detail to the browser.
    return res.status(502).json({ error: 'Could not fetch a shipping estimate right now.' });
  }
});

// ── 404 for anything else ────────────────────────────────────────────────
// Return JSON rather than Express's default HTML "Cannot GET …" page.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// ── Error handler ────────────────────────────────────────────────────────
// Catches CORS rejections (thrown from corsOptions.origin), malformed JSON
// bodies, and anything else that bubbles up, so callers always get a clean
// JSON response instead of Express's default HTML error page.
app.use((err, req, res, _next) => {
  if (err && /not allowed by CORS/.test(err.message)) {
    console.warn(`[cors] rejected origin: ${req.headers.origin}`);
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  // Body-parser throws for malformed JSON / oversized payloads.
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large.' });
  }
  console.error('[error]', err.message);
  return res.status(500).json({ error: 'Internal server error.' });
});

const server = app.listen(PORT, () => {
  console.log(`oto-shipping-proxy listening on :${PORT} (origin city: ${ORIGIN_CITY})`);
  if (ALLOWED_ORIGINS.length === 0) {
    console.warn('[startup] ALLOWED_ORIGINS is empty — CORS is open. Set it before going live.');
  }
  startProactiveRefresh();
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
// Railway sends SIGTERM on redeploy; drain in-flight requests, then exit.
function shutdown(signal) {
  console.log(`[shutdown] ${signal} received — closing server…`);
  server.close(() => {
    console.log('[shutdown] server closed cleanly.');
    process.exit(0);
  });
  // Don't hang forever if a connection won't close.
  setTimeout(() => {
    console.warn('[shutdown] forced exit after timeout.');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Cache helpers ─────────────────────────────────────────────────────────

function cacheGet(key) {
  if (CACHE_TTL_MS <= 0) return null;
  const hit = estimateCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    estimateCache.delete(key);
    return null;
  }
  // Refresh recency so the Map's insertion order approximates LRU.
  estimateCache.delete(key);
  estimateCache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  if (CACHE_TTL_MS <= 0) return;
  if (estimateCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = estimateCache.keys().next().value;
    if (oldest !== undefined) estimateCache.delete(oldest);
  }
  estimateCache.set(key, { at: Date.now(), value });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// OTO wraps its option list under different keys across responses; find it.
function extractOptionList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const candidates = [
    raw.deliveryOptions,
    raw.deliveryCompany,
    raw.deliveryCompanyList,
    raw.data,
    raw.result,
    raw.options,
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  // Sometimes nested one level under data.
  if (raw.data && typeof raw.data === 'object') {
    for (const c of [raw.data.deliveryOptions, raw.data.deliveryCompany, raw.data.options]) {
      if (Array.isArray(c)) return c;
    }
  }
  return [];
}

// Normalize one OTO option into { name, price, codCharge, eta, logo }.
function mapDeliveryOptions(raw) {
  const list = extractOptionList(raw);
  return list
    .map((o) => {
      const name =
        o.deliveryOptionName || o.deliveryCompanyName || o.name || o.courierName || 'Courier';
      const basePrice = toNum(o.price ?? o.deliveryFee ?? o.totalPrice);
      const codCharge = toNum(o.codCharge ?? o.codFee ?? 0);
      const safeCod = Number.isFinite(codCharge) ? codCharge : 0;
      const price = INCLUDE_COD_IN_PRICE ? basePrice + safeCod : basePrice;
      const eta = o.avgDeliveryTime || o.deliveryTime || o.eta || null;
      const logo = o.logo || o.companyLogo || o.icon || null;
      return { name, price, codCharge: safeCod, eta, logo };
    })
    .filter((o) => Number.isFinite(o.price));
}

function toNum(v) {
  if (v == null) return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
