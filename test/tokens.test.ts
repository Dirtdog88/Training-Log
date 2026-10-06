import { describe, expect, it, vi } from "vitest";
import type { TokenRow } from "../src/strava/oauth";
import { getAccessToken, type TokenStore } from "../src/strava/tokens";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const creds = { clientId: "id", clientSecret: "secret" };

function memoryStore(row: TokenRow | null): TokenStore & { saved: TokenRow[] } {
  const saved: TokenRow[] = [];
  return {
    saved,
    load: async () => row,
    save: async (r) => {
      saved.push(r);
    },
  };
}

function storedRow(expiresInMinutes: number): TokenRow {
  return {
    athlete_id: 9,
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_at: new Date(NOW + expiresInMinutes * 60_000).toISOString(),
    scope: "read,activity:read_all,profile:read_all",
  };
}

describe("getAccessToken", () => {
  it("reuses a token that is not close to expiry", async () => {
    const store = memoryStore(storedRow(60));
    const fetchMock = vi.fn();
    const token = await getAccessToken(9, creds, store, fetchMock as unknown as typeof fetch, () => NOW);
    expect(token).toBe("old-access");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.saved).toEqual([]);
  });

  it("refreshes near expiry and persists the rotated refresh token", async () => {
    const store = memoryStore(storedRow(5));
    const fetchMock = vi.fn(async () =>
      Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_at: NOW / 1000 + 21600 }),
    );
    const token = await getAccessToken(9, creds, store, fetchMock as unknown as typeof fetch, () => NOW);

    expect(token).toBe("new-access");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh");
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toMatchObject({
      athlete_id: 9,
      access_token: "new-access",
      refresh_token: "new-refresh",
      scope: "read,activity:read_all,profile:read_all",
    });
  });

  it("does not save anything when the refresh fails", async () => {
    const store = memoryStore(storedRow(-1));
    const fetchMock = vi.fn(async () => new Response("revoked", { status: 401 }));
    await expect(
      getAccessToken(9, creds, store, fetchMock as unknown as typeof fetch, () => NOW),
    ).rejects.toThrow("401");
    expect(store.saved).toEqual([]);
  });

  it("explains how to fix a missing login", async () => {
    await expect(getAccessToken(9, creds, memoryStore(null))).rejects.toThrow("npm run auth");
  });
});
