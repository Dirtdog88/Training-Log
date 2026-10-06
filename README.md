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
| 4 | Backfill (run list + detail view) | next |
| 5 | Incremental sync + 30-day re-pull | |
| 6 | `runs_overview` CSV export | view done, script pending |
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

## Security notes

- All tables and the view have RLS enabled with no policies, and grants revoked from `anon` and
  `authenticated`. Only the `service_role` key can read or write. Keep that key out of git and
  out of any browser code.
- There is no public OAuth route on the Worker; login happens once via a local script.
