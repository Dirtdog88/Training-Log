import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { TokenRow } from "./strava/oauth";
import type { TokenStore } from "./strava/tokens";

export function createDb(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function supabaseTokenStore(db: SupabaseClient): TokenStore {
  return {
    async load(athleteId) {
      const { data, error } = await db
        .from("strava_tokens")
        .select("athlete_id, access_token, refresh_token, expires_at, scope")
        .eq("athlete_id", athleteId)
        .maybeSingle();
      if (error) throw new Error(`Loading Strava tokens failed: ${error.message}`);
      return data as TokenRow | null;
    },
    async save(row) {
      const { error } = await db
        .from("strava_tokens")
        .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "athlete_id" });
      if (error) throw new Error(`Saving Strava tokens failed: ${error.message}`);
    },
  };
}
