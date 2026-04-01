// Vercel Serverless Function — FareHarbor single-date availability proxy
// API keys live server-side only. Frontend never sees FAREHARBOR_APP_KEY or FAREHARBOR_USER_KEY.

const FH_BASE = 'https://fareharbor.com/api/external/v1';
const SHORTNAME = 'viamar-berlenga';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const _cache = new Map();

function setCache(key, data) {
  _cache.set(key, { data, ts: Date.now() });
}

function getCache(key) {
  const entry = _cache.get(key);
  if (!entry || Date.now() - entry.ts > CACHE_TTL) return null;
  return entry.data;
}

function simplify(a) {
  return {
    pk: a.pk,
    start_at: a.start_at,
    end_at: a.end_at,
    capacity: a.capacity,
    num_remaining: a.num_remaining,
    is_available: a.is_available,
    item_name: a.item?.name ?? null,
    item_pk: a.item?.pk ?? null,
    prices: (a.customer_type_rates || []).map(r => ({
      type: r.customer_type?.plural ?? r.customer_type?.singular ?? 'Passenger',
      singular: r.customer_type?.singular ?? 'Passenger',
      total_cents: r.total,       // e.g. 2200 = 22.00 €
      capacity: r.capacity ?? null,
    })),
  };
}

module.exports = async function handler(req, res) {
  // CORS — restrict to production domain in prod; wildcard for dev
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  const appKey  = process.env.FAREHARBOR_APP_KEY;
  const userKey = process.env.FAREHARBOR_USER_KEY;
  if (!appKey) {
    // APP key not yet configured — request it from FareHarbor support
    // USER key (FAREHARBOR_USER_KEY) is already set; APP key is issued separately
    console.error('[FH] FAREHARBOR_APP_KEY not set. Request it via FareHarbor dashboard → API → Lighthouse.');
    return res.status(503).json({ error: 'API not yet configured', code: 'app-key-missing' });
  }
  if (!userKey) {
    console.error('[FH] FAREHARBOR_USER_KEY not set.');
    return res.status(503).json({ error: 'API not yet configured', code: 'user-key-missing' });
  }

  const cached = getCache(`avail_${date}`);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(cached);
  }

  try {
    const fhRes = await fetch(
      `${FH_BASE}/companies/${SHORTNAME}/availabilities/date/${date}/`,
      {
        headers: {
          'X-FareHarbor-API-App': appKey,
          'X-FareHarbor-API-User': userKey,
        },
      }
    );

    // 404 = no availability configured for that date (not an error)
    if (fhRes.status === 404) {
      const result = { availabilities: [] };
      setCache(`avail_${date}`, result);
      return res.status(200).json(result);
    }

    if (!fhRes.ok) {
      throw new Error(`FareHarbor responded with ${fhRes.status}`);
    }

    const data = await fhRes.json();
    const result = {
      availabilities: (data.availabilities || []).map(simplify),
    };

    setCache(`avail_${date}`, result);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(result);

  } catch (err) {
    console.error('[FH] availability error:', err.message);
    return res.status(503).json({ error: 'Booking service temporarily unavailable' });
  }
};
