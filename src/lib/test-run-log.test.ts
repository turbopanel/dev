import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: vi.fn(actual.createWriteStream),
  };
});

vi.mock("./paths.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths.ts")>();
  return {
    ...actual,
    testRunLogPath: vi.fn(actual.testRunLogPath),
  };
});

import { testRunLogPath } from "./paths.ts";
import { openTestRunLog } from "./test-run-log.ts";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

test("openTestRunLog writes header lines and persists body until close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-test-run-log-"));
  tempDirs.push(dir);
  const path = join(dir, "runs", "ui-test.log");

  const handle = await openTestRunLog("ui", "test", {
    resolvePath: () => path,
  });
  if (handle === null) {
    throw new TypeError("expected openTestRunLog to return a handle");
  }

  expect(handle.path).toBe(path);
  handle.writeLine("ok line");
  await handle.close();

  const text = readFileSync(path, "utf8");
  expect(text).toContain("# turbopanel console test run");
  expect(text).toContain("# repo=ui");
  expect(text).toContain("# suite=test");
  expect(text).toContain("ok line");
});

test("openTestRunLog ignores writes after close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-test-run-log-"));
  tempDirs.push(dir);
  const path = join(dir, "suite.log");

  const handle = await openTestRunLog("dev", "typecheck", {
    resolvePath: () => path,
  });
  if (handle === null) {
    throw new TypeError("expected openTestRunLog to return a handle");
  }

  await handle.close();
  handle.writeLine("should not appear");
  await handle.close();

  expect(readFileSync(path, "utf8")).not.toContain("should not appear");
});

test("openTestRunLog uses testRunLogPath when resolvePath is omitted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-test-run-log-"));
  tempDirs.push(dir);
  const path = join(dir, "default.log");
  vi.mocked(testRunLogPath).mockReturnValue(path);

  const handle = await openTestRunLog("ui", "test");
  if (handle === null) {
    throw new TypeError("expected openTestRunLog to return a handle");
  }
  expect(handle.path).toBe(path);
  expect(testRunLogPath).toHaveBeenCalledWith("ui", "test");
  await handle.close();
  expect(readFileSync(path, "utf8")).toContain("# repo=ui");
});

test("openTestRunLog returns null when the log path cannot be opened", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-test-run-log-"));
  tempDirs.push(dir);
  const path = join(dir, "run.log");
  vi.mocked(createWriteStream).mockImplementationOnce(() => {
    throw new Error("EACCES");
  });
  const handle = await openTestRunLog("ui", "test", {
    resolvePath: () => path,
  });
  expect(handle).toBeNull();
});

test("openTestRunLog returns null when mkdir fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-test-run-log-"));
  tempDirs.push(dir);
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "x");
  const handle = await openTestRunLog("ui", "test", {
    resolvePath: () => join(blocker, "nested", "run.log"),
  });
  expect(handle).toBeNull();
});