import { describe, expect, it } from "vitest";
import type { SyncState } from "../src/repo";
import { buildStatus, handleStatus, tokenMatches, type StatusSource, type SyncRunRow } from "../src/status";

const NOW = new Date("2026-10-07T12:00:00Z");

const state: SyncState = {
  backfill_before: "2023-04-01T07:00:01.000Z",
  backfill_complete: false,
  incremental_after: null,
  last_incremental_at: "2026-10-07T11:30:00Z",
  last_resync_at: null,
  zones_fetched_at: "2026-10-07T00:00:00Z",
};

function run(id: number, status: SyncRunRow["status"], finishedMinutesAgo: number, error: string | null = null): SyncRunRow {
  const finished = new Date(NOW.getTime() - finishedMinutesAgo * 60_000).toISOString();
  return {
    id,
    started_at: finished,
    finished_at: finished,
    status,
    summaries_upserted: 0,
    details_fetched: 12,
    streams_fetched: 0,
    strava_requests: 15,
    error,
  };
}

function source(runs: SyncRunRow[]): StatusSource {
  return {
    syncState: async () => state,
    recentRuns: async () => runs,
    counts: async () => ({ runs: 812, awaiting_detail: 340, deleted: 2 }),
  };
}

describe("buildStatus", () => {
  it("reports progress and is healthy after a recent rate-limited pause", async () => {
    const report = await buildStatus(source([run(3, "rate_limited", 10), run(2, "ok", 25)]), NOW);
    expect(report.healthy).toBe(true);
    expect(report.backfill).toEqual({ complete: false, reached: "2023-04-01T07:00:01.000Z" });
    expect(report.counts.awaiting_detail).toBe(340);
    expect(report.last_run?.id).toBe(3);
  });

  it("is unhealthy when only errors happened recently, and lists them", async () => {
    const report = await buildStatus(
      source([run(5, "error", 5, "Strava token request failed: 401"), run(4, "error", 20, "boom"), run(3, "ok", 200)]),
      NOW,
    );
    expect(report.healthy).toBe(false);
    expect(report.last_success_at).toBe(new Date(NOW.getTime() - 200 * 60_000).toISOString());
    expect(report.recent_errors.map((e) => e.error)).toEqual(["Strava token request failed: 401", "boom"]);
  });

  it("is unhealthy before any run", async () => {
    const report = await buildStatus(source([]), NOW);
    expect(report.healthy).toBe(false);
    expect(report.last_run).toBeNull();
  });
});

describe("handleStatus", () => {
  const req = (auth?: string, method = "GET") =>
    new Request("https://w.example/status", { method, headers: auth ? { Authorization: auth } : {} });

  it("returns the report with the right token, uncached", async () => {
    const res = await handleStatus(req("Bearer s3cret"), "s3cret", source([run(1, "ok", 1)]));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(((await res.json()) as { counts: { runs: number } }).counts.runs).toBe(812);
  });

  it("rejects a missing or wrong token", async () => {
    expect((await handleStatus(req(), "s3cret", source([]))).status).toBe(401);
    expect((await handleStatus(req("Bearer nope"), "s3cret", source([]))).status).toBe(401);
    expect((await handleStatus(req("s3cret"), "s3cret", source([]))).status).toBe(401);
  });

  it("refuses to serve when no token is configured", async () => {
    expect((await handleStatus(req("Bearer "), "", source([]))).status).toBe(503);
    expect((await handleStatus(req("Bearer x"), undefined, source([]))).status).toBe(503);
  });

  it("only allows GET", async () => {
    expect((await handleStatus(req("Bearer s3cret", "POST"), "s3cret", source([]))).status).toBe(405);
  });
});

describe("tokenMatches", () => {
  it("matches equal strings only, regardless of length", async () => {
    expect(await tokenMatches("abc", "abc")).toBe(true);
    expect(await tokenMatches("abc", "abd")).toBe(false);
    expect(await tokenMatches("abc", "abcd")).toBe(false);
    expect(await tokenMatches("", "abc")).toBe(false);
  });
});
