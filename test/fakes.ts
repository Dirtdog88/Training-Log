import type { ActivityRow, DetailRow } from "../src/mapping";
import type { SyncRepo, SyncRunResult, SyncState, SyncStatePatch } from "../src/repo";
import type { SummaryActivity } from "../src/strava/types";

const ATHLETE = 9;

export function makeActivity(id: number, startIso: string, sport_type = "Run"): SummaryActivity {
  return {
    id,
    athlete: { id: ATHLETE },
    name: `Activity ${id}`,
    sport_type,
    workout_type: 0,
    start_date: startIso,
    start_date_local: startIso,
    distance: 10000,
    moving_time: 2700,
    elapsed_time: 2800,
    has_heartrate: true,
    average_heartrate: 150,
  };
}

/** `count` activities one day apart, newest first, every `rideEvery`-th one a ride. */
export function makeHistory(count: number, rideEvery = 0): SummaryActivity[] {
  const start = Date.parse("2026-10-01T07:00:00Z");
  return Array.from({ length: count }, (_, i) =>
    makeActivity(
      1000 + count - i,
      new Date(start - i * 86_400_000).toISOString(),
      rideEvery && i % rideEvery === rideEvery - 1 ? "Ride" : "Run",
    ),
  );
}

export interface FakeStravaOptions {
  /** Return 429 once this many requests have been served. */
  failAfter?: number;
  failStatus?: number;
  /** Rate-limit usage reported in headers: [15-min used, daily used]. */
  usage?: () => [number, number];
}

/** A fake Strava API backed by an in-memory list of activities (newest first). */
export class FakeStrava {
  calls: string[] = [];
  deleted = new Set<number>();

  constructor(public activities: SummaryActivity[], private opts: FakeStravaOptions = {}) {}

  fetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    this.calls.push(url.pathname + url.search);
    const [shortUsed, dailyUsed] = this.opts.usage?.() ?? [0, 0];
    const headers = {
      "x-readratelimit-limit": "100,1000",
      "x-readratelimit-usage": `${shortUsed},${dailyUsed}`,
    };
    if (this.opts.failAfter !== undefined && this.calls.length > this.opts.failAfter) {
      return new Response("fail", { status: this.opts.failStatus ?? 429, headers });
    }

    const path = url.pathname.replace("/api/v3", "");
    if (path === "/athlete/zones") return Response.json({ heart_rate: { zones: [] } }, { headers });
    if (path === "/athlete/activities") {
      const perPage = Number(url.searchParams.get("per_page"));
      const page = Number(url.searchParams.get("page") ?? 1);
      const before = url.searchParams.get("before");
      const after = url.searchParams.get("after");
      const list = this.activities
        .filter((a) => !this.deleted.has(a.id))
        .filter((a) => !before || Date.parse(a.start_date) / 1000 < Number(before))
        .filter((a) => !after || Date.parse(a.start_date) / 1000 > Number(after))
        // Strava returns oldest-first when `after` is given, newest-first otherwise.
        .sort((a, b) => (after ? 1 : -1) * (Date.parse(a.start_date) - Date.parse(b.start_date)))
        .slice((page - 1) * perPage, page * perPage);
      return Response.json(list, { headers });
    }
    const m = path.match(/^\/activities\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const a = this.activities.find((x) => x.id === id);
      if (!a || this.deleted.has(id)) return new Response("not found", { status: 404, headers });
      return Response.json(
        { ...a, description: "desc", laps: [{}, {}], splits_metric: [], best_efforts: [], segment_efforts: [1, 2] },
        { headers },
      );
    }
    return new Response("unknown route", { status: 500 });
  };

  detailCalls(): number[] {
    return this.calls.filter((c) => c.startsWith("/api/v3/activities/")).map((c) => Number(c.split("/")[4]?.split("?")[0]));
  }
}

type StoredActivity = Omit<ActivityRow, "deleted_at"> & { detail_synced_at: string | null; deleted_at: string | null };

/** In-memory SyncRepo that mimics the Supabase upsert semantics and counts calls. */
export class MemoryRepo implements SyncRepo {
  calls = 0;
  state: SyncState = {
    backfill_before: null,
    backfill_complete: false,
    incremental_after: null,
    last_incremental_at: null,
    last_resync_at: null,
    zones_fetched_at: null,
  };
  activities = new Map<number, StoredActivity>();
  details = new Map<number, DetailRow>();
  runs: SyncRunResult[] = [];
  zones: unknown = null;

  async getSyncState() {
    this.calls++;
    return { ...this.state };
  }
  async updateSyncState(patch: SyncStatePatch) {
    this.calls++;
    this.state = { ...this.state, ...patch };
  }
  async startRun() {
    this.calls++;
    return this.runs.length + 1;
  }
  async finishRun(id: number, result: SyncRunResult) {
    this.calls++;
    this.runs[id - 1] = result;
  }
  async saveZones(_athleteId: number, zones: unknown) {
    this.calls++;
    this.zones = zones;
  }
  async upsertActivities(rows: ActivityRow[]) {
    this.calls++;
    for (const r of rows) {
      const existing = this.activities.get(r.id);
      // Upsert updates only the supplied columns, like PostgREST merge-duplicates.
      this.activities.set(r.id, { detail_synced_at: null, ...existing, ...r });
    }
  }
  async activitiesNeedingDetail(limit: number) {
    this.calls++;
    return [...this.activities.values()]
      .filter((a) => a.detail_synced_at === null && a.deleted_at === null)
      .sort((a, b) => Date.parse(b.start_date) - Date.parse(a.start_date))
      .slice(0, limit)
      .map((a) => a.id);
  }
  async saveDetails(rows: DetailRow[]) {
    this.calls++;
    for (const r of rows) this.details.set(r.activity_id, r);
  }
  async markDetailSynced(ids: number[], at: string) {
    this.calls++;
    for (const id of ids) this.activities.get(id)!.detail_synced_at = at;
  }
  async markDeleted(ids: number[], at: string) {
    this.calls++;
    for (const id of ids) this.activities.get(id)!.deleted_at = at;
  }
  async newestActivityStart() {
    this.calls++;
    const starts = [...this.activities.values()].map((a) => Date.parse(a.start_date));
    // Postgres-style formatting, to catch code that compares timestamps as strings.
    return starts.length ? new Date(Math.max(...starts)).toISOString().replace("Z", "+00:00") : null;
  }
  async activeRunIdsSince(sinceIso: string) {
    this.calls++;
    return [...this.activities.values()]
      .filter((a) => a.deleted_at === null && Date.parse(a.start_date) >= Date.parse(sinceIso))
      .map((a) => a.id);
  }
  async resetDetails(ids: number[]) {
    this.calls++;
    for (const id of ids) this.activities.get(id)!.detail_synced_at = null;
  }
}
