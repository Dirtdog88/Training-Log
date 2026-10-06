-- Phase 1 schema: Strava run history.
--
-- Security model: every table and view is reachable only with the service-role key.
-- RLS is enabled with no policies, and anon/authenticated roles have all grants revoked,
-- so the public anon key cannot read tokens or runs through the Supabase REST API.
--
-- Units are Strava-native (meters, seconds, m/s); conversions live in runs_overview.

-- ---------------------------------------------------------------------------
-- OAuth tokens (refresh tokens rotate, so the latest one must be persisted)
-- ---------------------------------------------------------------------------
create table public.strava_tokens (
  athlete_id     bigint primary key,
  access_token   text        not null,
  refresh_token  text        not null,
  expires_at     timestamptz not null,
  scope          text        not null,
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Athlete HR / pace zones (one row, refreshed occasionally; needed for Phase 2 scoring)
-- ---------------------------------------------------------------------------
create table public.athlete_zones (
  athlete_id  bigint primary key,
  zones       jsonb       not null,
  fetched_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Activities: one row per run, from the list endpoint (SummaryActivity)
-- ---------------------------------------------------------------------------
create table public.activities (
  id                    bigint primary key,           -- Strava activity id
  athlete_id            bigint      not null,
  name                  text        not null,
  sport_type            text        not null,           -- Run, TrailRun, VirtualRun, ...
  workout_type          integer,                        -- runs: 0 default, 1 race, 2 long run, 3 workout
  start_date            timestamptz not null,
  start_date_local      timestamp   not null,           -- wall-clock time where the run happened
  timezone              text,
  distance_m            double precision not null,
  moving_time_s         integer     not null,
  elapsed_time_s        integer     not null,
  total_elevation_gain_m double precision,
  average_speed_mps     double precision,
  max_speed_mps         double precision,
  has_heartrate         boolean     not null default false,
  average_heartrate     double precision,
  max_heartrate         double precision,
  trainer               boolean     not null default false, -- treadmill
  summary               jsonb       not null,           -- raw SummaryActivity
  summary_synced_at     timestamptz not null default now(),
  detail_synced_at      timestamptz,                    -- null = detail still to fetch
  streams_wanted        boolean     not null default false, -- flag runs to fetch per-second data for
  deleted_at            timestamptz                     -- set when a run disappears from Strava
);

create index activities_start_date_idx on public.activities (start_date desc);
create index activities_needs_detail_idx on public.activities (start_date desc)
  where detail_synced_at is null and deleted_at is null;
create index activities_needs_streams_idx on public.activities (id)
  where streams_wanted and deleted_at is null;

-- ---------------------------------------------------------------------------
-- Activity details (DetailedActivity): laps, splits, best efforts, description
-- ---------------------------------------------------------------------------
create table public.activity_details (
  activity_id    bigint primary key references public.activities (id) on delete cascade,
  description    text,
  laps           jsonb,
  splits_metric  jsonb,
  best_efforts   jsonb,
  raw            jsonb       not null,
  fetched_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Per-second streams: stored gzipped in Supabase Storage, indexed here.
-- Fetched only for runs with activities.streams_wanted = true.
-- ---------------------------------------------------------------------------
create table public.activity_streams (
  activity_id   bigint primary key references public.activities (id) on delete cascade,
  storage_path  text        not null,       -- object path in the activity-streams bucket
  stream_keys   text[]      not null,       -- e.g. {time,distance,heartrate,velocity_smooth}
  point_count   integer     not null,
  fetched_at    timestamptz not null default now()
);

insert into storage.buckets (id, name, public)
values ('activity-streams', 'activity-streams', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Sync bookkeeping
-- ---------------------------------------------------------------------------
create table public.sync_state (
  id                     integer primary key default 1 check (id = 1),
  backfill_before        timestamptz,                      -- backfill cursor: fetch runs older than this (null = start from now)
  backfill_complete      boolean     not null default false,
  last_resync_at         timestamptz,                      -- last 30-day re-pull
  zones_fetched_at       timestamptz,
  updated_at             timestamptz not null default now()
);

insert into public.sync_state (id) values (1);

create table public.sync_runs (
  id                  bigint generated always as identity primary key,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  status              text        not null default 'running'
                        check (status in ('running', 'ok', 'rate_limited', 'error')),
  summaries_upserted  integer     not null default 0,
  details_fetched     integer     not null default 0,
  streams_fetched     integer     not null default 0,
  strava_requests     integer     not null default 0,
  error               text
);

create index sync_runs_started_at_idx on public.sync_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- Review view for Phase 2: readable units, one row per run
-- ---------------------------------------------------------------------------
create view public.runs_overview
with (security_invoker = true) as
select
  a.id,
  a.start_date_local::date                                  as run_date,
  to_char(a.start_date_local, 'Dy')                         as weekday,
  a.name,
  a.sport_type,
  case a.workout_type
    when 1 then 'race' when 2 then 'long run' when 3 then 'workout' else 'default'
  end                                                       as workout_type,
  round((a.distance_m / 1000)::numeric, 2)                  as distance_km,
  round((a.moving_time_s / 60.0)::numeric, 1)               as moving_min,
  case when a.distance_m > 0 then
    to_char(make_interval(secs => round(a.moving_time_s / (a.distance_m / 1000))), 'MI:SS')
  end                                                       as pace_per_km,
  round(a.average_heartrate::numeric)                       as avg_hr,
  round(a.max_heartrate::numeric)                           as max_hr,
  round(a.total_elevation_gain_m::numeric)                  as elev_gain_m,
  a.trainer                                                 as treadmill,
  jsonb_array_length(coalesce(d.laps, '[]'::jsonb))         as lap_count,
  d.description,
  a.detail_synced_at is not null                            as has_detail,
  s.activity_id is not null                                 as has_streams
from public.activities a
left join public.activity_details d on d.activity_id = a.id
left join public.activity_streams s on s.activity_id = a.id
where a.deleted_at is null;

-- ---------------------------------------------------------------------------
-- Lock everything down to the service role
-- ---------------------------------------------------------------------------
alter table public.strava_tokens    enable row level security;
alter table public.athlete_zones    enable row level security;
alter table public.activities       enable row level security;
alter table public.activity_details enable row level security;
alter table public.activity_streams enable row level security;
alter table public.sync_state       enable row level security;
alter table public.sync_runs        enable row level security;

revoke all on
  public.strava_tokens, public.athlete_zones, public.activities, public.activity_details,
  public.activity_streams, public.sync_state, public.sync_runs, public.runs_overview
from anon, authenticated;
