import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("./spawn-trusted.ts", () => ({
  spawnSyncTrustedText: vi.fn(() => ({
    status: 1,
    stdout: "",
    stderr: "",
    pid: 0,
    output: [],
    signal: null,
  })),
}));

import { spawnSyncTrustedText } from "./spawn-trusted.ts";
import { LogFileTailer } from "./log-file-tail.ts";

const mockedSpawn = vi.mocked(spawnSyncTrustedText);
const tempDirs: string[] = [];

function okSpawn(stdout: string) {
  return {
    status: 0,
    stdout,
    stderr: "",
    pid: 0,
    output: ["", stdout, ""],
    signal: null,
  };
}

beforeEach(() => {
  mockedSpawn.mockReset();
  mockedSpawn.mockReturnValue({
    status: 1,
    stdout: "",
    stderr: "",
    pid: 0,
    output: [],
    signal: null,
  });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LogFileTailer emits complete lines appended after construction", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-log-tail-"));
  tempDirs.push(dir);
  const path = join(dir, "svc.log");
  writeFileSync(path, "already seen\n");
  const tailer = new LogFileTailer([path]);
  writeFileSync(path, "already seen\nhello\n  \nworld\n");
  const lines: string[] = [];
  tailer.drain((line) => lines.push(line));
  expect(lines).toEqual(["hello", "world"]);
});

test("LogFileTailer does not emit an incomplete trailing line", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-log-tail-partial-"));
  tempDirs.push(dir);
  const path = join(dir, "svc.log");
  writeFileSync(path, "");
  const tailer = new LogFileTailer([path]);
  writeFileSync(path, "no newline yet");
  const lines: string[] = [];
  tailer.drain((line) => lines.push(line));
  expect(lines).toEqual([]);
});

test("LogFileTailer resets when the file shrinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-log-tail-trunc-"));
  tempDirs.push(dir);
  const path = join(dir, "svc.log");
  writeFileSync(path, "old-one\nold-two\n");
  const tailer = new LogFileTailer([path]);
  writeFileSync(path, "fresh\n");
  const lines: string[] = [];
  tailer.drain((line) => lines.push(line));
  expect(lines).toEqual(["fresh"]);
});

test("LogFileTailer is a no-op when size is unchanged or the file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-log-tail-idle-"));
  tempDirs.push(dir);
  const path = join(dir, "svc.log");
  writeFileSync(path, "steady\n");
  const tailer = new LogFileTailer([path, join(dir, "missing.log")]);
  const lines: string[] = [];
  tailer.drain((line) => lines.push(line));
  expect(lines).toEqual([]);
});

test("LogFileTailer falls back to sudo stat and tail when open/stat fail", () => {
  const missing = join(tmpdir(), "tp-log-tail-no-such.log");
  let size = "0";
  mockedSpawn.mockImplementation((_cmd, args) => {
    if (args.includes("stat")) {
      return okSpawn(`${size}\n`);
    }
    if (args.includes("tail")) {
      return okSpawn("sudo-one\nsudo-two\n");
    }
    return {
      status: 1,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    };
  });
  const tailer = new LogFileTailer([missing]);
  size = "20";
  const lines: string[] = [];
  tailer.drain((line) => lines.push(line));
  expect(lines).toEqual(["sudo-one", "sudo-two"]);
});

test("LogFileTailer ignores non-finite sudo stat output", () => {
  mockedSpawn.mockReturnValue(okSpawn("not-a-size"));
  const tailer = new LogFileTailer([join(tmpdir(), "tp-log-tail-bad-stat.log")]);
  const lines: string[] = [];
  tailer.drain((line) => lines.push(line));
  expect(lines).toEqual([]);
});

test("LogFileTailer is a no-op when sudo tail fails after a size increase", () => {
  const missing = join(tmpdir(), "tp-log-tail-sudo-tail-fail.log");
  let size = "0";
  mockedSpawn.mockImplementation((_cmd, args) => {
    if (args.includes("stat")) {
      return okSpawn(`${size}\n`);
    }
    return {
      status: 1,
      stdout: undefined as unknown as string,
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    };
  });
  const tailer = new LogFileTailer([missing]);
  size = "20";
  const lines: string[] = [];
  tailer.drain((line) => lines.push(line));
  expect(lines).toEqual([]);
});

test("LogFileTailer ignores an empty sudo tail chunk", () => {
  const missing = join(tmpdir(), "tp-log-tail-empty-chunk.log");
  let size = "0";
  mockedSpawn.mockImplementation((_cmd, args) => {
    if (args.includes("stat")) {
      return okSpawn(`${size}\n`);
    }
    if (args.includes("tail")) {
      return okSpawn("");
    }
    return {
      status: 1,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    };
  });
  const tailer = new LogFileTailer([missing]);
  size = "8";
  const lines: string[] = [];
  tailer.drain((line) => lines.push(line));
  expect(lines).toEqual([]);
});

test("LogFileTailer skips a zero-length chunk when sudo reports a negative size", () => {
  const missing = join(tmpdir(), "tp-log-tail-negative-size.log");
  mockedSpawn.mockReturnValue({
    status: 1,
    stdout: "",
    stderr: "",
    pid: 0,
    output: [],
    signal: null,
  });
  const tailer = new LogFileTailer([missing]);
  mockedSpawn.mockReturnValue(okSpawn("-5\n"));
  const lines: string[] = [];
  tailer.drain((line) => lines.push(line));
  expect(lines).toEqual([]);
});

test("LogFileTailer treats a missing stored offset as the start of the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-log-tail-offset-"));
  tempDirs.push(dir);
  const path = join(dir, "svc.log");
  writeFileSync(path, "replayed\n");
  const tailer = new LogFileTailer([path]);
  const internal = tailer as unknown as { offsets: Map<string, number> };
  internal.offsets.set(path, undefined as unknown as number);
  const lines: string[] = [];
  tailer.drain((line) => lines.push(line));
  expect(lines).toEqual(["replayed"]);
});

test("LogFileTailer treats a failed sudo stat as a missing file", () => {
  mockedSpawn.mockReturnValue({
    status: 1,
    stdout: "",
    stderr: "",
    pid: 0,
    output: [],
    signal: null,
  });
  const tailer = new LogFileTailer([join(tmpdir(), "tp-log-tail-stat-fail.log")]);
  const lines: string[] = [];
  tailer.drain((line) => lines.push(line));
  expect(lines).toEqual([]);
});
