import { createDb, supabaseTokenStore } from "./db";
import type { Env } from "./env";
import { supabaseSyncRepo, type SyncRepo } from "./repo";
import { StravaClient } from "./strava/client";
import { getAccessToken, type TokenStore } from "./strava/tokens";
import { runSync } from "./sync";

// Defaults sized for the Workers free plan (50 subrequests and limited CPU per invocation).
// Strava's ~1,000 reads/day cap is the real throughput limit, so small runs lose nothing:
// 96 runs/day x 15 requests already exceeds it.
const DEFAULT_STRAVA_BUDGET = 15;
const DEFAULT_MAX_LIST_PAGES = 2;
const PER_PAGE = 200;

function intVar(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export async function syncOnce(
  env: Env,
  deps: { repo: SyncRepo; tokens: TokenStore; fetchImpl?: typeof fetch },
): Promise<void> {
  const athleteId = Number(env.STRAVA_ATHLETE_ID);
  if (!Number.isInteger(athleteId) || athleteId <= 0) {
    throw new Error("STRAVA_ATHLETE_ID is not set in wrangler.toml; run `npm run auth` first.");
  }

  const runId = await deps.repo.startRun();
  let strava: StravaClient | null = null;
  let recorded = false;
  try {
    const token = await getAccessToken(
      athleteId,
      { clientId: env.STRAVA_CLIENT_ID, clientSecret: env.STRAVA_CLIENT_SECRET },
      deps.tokens,
      deps.fetchImpl,
    );
    strava = new StravaClient(token, intVar(env.SYNC_STRAVA_BUDGET, DEFAULT_STRAVA_BUDGET), deps.fetchImpl);
    const outcome = await runSync(strava, deps.repo, {
      athleteId,
      maxListPages: intVar(env.SYNC_MAX_LIST_PAGES, DEFAULT_MAX_LIST_PAGES),
      perPage: PER_PAGE,
    });
    const { backfill_complete: _done, ...result } = outcome;
    await deps.repo.finishRun(runId, { ...result, strava_requests: strava.requests });
    recorded = true;
    console.log(JSON.stringify({ event: "sync", runId, ...outcome, strava_requests: strava.requests }));
    if (outcome.status === "error") throw new Error(outcome.error ?? "sync failed");
  } catch (err) {
    if (!recorded) {
      // Failed before the sync could report (e.g. token refresh, database write).
      await deps.repo
        .finishRun(runId, {
          status: "error",
          summaries_upserted: 0,
          details_fetched: 0,
          streams_fetched: 0,
          strava_requests: strava?.requests ?? 0,
          error: err instanceof Error ? err.message : String(err),
        })
        .catch(() => undefined);
    }
    // Rethrow so Cloudflare marks the cron invocation as failed.
    throw err;
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const db = createDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    await syncOnce(env, { repo: supabaseSyncRepo(db), tokens: supabaseTokenStore(db) });
  },

  // /status arrives in Step 7.
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
