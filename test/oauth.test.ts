import { describe, expect, it, vi } from "vitest";
import { buildAuthorizeUrl, exchangeCode, missingScopes, toTokenRow } from "../src/strava/oauth";

describe("buildAuthorizeUrl", () => {
  it("requests all required scopes and carries the state", () => {
    const url = new URL(buildAuthorizeUrl("123", "http://localhost:8721/callback", "abc"));
    expect(url.origin + url.pathname).toBe("https://www.strava.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("123");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8721/callback");
    expect(url.searchParams.get("scope")).toBe("read,activity:read_all,profile:read_all");
    expect(url.searchParams.get("state")).toBe("abc");
  });
});

describe("missingScopes", () => {
  it("returns nothing when all scopes were granted", () => {
    expect(missingScopes("read,activity:read_all,profile:read_all")).toEqual([]);
  });

  it("flags scopes the user unticked", () => {
    expect(missingScopes("read,activity:read")).toEqual(["activity:read_all", "profile:read_all"]);
  });

  it("treats a missing scope param as nothing granted", () => {
    expect(missingScopes(null)).toEqual(["read", "activity:read_all", "profile:read_all"]);
  });
});

describe("exchangeCode", () => {
  it("posts the authorization code as a form", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ access_token: "a", refresh_token: "r", expires_at: 1, athlete: { id: 9 } }),
    );
    const t = await exchangeCode("id", "secret", "the-code", fetchMock as unknown as typeof fetch);
    expect(t.athlete?.id).toBe(9);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
  });

  it("throws with Strava's error text on failure", async () => {
    const fetchMock = vi.fn(async () => new Response("bad code", { status: 400 }));
    await expect(exchangeCode("id", "s", "x", fetchMock as unknown as typeof fetch)).rejects.toThrow(
      "400 bad code",
    );
  });
});

describe("toTokenRow", () => {
  it("converts epoch-second expiry to ISO", () => {
    const row = toTokenRow(9, "read", { access_token: "a", refresh_token: "r", expires_at: 1_700_000_000 });
    expect(row.expires_at).toBe("2023-11-14T22:13:20.000Z");
  });
});
