# Deploy checklist — Phase 1

Run these on your own machine from the repo root. About 20–30 minutes end to end.
Commands that print secrets are marked; don't paste their output anywhere.

## 1. Supabase (≈5 min)

1. Create a project at <https://supabase.com/dashboard> (free plan, any region near you).
2. **SQL Editor → New query**: paste all of `supabase/migrations/20261006000000_init.sql`, run it.
   Expect "Success. No rows returned".
3. **Project Settings → API**: copy the **Project URL** and the **`service_role`** key
   (not the `anon` key). Note the **Project ID** too if you want the Claude connection later.
4. Quick check in the SQL editor: `select * from sync_state;` returns one row.

## 2. Strava API app (≈3 min)

1. <https://www.strava.com/settings/api> → create an app. Website can be anything
   (e.g. `http://localhost`). **Authorization Callback Domain: `localhost`**.
2. Copy the **Client ID** and **Client Secret**.
3. If Strava asks for a paid developer plan or any fee, stop and let me know before paying.

## 3. Local setup and Strava login (≈5 min)

```sh
npm install
cp .env.example .env          # then fill in STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET,
                              # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
npm run auth                  # open the printed URL, approve with ALL boxes ticked
```

Expect: `Saved tokens for <your name> (ID 12345678)`. Then:

- Put that ID in `wrangler.toml`: `STRAVA_ATHLETE_ID = "12345678"`
- Add `STRAVA_ATHLETE_ID=12345678` to `.env` (locks future logins to your account).

## 4. Cloudflare (≈5 min)

```sh
npx wrangler login
openssl rand -hex 32          # SECRET OUTPUT: this is your STATUS_TOKEN; save it in your password manager
npx wrangler secret put STRAVA_CLIENT_ID
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put STATUS_TOKEN
npm run deploy
```

> The first `secret put` may offer to create the Worker before it is deployed: answer yes.

`npm run deploy` prints the Worker URL, e.g. `https://training-log.<you>.workers.dev`.
The cron starts on the next quarter hour.

## 5. Watch the first runs (≈15–30 min)

```sh
npx wrangler tail             # live logs; each run prints one {"event":"sync",...} line
```

And the status page:

```sh
curl -s -H "Authorization: Bearer <STATUS_TOKEN>" https://training-log.<you>.workers.dev/status
```

What good looks like after the first run:

- `last_run.status` is `ok` (or `rate_limited`, which is normal: it paused for Strava's limit).
- `counts.runs` jumps by up to 400, then `awaiting_detail` falls by ~12 per run.
- `healthy: true`. `backfill.reached` moves further into the past until `complete: true`.

You can also query Supabase directly: `select * from sync_runs order by id desc limit 10;`

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Exceeded CPU limit` in `wrangler tail` | Free plan's 10 ms CPU cap | Set `SYNC_MAX_LIST_PAGES = "1"` in `wrangler.toml`, redeploy. If it persists, Workers Paid ($5/mo). |
| `No Strava tokens stored…` | Login not done, or different Supabase project | Re-run `npm run auth` with the same `.env` as the Worker secrets. |
| `Strava token request failed: 400/401` | App secret changed, or access revoked on Strava | Check `STRAVA_CLIENT_SECRET`; re-run `npm run auth`. |
| `STRAVA_ATHLETE_ID is not set` | ID missing in `wrangler.toml` | Add it, `npm run deploy`. |
| `/status` returns 503 | `STATUS_TOKEN` secret not set | `npx wrangler secret put STATUS_TOKEN`. |
| `… failed: permission denied` | Using the `anon` key | Use the `service_role` key. |
| Status stuck at `rate_limited` for hours | Daily Strava limit reached | Normal during the backfill; resumes after midnight UTC. |

## After the backfill completes

- `npm run export:csv` → `exports/` → bring the CSVs to Claude for the workout review.
- Or connect the read-only Supabase MCP (see README) so Claude can query directly.
