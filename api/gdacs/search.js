// Vercel serverless function: the production twin of the GDACS proxy in vite.config.ts.
//
// GDACS sends no CORS headers, so browsers cannot call it directly. This forwards exactly one
// documented, public endpoint (the event SEARCH API in GDACS's Swagger docs) with an allowlist
// of query parameters, and lets Vercel's CDN cache each answer so visitors share one upstream
// request per query instead of each reaching GDACS.

const GDACS_SEARCH = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
const ALLOWED_PARAMS = ['eventlist', 'alertlevel', 'fromDate', 'toDate', 'country', 'pageSize', 'pageNumber'];
const EMPTY_COLLECTION = '{"type":"FeatureCollection","features":[]}';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end();
    return;
  }

  const incoming = new URL(req.url, 'http://localhost');
  const params = new URLSearchParams();
  for (const key of ALLOWED_PARAMS) {
    const value = incoming.searchParams.get(key);
    if (value) params.set(key, value.slice(0, 64));
  }
  params.set('pageSize', String(Math.min(100, Math.max(1, Number(params.get('pageSize')) || 100))));
  params.set('caller', 'earthisdoomed');

  // Recent windows change; older ones do not.
  const to = Date.parse(params.get('toDate') ?? '');
  const recent = !Number.isFinite(to) || to > Date.now() - 2 * 86_400_000;
  const ttl = recent ? 240 : 3600;

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const upstream = await fetch(`${GDACS_SEARCH}?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'earthisdoomed/0.1 (public data visualisation)' },
      signal: AbortSignal.timeout(25_000),
    });
    // "204 No Content" means nothing matched: a valid, empty result.
    const empty = upstream.status === 204;
    const status = empty ? 200 : upstream.status;
    const body = empty ? EMPTY_COLLECTION : await upstream.text();
    res.statusCode = status;
    res.setHeader(
      'Cache-Control',
      status === 200 ? `public, max-age=60, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}` : 'no-store',
    );
    res.end(body || '{}');
  } catch {
    res.statusCode = 502;
    res.setHeader('Cache-Control', 'no-store');
    res.end('{"error":"GDACS unreachable"}');
  }
}
