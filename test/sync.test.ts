import { describe, expect, it } from "vitest";
import { StravaClient } from "../src/strava/client";
import { runSync, type SyncOptions } from "../src/sync";
import { FakeStrava, MemoryRepo, makeActivity, makeHistory } from "./fakes";

const opts: SyncOptions = { athleteId: 9, maxListPages: 2, perPage: 200 };
const BUDGET = 15;

async function invoke(fake: FakeStrava, repo: MemoryRepo, budget = BUDGET) {
  const client = new StravaClient("token", budget, fake.fetch);
  const outcome = await runSync(client, repo, opts);
  return { outcome, client };
}

/** Run invocations until the backfill and all details are done (or a safety cap is hit). */
async function runToCompletion(fake: FakeStrava, repo: MemoryRepo) {
  let invocations = 0;
  while (invocations < 500) {
    invocations++;
    const { outcome, client } = await invoke(fake, repo);
    expect(client.requests).toBeLessThanOrEqual(BUDGET);
    expect(outcome.status).toBe("ok");
    if (outcome.backfill_complete && (await repo.activitiesNeedingDetail(1)).length === 0) break;
  }
  return invocations;
}

describe("runSync: backfill", () => {
  it("backfills every run across many invocations, skipping rides, fetching each detail once", async () => {
    const history = makeHistory(450, 5); // 360 runs, 90 rides
    const fake = new FakeStrava(history);
    const repo = new MemoryRepo();

    const invocations = await runToCompletion(fake, repo);

    const runIds = history.filter((a) => a.sport_type === "Run").map((a) => a.id).sort();
    expect([...repo.activities.keys()].sort()).toEqual(runIds);
    expect([...repo.details.keys()].sort()).toEqual(runIds);
    const detailCalls = fake.detailCalls();
    expect(new Set(detailCalls).size).toBe(detailCalls.length); // no detail fetched twice
    expect(repo.state.backfill_complete).toBe(true);
    expect(repo.zones).not.toBeNull();
    // 3 list pages + 1 zones + 360 details = 364 requests at 15 per invocation.
    expect(invocations).toBe(Math.ceil(364 / BUDGET));
  });

  it("strips segment efforts and map from stored details, keeps laps and description", async () => {
    const fake = new FakeStrava(makeHistory(3));
    const repo = new MemoryRepo();
    await invoke(fake, repo);
    const d = repo.details.get(1003)!;
    expect(d.description).toBe("desc");
    expect(d.laps).toHaveLength(2);
    expect(d.raw).not.toHaveProperty("segment_efforts");
    expect(d.raw).not.toHaveProperty("laps");
  });

  it("does not skip older runs when a run is deleted mid-backfill", async () => {
    const history = makeHistory(450);
    const fake = new FakeStrava(history);
    const repo = new MemoryRepo();
    await invoke(fake, repo, 2); // zones + first page only
    expect(repo.activities.size).toBe(200);
    fake.deleted.add(history[10]!.id); // a run already pulled disappears
    await runToCompletion(fake, repo);
    expect(repo.activities.size).toBe(450);
    expect(repo.activities.get(history[10]!.id)!.deleted_at).not.toBeNull();
  });

  it("stops on 429, keeps details fetched before it, and resumes next time", async () => {
    const fake = new FakeStrava(makeHistory(10), { failAfter: 5 }); // zones, 1 page, 3 details, then 429
    const repo = new MemoryRepo();
    const { outcome } = await invoke(fake, repo);
    expect(outcome.status).toBe("rate_limited");
    expect(outcome.details_fetched).toBe(3);
    expect(repo.details.size).toBe(3);
    expect(repo.state.backfill_complete).toBe(true);

    const healthy = new FakeStrava(fake.activities);
    await invoke(healthy, repo);
    expect(repo.details.size).toBe(10);
    expect(healthy.detailCalls()).toHaveLength(7); // only the missing ones
  });

  it("pauses before Strava's daily limit using the usage headers", async () => {
    const fake = new FakeStrava(makeHistory(10), { usage: () => [10, 996] });
    const repo = new MemoryRepo();
    const { outcome, client } = await invoke(fake, repo);
    expect(outcome.status).toBe("rate_limited");
    expect(client.requests).toBe(1); // first response reported 996/1000, so it stopped
  });

  it("records a Strava server error but keeps progress", async () => {
    const fake = new FakeStrava(makeHistory(10), { failAfter: 4, failStatus: 500 });
    const repo = new MemoryRepo();
    const { outcome } = await invoke(fake, repo);
    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("500");
    expect(repo.details.size).toBe(2);
    expect(repo.activities.size).toBe(10);
  });

  it("marks a run deleted when its detail returns 404", async () => {
    const fake = new FakeStrava(makeHistory(3));
    const repo = new MemoryRepo();
    await invoke(fake, repo, 2); // zones + list
    fake.deleted.add(1002);
    await invoke(fake, repo);
    expect(repo.activities.get(1002)!.deleted_at).not.toBeNull();
    expect(repo.details.has(1002)).toBe(false);
    expect(repo.details.size).toBe(2);
  });

  it("re-upserting a summary keeps detail progress", async () => {
    const fake = new FakeStrava([makeActivity(1, "2026-10-01T07:00:00Z")]);
    const repo = new MemoryRepo();
    await invoke(fake, repo);
    const syncedAt = repo.activities.get(1)!.detail_synced_at;
    expect(syncedAt).not.toBeNull();
    const { detail_synced_at: _d, ...summary } = repo.activities.get(1)!;
    await repo.upsertActivities([{ ...summary, name: "renamed", deleted_at: null }]);
    expect(repo.activities.get(1)!.detail_synced_at).toBe(syncedAt);
  });

  it("stays under the Workers free-plan limit of 50 subrequests in the busiest invocation", async () => {
    const fake = new FakeStrava(makeHistory(1000));
    const repo = new MemoryRepo();
    const { client } = await invoke(fake, repo); // zones + 2 full pages + details: worst case
    const TOKEN_CALLS = 3; // load, refresh, save
    const RUN_LOG_CALLS = 2; // startRun, finishRun (outside runBackfill)
    expect(client.requests + repo.calls + TOKEN_CALLS + RUN_LOG_CALLS).toBeLessThanOrEqual(50);
  });
});
