import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncRunResult, SyncState } from "./repo";

// A run counts as healthy if a sync finished cleanly (or paused for rate limits) this recently.
const HEALTHY_WITHIN_MS = 2 * 60 * 60 * 1000;
const RECENT_RUNS = 10;

export interface SyncRunRow extends SyncRunResult {
  id: number;
  started_at: string;
  finished_at: string | null;
}

export interface RunCounts {
  runs: number;
  awaiting_detail: number;
  deleted: number;
}

export interface StatusSource {
  syncState(): Promise<SyncState>;
  recentRuns(limit: number): Promise<SyncRunRow[]>;
  counts(): Promise<RunCounts>;
}

export interface StatusReport {
  healthy: boolean;
  last_success_at: string | null;
  backfill: { complete: boolean; reached: string | null };
  counts: RunCounts;
  last_new_run_check_at: string | null;
  last_30_day_resync_at: string | null;
  last_run: SyncRunRow | null;
  recent_errors: Pick<SyncRunRow, "id" | "started_at" | "error">[];
}

export async function buildStatus(source: StatusSource, now: Date = new Date()): Promise<StatusReport> {
  const [state, runs, counts] = await Promise.all([source.syncState(), source.recentRuns(RECENT_RUNS), source.counts()]);
  const lastSuccess = runs.find((r) => r.finished_at && (r.status === "ok" || r.status === "rate_limited"));
  const lastSuccessAt = lastSuccess?.finished_at ?? null;
  return {
    healthy: lastSuccessAt !== null && now.getTime() - Date.parse(lastSuccessAt) <= HEALTHY_WITHIN_MS,
    last_success_at: lastSuccessAt,
    backfill: { complete: state.backfill_complete, reached: state.backfill_before },
    counts,
    last_new_run_check_at: state.last_incremental_at,
    last_30_day_resync_at: state.last_resync_at,
    last_run: runs[0] ?? null,
    recent_errors: runs
      .filter((r) => r.status === "error")
      .map(({ id, started_at, error }) => ({ id, started_at, error })),
  };
}

/** Constant-time token check: compares SHA-256 digests so neither content nor length leaks. */
export async function tokenMatches(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export async function handleStatus(request: Request, statusToken: string | undefined, source: StatusSource): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  // Never serve status without a configured token, even by accident.
  if (!statusToken) return json({ error: "status endpoint not configured" }, 503);
  const header = request.headers.get("Authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided || !(await tokenMatches(provided, statusToken))) return json({ error: "unauthorized" }, 401);
  return json(await buildStatus(source));
}

function check(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what} failed: ${error.message}`);
}

export function supabaseStatusSource(db: SupabaseClient): StatusSource {
  const count = async (what: string, build: (q: ReturnType<typeof db.from>) => PromiseLike<{ count: number | null; error: { message: string } | null }>) => {
    const { count: n, error } = await build(db.from("activities"));
    check(error, `Counting ${what}`);
    return n ?? 0;
  };
  return {
    async syncState() {
      const { data, error } = await db.from("sync_state").select("*").eq("id", 1).single();
      check(error, "Loading sync_state");
      return data as SyncState;
    },
    async recentRuns(limit) {
      const { data, error } = await db
        .from("sync_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(limit);
      check(error, "Loading sync runs");
      return data as SyncRunRow[];
    },
    async counts() {
      const [runs, awaiting_detail, deleted] = await Promise.all([
        count("runs", (q) => q.select("id", { count: "exact", head: true }).is("deleted_at", null)),
        count("runs awaiting detail", (q) =>
          q.select("id", { count: "exact", head: true }).is("deleted_at", null).is("detail_synced_at", null),
        ),
        count("deleted runs", (q) => q.select("id", { count: "exact", head: true }).not("deleted_at", "is", null)),
      ]);
      return { runs, awaiting_detail, deleted };
    },
  };
}
