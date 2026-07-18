// OTO API client: handles access-token lifecycle and delivery-fee lookups.
// The refresh_token and access_token live ONLY here, server-side. They are
// never returned to callers, never logged in plaintext.

const OTO_API_BASE = process.env.OTO_API_BASE || 'https://api.tryoto.com';
const REFRESH_TOKEN = process.env.OTO_REFRESH_TOKEN;

// In-memory access-token cache.
let accessToken = null;
let accessTokenExpiresAt = 0; // epoch ms

// OTO access tokens last ~1 hour. Refresh proactively before that.
const TOKEN_TTL_MS = 55 * 60 * 1000; // treat token as good for 55 min
const PROACTIVE_REFRESH_MS = 55 * 60 * 1000; // background refresh cadence

let refreshInFlight = null;

function assertConfigured() {
  if (!REFRESH_TOKEN) {
    throw new Error(
      'OTO_REFRESH_TOKEN is not set. Add it to your local .env (dev) or the ' +
        'Railway service Variables (prod). It must never be committed to git.'
    );
  }
}

// Exchange the refresh_token for a fresh access_token. De-duplicated so
// concurrent callers share one in-flight refresh.
async function refreshAccessToken() {
  assertConfigured();
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const res = await fetch(`${OTO_API_BASE}/rest/v2/refreshToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: REFRESH_TOKEN }),
    });

    if (!res.ok) {
      const detail = await safeReadText(res);
      // Do NOT include the refresh_token in the error.
      throw new Error(
        `OTO token refresh failed (HTTP ${res.status}). ${truncate(detail, 300)}`
      );
    }

    const data = await res.json();
    const token = data.access_token || data.accessToken || data.token;
    if (!token) {
      throw new Error('OTO token refresh response did not contain an access_token.');
    }

    accessToken = token;
    accessTokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    console.log('[oto] access token refreshed; valid ~55m');
    return accessToken;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt) {
    return accessToken;
  }
  return refreshAccessToken();
}

// Call OTO's delivery-fee endpoint and return the raw parsed response.
async function checkOTODeliveryFee({
  originCity,
  destinationCity,
  weight,
  length,
  width,
  height,
  totalDue,
  serviceType,
}) {
  // Local-dev mock: prove the full path (map + response shape) with no token
  // Set OTO_MOCK=true in your local .env. NEVER enable this on Railway.
  if (String(process.env.OTO_MOCK).toLowerCase() === 'true') {
    return mockDeliveryFeeResponse({ originCity, destinationCity, weight });
  }

  const token = await getAccessToken();

  const body = { originCity, destinationCity, weight };
  if (length != null) body.length = length;
  if (width != null) body.width = width;
  if (height != null) body.height = height;
  if (totalDue != null) body.totalDue = totalDue;
  if (serviceType != null) body.serviceType = serviceType;

  let res = await fetch(`${OTO_API_BASE}/rest/v2/checkOTODeliveryFee`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  // If the token was rejected (expired early / revoked), refresh once and retry.
  if (res.status === 401 || res.status === 403) {
    console.log('[oto] delivery-fee call got', res.status, '- refreshing token and retrying');
    const fresh = await refreshAccessToken();
    res = await fetch(`${OTO_API_BASE}/rest/v2/checkOTODeliveryFee`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${fresh}`,
      },
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new Error(
      `OTO checkOTODeliveryFee failed (HTTP ${res.status}). ${truncate(detail, 300)}`
    );
  }

  return res.json();
}

// Kick off a background refresh loop so tokens are warm before they expire.
// Never crash the process on a transient refresh failure.
function startProactiveRefresh() {
  if (!REFRESH_TOKEN) return; // nothing to refresh yet
  refreshAccessToken().catch((err) =>
    console.error('[oto] initial token refresh failed:', err.message)
  );
  const timer = setInterval(() => {
    refreshAccessToken().catch((err) =>
      console.error('[oto] scheduled token refresh failed:', err.message)
    );
  }, PROACTIVE_REFRESH_MS);
  // Don't keep the event loop alive just for the refresh timer.
  if (typeof timer.unref === 'function') timer.unref();
}

// Canned response shaped like OTO's checkOTODeliveryFee for local testing.
function mockDeliveryFeeResponse({ originCity, destinationCity, weight }) {
  const w = Number(weight) || 1;
  return {
    success: true,
    _mock: true,
    _echo: { originCity, destinationCity, weight: w },
    deliveryCompany: [
      {
        deliveryOptionName: 'Aramex',
        price: +(18 + w * 3).toFixed(2),
        codCharge: 10,
        avgDeliveryTime: '2-3 days',
        logo: 'https://cdn.tryoto.com/logos/aramex.png',
      },
      {
        deliveryOptionName: 'SMSA Express',
        price: +(15 + w * 3.5).toFixed(2),
        codCharge: 12,
        avgDeliveryTime: '3-4 days',
        logo: 'https://cdn.tryoto.com/logos/smsa.png',
      },
      {
        deliveryOptionName: 'Fetchr',
        price: +(20 + w * 2.5).toFixed(2),
        codCharge: 0,
        avgDeliveryTime: '1-2 days',
        logo: null,
      },
    ],
  };
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

export {
  checkOTODeliveryFee,
  getAccessToken,
  refreshAccessToken,
  startProactiveRefresh,
  assertConfigured,
};
