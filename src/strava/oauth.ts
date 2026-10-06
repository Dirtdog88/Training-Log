// Strava OAuth helpers shared by the local login script and the Worker.
// Runtime-neutral: uses only fetch/URL so it runs in Node and in Workers.

export const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
export const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";

// read: required base scope. activity:read_all: includes private runs.
// profile:read_all: required by GET /athlete/zones (HR zones for Phase 2).
export const REQUIRED_SCOPES = ["read", "activity:read_all", "profile:read_all"] as const;

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
  athlete?: { id: number; firstname?: string; lastname?: string };
}

export interface TokenRow {
  athlete_id: number;
  access_token: string;
  refresh_token: string;
  expires_at: string; // ISO timestamp
  scope: string;
}

export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(STRAVA_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("approval_prompt", "force");
  url.searchParams.set("scope", REQUIRED_SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

/** Strava returns the scopes actually granted (the user can untick boxes) as a comma list. */
export function missingScopes(granted: string | null): string[] {
  const have = new Set((granted ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  return REQUIRED_SCOPES.filter((s) => !have.has(s));
}

async function postToken(body: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
  const res = await fetchImpl(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    throw new Error(`Strava token request failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

export function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  return postToken(
    { client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code" },
    fetchImpl,
  );
}

export function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  return postToken(
    { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" },
    fetchImpl,
  );
}

export function toTokenRow(athleteId: number, scope: string, t: TokenResponse): TokenRow {
  return {
    athlete_id: athleteId,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: new Date(t.expires_at * 1000).toISOString(),
    scope,
  };
}
