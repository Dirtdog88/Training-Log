// One-time Strava login. Run locally: `npm run auth`
//
// Opens a temporary server on localhost, sends you to Strava's consent page, exchanges the code
// for tokens, checks the athlete and granted scopes, and stores the tokens in Supabase.
// Requires a `.env` file (see `.env.example`) and the Strava app's callback domain set to `localhost`.

import { createServer } from "node:http";
import { buildAuthorizeUrl, exchangeCode, missingScopes, toTokenRow } from "../src/strava/oauth";
import { createDb, supabaseTokenStore } from "../src/db";

const PORT = Number(process.env.AUTH_PORT ?? 8721);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const TIMEOUT_MS = 5 * 60 * 1000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    throw new Error("No .env file found. Copy .env.example to .env and fill it in.");
  }
  const clientId = requireEnv("STRAVA_CLIENT_ID");
  const clientSecret = requireEnv("STRAVA_CLIENT_SECRET");
  const store = supabaseTokenStore(createDb(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY")));
  const expectedAthlete = process.env.STRAVA_ATHLETE_ID ? Number(process.env.STRAVA_ATHLETE_ID) : null;

  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

  const result = await new Promise<{ code: string; scope: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for Strava login (5 minutes)."));
    }, TIMEOUT_MS);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, message: string, outcome: () => void) => {
        res.writeHead(status, { "Content-Type": "text/plain" }).end(message);
        clearTimeout(timer);
        server.close();
        outcome();
      };

      if (url.searchParams.get("state") !== state) {
        return finish(400, "State mismatch. Close this tab and run `npm run auth` again.", () =>
          reject(new Error("OAuth state mismatch — possible forged request; nothing was saved.")),
        );
      }
      const error = url.searchParams.get("error");
      if (error) {
        return finish(400, `Strava returned an error: ${error}`, () => reject(new Error(`Strava denied access: ${error}`)));
      }
      const code = url.searchParams.get("code");
      const scope = url.searchParams.get("scope") ?? "";
      const missing = missingScopes(scope);
      if (!code || missing.length > 0) {
        return finish(400, `Missing permissions: ${missing.join(", ")}. Run again and leave all boxes ticked.`, () =>
          reject(new Error(`Required scopes not granted: ${missing.join(", ")}`)),
        );
      }
      finish(200, "Strava connected. You can close this tab and return to the terminal.", () =>
        resolve({ code, scope }),
      );
    });

    server.listen(PORT, "127.0.0.1", () => {
      console.log("\nOpen this URL in your browser and approve access:\n");
      console.log(buildAuthorizeUrl(clientId, REDIRECT_URI, state));
      console.log(`\nWaiting for Strava to redirect to ${REDIRECT_URI} ...`);
    });
    server.on("error", reject);
  });

  const tokens = await exchangeCode(clientId, clientSecret, result.code);
  const athleteId = tokens.athlete?.id;
  if (!athleteId) throw new Error("Strava token response did not include an athlete ID.");
  if (expectedAthlete !== null && athleteId !== expectedAthlete) {
    throw new Error(
      `Logged in as athlete ${athleteId}, but STRAVA_ATHLETE_ID is ${expectedAthlete}. Nothing was saved.`,
    );
  }

  await store.save(toTokenRow(athleteId, result.scope, tokens));

  const name = [tokens.athlete?.firstname, tokens.athlete?.lastname].filter(Boolean).join(" ");
  console.log(`\nSaved tokens for ${name || "athlete"} (ID ${athleteId}). Scopes: ${result.scope}`);
  if (expectedAthlete === null) {
    console.log(`\nNext: set STRAVA_ATHLETE_ID = "${athleteId}" in wrangler.toml (and in .env to lock future logins).`);
  }
}

main().catch((err: unknown) => {
  console.error(`\nLogin failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
