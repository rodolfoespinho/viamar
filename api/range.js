// Vercel Serverless Function — FareHarbor date-range availability proxy
// Used by the booking widget to populate upcoming available dates.
// API keys live server-side only.

const FH_BASE = 'https://fareharbor.com/api/external/v1';
const SHORTNAME = 'viamar-berlenga';
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes (range data changes less often)
const MAX_RANGE_DAYS = 31;         // FareHarbor API hard limit

const _cache = new Map();

function setCache(key, data) {
  _cache.set(key, { data, ts: Date.now() });
}

function getCache(key) {
  const entry = _cache.get(key);
  if (!entry || Date.now() - entry.ts > CACHE_TTL) return null;
  return entry.data;
}

function daysBetween(a, b) {
  return Math.floor((new Date(b) - new Date(a)) / 86_400_000);
}

// Default end date: start + 30 days
function defaultEnd(start) {
  const d = new Date(start);
  d.setDate(d.getDate() + 30);
  return d.toISOString().split('T')[0];
}

module.exports = async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let { start, end } = req.query;

  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return res.status(400).json({ error: 'start must be YYYY-MM-DD' });
  }

  if (!end) {
    end = defaultEnd(start);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res.status(400).json({ error: 'end must be YYYY-MM-DD' });
  }

  if (daysBetween(start, end) > MAX_RANGE_DAYS) {
    return res.status(400).json({ error: `Range cannot exceed ${MAX_RANGE_DAYS} days` });
  }

  const appKey  = process.env.FAREHARBOR_APP_KEY;
  const userKey = process.env.FAREHARBOR_USER_KEY;
  if (!appKey) {
    console.error('[FH] FAREHARBOR_APP_KEY not set. Request it via FareHarbor dashboard → API → Lighthouse.');
    return res.status(503).json({ error: 'API not yet configured', code: 'app-key-missing' });
  }
  if (!userKey) {
    console.error('[FH] FAREHARBOR_USER_KEY not set.');
    return res.status(503).json({ error: 'API not yet configured', code: 'user-key-missing' });
  }

  const cacheKey = `range_${start}_${end}`;
  const cached = getCache(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.status(200).json(cached);
  }

  try {
    const fhRes = await fetch(
      `${FH_BASE}/companies/${SHORTNAME}/availabilities/date-range/${start}/${end}/`,
      {
        headers: {
          'X-FareHarbor-API-App': appKey,
          'X-FareHarbor-API-User': userKey,
        },
      }
    );

    if (fhRes.status === 404) {
      const result = { availabilities: [] };
      setCache(cacheKey, result);
      return res.status(200).json(result);
    }

    if (!fhRes.ok) {
      throw new Error(`FareHarbor responded with ${fhRes.status}`);
    }

    const data = await fhRes.json();

    // Return only available slots with essential fields — keeps payload small
    const result = {
      availabilities: (data.availabilities || [])
        .filter(a => a.is_available && a.num_remaining > 0)
        .map(a => ({
          pk: a.pk,
          start_at: a.start_at,
          capacity: a.capacity,
          num_remaining: a.num_remaining,
          item_name: a.item?.name ?? null,
          item_pk: a.item?.pk ?? null,
          prices: (a.customer_type_rates || []).map(r => ({
            type: r.customer_type?.plural ?? r.customer_type?.singular ?? 'Passenger',
            singular: r.customer_type?.singular ?? 'Passenger',
            total_cents: r.total,  // e.g. 2200 = 22.00 €
          })),
        })),
    };

    setCache(cacheKey, result);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(result);

  } catch (err) {
    console.error('[FH] range error:', err.message);
    return res.status(503).json({ error: 'Booking service temporarily unavailable' });
  }
};
