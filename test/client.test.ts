import { describe, expect, it, vi } from "vitest";
import { BudgetExhaustedError, parseRateLimitHeaders, StravaClient } from "../src/strava/client";

describe("parseRateLimitHeaders", () => {
  it("prefers the read limits", () => {
    const h = new Headers({
      "x-ratelimit-limit": "200,2000",
      "x-ratelimit-usage": "50,500",
      "x-readratelimit-limit": "100,1000",
      "x-readratelimit-usage": "20,300",
    });
    expect(parseRateLimitHeaders(h)).toEqual({ shortUsed: 20, shortLimit: 100, dailyUsed: 300, dailyLimit: 1000 });
  });

  it("falls back to overall limits and ignores junk", () => {
    expect(parseRateLimitHeaders(new Headers({ "x-ratelimit-limit": "200,2000", "x-ratelimit-usage": "1,2" })))
      .toEqual({ shortUsed: 1, shortLimit: 200, dailyUsed: 2, dailyLimit: 2000 });
    expect(parseRateLimitHeaders(new Headers({ "x-ratelimit-limit": "a,b", "x-ratelimit-usage": "1,2" }))).toBeNull();
    expect(parseRateLimitHeaders(new Headers())).toBeNull();
  });
});

describe("StravaClient", () => {
  it("sends the bearer token and enforces the budget without calling Strava", async () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    const client = new StravaClient("tok", 1, fetchMock as unknown as typeof fetch);
    await client.get("/athlete/activities", { per_page: 5 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://www.strava.com/api/v3/athlete/activities?per_page=5");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    await expect(client.get("/athlete/activities")).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
