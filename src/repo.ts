import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActivityRow, DetailRow } from "./mapping";

export interface SyncState {
  backfill_before: string | null;
  backfill_complete: boolean;
  last_resync_at: string | null;
  zones_fetched_at: string | null;
}

export type SyncStatePatch = Partial<SyncState>;

export interface SyncRunResult {
  status: "ok" | "rate_limited" | "error";
  summaries_upserted: number;
  details_fetched: number;
  streams_fetched: number;
  strava_requests: number;
  error: string | null;
}

/**
 * Everything the sync needs from the database. Each method is one Supabase request, which keeps
 * the per-invocation subrequest count predictable (Workers free plan: 50 per invocation).
 */
export interface SyncRepo {
  getSyncState(): Promise<SyncState>;
  updateSyncState(patch: SyncStatePatch): Promise<void>;
  startRun(): Promise<number>;
  finishRun(id: number, result: SyncRunResult): Promise<void>;
  saveZones(athleteId: number, zones: unknown): Promise<void>;
  upsertActivities(rows: ActivityRow[]): Promise<void>;
  activitiesNeedingDetail(limit: number): Promise<number[]>;
  saveDetails(rows: DetailRow[]): Promise<void>;
  markDetailSynced(ids: number[], at: string): Promise<void>;
  markDeleted(ids: number[], at: string): Promise<void>;
}

function check(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what} failed: ${error.message}`);
}

export function supabaseSyncRepo(db: SupabaseClient): SyncRepo {
  return {
    async getSyncState() {
      const { data, error } = await db
        .from("sync_state")
        .select("backfill_before, backfill_complete, last_resync_at, zones_fetched_at")
        .eq("id", 1)
        .single();
      check(error, "Loading sync_state");
      return data as SyncState;
    },
    async updateSyncState(patch) {
      const { error } = await db
        .from("sync_state")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", 1);
      check(error, "Updating sync_state");
    },
    async startRun() {
      const { data, error } = await db.from("sync_runs").insert({}).select("id").single();
      check(error, "Starting sync run");
      return (data as { id: number }).id;
    },
    async finishRun(id, result) {
      const { error } = await db
        .from("sync_runs")
        .update({ ...result, finished_at: new Date().toISOString() })
        .eq("id", id);
      check(error, "Finishing sync run");
    },
    async saveZones(athleteId, zones) {
      const { error } = await db
        .from("athlete_zones")
        .upsert({ athlete_id: athleteId, zones, fetched_at: new Date().toISOString() });
      check(error, "Saving athlete zones");
    },
    async upsertActivities(rows) {
      const { error } = await db.from("activities").upsert(rows, { onConflict: "id" });
      check(error, "Upserting activities");
    },
    async activitiesNeedingDetail(limit) {
      const { data, error } = await db
        .from("activities")
        .select("id")
        .is("detail_synced_at", null)
        .is("deleted_at", null)
        .order("start_date", { ascending: false })
        .limit(limit);
      check(error, "Listing activities needing detail");
      return (data as { id: number }[]).map((r) => r.id);
    },
    async saveDetails(rows) {
      const { error } = await db.from("activity_details").upsert(rows, { onConflict: "activity_id" });
      check(error, "Saving activity details");
    },
    async markDetailSynced(ids, at) {
      const { error } = await db.from("activities").update({ detail_synced_at: at }).in("id", ids);
      check(error, "Marking details synced");
    },
    async markDeleted(ids, at) {
      const { error } = await db.from("activities").update({ deleted_at: at }).in("id", ids);
      check(error, "Marking activities deleted");
    },
  };
}
