import { afterEach, describe, expect, it } from "vitest";
import { devTierCataloguePath, normalizeTierCatalogue } from "./save-dev-tier-catalogue.ts";

describe("normalizeTierCatalogue", () => {
  it("sorts rows by rank and pretty-prints with a trailing newline", () => {
    const raw = JSON.stringify([
      { id: "c", rank: 3, label: "S3" },
      { id: "a", rank: 8, label: "SX" },
      { id: "b", rank: 1, label: "S1" },
    ]);
    const out = normalizeTierCatalogue(raw);
    expect(out.rows).toBe(3);
    expect(JSON.parse(out.text).map((row: { id: string }) => row.id)).toEqual(["b", "c", "a"]);
    expect(out.text.endsWith("\n")).toBe(true);
    expect(out.text.startsWith("[\n  {")).toBe(true);
  });

  it("treats an empty export as an empty catalogue", () => {
    expect(normalizeTierCatalogue("")).toEqual({ text: "[]\n", rows: 0 });
    expect(normalizeTierCatalogue("[]")).toEqual({ text: "[]\n", rows: 0 });
  });

  it("refuses anything that is not a JSON array, so a psql error never becomes the file", () => {
    expect(() => normalizeTierCatalogue('psql: error: connection refused')).toThrow();
    expect(() => normalizeTierCatalogue('{"id":"x"}')).toThrow(TypeError);
  });
});

describe("devTierCataloguePath", () => {
  const previous = process.env.TURBOPANEL_DEV_ROOT;
  afterEach(() => {
    if (previous === undefined) delete process.env.TURBOPANEL_DEV_ROOT;
    else process.env.TURBOPANEL_DEV_ROOT = previous;
  });

  it("lives in the dev checkout's local dir under the dev root", () => {
    process.env.TURBOPANEL_DEV_ROOT = "/home/vagrant";
    expect(devTierCataloguePath()).toBe("/home/vagrant/dev/local/tiers.json");
  });
});
