import { isRun, toActivityRow, toDetailRow, type DetailRow } from "./mapping";
import type { SyncRepo, SyncRunResult, SyncState, SyncStatePatch } from "./repo";
import { BudgetExhaustedError, NotFoundError, RateLimitedError, type StravaClient } from "./strava/client";
import type { DetailedActivity, SummaryActivity } from "./strava/types";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ZONES_REFRESH_MS = 30 * DAY;
// Slightly under the nominal interval so cron jitter doesn't push a check back a whole cycle.
const INCREMENTAL_EVERY_MS = 55 * MINUTE;
const RESYNC_EVERY_MS = 23.5 * 60 * MINUTE;
const RESYNC_WINDOW_MS = 30 * DAY;

export interface SyncOptions {
  athleteId: number;
  /** Max list pages per phase per invocation; each page is one request and one upsert. */
  maxListPages: number;
  /** Activities per list page (Strava max 200). */
  perPage: number;
  now?: () => Date;
}

export type SyncOutcome = Omit<SyncRunResult, "strava_requests"> & { backfill_complete: boolean };

interface Ctx {
  strava: StravaClient;
  repo: SyncRepo;
  opts: SyncOptions;
  now: () => Date;
  state: SyncState;
  patch: SyncStatePatch;
  outcome: SyncOutcome;
}

const toEpoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const isDue = (last: string | null, everyMs: number, now: Date) =>
  last === null || now.getTime() - Date.parse(last) >= everyMs;

/**
 * Lists activities that started after `afterIso`, using the page parameter (correct whichever
 * order Strava returns them in). `complete` is false if the page cap was hit with more to come.
 */
async function listAfter(ctx: Ctx, afterIso: string): Promise<{ activities: SummaryActivity[]; complete: boolean }> {
  const activities: SummaryActivity[] = [];
  for (let page = 1; page <= ctx.opts.maxListPages; page++) {
    const batch = await ctx.strava.get<SummaryActivity[]>("/athlete/activities", {
      after: toEpoch(afterIso),
      per_page: ctx.opts.perPage,
      page,
    });
    activities.push(...batch);
    if (batch.length < ctx.opts.perPage) return { activities, complete: true };
  }
  return { activities, complete: false };
}

async function upsertRuns(ctx: Ctx, activities: SummaryActivity[]): Promise<number[]> {
  const rows = activities.filter(isRun).map((a) => toActivityRow(a, ctx.now()));
  if (rows.length > 0) {
    await ctx.repo.upsertActivities(rows);
    ctx.outcome.summaries_upserted += rows.length;
  }
  return rows.map((r) => r.id);
}

/** HR zones — one request, refreshed monthly. */
async function syncZones(ctx: Ctx): Promise<void> {
  if (!isDue(ctx.state.zones_fetched_at, ZONES_REFRESH_MS, ctx.now())) return;
  const zones = await ctx.strava.get<unknown>("/athlete/zones");
  await ctx.repo.saveZones(ctx.opts.athleteId, zones);
  ctx.patch.zones_fetched_at = ctx.now().toISOString();
}

/** New runs since the newest one already listed. Hourly; also runs during the backfill. */
async function syncNewRuns(ctx: Ctx): Promise<void> {
  if (!isDue(ctx.state.last_incremental_at, INCREMENTAL_EVERY_MS, ctx.now())) return;
  const after = ctx.state.incremental_after ?? (await ctx.repo.newestActivityStart());
  if (after === null) return; // nothing stored yet; the backfill's first page covers "now"

  const { activities, complete } = await listAfter(ctx, after);
  await upsertRuns(ctx, activities);
  if (!complete) return; // try again next run from the same cursor

  // Compare as times: Strava ("...Z") and Postgres ("...+00:00") format timestamps differently.
  const newest = Math.max(Date.parse(after), ...activities.map((a) => Date.parse(a.start_date)));
  ctx.patch.incremental_after = new Date(newest).toISOString();
  ctx.patch.last_incremental_at = ctx.now().toISOString();
}

/**
 * Daily re-pull of the last 30 days, once the backfill is done: picks up renamed or edited runs,
 * re-queues their detail views (descriptions and laps can change), and marks runs that vanished
 * from Strava (deleted, or changed to a non-run sport) as deleted.
 */
async function resyncRecent(ctx: Ctx): Promise<void> {
  if (!ctx.state.backfill_complete || !isDue(ctx.state.last_resync_at, RESYNC_EVERY_MS, ctx.now())) return;
  const windowStart = new Date(ctx.now().getTime() - RESYNC_WINDOW_MS).toISOString();

  const { activities, complete } = await listAfter(ctx, windowStart);
  const listed = await upsertRuns(ctx, activities);
  if (!complete) return; // can't judge deletions from a partial list

  // Skip the first minute of the window so boundary rounding can't flag a run as missing.
  const stored = await ctx.repo.activeRunIdsSince(new Date(Date.parse(windowStart) + MINUTE).toISOString());
  const listedSet = new Set(listed);
  const vanished = stored.filter((id) => !listedSet.has(id));
  if (vanished.length > 0) await ctx.repo.markDeleted(vanished, ctx.now().toISOString());
  if (listed.length > 0) await ctx.repo.resetDetails(listed);
  ctx.patch.last_resync_at = ctx.now().toISOString();
}

/**
 * Pages backwards through the full history using a `before` timestamp cursor, so runs added or
 * deleted mid-backfill cannot shift pages and cause skips.
 */
async function backfill(ctx: Ctx): Promise<void> {
  let before = ctx.state.backfill_before;
  for (let page = 0; !ctx.outcome.backfill_complete && page < ctx.opts.maxListPages; page++) {
    const params: Record<string, number> = { per_page: ctx.opts.perPage, page: 1 };
    if (before) params.before = toEpoch(before);
    const activities = await ctx.strava.get<SummaryActivity[]>("/athlete/activities", params);
    await upsertRuns(ctx, activities);

    if (activities.length < ctx.opts.perPage) {
      ctx.outcome.backfill_complete = true;
      ctx.patch.backfill_complete = true;
      // Everything was just fetched, so the first 30-day re-pull can wait a day.
      ctx.patch.last_resync_at = ctx.now().toISOString();
      return;
    }
    // `before` is exclusive; step 1s past the oldest start so a run sharing that exact second
    // is re-read (harmless upsert) rather than skipped.
    const oldest = Math.min(...activities.map((a) => Date.parse(a.start_date)));
    before = new Date(oldest + 1000).toISOString();
    ctx.patch.backfill_before = before;
  }
}

/** Detail view for runs missing it, newest first, using whatever budget is left. */
async function fetchDetails(ctx: Ctx, details: DetailRow[], deleted: number[]): Promise<void> {
  const remaining = ctx.strava.remaining();
  if (remaining === 0) return;
  for (const id of await ctx.repo.activitiesNeedingDetail(remaining)) {
    try {
      const d = await ctx.strava.get<DetailedActivity>(`/activities/${id}`, { include_all_efforts: "false" });
      details.push(toDetailRow(d, ctx.now()));
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      deleted.push(id);
    }
  }
}

/**
 * One cron invocation. Phases run in priority order and share the request budget:
 * zones → new runs → 30-day re-pull → backfill → details. Stops cleanly at the budget or
 * Strava's rate limit; everything fetched so far is saved and the next run resumes.
 */
export async function runSync(strava: StravaClient, repo: SyncRepo, opts: SyncOptions): Promise<SyncOutcome> {
  const state = await repo.getSyncState();
  const ctx: Ctx = {
    strava,
    repo,
    opts,
    now: opts.now ?? (() => new Date()),
    state,
    patch: {},
    outcome: {
      status: "ok",
      summaries_upserted: 0,
      details_fetched: 0,
      streams_fetched: 0,
      error: null,
      backfill_complete: state.backfill_complete,
    },
  };
  const details: DetailRow[] = [];
  const deleted: number[] = [];

  try {
    await syncZones(ctx);
    await syncNewRuns(ctx);
    await resyncRecent(ctx);
    await backfill(ctx);
    await fetchDetails(ctx, details, deleted);
  } catch (err) {
    if (err instanceof RateLimitedError) {
      ctx.outcome.status = "rate_limited";
      ctx.outcome.error = err.message;
    } else if (!(err instanceof BudgetExhaustedError)) {
      ctx.outcome.status = "error";
      ctx.outcome.error = err instanceof Error ? err.message : String(err);
    }
  }

  // Persist whatever was fetched, even after a stop or error, so nothing is fetched twice.
  const at = ctx.now().toISOString();
  if (details.length > 0) {
    await repo.saveDetails(details);
    await repo.markDetailSynced(details.map((d) => d.activity_id), at);
    ctx.outcome.details_fetched = details.length;
  }
  if (deleted.length > 0) await repo.markDeleted(deleted, at);
  if (Object.keys(ctx.patch).length > 0) await repo.updateSyncState(ctx.patch);

  return ctx.outcome;
}
