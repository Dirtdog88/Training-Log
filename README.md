# Training Log

Pulls my Strava run history into Supabase on a Cloudflare Workers cron, so runs can be
analyzed later (Phase 2: key-workout scoring and a 2027 half-marathon plan).

Plan and design decisions: [`docs/2026-10-06-phase1-plan.md`](docs/2026-10-06-phase1-plan.md).

## Status

| Step | What | State |
|---|---|---|
| 0 | Accounts & keys (Strava app, Supabase, Cloudflare) | to do (manual) |
| 1 | Repo scaffold | done |
| 2 | Database schema | done |
| 3 | One-time local OAuth script + token refresh | done |
| 4 | Backfill (run list + detail view) | done |
| 5 | Incremental sync + 30-day re-pull | done |
| 6 | `runs_overview` CSV export | next (view done) |
| 7 | Tests, `/status`, deploy | |

## Layout

```
src/                      Cloudflare Worker (cron sync + /status)
scripts/                  Local one-off scripts (OAuth login, CSV export)
supabase/migrations/      Postgres schema
docs/                     Plans and notes (dated file names)
test/                     Vitest unit tests
```

## Step 0 — Setup

1. **Supabase**: create a project. Under *Project Settings → API* copy the project URL and the
   `service_role` key. Apply the schema by pasting
   `supabase/migrations/20261006000000_init.sql` into the SQL editor (or `supabase db push`).
2. **Strava**: create an API app at <https://www.strava.com/settings/api>. Set
   *Authorization Callback Domain* to `localhost`. Copy the Client ID and Client Secret.
3. **Cloudflare**: a free account is enough. `npx wrangler login`.
4. Copy `.env.example` to `.env` and fill it in (git-ignored).

## Step 3 — Connect Strava (once)

```sh
npm install
npm run auth
```

Open the printed URL, approve with **all boxes ticked**, and the script stores the tokens in
Supabase. It asks for `read`, `activity:read_all` (includes private runs) and
`profile:read_all` (needed for heart-rate zones), and refuses to save if any is missing or if
the redirect's `state` doesn't match. On first run it prints your athlete ID: put it in
`wrangler.toml` (`STRAVA_ATHLETE_ID`) and in `.env` so later logins must be the same account.

## How the sync works

Every 15 minutes the Worker runs these phases in order, sharing one request budget:

1. **Zones** — refreshes HR zones if they are older than 30 days (1 request).
2. **New runs** — hourly, lists activities newer than the newest one already seen
   (`sync_state.incremental_after`). Runs during the backfill too.
3. **30-day re-pull** — daily, once the backfill is done: re-lists the last 30 days to pick up
   renames and edits, re-queues those runs' detail views (descriptions and laps can change), and
   marks runs that disappeared or stopped being runs as deleted (`deleted_at`). A run that
   reappears is restored. Costs ~1 list request plus ~30 detail requests a day.
4. **Backfill** — pages backwards through `/athlete/activities` (200 per page, max 2 pages per run), keeping only
   `Run`, `TrailRun` and `VirtualRun`. Progress is a timestamp cursor (`sync_state.backfill_before`).
5. **Details** — spends the rest of its budget (15 Strava requests per run by default) fetching
   the detail view of runs that lack it, newest first. Segment efforts and the full map are dropped to save space.

It stops early on a 429 or when Strava's usage headers show it is within 5 requests of the
15-minute or daily limit, saves what it fetched, and resumes on the next run. Each run is logged
in `sync_runs`. Expect roughly 1,000 runs per day, so a few years of history finishes in 1–3 days.

Tuning (`wrangler.toml` vars): `SYNC_STRAVA_BUDGET`, `SYNC_MAX_LIST_PAGES`.

## Security notes

- All tables and the view have RLS enabled with no policies, and grants revoked from `anon` and
  `authenticated`. Only the `service_role` key can read or write. Keep that key out of git and
  out of any browser code.
- There is no public OAuth route on the Worker; login happens once via a local script.
