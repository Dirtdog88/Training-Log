import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { syncOnce } from "../src/index";
import type { TokenRow } from "../src/strava/oauth";
import type { TokenStore } from "../src/strava/tokens";
import { FakeStrava, MemoryRepo, makeHistory } from "./fakes";

const env = { STRAVA_ATHLETE_ID: "9", STRAVA_CLIENT_ID: "id", STRAVA_CLIENT_SECRET: "s" } as Env;

const validTokens: TokenStore = {
  load: async (): Promise<TokenRow> => ({
    athlete_id: 9,
    access_token: "tok",
    refresh_token: "r",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    scope: "read",
  }),
  save: async () => undefined,
};

describe("syncOnce", () => {
  it("logs a successful run with request counts", async () => {
    const repo = new MemoryRepo();
    const fake = new FakeStrava(makeHistory(3));
    await syncOnce(env, { repo, tokens: validTokens, fetchImpl: fake.fetch });
    expect(repo.runs[0]).toMatchObject({ status: "ok", summaries_upserted: 3, details_fetched: 3, strava_requests: 5 });
  });

  it("records the error and rethrows when login is missing", async () => {
    const repo = new MemoryRepo();
    const noTokens: TokenStore = { load: async () => null, save: async () => undefined };
    await expect(syncOnce(env, { repo, tokens: noTokens })).rejects.toThrow("npm run auth");
    expect(repo.runs[0]).toMatchObject({ status: "error", strava_requests: 0 });
    expect(repo.runs[0]!.error).toContain("npm run auth");
  });

  it("keeps the real counts when the sync reports an error", async () => {
    const repo = new MemoryRepo();
    const fake = new FakeStrava(makeHistory(10), { failAfter: 4, failStatus: 500 });
    await expect(syncOnce(env, { repo, tokens: validTokens, fetchImpl: fake.fetch })).rejects.toThrow("500");
    expect(repo.runs[0]).toMatchObject({ status: "error", details_fetched: 2, strava_requests: 5 });
  });

  it("refuses to run without an athlete ID", async () => {
    await expect(
      syncOnce({ ...env, STRAVA_ATHLETE_ID: "" }, { repo: new MemoryRepo(), tokens: validTokens }),
    ).rejects.toThrow("STRAVA_ATHLETE_ID");
  });
});
