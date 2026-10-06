export interface Env {
  STRAVA_ATHLETE_ID: string;
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  STATUS_TOKEN: string;
  /** Optional tuning: Strava requests per invocation (default 15). */
  SYNC_STRAVA_BUDGET?: string;
  /** Optional tuning: activity list pages per invocation (default 2). */
  SYNC_MAX_LIST_PAGES?: string;
}
