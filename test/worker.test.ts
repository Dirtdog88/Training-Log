import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";

const env = { STATUS_TOKEN: "s3cret", SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "x" } as Env;

describe("worker fetch routing", () => {
  it("404s anything except /status, including the root", async () => {
    for (const path of ["/", "/auth/start", "/status/extra"]) {
      const res = await worker.fetch(new Request(`https://w.example${path}`), env);
      expect(res.status).toBe(404);
    }
  });

  it("rejects /status without a token before touching the database", async () => {
    const res = await worker.fetch(new Request("https://w.example/status"), env);
    expect(res.status).toBe(401);
  });
});
