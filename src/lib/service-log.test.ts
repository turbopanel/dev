import { mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
  };
});

vi.mock("./docker-access.ts", () => ({
  spawnDocker: vi.fn(() => null),
  dockerOutputLines: vi.fn(() => []),
}));

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

let convergeLogPath = join(tmpdir(), "tp-service-log-missing-converge.log");

vi.mock("./paths.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths.ts")>();
  return {
    ...actual,
    convergeServiceLogPath: () => convergeLogPath,
  };
});

import { spawnDocker, dockerOutputLines } from "./docker-access.ts";
import { spawnSyncTrustedText } from "./spawn-trusted.ts";
import {
  readServiceLogFileStat,
  readServiceLogTail,
  serviceDockerLogContainer,
  serviceSystemdUnit,
  SERVICE_FILE_LOG_PATHS,
} from "./service-log.ts";

const mockedSpawnDocker = vi.mocked(spawnDocker);
const mockedDockerOutputLines = vi.mocked(dockerOutputLines);
const mockedSpawnSyncTrustedText = vi.mocked(spawnSyncTrustedText);
const fsActual = await vi.importActual<typeof import("node:fs")>("node:fs");

const originalFileLogPaths = Object.fromEntries(
  Object.entries(SERVICE_FILE_LOG_PATHS).map(([id, paths]) => [id, [...paths]]),
);
const tempDirs: string[] = [];

function failedSpawn() {
  return {
    status: 1,
    stdout: "",
    stderr: "",
    pid: 0,
    output: ["", "", ""],
    signal: null,
  };
}

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
  mockedSpawnDocker.mockReset();
  mockedDockerOutputLines.mockReset();
  mockedSpawnSyncTrustedText.mockReset();
  mockedSpawnDocker.mockReturnValue(null);
  mockedDockerOutputLines.mockReturnValue([]);
  mockedSpawnSyncTrustedText.mockReturnValue(failedSpawn());
  convergeLogPath = join(tmpdir(), "tp-service-log-missing-converge.log");
});

afterEach(() => {
  vi.mocked(openSync).mockImplementation(fsActual.openSync);
  for (const key of Object.keys(SERVICE_FILE_LOG_PATHS)) {
    delete SERVICE_FILE_LOG_PATHS[key];
  }
  Object.assign(SERVICE_FILE_LOG_PATHS, originalFileLogPaths);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serviceSystemdUnit maps known services and rejects unknowns", () => {
  expect(serviceSystemdUnit("instance")).toBe("turbopanel-instance");
  expect(serviceSystemdUnit("caddy")).toBe("turbopanel-caddy");
  expect(serviceSystemdUnit("ui")).toBe("turbopanel-ui");
  expect(serviceSystemdUnit("daemon")).toBeNull();
  expect(serviceSystemdUnit("nope")).toBeNull();
});

test("serviceDockerLogContainer maps docker-backed services", () => {
  expect(serviceDockerLogContainer("db")).toBe("turbopanel-database");
  expect(serviceDockerLogContainer("smtp")).toBe("turbopanel-dev-mailpit");
  expect(serviceDockerLogContainer("queue")).toBe("turbopanel-queue");
  expect(serviceDockerLogContainer("instance")).toBeNull();
});

test("SERVICE_FILE_LOG_PATHS covers instance, daemon, ui, and website", () => {
  expect(SERVICE_FILE_LOG_PATHS.instance?.length).toBe(2);
  expect(SERVICE_FILE_LOG_PATHS.daemon?.length).toBe(2);
  expect(SERVICE_FILE_LOG_PATHS.ui?.some((p) => p.includes("/ui/"))).toBe(true);
  expect(
    SERVICE_FILE_LOG_PATHS.website?.some((p) => p.includes("/website/")),
  ).toBe(true);
});

test.each([
  ["docker-backed", "db", "docker logs turbopanel-database"],
  ["unit-backed", "caddy", "journalctl -u turbopanel-caddy"],
  ["unknown", "not-a-service", "No logs available"],
])(
  "readServiceLogTail returns a %s hint when nothing is available",
  (_kind, serviceId, hint) => {
    const lines = readServiceLogTail(serviceId, 20);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain(hint);
  },
);

test("readServiceLogTail tails service log files and parses structured time", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-service-log-"));
  tempDirs.push(dir);
  const errPath = join(dir, "instance.err.log");
  const logPath = join(dir, "instance.log");
  writeFileSync(errPath, "plain error line\n");
  writeFileSync(
    logPath,
    "2026-08-25T12:00:00.000Z INFO daemon-cell  hibernate\nnoise\n",
  );
  SERVICE_FILE_LOG_PATHS.instance = [errPath, logPath];

  const lines = readServiceLogTail("instance", 20);
  expect(lines.map((line) => line.text)).toEqual([
    "plain error line",
    "INFO daemon-cell  hibernate",
    "noise",
  ]);
  expect(lines[1]?.time).toBe("2026-08-25T12:00:00.000Z");
});

test("readServiceLogTail honors a byte floor and drops the partial first line", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-service-log-floor-"));
  tempDirs.push(dir);
  const logPath = join(dir, "instance.log");
  writeFileSync(logPath, "AAAA\nsecond line\nthird line\n");
  SERVICE_FILE_LOG_PATHS.instance = [logPath];

  const lines = readServiceLogTail("instance", 20, { [logPath]: 2 });
  expect(lines.map((line) => line.text)).toEqual(["second line", "third line"]);
});

test("readServiceLogFileStat records readable file sizes", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-service-log-stat-"));
  tempDirs.push(dir);
  const logPath = join(dir, "ui.log");
  writeFileSync(logPath, "abc");
  SERVICE_FILE_LOG_PATHS.ui = [logPath];

  expect(readServiceLogFileStat("ui")).toEqual({ [logPath]: 3 });
});

test("readServiceLogFileStat ignores sudo stat failures and non-numeric sizes", () => {
  const missing = join(tmpdir(), "tp-service-log-stat-fail.log");
  SERVICE_FILE_LOG_PATHS.ui = [missing];
  mockedSpawnSyncTrustedText.mockReturnValueOnce(failedSpawn());
  expect(readServiceLogFileStat("ui")).toEqual({});

  mockedSpawnSyncTrustedText.mockReturnValueOnce(okSpawn("not-a-size\n"));
  expect(readServiceLogFileStat("ui")).toEqual({});
});

test("readServiceLogTail skips empty files", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-service-log-empty-"));
  tempDirs.push(dir);
  const logPath = join(dir, "instance.log");
  writeFileSync(logPath, "");
  SERVICE_FILE_LOG_PATHS.instance = [logPath];
  mockedSpawnSyncTrustedText.mockReturnValue(
    okSpawn("journal after empty file\n"),
  );

  const lines = readServiceLogTail("instance", 20);
  expect(lines.map((line) => line.text)).toEqual(["journal after empty file"]);
});

test("readServiceLogFileStat falls back to sudo stat when open fails", () => {
  const missing = join(tmpdir(), "tp-service-log-no-such.log");
  SERVICE_FILE_LOG_PATHS.ui = [missing];
  mockedSpawnSyncTrustedText.mockReturnValue(okSpawn("42\n"));

  expect(readServiceLogFileStat("ui")).toEqual({ [missing]: 42 });
  expect(mockedSpawnSyncTrustedText).toHaveBeenCalledWith(
    "sudo",
    ["-n", "stat", "-c", "%s", missing],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
});

test("readServiceLogTail uses journalctl when file logs are empty", () => {
  mockedSpawnSyncTrustedText.mockReturnValue(
    okSpawn("journal line one\njournal line two\n"),
  );
  const lines = readServiceLogTail("caddy", 20);
  expect(lines.map((line) => line.text)).toEqual([
    "journal line one",
    "journal line two",
  ]);
  expect(mockedSpawnSyncTrustedText.mock.calls[0]?.[0]).toBe("sudo");
});

test("readServiceLogFileStat returns an empty floor for unknown services", () => {
  expect(readServiceLogFileStat("not-a-service")).toEqual({});
});

test("readServiceLogTail drops a partial first line when the tail has no newline", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-service-log-nonewline-"));
  tempDirs.push(dir);
  const logPath = join(dir, "instance.log");
  writeFileSync(logPath, "ABCDEFGHIJ");
  SERVICE_FILE_LOG_PATHS.instance = [logPath];

  const lines = readServiceLogTail("instance", 20, { [logPath]: 2 });
  expect(lines.map((line) => line.text).join("\n")).not.toContain("ABCDEFGHIJ");
});

test("readServiceLogTail reads only the tail window of a large file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-service-log-large-"));
  tempDirs.push(dir);
  const logPath = join(dir, "instance.log");
  const keep = "kept-large-line\n";
  writeFileSync(logPath, `${"x".repeat(70 * 1024)}\n${keep}`);
  SERVICE_FILE_LOG_PATHS.instance = [logPath];

  const lines = readServiceLogTail("instance", 10);
  expect(lines.some((line) => line.text.includes("kept-large-line"))).toBe(true);
});

test("readServiceLogTail treats an unreadable existing file as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-service-log-unreadable-"));
  tempDirs.push(dir);
  const logPath = join(dir, "instance.log");
  writeFileSync(logPath, "secret line\n");
  SERVICE_FILE_LOG_PATHS.instance = [logPath];
  vi.mocked(openSync).mockImplementation((path, flags, mode) => {
    if (String(path) === logPath) {
      throw new Error("EACCES");
    }
    return fsActual.openSync(path, flags, mode);
  });

  mockedSpawnSyncTrustedText.mockReturnValue(failedSpawn());
  const lines = readServiceLogTail("instance", 20);
  expect(lines[0]?.text).toContain("journalctl -u turbopanel-instance");
});

test("readServiceLogTail treats a successful journalctl with no stdout as empty", () => {
  mockedSpawnSyncTrustedText.mockReturnValue({
    status: 0,
    stdout: undefined as unknown as string,
    stderr: "",
    pid: 0,
    output: ["", "", ""],
    signal: null,
  });
  const lines = readServiceLogTail("caddy", 20);
  expect(lines).toHaveLength(1);
  expect(lines[0]?.text).toContain("journalctl -u turbopanel-caddy");
});

test("readServiceLogTail uses docker logs for container-backed services", () => {
  mockedSpawnDocker.mockReturnValue(okSpawn("db line"));
  mockedDockerOutputLines.mockReturnValue(["db line"]);
  const lines = readServiceLogTail("db", 20);
  expect(lines.map((line) => line.text)).toEqual(["db line"]);
  expect(mockedSpawnDocker).toHaveBeenCalledWith([
    "logs",
    "--tail",
    "20",
    "turbopanel-database",
  ]);
  expect(mockedDockerOutputLines).toHaveBeenCalled();
});
