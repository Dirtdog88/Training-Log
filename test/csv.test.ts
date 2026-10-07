import { describe, expect, it } from "vitest";
import { toCsv } from "../src/csv";

describe("toCsv", () => {
  it("writes a header and rows in column order", () => {
    expect(toCsv([{ b: 2, a: 1 }], ["a", "b"])).toBe("a,b\r\n1,2\r\n");
  });

  it("quotes commas, quotes and newlines in run names and descriptions", () => {
    const csv = toCsv([{ name: 'Tempo, "hard"', description: "6x800\nfelt good" }], ["name", "description"]);
    expect(csv).toBe('name,description\r\n"Tempo, ""hard""","6x800\nfelt good"\r\n');
  });

  it("leaves nulls empty and keeps booleans and zeros", () => {
    expect(toCsv([{ a: null, b: false, c: 0, d: undefined }], ["a", "b", "c", "d"])).toBe("a,b,c,d\r\n,false,0,\r\n");
  });
});
