// Fixed-window per-key rate limiter used by /api/uploads/register.
//
// TECH_SPEC §9 requires rate limiting on upload/register endpoints. This is a
// deliberately tiny in-memory implementation — single-instance MVP running on
// one Next.js server — sized for the venue-scale upload path where the queue
// worker (`lib/upload/uploader.ts`) hits the route many times in bursts and a
// hostile client shouldn't be able to hammer it.
//
// Fixed-window vs sliding-window / token bucket: at MVP scale a burst that
// straddles a window boundary is not a real concern, the state per key is one
// int + one number, and the code fits in a screen. If we later go
// multi-instance the same interface can be backed by Upstash without touching
// callers.
//
// The map grows unbounded in the worst case (one attacker rotating IPs). We
// keep memory bounded via a lazy cleanup — when the map crosses a size cap we
// drop entries whose window has already elapsed. That is enough for a
// single-process Next.js server that restarts every deploy.

export interface RateLimitOptions {
  /** Max requests permitted per window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
  /** Injectable clock — tests pass a fixed value to advance the window. */
  now?: () => number;
}

export interface RateLimitResult {
  /** True when the request is under the limit and should be served. */
  ok: boolean;
  /**
   * Seconds until the current window resets. Always populated so the caller
   * can set a `Retry-After` header on 429s; 0 when `ok` is true and there is
   * still budget left in the window.
   */
  retryAfterSeconds: number;
}

interface Entry {
  count: number;
  windowStartMs: number;
}

const buckets = new Map<string, Entry>();

// Chosen so a single-process Next server holding thousands of concurrent
// guest keys stays well under a MB of state. If we ever cross this we sweep
// expired entries before inserting the next one — bounded work per request.
const CLEANUP_THRESHOLD = 10_000;

function defaultNow(): number {
  return Date.now();
}

function sweepExpired(nowMs: number, windowMs: number): void {
  for (const [key, entry] of buckets) {
    if (nowMs - entry.windowStartMs >= windowMs) buckets.delete(key);
  }
}

export function checkRateLimit(
  key: string,
  opts: RateLimitOptions,
): RateLimitResult {
  const now = (opts.now ?? defaultNow)();
  const entry = buckets.get(key);

  if (!entry || now - entry.windowStartMs >= opts.windowMs) {
    if (buckets.size >= CLEANUP_THRESHOLD) sweepExpired(now, opts.windowMs);
    buckets.set(key, { count: 1, windowStartMs: now });
    return { ok: true, retryAfterSeconds: 0 };
  }

  if (entry.count < opts.limit) {
    entry.count += 1;
    return { ok: true, retryAfterSeconds: 0 };
  }

  const msLeft = opts.windowMs - (now - entry.windowStartMs);
  // Ceil so we never report a Retry-After of 0 when there's actually a
  // fractional second remaining — that would put us in a tight retry loop.
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(msLeft / 1000)) };
}

/** Test-only: clear the module-level state so cases stay hermetic. */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}
