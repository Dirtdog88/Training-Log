// The subset of Strava API shapes this project reads. Everything else is kept in raw JSON columns.

export interface SummaryActivity {
  id: number;
  athlete: { id: number };
  name: string;
  sport_type: string;
  type?: string;
  workout_type?: number | null;
  start_date: string; // ISO, UTC
  start_date_local: string; // local wall-clock time, but Strava suffixes it with "Z"
  timezone?: string;
  distance: number; // meters
  moving_time: number; // seconds
  elapsed_time: number; // seconds
  total_elevation_gain?: number;
  average_speed?: number; // m/s
  max_speed?: number; // m/s
  has_heartrate?: boolean;
  average_heartrate?: number;
  max_heartrate?: number;
  trainer?: boolean;
  [key: string]: unknown;
}

export interface DetailedActivity extends SummaryActivity {
  description?: string | null;
  laps?: unknown[];
  splits_metric?: unknown[];
  best_efforts?: unknown[];
  segment_efforts?: unknown[];
  map?: unknown;
}
