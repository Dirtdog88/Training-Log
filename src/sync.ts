import { isRun, toActivityRow, toDetailRow, type DetailRow } from "./mapping";
import type { SyncRepo, SyncRunResult, SyncStatePatch } from "./repo";
import { BudgetExhaustedError, NotFoundError, RateLimitedError, type StravaClient } from "./strava/client";
import type { DetailedActivity, SummaryActivity } from "./strava/types";

const ZONES_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

export interface SyncOptions {
  athleteId: number;
  /** Max list pages per invocation; each page is one request and one upsert. */
  maxListPages: number;
  /** Activities per list page (Strava max 200). */
  perPage: number;
  now?: () => Date;
}

export type SyncOutcome = Omit<SyncRunResult, "strava_requests"> & { backfill_complete: boolean };

/**
 * One cron invocation of the backfill: refresh HR zones if stale, page backwards through the
 * activity list, then fetch detail views for runs that lack them. Stops cleanly when the request
 * budget or Strava's rate limit is reached; progress is saved so the next run resumes.
 */
export async function runBackfill(strava: StravaClient, repo: SyncRepo, opts: SyncOptions): Promise<SyncOutcome> {
  const now = opts.now ?? (() => new Date());
  const state = await repo.getSyncState();
  const patch: SyncStatePatch = {};
  const outcome: SyncOutcome = {
    status: "ok",
    summaries_upserted: 0,
    details_fetched: 0,
    streams_fetched: 0,
    error: null,
    backfill_complete: state.backfill_complete,
  };
  const details: DetailRow[] = [];
  const deleted: number[] = [];

  try {
    // 1. HR zones — one request, refreshed monthly.
    const zonesAge = state.zones_fetched_at ? now().getTime() - Date.parse(state.zones_fetched_at) : Infinity;
    if (zonesAge > ZONES_REFRESH_MS) {
      const zones = await strava.get<unknown>("/athlete/zones");
      await repo.saveZones(opts.athleteId, zones);
      patch.zones_fetched_at = now().toISOString();
    }

    // 2. Activity list, newest to oldest, using a `before` timestamp cursor so runs added or
    //    deleted mid-backfill cannot shift pages and cause skips.
    let before = state.backfill_before;
    for (let page = 0; !outcome.backfill_complete && page < opts.maxListPages; page++) {
      const params: Record<string, number> = { per_page: opts.perPage, page: 1 };
      if (before) params.before = Math.floor(Date.parse(before) / 1000);
      const activities = await strava.get<SummaryActivity[]>("/athlete/activities", params);

      const runs = activities.filter(isRun).map((a) => toActivityRow(a, now()));
      if (runs.length > 0) {
        await repo.upsertActivities(runs);
        outcome.summaries_upserted += runs.length;
      }

      if (activities.length < opts.perPage) {
        outcome.backfill_complete = true;
        patch.backfill_complete = true;
        break;
      }
      // `before` is exclusive; step 1s past the oldest start so a run sharing that exact second
      // is re-read (harmless upsert) rather than skipped.
      const oldest = Math.min(...activities.map((a) => Date.parse(a.start_date)));
      before = new Date(oldest + 1000).toISOString();
      patch.backfill_before = before;
    }

    // 3. Detail view for runs missing it, newest first, using whatever budget is left.
    const remaining = strava.remaining();
    if (remaining > 0) {
      for (const id of await repo.activitiesNeedingDetail(remaining)) {
        try {
          const d = await strava.get<DetailedActivity>(`/activities/${id}`, { include_all_efforts: "false" });
          details.push(toDetailRow(d, now()));
        } catch (err) {
          if (!(err instanceof NotFoundError)) throw err;
          deleted.push(id);
        }
      }
    }
  } catch (err) {
    if (err instanceof RateLimitedError) {
      outcome.status = "rate_limited";
      outcome.error = err.message;
    } else if (!(err instanceof BudgetExhaustedError)) {
      outcome.status = "error";
      outcome.error = err instanceof Error ? err.message : String(err);
    }
  }

  // Persist whatever was fetched, even after a stop or error, so nothing is fetched twice.
  const at = now().toISOString();
  if (details.length > 0) {
    await repo.saveDetails(details);
    await repo.markDetailSynced(details.map((d) => d.activity_id), at);
    outcome.details_fetched = details.length;
  }
  if (deleted.length > 0) await repo.markDeleted(deleted, at);
  if (Object.keys(patch).length > 0) await repo.updateSyncState(patch);

  return outcome;
}
