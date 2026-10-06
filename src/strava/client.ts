// Minimal Strava REST client with a per-invocation request budget and rate-limit awareness.

const API_BASE = "https://www.strava.com/api/v3";

// Stop this many requests short of Strava's limits so a manual run or retry still has headroom.
const LIMIT_SAFETY_MARGIN = 5;

/** Strava said 429, or we are about to hit its 15-minute or daily limit. Stop and resume next run. */
export class RateLimitedError extends Error {}
/** This invocation has used its configured request budget. Normal stop. */
export class BudgetExhaustedError extends Error {}
/** 404: activity deleted (or no longer visible). */
export class NotFoundError extends Error {}

export interface RateLimitUsage {
  shortUsed: number;
  shortLimit: number;
  dailyUsed: number;
  dailyLimit: number;
}

/**
 * Strava reports "15min,daily" pairs in X-RateLimit-* (overall) and X-ReadRateLimit-* (reads).
 * All our calls are reads, so prefer the read headers.
 */
export function parseRateLimitHeaders(headers: Headers): RateLimitUsage | null {
  const limit = headers.get("x-readratelimit-limit") ?? headers.get("x-ratelimit-limit");
  const usage = headers.get("x-readratelimit-usage") ?? headers.get("x-ratelimit-usage");
  if (!limit || !usage) return null;
  const [shortLimit, dailyLimit] = limit.split(",").map(Number);
  const [shortUsed, dailyUsed] = usage.split(",").map(Number);
  if ([shortLimit, dailyLimit, shortUsed, dailyUsed].some((n) => n === undefined || Number.isNaN(n))) {
    return null;
  }
  return { shortUsed: shortUsed!, shortLimit: shortLimit!, dailyUsed: dailyUsed!, dailyLimit: dailyLimit! };
}

export class StravaClient {
  requests = 0;
  usage: RateLimitUsage | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly accessToken: string,
    private readonly budget: number,
    fetchImpl?: typeof fetch,
  ) {
    // Wrap so the global fetch is never invoked with a foreign `this` (Workers rejects that).
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  remaining(): number {
    return Math.max(0, this.budget - this.requests);
  }

  private nearLimit(): boolean {
    const u = this.usage;
    if (!u) return false;
    return u.shortUsed >= u.shortLimit - LIMIT_SAFETY_MARGIN || u.dailyUsed >= u.dailyLimit - LIMIT_SAFETY_MARGIN;
  }

  async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    if (this.remaining() === 0) throw new BudgetExhaustedError("Request budget for this run used up");
    if (this.nearLimit()) throw new RateLimitedError("Close to Strava rate limit; pausing until next run");

    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    this.requests++;
    const res = await this.fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    this.usage = parseRateLimitHeaders(res.headers) ?? this.usage;

    if (res.status === 429) throw new RateLimitedError("Strava returned 429 Too Many Requests");
    if (res.status === 404) throw new NotFoundError(`Strava GET ${path}: not found`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Strava GET ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }
}
