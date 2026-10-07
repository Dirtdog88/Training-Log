// RFC 4180 CSV: quote fields containing commas, quotes or newlines; double embedded quotes.
function field(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.map(field).join(",")];
  for (const row of rows) lines.push(columns.map((c) => field(row[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}
