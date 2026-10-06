import { beforeEach, describe, expect, it } from "vitest";
import { StravaClient } from "../src/strava/client";
import { runSync } from "../src/sync";
import { FakeStrava, MemoryRepo, makeActivity, makeHistory } from "./fakes";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let clock: number;
let fake: FakeStrava;
let repo: MemoryRepo;

function invoke(budget = 15) {
  const client = new StravaClient("token", budget, fake.fetch);
  return runSync(client, repo, { athleteId: 9, maxListPages: 2, perPage: 200, now: () => new Date(clock) });
}

async function drain() {
  for (let i = 0; i < 100; i++) {
    await invoke();
    if (repo.state.backfill_complete && (await repo.activitiesNeedingDetail(1)).length === 0) return;
  }
  throw new Error("did not finish");
}

const listCalls = () => fake.calls.filter((c) => c.includes("/athlete/activities"));

beforeEach(async () => {
  clock = Date.parse("2026-10-01T12:00:00Z"); // newest history run is 07:00 the same day
  fake = new FakeStrava(makeHistory(60)); // one run per day, going back 60 days
  repo = new MemoryRepo();
  await drain();
  fake.calls = [];
});

describe("new runs", () => {
  it("picks up a new run within the hour and fetches its detail, without re-listing history", async () => {
    fake.activities.unshift(makeActivity(5000, "2026-10-01T18:00:00Z"));
    clock += 7 * HOUR;
    await invoke();

    expect(repo.activities.has(5000)).toBe(true);
    expect(repo.details.has(5000)).toBe(true);
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]).toContain("after=");
    expect(Date.parse(repo.state.incremental_after!)).toBe(Date.parse("2026-10-01T18:00:00Z"));
  });

  it("checks at most hourly", async () => {
    clock += 2 * HOUR;
    await invoke();
    clock += 30 * 60_000;
    await invoke();
    expect(listCalls()).toHaveLength(1);
  });

  it("ignores new rides", async () => {
    fake.activities.unshift(makeActivity(5001, "2026-10-01T18:00:00Z", "Ride"));
    clock += 7 * HOUR;
    await invoke();
    expect(repo.activities.has(5001)).toBe(false);
  });

  it("catches runs added while the backfill is still in progress", async () => {
    fake = new FakeStrava(makeHistory(600));
    repo = new MemoryRepo();
    await invoke(); // zones + 2 list pages + details; backfill not finished
    expect(repo.state.backfill_complete).toBe(false);

    fake.activities.unshift(makeActivity(7000, "2026-10-01T18:00:00Z"));
    clock += 7 * HOUR;
    await drain();
    expect(repo.activities.has(7000)).toBe(true);
    expect(repo.activities.size).toBe(601);
  });
});

describe("daily 30-day re-pull", () => {
  it("does not start until a day after the backfill finished", async () => {
    clock += 20 * HOUR;
    await invoke();
    expect(listCalls().some((c) => c.includes(`after=${Math.floor((clock - 30 * DAY) / 1000)}`))).toBe(false);
  });

  it("applies renames, re-fetches details, and marks vanished or re-typed runs deleted", async () => {
    const [renamed, removed, retyped] = [fake.activities[2]!, fake.activities[5]!, fake.activities[8]!];
    const old = fake.activities[45]!; // outside the 30-day window
    renamed.name = "6x800 @ track";
    fake.deleted.add(removed.id);
    retyped.sport_type = "Ride";
    fake.deleted.add(old.id);

    clock += DAY;
    await drain();

    expect(repo.activities.get(renamed.id)!.name).toBe("6x800 @ track");
    expect(repo.activities.get(renamed.id)!.detail_synced_at).not.toBeNull(); // re-fetched
    expect(repo.activities.get(removed.id)!.deleted_at).not.toBeNull();
    expect(repo.activities.get(retyped.id)!.deleted_at).not.toBeNull();
    expect(repo.activities.get(old.id)!.deleted_at).toBeNull(); // outside window: untouched
    expect(Date.parse(repo.state.last_resync_at!)).toBe(clock);

    // Details for the window were re-fetched once each (~29 runs), not the whole history.
    const detailCalls = fake.detailCalls();
    expect(detailCalls.length).toBeGreaterThan(25);
    expect(detailCalls.length).toBeLessThan(32);
  });

  it("restores a run that reappears after being marked deleted", async () => {
    const run = fake.activities[3]!;
    fake.deleted.add(run.id);
    clock += DAY;
    await drain();
    expect(repo.activities.get(run.id)!.deleted_at).not.toBeNull();

    fake.deleted.delete(run.id);
    clock += DAY;
    await drain();
    expect(repo.activities.get(run.id)!.deleted_at).toBeNull();
  });
});
