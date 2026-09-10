import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./install-output.ts", () => ({
  runCaptured: vi.fn(async () => 0),
}));

import { runCaptured } from "./install-output.ts";
import { POSTGRES_CONTAINER_NAME } from "./platform-docker-resources.ts";
import {
  devTierCataloguePath,
  normalizeTierCatalogue,
  saveDevTierCatalogue,
} from "./save-dev-tier-catalogue.ts";

const mockedRunCaptured = vi.mocked(runCaptured);

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

  it("drops non-object rows and sorts missing ranks last", () => {
    const out = normalizeTierCatalogue(
      JSON.stringify([
        { id: "unranked" },
        null,
        "skip",
        { id: "priced", rank: 2 },
      ]),
    );
    expect(out.rows).toBe(2);
    expect(JSON.parse(out.text).map((row: { id: string }) => row.id)).toEqual([
      "priced",
      "unranked",
    ]);
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

describe("saveDevTierCatalogue", () => {
  const previous = process.env.TURBOPANEL_DEV_ROOT;
  let tempRoot: string | undefined;

  afterEach(() => {
    mockedRunCaptured.mockReset();
    mockedRunCaptured.mockResolvedValue(0);
    if (previous === undefined) delete process.env.TURBOPANEL_DEV_ROOT;
    else process.env.TURBOPANEL_DEV_ROOT = previous;
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  function stubTempRoot(): string {
    tempRoot = mkdtempSync(join(tmpdir(), "tp-tier-catalogue-"));
    process.env.TURBOPANEL_DEV_ROOT = tempRoot;
    return tempRoot;
  }

  function mockPsql(code: number, lines: string[] = []): void {
    mockedRunCaptured.mockImplementation(async (cmd, onLine) => {
      if (!Array.isArray(cmd)) {
        throw new TypeError("expected docker argv");
      }
      expect(cmd.slice(0, 4)).toEqual([
        "docker",
        "exec",
        POSTGRES_CONTAINER_NAME,
        "psql",
      ]);
      for (const line of lines) {
        onLine?.(line);
      }
      return code;
    });
  }

  it("writes a pretty-printed catalogue and reports the row count", async () => {
    stubTempRoot();
    mockPsql(0, [
      JSON.stringify([
        { id: "s2", rank: 2 },
        { id: "s1", rank: 1 },
      ]),
    ]);
    const messages: string[] = [];

    await saveDevTierCatalogue((line) => messages.push(line));

    const path = `${tempRoot}/dev/local/tiers.json`;
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(
      [
        { id: "s1", rank: 1 },
        { id: "s2", rank: 2 },
      ],
      null,
      2,
    )}\n`);
    expect(messages).toEqual([
      `save-tier-catalogue: 2 tier rows written to ${path}`,
    ]);
  });

  it("uses the singular label when exactly one row is written", async () => {
    stubTempRoot();
    mockPsql(0, [JSON.stringify([{ id: "s1", rank: 1 }])]);
    const messages: string[] = [];

    await saveDevTierCatalogue((line) => messages.push(line));

    expect(messages[0]).toMatch(/1 tier row written to /);
    expect(messages).toHaveLength(1);
  });

  it("writes an empty catalogue and warns when the table has no rows", async () => {
    stubTempRoot();
    mockPsql(0, ["[]"]);
    const messages: string[] = [];

    await saveDevTierCatalogue((line) => messages.push(line));

    const path = `${tempRoot}/dev/local/tiers.json`;
    expect(readFileSync(path, "utf8")).toBe("[]\n");
    expect(messages).toEqual([
      `save-tier-catalogue: 0 tier rows written to ${path}`,
      "save-tier-catalogue: the tier table is empty — enter tiers in Admin → Tiers first",
    ]);
  });

  it("writes the file when no output handler is provided", async () => {
    stubTempRoot();
    mockPsql(0, [JSON.stringify([{ id: "s1", rank: 1 }])]);

    await saveDevTierCatalogue();

    expect(readFileSync(`${tempRoot}/dev/local/tiers.json`, "utf8")).toContain(
      '"id": "s1"',
    );
  });

  it("reports the last psql line and throws when the export fails", async () => {
    stubTempRoot();
    mockPsql(1, ["NOTICE: skip", "psql: error: connection refused"]);
    const messages: string[] = [];

    await expect(saveDevTierCatalogue((line) => messages.push(line))).rejects.toThrow(
      "psql: error: connection refused",
    );
    expect(messages).toEqual(["psql: error: connection refused"]);
  });

  it("falls back to default failure copy when psql exits with no output", async () => {
    stubTempRoot();
    mockPsql(1);
    const messages: string[] = [];

    await expect(saveDevTierCatalogue((line) => messages.push(line))).rejects.toThrow(
      "Failed to read the tier table from the dev database",
    );
    expect(messages).toEqual(["psql failed"]);
  });

  it("throws without calling an output handler when none is provided", async () => {
    stubTempRoot();
    mockPsql(1, ["psql: error: boom"]);

    await expect(saveDevTierCatalogue()).rejects.toThrow("psql: error: boom");
  });
});
