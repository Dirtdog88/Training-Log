// Export the review views to CSV for the Phase 2 workout review. Run locally: `npm run export:csv`
//
// Writes exports/YYYY-MM-DD-runs-overview.csv (one row per run) and
// exports/YYYY-MM-DD-run-laps.csv (one row per watch lap). exports/ is git-ignored.
// Optional: `npm run export:csv -- --since 2024-01-01` to limit by run date.

import { mkdirSync, writeFileSync } from "node:fs";
import { createDb } from "../src/db";
import { toCsv } from "../src/csv";

const PAGE_SIZE = 1000; // PostgREST's default max rows per request

const VIEWS = [
  {
    view: "runs_overview",
    file: "runs-overview",
    order: ["run_date", "id"],
    columns: [
      "id", "run_date", "weekday", "name", "sport_type", "workout_type", "distance_km", "moving_min",
      "pace_per_km", "avg_hr", "max_hr", "elev_gain_m", "treadmill", "lap_count", "description",
      "has_detail", "has_streams",
    ],
  },
  {
    view: "run_laps",
    file: "run-laps",
    order: ["run_date", "activity_id", "lap_index"],
    columns: [
      "activity_id", "run_date", "run_name", "lap_index", "distance_km", "moving_s", "elapsed_s",
      "pace_per_km", "avg_hr", "max_hr",
    ],
  },
] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

function parseSince(argv: string[]): string | null {
  const i = argv.indexOf("--since");
  if (i === -1) return null;
  const value = argv[i + 1];
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("--since expects a date like 2024-01-01");
  return value;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    throw new Error("No .env file found. Copy .env.example to .env and fill it in.");
  }
  const db = createDb(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const since = parseSince(process.argv.slice(2));
  const today = new Date().toISOString().slice(0, 10);
  mkdirSync("exports", { recursive: true });

  for (const { view, file, order, columns } of VIEWS) {
    const rows: Record<string, unknown>[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      let query = db.from(view).select(columns.join(","));
      // A total order keeps paging stable: no row is skipped or repeated across pages.
      for (const col of order) query = query.order(col, { ascending: true });
      query = query.range(from, from + PAGE_SIZE - 1);
      if (since) query = query.gte("run_date", since);
      const { data, error } = await query;
      if (error) throw new Error(`Reading ${view} failed: ${error.message}`);
      rows.push(...(data as unknown as Record<string, unknown>[]));
      if (data.length < PAGE_SIZE) break;
    }
    const path = `exports/${today}-${file}.csv`;
    writeFileSync(path, toCsv(rows, [...columns]));
    console.log(`Wrote ${rows.length} rows to ${path}`);
  }
}

main().catch((err: unknown) => {
  console.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
