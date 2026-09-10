import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, test, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

vi.mock("./spawn-trusted.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spawn-trusted.ts")>();
  return {
    ...actual,
    spawnSyncTrusted: vi.fn(actual.spawnSyncTrusted),
    spawnSyncTrustedText: vi.fn(actual.spawnSyncTrustedText),
    spawnTrustedText: vi.fn(actual.spawnTrustedText),
  };
});

vi.mock("./dev-identity.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dev-identity.ts")>();
  return {
    ...actual,
    resolveDevIdentity: vi.fn(actual.resolveDevIdentity),
  };
});

import { resolveDevIdentity } from "./dev-identity.ts";
import {
  mergeEnvFile,
  parseEnvEntries,
  readEnvFile,
  readEnvFileAsync,
  writeEnvFile,
} from "./env-file.ts";
import { spawnSyncTrusted, spawnSyncTrustedText, spawnTrustedText } from "./spawn-trusted.ts";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);
const mockedSpawnSyncTrusted = vi.mocked(spawnSyncTrusted);
const mockedSpawnSyncTrustedText = vi.mocked(spawnSyncTrustedText);
const mockedSpawnTrustedText = vi.mocked(spawnTrustedText);
const mockedResolveDevIdentity = vi.mocked(resolveDevIdentity);

const fsActual = await vi.importActual<typeof import("node:fs")>("node:fs");
const spawnActual = await vi.importActual<typeof import("./spawn-trusted.ts")>(
  "./spawn-trusted.ts",
);
const identityActual = await vi.importActual<typeof import("./dev-identity.ts")>(
  "./dev-identity.ts",
);

let tempDir: string | undefined;

afterEach(() => {
  mockedReadFileSync.mockImplementation(fsActual.readFileSync);
  mockedWriteFileSync.mockImplementation(fsActual.writeFileSync);
  mockedUnlinkSync.mockImplementation(fsActual.unlinkSync);
  mockedSpawnSyncTrusted.mockImplementation(spawnActual.spawnSyncTrusted);
  mockedSpawnSyncTrustedText.mockImplementation(spawnActual.spawnSyncTrustedText);
  mockedSpawnTrustedText.mockImplementation(spawnActual.spawnTrustedText);
  mockedResolveDevIdentity.mockImplementation(identityActual.resolveDevIdentity);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "turbopanel-env-file-"));
  return tempDir;
}

function sudoResult(status: number, stdout = ""): ReturnType<typeof spawnSyncTrustedText> {
  return {
    status,
    stdout,
    stderr: "",
    pid: 1,
    output: ["", stdout, ""],
    signal: null,
  };
}

function sudoBufferResult(status: number): ReturnType<typeof spawnSyncTrusted> {
  return {
    status,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    pid: 1,
    output: [null, Buffer.alloc(0), Buffer.alloc(0)],
    signal: null,
  };
}

test("parseEnvEntries parses keys and ignores non-matching lines", () => {
  const content = [
    "# comment",
    "",
    "FOO=bar",
    "lowercase=ignored",
    "BAZ=value=with=equals",
    "FOO=later",
  ].join("\n");

  const entries = parseEnvEntries(content);
  expect(entries.get("FOO")).toBe("later");
  expect(entries.get("BAZ")).toBe("value=with=equals");
  expect(entries.has("lowercase")).toBe(false);
  expect(entries.size).toBe(2);
});

test("mergeEnvFile updates managed keys in place and appends new ones", () => {
  const dir = makeTempDir();
  const path = join(dir, "daemon.env");
  writeFileSync(
    path,
    [
      "# header",
      "",
      "KEEP=untouched",
      "MANAGED=old",
      "# mid comment",
      "MANAGED=duplicate",
      "OTHER=stay",
      "",
      "",
    ].join("\n"),
  );

  mergeEnvFile(path, {
    MANAGED: "new",
    APPENDED: "yes",
  });

  expect(fsActual.readFileSync(path, "utf8")).toBe(
    [
      "# header",
      "",
      "KEEP=untouched",
      "MANAGED=new",
      "# mid comment",
      "OTHER=stay",
      "",
      "",
      "APPENDED=yes",
      "",
    ].join("\n"),
  );
});

test("mergeEnvFile removeKeys deletes matching lines", () => {
  const dir = makeTempDir();
  const path = join(dir, "daemon.env");
  writeFileSync(path, "KEEP=1\nGONE=2\nALSO=3\n");

  mergeEnvFile(path, { KEEP: "1" }, { removeKeys: ["GONE"] });

  expect(fsActual.readFileSync(path, "utf8")).toBe("KEEP=1\nALSO=3\n");
});

test("mergeEnvFile trims trailing blank lines to a single terminating newline", () => {
  const dir = makeTempDir();
  const path = join(dir, "daemon.env");
  writeFileSync(path, "A=1\n\n\n");

  mergeEnvFile(path, { A: "1" });

  expect(fsActual.readFileSync(path, "utf8")).toBe("A=1\n");
});

test("mergeEnvFile creates a file when the path is missing", () => {
  const dir = makeTempDir();
  const path = join(dir, "missing.env");

  mergeEnvFile(path, { NEW: "yes" });

  expect(fsActual.readFileSync(path, "utf8")).toBe("NEW=yes\n");
});

describe("readEnvFile / writeEnvFile privilege fallbacks", () => {
  it("readEnvFile uses sudo cat when the path is unreadable", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    mockedSpawnSyncTrustedText.mockReturnValue(sudoResult(0, "FROM_SUDO=1\n"));

    expect(readEnvFile("/etc/turbopanel/daemon.env")).toBe("FROM_SUDO=1\n");
  });

  it("readEnvFile treats a successful sudo cat with empty stdout as blank", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    mockedSpawnSyncTrustedText.mockReturnValue({
      ...sudoResult(0, ""),
      stdout: undefined as unknown as string,
    });

    expect(readEnvFile("/etc/turbopanel/daemon.env")).toBe("");
  });

  it("readEnvFile returns blank when sudo cat fails", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    mockedSpawnSyncTrustedText.mockReturnValue(sudoResult(1, "denied"));

    expect(readEnvFile("/etc/turbopanel/daemon.env")).toBe("");
  });

  it("readEnvFileAsync reads the path when it is readable", async () => {
    const dir = makeTempDir();
    const path = join(dir, "readable.env");
    writeFileSync(path, "ASYNC=1\n");
    mockedSpawnTrustedText.mockClear();

    await expect(readEnvFileAsync(path)).resolves.toBe("ASYNC=1\n");
    expect(mockedSpawnTrustedText).not.toHaveBeenCalled();
  });

  it("readEnvFileAsync uses sudo cat when the path is unreadable", async () => {
    mockedSpawnTrustedText.mockResolvedValue({
      status: 0,
      stdout: "FROM_SUDO_ASYNC=1\n",
      stderr: "",
    });

    await expect(readEnvFileAsync(join("/no-such-turbopanel-env", "missing.env"))).resolves
      .toBe("FROM_SUDO_ASYNC=1\n");
    expect(mockedSpawnTrustedText).toHaveBeenCalledWith("sudo", [
      "-n",
      "cat",
      join("/no-such-turbopanel-env", "missing.env"),
    ]);
  });

  it("readEnvFileAsync returns blank when sudo cat fails", async () => {
    mockedSpawnTrustedText.mockResolvedValue({
      status: 1,
      stdout: "denied",
      stderr: "sudo: a password is required",
    });

    await expect(readEnvFileAsync(join("/no-such-turbopanel-env", "denied.env")))
      .resolves.toBe("");
  });

  it("writeEnvFile falls back to sudo mkdir/cp/chown when the path is not writable", () => {
    mockedWriteFileSync.mockImplementation((path, content, options) => {
      if (String(path).endsWith("protected.env")) {
        throw new Error("EACCES");
      }
      return fsActual.writeFileSync(path, content, options);
    });
    mockedSpawnSyncTrusted.mockReturnValue(sudoBufferResult(0));
    mockedResolveDevIdentity.mockReturnValue({
      user: "dev",
      uid: 1000,
      gid: 1000,
    });

    writeEnvFile("/etc/turbopanel/protected.env", "A=1\n");

    const mkdir = mockedSpawnSyncTrusted.mock.calls.find((call) => call[1]?.[1] === "mkdir");
    const copy = mockedSpawnSyncTrusted.mock.calls.find((call) => call[1]?.[1] === "cp");
    const chown = mockedSpawnSyncTrusted.mock.calls.find((call) => call[1]?.[1] === "chown");
    if (!mkdir || !copy || !chown) {
      throw new TypeError("expected sudo mkdir, cp, and chown");
    }
    expect(mkdir[1]).toEqual(["-n", "mkdir", "-p", dirname("/etc/turbopanel/protected.env")]);
    expect(copy[1]?.[3]).toBe("/etc/turbopanel/protected.env");
    expect(chown[1]).toEqual(["-n", "chown", "dev:1000", "/etc/turbopanel/protected.env"]);
  });

  it("writeEnvFile throws when sudo mkdir fails", () => {
    mockedWriteFileSync.mockImplementation((path, content, options) => {
      if (String(path).endsWith("protected.env")) {
        throw new Error("EACCES");
      }
      return fsActual.writeFileSync(path, content, options);
    });
    mockedSpawnSyncTrusted.mockReturnValue(sudoBufferResult(1));

    expect(() => writeEnvFile("/etc/turbopanel/protected.env", "A=1\n")).toThrow(
      "Failed to create /etc/turbopanel",
    );
  });

  it("writeEnvFile throws when sudo cp fails after mkdir", () => {
    mockedWriteFileSync.mockImplementation((path, content, options) => {
      if (String(path).endsWith("protected.env")) {
        throw new Error("EACCES");
      }
      return fsActual.writeFileSync(path, content, options);
    });
    mockedSpawnSyncTrusted.mockImplementation((_cmd, args) =>
      sudoBufferResult(String(args[1] ?? "") === "cp" ? 1 : 0),
    );

    expect(() => writeEnvFile("/etc/turbopanel/protected.env", "A=1\n")).toThrow(
      "Failed to write /etc/turbopanel/protected.env",
    );
  });

  it("writeEnvFile ignores tmp cleanup failures", () => {
    mockedWriteFileSync.mockImplementation((path, content, options) => {
      if (String(path).endsWith("protected.env")) {
        throw new Error("EACCES");
      }
      return fsActual.writeFileSync(path, content, options);
    });
    mockedSpawnSyncTrusted.mockReturnValue(sudoBufferResult(0));
    mockedResolveDevIdentity.mockReturnValue({
      user: "dev",
      uid: 1000,
      gid: 1000,
    });
    mockedUnlinkSync.mockImplementation(() => {
      throw new Error("already gone");
    });

    expect(() => writeEnvFile("/etc/turbopanel/protected.env", "A=1\n")).not.toThrow();
  });
});
