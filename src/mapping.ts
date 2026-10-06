import type { DetailedActivity, SummaryActivity } from "./strava/types";

export const RUN_SPORT_TYPES: ReadonlySet<string> = new Set(["Run", "TrailRun", "VirtualRun"]);

export function isRun(a: SummaryActivity): boolean {
  return RUN_SPORT_TYPES.has(a.sport_type);
}

export interface ActivityRow {
  id: number;
  athlete_id: number;
  name: string;
  sport_type: string;
  workout_type: number | null;
  start_date: string;
  start_date_local: string;
  timezone: string | null;
  distance_m: number;
  moving_time_s: number;
  elapsed_time_s: number;
  total_elevation_gain_m: number | null;
  average_speed_mps: number | null;
  max_speed_mps: number | null;
  has_heartrate: boolean;
  average_heartrate: number | null;
  max_heartrate: number | null;
  trainer: boolean;
  summary: SummaryActivity;
  summary_synced_at: string;
}

// Deliberately omits detail_synced_at, streams_wanted and deleted_at so that re-upserting a
// summary never clobbers detail/stream progress.
export function toActivityRow(a: SummaryActivity, syncedAt: Date): ActivityRow {
  return {
    id: a.id,
    athlete_id: a.athlete.id,
    name: a.name,
    sport_type: a.sport_type,
    workout_type: a.workout_type ?? null,
    start_date: a.start_date,
    // Strava's local time carries a misleading "Z"; store it as plain wall-clock time.
    start_date_local: a.start_date_local.replace(/Z$/, ""),
    timezone: a.timezone ?? null,
    distance_m: a.distance,
    moving_time_s: a.moving_time,
    elapsed_time_s: a.elapsed_time,
    total_elevation_gain_m: a.total_elevation_gain ?? null,
    average_speed_mps: a.average_speed ?? null,
    max_speed_mps: a.max_speed ?? null,
    has_heartrate: a.has_heartrate ?? false,
    average_heartrate: a.average_heartrate ?? null,
    max_heartrate: a.max_heartrate ?? null,
    trainer: a.trainer ?? false,
    summary: a,
    summary_synced_at: syncedAt.toISOString(),
  };
}

export interface DetailRow {
  activity_id: number;
  description: string | null;
  laps: unknown[] | null;
  splits_metric: unknown[] | null;
  best_efforts: unknown[] | null;
  raw: Record<string, unknown>;
  fetched_at: string;
}

// Segment efforts and the full-resolution map are large and not needed for workout analysis.
// Fields promoted to their own columns are removed from `raw` to avoid storing them twice.
export function toDetailRow(d: DetailedActivity, fetchedAt: Date): DetailRow {
  const { description, laps, splits_metric, best_efforts, segment_efforts: _s, map: _m, ...raw } = d;
  return {
    activity_id: d.id,
    description: description ?? null,
    laps: laps ?? null,
    splits_metric: splits_metric ?? null,
    best_efforts: best_efforts ?? null,
    raw,
    fetched_at: fetchedAt.toISOString(),
  };
}
