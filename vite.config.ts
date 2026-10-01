import { defineConfig, type Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * GDACS does not send CORS headers, so the browser cannot call it directly.
 * This middleware forwards exactly one documented, public endpoint (the event
 * SEARCH API listed in GDACS's Swagger docs) and nothing else.
 *
 * It is deliberately polite:
 *  - only whitelisted query parameters are forwarded, pageSize is capped at 100
 *  - the documented `caller` parameter identifies this app
 *  - identical requests are cached (4 min for recent windows, 1 h for older ones)
 *    and coalesced while in flight, so dev reloads do not re-hit GDACS
 *  - upstream calls are serialised with a small gap, so paging never bursts
 */
const GDACS_SEARCH = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
const LOCAL_PATH = '/api/gdacs/search';
const ALLOWED_PARAMS = ['eventlist', 'alertlevel', 'fromDate', 'toDate', 'country', 'pageSize', 'pageNumber'];
const MIN_GAP_MS = 400;
const MAX_CACHE_ENTRIES = 200;
const EMPTY_COLLECTION = '{"type":"FeatureCollection","features":[]}';

interface Upstream {
  status: number;
  body: string;
}

function gdacsProxy(): Plugin {
  const cache = new Map<string, { expires: number; body: string }>();
  const inflight = new Map<string, Promise<Upstream>>();
  let queue: Promise<unknown> = Promise.resolve();

  const callUpstream = (url: string): Promise<Upstream> => {
    const run = queue.then(async () => {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'earthisdoomed/0.1 (local data visualisation; vite dev proxy)',
        },
        signal: AbortSignal.timeout(30_000),
      });
      return { status: res.status, body: await res.text() };
    });
    queue = run.then(
      () => sleep(MIN_GAP_MS),
      () => sleep(MIN_GAP_MS),
    );
    return run;
  };

  const ttlFor = (params: URLSearchParams): number => {
    const to = Date.parse(params.get('toDate') ?? '');
    const recent = !Number.isFinite(to) || to > Date.now() - 2 * 86_400_000;
    return recent ? 4 * 60_000 : 60 * 60_000;
  };

  const send = (res: ServerResponse, status: number, body: string, cacheState: string) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Proxy-Cache', cacheState);
    res.end(body);
  };

  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url || !req.url.startsWith(LOCAL_PATH)) return next();
    if (req.method !== 'GET') return send(res, 405, '{"error":"method not allowed"}', 'SKIP');

    const incoming = new URL(req.url, 'http://localhost');
    const params = new URLSearchParams();
    for (const key of ALLOWED_PARAMS) {
      const value = incoming.searchParams.get(key);
      if (value) params.set(key, value);
    }
    const pageSize = Math.min(100, Math.max(1, Number(params.get('pageSize')) || 100));
    params.set('pageSize', String(pageSize));
    params.set('caller', 'earthisdoomed');

    const url = `${GDACS_SEARCH}?${params}`;
    const hit = cache.get(url);
    if (hit && hit.expires > Date.now()) return send(res, 200, hit.body, 'HIT');

    try {
      let pending = inflight.get(url);
      if (!pending) {
        pending = callUpstream(url);
        inflight.set(url, pending);
        const clear = () => inflight.delete(url);
        pending.then(clear, clear);
      }
      const upstream = await pending;
      // GDACS answers "204 No Content" when nothing matches: that is a valid, empty result.
      const { status, body } =
        upstream.status === 204 ? { status: 200, body: EMPTY_COLLECTION } : upstream;
      if (status === 200) {
        cache.set(url, { expires: Date.now() + ttlFor(params), body });
        while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
      }
      send(res, status, body || '{}', 'MISS');
    } catch (err) {
      send(res, 502, JSON.stringify({ error: 'GDACS unreachable', detail: String(err) }), 'ERROR');
    }
  };

  return {
    name: 'gdacs-caching-proxy',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default defineConfig({
  plugins: [gdacsProxy()],
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 2500 },
});
