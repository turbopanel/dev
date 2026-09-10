import { mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const tempDirs: string[] = [];
const instancePaths: string[] = [];
let instancePathsMissing = false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
  };
});

vi.mock("./service-log.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service-log.ts")>();
  return {
    ...actual,
    SERVICE_FILE_LOG_PATHS: new Proxy(actual.SERVICE_FILE_LOG_PATHS, {
      get(target, prop, receiver) {
        if (prop === "instance") {
          return instancePathsMissing ? undefined : instancePaths;
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
    readServiceLogFileStat: vi.fn(() => {
      const floor: Record<string, number> = {};
      for (const path of instancePaths) {
        floor[path] = 0;
      }
      return floor;
    }),
  };
});

import {
  readCellTraceLogFileStat,
  readCellTraceLogTail,
} from "./cell-trace-log.ts";
import { readServiceLogFileStat } from "./service-log.ts";

const fsActual = await vi.importActual<typeof import("node:fs")>("node:fs");

beforeEach(() => {
  instancePathsMissing = false;
  const dir = mkdtempSync(join(tmpdir(), "tp-cell-trace-log-"));
  tempDirs.push(dir);
  const errPath = join(dir, "instance.err.log");
  const logPath = join(dir, "instance.log");
  writeFileSync(errPath, "");
  writeFileSync(logPath, "");
  instancePaths.splice(0, instancePaths.length, errPath, logPath);
});

afterEach(() => {
  vi.mocked(openSync).mockImplementation(fsActual.openSync);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCellTraceLogFileStat delegates to instance service stats", () => {
  expect(readCellTraceLogFileStat()).toEqual({
    [instancePaths[0]!]: 0,
    [instancePaths[1]!]: 0,
  });
  expect(readServiceLogFileStat).toHaveBeenCalledWith("instance");
});

test("readCellTraceLogTail returns the empty-state hint when no trace lines exist", () => {
  writeFileSync(
    instancePaths[1]!,
    "2026-08-25T12:00:00.000Z INFO other-component  hello\n",
  );
  const lines = readCellTraceLogTail(50);
  expect(lines).toHaveLength(1);
  expect(lines[0]?.text).toContain("No cell trace lines yet");
});

test("readCellTraceLogTail keeps daemon-cell token and command-consumer lines", () => {
  writeFileSync(
    instancePaths[1]!,
    [
      "noise without structure",
      "plain daemon-cell presence update",
      "2026-08-25T12:00:00.000Z INFO command-consumer  handled ping",
      "2026-08-25T12:00:01.000Z INFO other  ignored",
      "2026-08-25T12:00:02.000Z DEBUG daemon-cell  hibernate",
      "",
    ].join("\n"),
  );

  const lines = readCellTraceLogTail(50);
  expect(lines.map((line) => line.text)).toEqual([
    "plain daemon-cell presence update",
    "INFO command-consumer  handled ping",
    "DEBUG daemon-cell  hibernate",
  ]);
  expect(lines[1]?.time).toBe("2026-08-25T12:00:00.000Z");
});

test("readCellTraceLogTail respects maxLines on the filtered set", () => {
  const rows = Array.from({ length: 5 }, (_, i) =>
    `line-${i} daemon-cell event`
  );
  writeFileSync(instancePaths[1]!, `${rows.join("\n")}\n`);
  const lines = readCellTraceLogTail(2);
  expect(lines).toHaveLength(2);
  expect(lines[0]?.text).toContain("line-3");
  expect(lines[1]?.text).toContain("line-4");
});

test("readCellTraceLogTail skips missing log paths", () => {
  const missing = join(tempDirs[0]!, "gone.log");
  instancePaths.splice(0, instancePaths.length, missing, instancePaths[1]!);
  writeFileSync(instancePaths[1]!, "kept daemon-cell line\n");
  const lines = readCellTraceLogTail(50);
  expect(lines.map((line) => line.text)).toEqual(["kept daemon-cell line"]);
});

test("readCellTraceLogTail treats an unreadable path as empty", () => {
  const locked = join(tempDirs[0]!, "locked.log");
  writeFileSync(locked, "secret daemon-cell event\n");
  instancePaths.splice(0, instancePaths.length, locked);
  vi.mocked(openSync).mockImplementation((path, flags, mode) => {
    if (String(path) === locked) {
      throw new Error("EACCES");
    }
    return fsActual.openSync(path, flags, mode);
  });
  const lines = readCellTraceLogTail(50);
  expect(lines[0]?.text).toContain("No cell trace lines yet");
});

test("readCellTraceLogTail drops a partial first line past the tail window", () => {
  const keep = "kept-line daemon-cell event\n";
  writeFileSync(
    instancePaths[1]!,
    `PARTIAL-NO-NEWLINE${"x".repeat(70 * 1024)}\n${keep}`,
  );
  const lines = readCellTraceLogTail(10);
  expect(lines.some((line) => line.text.includes("PARTIAL"))).toBe(false);
  expect(lines.some((line) => line.text.includes("kept-line"))).toBe(true);
});

test("readCellTraceLogTail returns empty-state when the tail has no newline", () => {
  writeFileSync(instancePaths[1]!, `${"y".repeat(70 * 1024)}daemon-cell-no-nl`);
  const lines = readCellTraceLogTail(10);
  expect(lines).toHaveLength(1);
  expect(lines[0]?.text).toContain("No cell trace lines yet");
});

test("readCellTraceLogTail treats a missing instance path list as empty", () => {
  instancePathsMissing = true;
  const lines = readCellTraceLogTail(10);
  expect(lines).toHaveLength(1);
  expect(lines[0]?.text).toContain("No cell trace lines yet");
});
