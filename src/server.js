import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';

import { checkOTODeliveryFee, startProactiveRefresh } from './otoClient.js';

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy; needed for correct client IPs

const PORT = process.env.PORT || 3000;
const ORIGIN_CITY = process.env.ORIGIN_CITY || 'Dubai';
const INCLUDE_COD_IN_PRICE = String(process.env.INCLUDE_COD_IN_PRICE).toLowerCase() === 'true';

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

app.use(cors(corsOptions));
app.use(express.json({ limit: '16kb' }));

// ── Rate limit the public estimate endpoint ─────────────────────────────────
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: Number(process.env.RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

// ── Health check (handy for Railway) ────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'oto-shipping-proxy', originCity: ORIGIN_CITY });
});

// ── Public storefront endpoint ──────────────────────────────────────────────
// POST /api/shipping-estimate  { destinationCity, weightKg, totalDue? }
app.post('/api/shipping-estimate', limiter, async (req, res) => {
  try {
    const { destinationCity, weightKg, totalDue } = req.body || {};

    if (!destinationCity || typeof destinationCity !== 'string') {
      return res.status(400).json({ error: 'destinationCity (string) is required.' });
    }
    const weight = Number(weightKg);
    if (!Number.isFinite(weight) || weight <= 0) {
      return res.status(400).json({ error: 'weightKg must be a positive number.' });
    }

    const raw = await checkOTODeliveryFee({
      originCity: ORIGIN_CITY,
      destinationCity: destinationCity.trim(),
      weight,
      totalDue: totalDue != null ? Number(totalDue) : undefined,
    });

    const options = mapDeliveryOptions(raw);
    return res.json({ originCity: ORIGIN_CITY, destinationCity, weightKg: weight, options });
  } catch (err) {
    console.error('[estimate] error:', err.message);
    // Never leak tokens or internal detail to the browser.
    return res.status(502).json({ error: 'Could not fetch a shipping estimate right now.' });
  }
});

app.listen(PORT, () => {
  console.log(`oto-shipping-proxy listening on :${PORT} (origin city: ${ORIGIN_CITY})`);
  startProactiveRefresh();
});

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
      const price = INCLUDE_COD_IN_PRICE ? basePrice + codCharge : basePrice;
      const eta = o.avgDeliveryTime || o.deliveryTime || o.eta || null;
      const logo = o.logo || o.companyLogo || o.icon || null;
      return { name, price, codCharge, eta, logo };
    })
    .filter((o) => Number.isFinite(o.price));
}

function toNum(v) {
  if (v == null) return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
