import { refreshAccessToken, toTokenRow, type TokenRow } from "./oauth";

// Refresh this long before expiry so a token never dies mid-sync.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export interface TokenStore {
  load(athleteId: number): Promise<TokenRow | null>;
  save(row: TokenRow): Promise<void>;
}

export interface StravaCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Returns a usable access token, refreshing and persisting it first when it is close to expiry.
 * Strava may rotate the refresh token on refresh, so the new one is always saved.
 */
export async function getAccessToken(
  athleteId: number,
  creds: StravaCredentials,
  store: TokenStore,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<string> {
  const row = await store.load(athleteId);
  if (!row) {
    throw new Error(`No Strava tokens stored for athlete ${athleteId}; run \`npm run auth\` first.`);
  }
  if (new Date(row.expires_at).getTime() - now() > REFRESH_MARGIN_MS) {
    return row.access_token;
  }
  const refreshed = await refreshAccessToken(creds.clientId, creds.clientSecret, row.refresh_token, fetchImpl);
  await store.save(toTokenRow(athleteId, row.scope, refreshed));
  return refreshed.access_token;
}
