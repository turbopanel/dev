import { afterEach, expect, test, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    statSync: vi.fn(actual.statSync),
  };
});

vi.mock("./spawn-trusted.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spawn-trusted.ts")>();
  return {
    ...actual,
    spawnSyncTrusted: vi.fn(actual.spawnSyncTrusted),
    spawnSyncTrustedText: vi.fn(actual.spawnSyncTrustedText),
  };
});

import { existsSync, statSync, type Stats } from "node:fs";
import {
  EXTERNAL_LOG_TAIL_LINES,
  openServiceLogPager,
  resolveServiceLogPager,
} from "./service-log-pager.ts";
import {
  convergeServiceLogPath,
  DAEMON_ERR_LOG_PATH,
  DAEMON_LOG_PATH,
} from "./paths.ts";
import { spawnSyncTrusted, spawnSyncTrustedText } from "./spawn-trusted.ts";

function spawnRet(
  status: number,
  stdout = "",
  extras: { signal?: NodeJS.Signals | null; error?: Error } = {},
) {
  return {
    status,
    stdout,
    stderr: "",
    pid: 0,
    output: ["", stdout, ""],
    signal: extras.signal ?? null,
    error: extras.error,
  };
}

afterEach(() => {
  vi.mocked(spawnSyncTrusted).mockReset();
  vi.mocked(spawnSyncTrustedText).mockReset();
  vi.mocked(existsSync).mockReset();
  vi.mocked(statSync).mockReset();
});

test("resolveServiceLogPager returns null for unknown services with no log source", () => {
  const pager = resolveServiceLogPager("no-such-service", EXTERNAL_LOG_TAIL_LINES, {
    pathExists: () => false,
    hasCommand: () => true,
  });
  expect(pager).toBeNull();
});

test("resolveServiceLogPager prefers less +F on existing file logs", () => {
  const pager = resolveServiceLogPager("daemon", 500, {
    pathExists: (path) => path === DAEMON_LOG_PATH || path === DAEMON_ERR_LOG_PATH,
    pathSize: () => 100,
    hasCommand: (name) => name === "less",
  });
  expect(pager).toBeTruthy();
  expect(pager!.command).toBe("less");
  expect(pager!.args.includes("+F")).toBe(true);
  expect(pager!.args.includes(DAEMON_LOG_PATH)).toBe(true);
  expect(pager!.args.includes(DAEMON_ERR_LOG_PATH)).toBe(true);
  // Main log should be the first buffer (before .err.log).
  const logIndex = pager!.args.indexOf(DAEMON_LOG_PATH);
  const errIndex = pager!.args.indexOf(DAEMON_ERR_LOG_PATH);
  expect(logIndex).toBeLessThan(errIndex);
  expect(pager!.keys.some((line) => line.includes("Ctrl+X"))).toBe(true);
  expect(pager!.keys.some((line) => line.includes("q"))).toBe(true);
});

test("resolveServiceLogPager skips empty converge log when service logs exist", () => {
  const converge = convergeServiceLogPath("daemon");
  const pager = resolveServiceLogPager("daemon", 500, {
    pathExists: (path) =>
      path === DAEMON_LOG_PATH || path === DAEMON_ERR_LOG_PATH || path === converge,
    pathSize: (path) => (path === converge ? 0 : 100),
    hasCommand: (name) => name === "less",
  });
  expect(pager).toBeTruthy();
  expect(pager!.args.includes(converge)).toBe(false);
  expect(pager!.args.includes(DAEMON_LOG_PATH)).toBe(true);
});

test("resolveServiceLogPager falls back to tail -F when less is missing", () => {
  const pager = resolveServiceLogPager("daemon", 250, {
    pathExists: (path) => path === DAEMON_LOG_PATH,
    pathSize: () => 100,
    hasCommand: () => false,
  });
  expect(pager).toBeTruthy();
  expect(pager!.command).toBe("tail");
  expect(pager!.args.slice(0, 3)).toEqual(["-n", "250", "-F"]);
  expect(pager!.args.includes(DAEMON_LOG_PATH)).toBe(true);
});

test("resolveServiceLogPager uses docker logs for container-backed services", () => {
  const pager = resolveServiceLogPager("db", 100, {
    pathExists: () => false,
    hasCommand: (name) => name === "less",
    dockerInvoker: () => ["docker"],
  });
  expect(pager).toBeTruthy();
  expect(pager!.command).toBe("sh");
  expect(pager!.args[0]).toBe("-c");
  expect(pager!.args[1] ?? "").toMatch(
    /'docker' logs -f --tail '100' 'turbopanel-database' 2>&1 \| less -R \+F$/,
  );
  expect(pager!.keys.some((line) => line.includes("Ctrl+X"))).toBe(true);
});

test("resolveServiceLogPager uses journalctl when only a unit is available", () => {
  const pager = resolveServiceLogPager("cache", EXTERNAL_LOG_TAIL_LINES, {
    pathExists: () => false,
    hasCommand: () => false,
    journalInvoker: () => ["journalctl"],
  });
  expect(pager).toBeTruthy();
  expect(pager!.command).toBe("journalctl");
  expect(pager!.args).toEqual([
    "-u",
    "turbopanel-redis",
    "-n",
    String(EXTERNAL_LOG_TAIL_LINES),
    "-f",
    "-o",
    "cat",
  ]);
});

test("resolveServiceLogPager keeps empty files when every candidate is empty", () => {
  const pager = resolveServiceLogPager("daemon", 100, {
    pathExists: (path) => path === DAEMON_LOG_PATH,
    pathSize: () => 0,
    hasCommand: (name) => name === "less",
  });
  expect(pager?.command).toBe("less");
  expect(pager?.args.includes(DAEMON_LOG_PATH)).toBe(true);
  expect(pager?.summary).toBe("less follow");
  expect(pager?.keys.some((line) => line.includes(":n/:p"))).toBe(false);
});

test("resolveServiceLogPager uses raw docker logs when less is missing", () => {
  const pager = resolveServiceLogPager("db", 40, {
    pathExists: () => false,
    hasCommand: () => false,
    dockerInvoker: () => ["sudo", "-n", "docker"],
  });
  expect(pager?.command).toBe("sudo");
  expect(pager?.args).toEqual([
    "-n",
    "docker",
    "logs",
    "-f",
    "--tail",
    "40",
    "turbopanel-database",
  ]);
  expect(pager?.summary).toBe("docker logs -f");
});

test("resolveServiceLogPager pipes journalctl through less when available", () => {
  const pager = resolveServiceLogPager("cache", 20, {
    pathExists: () => false,
    hasCommand: (name) => name === "less",
    journalInvoker: () => ["sudo", "-n", "journalctl"],
  });
  expect(pager?.command).toBe("sh");
  expect(pager?.args[1] ?? "").toMatch(
    /'sudo' '-n' 'journalctl' -u 'turbopanel-redis' -n '20' -f -o cat 2>&1 \| less -R \+F$/,
  );
});

test("resolveServiceLogPager uses default pathSize when a file is missing", () => {
  vi.mocked(statSync).mockImplementation(() => {
    throw new Error("ENOENT");
  });
  const pager = resolveServiceLogPager("daemon", 10, {
    pathExists: (path) => path === DAEMON_LOG_PATH,
    hasCommand: (name) => name === "less",
  });
  expect(pager?.args.includes(DAEMON_LOG_PATH)).toBe(true);
});

test("resolveServiceLogPager uses default pathSize for a readable file", () => {
  vi.mocked(statSync).mockReturnValue({ size: 80 } as Stats);
  const pager = resolveServiceLogPager("daemon", 10, {
    pathExists: (path) => path === DAEMON_LOG_PATH,
    hasCommand: (name) => name === "less",
  });
  expect(pager?.command).toBe("less");
  expect(pager?.args.includes(DAEMON_LOG_PATH)).toBe(true);
});

test("resolveServiceLogPager probes less on PATH when hasCommand is omitted", () => {
  vi.mocked(spawnSyncTrustedText).mockReturnValue(
    spawnRet(0, "/usr/bin/less\n") as never,
  );
  const pager = resolveServiceLogPager("daemon", 10, {
    pathExists: (path) => path === DAEMON_LOG_PATH,
    pathSize: () => 12,
  });
  expect(pager?.command).toBe("less");
  expect(spawnSyncTrustedText).toHaveBeenCalled();
});

test("resolveServiceLogPager prefers direct docker then sudo then a docker fallback", () => {
  vi.mocked(spawnSyncTrusted)
    .mockReturnValueOnce(spawnRet(0) as never)
    .mockReturnValueOnce(spawnRet(1) as never)
    .mockReturnValueOnce(spawnRet(0) as never)
    .mockReturnValueOnce(spawnRet(1) as never)
    .mockReturnValueOnce(spawnRet(1) as never);

  const direct = resolveServiceLogPager("db", 8, {
    pathExists: () => false,
    hasCommand: () => false,
  });
  expect(direct?.command).toBe("docker");

  const elevated = resolveServiceLogPager("db", 8, {
    pathExists: () => false,
    hasCommand: () => false,
  });
  expect(elevated?.command).toBe("sudo");
  expect(elevated?.args.slice(0, 2)).toEqual(["-n", "docker"]);

  const fallback = resolveServiceLogPager("db", 8, {
    pathExists: () => false,
    hasCommand: () => false,
  });
  expect(fallback?.command).toBe("docker");
});

test("resolveServiceLogPager prefers passwordless sudo for journalctl", () => {
  vi.mocked(spawnSyncTrusted)
    .mockReturnValueOnce(spawnRet(0) as never)
    .mockReturnValueOnce(spawnRet(1) as never);

  const elevated = resolveServiceLogPager("cache", 8, {
    pathExists: () => false,
    hasCommand: () => false,
  });
  expect(elevated?.command).toBe("sudo");
  expect(elevated?.args[0]).toBe("-n");
  expect(elevated?.args[1]).toBe("journalctl");

  const plain = resolveServiceLogPager("cache", 8, {
    pathExists: () => false,
    hasCommand: () => false,
  });
  expect(plain?.command).toBe("journalctl");
});

test("openServiceLogPager waits for Enter when no logs exist", () => {
  const writes: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(spawnSyncTrusted).mockReturnValue(spawnRet(0) as never);
  try {
    openServiceLogPager("no-such-service");
    expect(writes.some((line) => line.includes("No logs available"))).toBe(true);
    expect(spawnSyncTrusted).toHaveBeenCalledWith(
      "sh",
      ["-c", "read -r _ </dev/tty"],
      { stdio: "inherit" },
    );
  } finally {
    write.mockRestore();
  }
});

test("openServiceLogPager runs the pager and reports a failed exit", () => {
  const writes: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  vi.mocked(existsSync).mockImplementation((path) => path === DAEMON_LOG_PATH);
  vi.mocked(statSync).mockReturnValue({ size: 40 } as Stats);
  vi.mocked(spawnSyncTrustedText).mockReturnValue(
    spawnRet(0, "/usr/bin/less\n") as never,
  );
  vi.mocked(spawnSyncTrusted)
    .mockReturnValueOnce(spawnRet(2) as never)
    .mockReturnValueOnce(spawnRet(0) as never);
  try {
    openServiceLogPager("daemon", 25);
    expect(writes.some((line) => line.includes("daemon logs"))).toBe(true);
    expect(writes.some((line) => line.includes("exited with status 2"))).toBe(
      true,
    );
    expect(spawnSyncTrusted).toHaveBeenCalledWith(
      "less",
      expect.arrayContaining(["+F", DAEMON_LOG_PATH]),
      { stdio: "inherit" },
    );
  } finally {
    write.mockRestore();
  }
});

test("resolveServiceLogPager treats a PATH hit with empty stdout as missing less", () => {
  vi.mocked(spawnSyncTrustedText).mockReturnValue({
    status: 0,
    stdout: undefined,
    stderr: "",
    pid: 0,
    output: ["", "", ""],
    signal: null,
  } as never);
  const pager = resolveServiceLogPager("daemon", 10, {
    pathExists: (path) => path === DAEMON_LOG_PATH,
    pathSize: () => 12,
  });
  expect(pager?.command).toBe("tail");
});

test("openServiceLogPager restores previous SIGINT listeners and null status as failure", () => {
  const writes: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const previous = (): void => undefined;
  process.on("SIGINT", previous);
  vi.mocked(existsSync).mockImplementation((path) => path === DAEMON_LOG_PATH);
  vi.mocked(statSync).mockReturnValue({ size: 40 } as Stats);
  vi.mocked(spawnSyncTrustedText).mockReturnValue(
    spawnRet(0, "/usr/bin/less\n") as never,
  );
  vi.mocked(spawnSyncTrusted)
    .mockReturnValueOnce(
      spawnRet(null as unknown as number, "", { signal: "SIGTERM" }) as never,
    )
    .mockReturnValueOnce(spawnRet(0) as never);
  try {
    openServiceLogPager("daemon");
    expect(writes.some((line) => line.includes("exited with status 1"))).toBe(
      true,
    );
    expect(process.listeners("SIGINT")).toContain(previous);
  } finally {
    process.off("SIGINT", previous);
    write.mockRestore();
  }
});

test("openServiceLogPager treats pager SIGINT and spawn errors as a return to the TUI", () => {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.mocked(existsSync).mockImplementation((path) => path === DAEMON_LOG_PATH);
  vi.mocked(statSync).mockReturnValue({ size: 40 } as Stats);
  vi.mocked(spawnSyncTrustedText).mockReturnValue(
    spawnRet(0, "/usr/bin/less\n") as never,
  );
  vi.mocked(spawnSyncTrusted).mockReturnValueOnce(
    spawnRet(1, "", { signal: "SIGINT" }) as never,
  );
  try {
    openServiceLogPager("daemon");
    expect(write.mock.calls.some(([chunk]) =>
      String(chunk).includes("exited with status")
    )).toBe(false);
  } finally {
    write.mockRestore();
  }

  vi.mocked(spawnSyncTrusted).mockReturnValueOnce(
    spawnRet(0, "", { error: new Error("spawn failed") }) as never,
  );
  vi.mocked(spawnSyncTrusted).mockReturnValueOnce(spawnRet(0) as never);
  const writeAgain = vi.spyOn(process.stdout, "write").mockImplementation(
    () => true,
  );
  try {
    openServiceLogPager("daemon");
    expect(writeAgain.mock.calls.some(([chunk]) =>
      String(chunk).includes("exited with status 1")
    )).toBe(true);
  } finally {
    writeAgain.mockRestore();
  }
});
