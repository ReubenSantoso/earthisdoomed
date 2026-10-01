export function $(selector: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el as HTMLElement;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for safe interpolation into innerHTML. Feed titles are untrusted. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Only allow http(s) links from feeds. */
export function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Run at most once per `ms`, always delivering the latest call. */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let last = 0;
  let timer: number | undefined;
  let pending: A | null = null;
  return (...args: A) => {
    pending = args;
    const now = performance.now();
    const run = () => {
      last = performance.now();
      timer = undefined;
      const a = pending!;
      pending = null;
      fn(...a);
    };
    if (now - last >= ms) run();
    else if (timer === undefined) timer = window.setTimeout(run, ms - (now - last));
  };
}
