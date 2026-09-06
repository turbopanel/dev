import type {
  SpawnSyncOptions,
  SpawnSyncReturns,
} from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellQuote } from "./shell-quote.ts";
import {
  daemonBootstrapScript,
  daemonDenoConfig,
  daemonOrchestrationScript,
  DENO_VERSION,
  RUNTIMES_DIR,
  VENDORED_DENO_BIN,
} from "./paths.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

vi.mock("./spawn-trusted.ts", () => ({
  spawnSyncTrusted: vi.fn(),
}));

vi.mock("./install-output.ts", () => ({
  runCaptured: vi.fn(async () => 0),
}));

import { spawnSync } from "node:child_process";
import { spawnSyncTrusted } from "./spawn-trusted.ts";
import { runCaptured } from "./install-output.ts";
import {
  bootstrapOrchestrationCommand,
  ensureBootstrapDeno,
  ensureOrchestrationDenoBin,
  isProductionRuntime,
  lookupHostDenoBin,
  orchestrationActionCommand,
  resolveBootstrapDenoBin,
  resolveDenoBinVersion,
  resolveHostDenoBin,
} from "./daemon-exec.ts";

const mockedSpawnSync = vi.mocked(spawnSync);
/**
 * `spawnSyncTrusted` is overloaded; `vi.mocked` resolves to the buffered form,
 * so pin the text shape these stubs return.
 */
type SpawnSyncTrustedTextFn = (
  command: string,
  args: readonly string[],
  options?: SpawnSyncOptions,
) => SpawnSyncReturns<string>;

const mockedSpawnSyncTrusted = vi.mocked(
  spawnSyncTrusted as SpawnSyncTrustedTextFn,
);
const mockedRunCaptured = vi.mocked(runCaptured);

const PINNED_DENO = `${RUNTIMES_DIR}/deno/${DENO_VERSION}/deno`;
/** Any version that is deliberately not the pin. */
const STALE_DENO_VERSION = "1.46.3";

function syncResult(
  status: number,
  stdout: string | null = "",
): SpawnSyncReturns<string> {
  return {
    status,
    stdout: stdout as string,
    stderr: "",
    pid: 1,
    output: ["", stdout ?? "", ""],
    signal: null,
  };
}

type DenoLookup = {
  hostDeno?: string | null;
  python3?: boolean;
  executable?: ReadonlySet<string>;
  sudoExecutable?: ReadonlySet<string>;
  /** True when `test -w <RUNTIMES_DIR>` succeeds (no sudo needed to write). */
  writableRuntimes?: boolean;
  /** bin path -> version `<bin> --version` reports; unlisted bins read stale. */
  denoVersions?: Record<string, string>;
};

function installSpawnMocks(lookup: DenoLookup): void {
  const hostDeno = lookup.hostDeno;
  const python3 = lookup.python3 ?? false;
  const executable = lookup.executable ?? new Set<string>();
  const sudoExecutable = lookup.sudoExecutable ?? new Set<string>();
  const writableRuntimes = lookup.writableRuntimes ?? false;
  const denoVersions = lookup.denoVersions ?? {};

  mockedSpawnSync.mockImplementation((command, args) => {
    const script = Array.isArray(args) ? String(args[1] ?? "") : "";
    if (Array.isArray(args) && args[0] === "--version") {
      const version = denoVersions[String(command)] ?? STALE_DENO_VERSION;
      return syncResult(0, `deno ${version} (release, x86_64-unknown-linux-gnu)\n`);
    }
    if (command === "/bin/sh" && script === "command -v deno") {
      if (!hostDeno) {
        return syncResult(1, "");
      }
      return syncResult(0, hostDeno);
    }
    if (command === "/bin/sh" && script === "command -v python3") {
      return syncResult(python3 ? 0 : 1);
    }
    if (command === "/bin/sh" && script.startsWith("test -w ")) {
      return syncResult(writableRuntimes ? 0 : 1);
    }
    if (command === "/bin/sh" && script.startsWith("test -x ")) {
      for (const path of executable) {
        if (script.includes(shellQuote(path))) {
          return syncResult(0);
        }
      }
      return syncResult(1);
    }
    return syncResult(1);
  });

  mockedSpawnSyncTrusted.mockImplementation((_command, args) => {
    const path = String(args[3] ?? "");
    return syncResult(sudoExecutable.has(path) ? 0 : 1);
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  mockedSpawnSync.mockReset();
  mockedSpawnSyncTrusted.mockReset();
  mockedRunCaptured.mockReset();
  mockedRunCaptured.mockResolvedValue(0);
});

describe("isProductionRuntime", () => {
  it("is true only when TURBOPANEL_RUNTIME is production", () => {
    vi.stubEnv("TURBOPANEL_RUNTIME", "production");
    expect(isProductionRuntime()).toBe(true);
  });

  it("is false when unset or any other value", () => {
    vi.stubEnv("TURBOPANEL_RUNTIME", "");
    expect(isProductionRuntime()).toBe(false);
    vi.stubEnv("TURBOPANEL_RUNTIME", "development");
    expect(isProductionRuntime()).toBe(false);
  });
});

describe("resolveDenoBinVersion", () => {
  it("returns null when --version fails or stdout is unparseable", () => {
    mockedSpawnSync.mockReturnValue(syncResult(1, "nope"));
    expect(resolveDenoBinVersion("/missing/deno")).toBeNull();

    mockedSpawnSync.mockReturnValue(syncResult(0, null));
    expect(resolveDenoBinVersion("/missing/deno")).toBeNull();

    mockedSpawnSync.mockReturnValue(syncResult(0, "not-deno 9.9.9\n"));
    expect(resolveDenoBinVersion("/missing/deno")).toBeNull();
  });
});

describe("lookupHostDenoBin / resolveHostDenoBin", () => {
  it("returns the trimmed PATH location when command -v deno succeeds", () => {
    installSpawnMocks({ hostDeno: "  /usr/bin/deno\n" });
    expect(lookupHostDenoBin()).toBe("/usr/bin/deno");
  });

  it("returns null when deno is missing or stdout is empty", () => {
    installSpawnMocks({ hostDeno: null });
    expect(lookupHostDenoBin()).toBeNull();

    mockedSpawnSync.mockReturnValue(syncResult(0, "   "));
    expect(lookupHostDenoBin()).toBeNull();

    mockedSpawnSync.mockReturnValue(syncResult(0, null));
    expect(lookupHostDenoBin()).toBeNull();
  });

  it("resolveHostDenoBin returns the lookup or throws", () => {
    installSpawnMocks({ hostDeno: "/usr/local/bin/deno" });
    expect(resolveHostDenoBin()).toBe("/usr/local/bin/deno");

    installSpawnMocks({ hostDeno: null });
    expect(() => resolveHostDenoBin()).toThrow(
      /Deno is not on PATH/,
    );
  });
});

describe("resolveBootstrapDenoBin", () => {
  it("prefers host Deno on PATH when it is the pinned version", () => {
    installSpawnMocks({
      hostDeno: "/home/dev/.deno/bin/deno",
      denoVersions: { "/home/dev/.deno/bin/deno": DENO_VERSION },
    });
    expect(resolveBootstrapDenoBin()).toBe("/home/dev/.deno/bin/deno");
  });

  it("prefers the vendored pin over a host Deno on a different version", () => {
    installSpawnMocks({
      hostDeno: "/usr/bin/deno",
      denoVersions: {
        "/usr/bin/deno": STALE_DENO_VERSION,
        [VENDORED_DENO_BIN]: DENO_VERSION,
      },
      executable: new Set([PINNED_DENO, VENDORED_DENO_BIN]),
    });
    expect(resolveBootstrapDenoBin()).toBe(VENDORED_DENO_BIN);
  });

  it("returns the pinned binary when vendor/deno/current is stale", () => {
    installSpawnMocks({
      hostDeno: null,
      denoVersions: { [VENDORED_DENO_BIN]: STALE_DENO_VERSION },
      executable: new Set([PINNED_DENO, VENDORED_DENO_BIN]),
    });
    expect(resolveBootstrapDenoBin()).toBe(PINNED_DENO);
  });

  it("prefers the pinned binary over a stale current even with a host Deno", () => {
    installSpawnMocks({
      hostDeno: "/usr/bin/deno",
      denoVersions: {
        "/usr/bin/deno": STALE_DENO_VERSION,
        [VENDORED_DENO_BIN]: STALE_DENO_VERSION,
      },
      executable: new Set([PINNED_DENO, VENDORED_DENO_BIN]),
    });
    expect(resolveBootstrapDenoBin()).toBe(PINNED_DENO);
  });

  it("falls back to a mismatched host Deno when the pin is not vendored", () => {
    installSpawnMocks({
      hostDeno: "/usr/bin/deno",
      denoVersions: { "/usr/bin/deno": STALE_DENO_VERSION },
    });
    expect(resolveBootstrapDenoBin()).toBe("/usr/bin/deno");
  });

  it("falls back to vendored current when it reports the pin and no host Deno", () => {
    installSpawnMocks({
      hostDeno: null,
      denoVersions: { [VENDORED_DENO_BIN]: DENO_VERSION },
      executable: new Set([VENDORED_DENO_BIN]),
    });
    expect(resolveBootstrapDenoBin()).toBe(VENDORED_DENO_BIN);
  });

  it("throws rather than exec a stale current when the pin is not vendored", () => {
    installSpawnMocks({
      hostDeno: null,
      denoVersions: { [VENDORED_DENO_BIN]: STALE_DENO_VERSION },
      executable: new Set([VENDORED_DENO_BIN]),
    });
    expect(() => resolveBootstrapDenoBin()).toThrow(
      new RegExp(`pinned ${DENO_VERSION.replaceAll(".", "\\.")}`),
    );
  });

  it("uses sudo -n test -x when a direct test -x fails", () => {
    installSpawnMocks({
      hostDeno: null,
      denoVersions: { [VENDORED_DENO_BIN]: DENO_VERSION },
      sudoExecutable: new Set([VENDORED_DENO_BIN]),
    });
    expect(resolveBootstrapDenoBin()).toBe(VENDORED_DENO_BIN);
    expect(mockedSpawnSyncTrusted).toHaveBeenCalledWith(
      "sudo",
      ["-n", "test", "-x", VENDORED_DENO_BIN],
      { stdio: "ignore" },
    );
  });

  it("throws when neither host nor vendored Deno is usable", () => {
    installSpawnMocks({ hostDeno: null });
    expect(() => resolveBootstrapDenoBin()).toThrow(
      new RegExp(`expected ${VENDORED_DENO_BIN.replaceAll("/", "\\/")}`),
    );
  });
});

describe("ensureBootstrapDeno", () => {
  beforeEach(() => {
    mockedRunCaptured.mockResolvedValue(0);
  });

  it("short-circuits when host Deno on PATH is the pinned version", async () => {
    installSpawnMocks({
      hostDeno: "/usr/bin/deno",
      denoVersions: { "/usr/bin/deno": DENO_VERSION },
    });
    await ensureBootstrapDeno();
    expect(mockedRunCaptured).not.toHaveBeenCalled();
  });

  it("warns and vendors the pin when host Deno is a different version", async () => {
    installSpawnMocks({
      hostDeno: "/usr/bin/deno",
      denoVersions: { "/usr/bin/deno": STALE_DENO_VERSION },
      executable: new Set([PINNED_DENO, VENDORED_DENO_BIN]),
    });
    const onOutput = vi.fn();
    await ensureBootstrapDeno(onOutput);
    expect(onOutput).toHaveBeenCalledWith(
      expect.stringContaining(
        `Host Deno ${STALE_DENO_VERSION} does not match pinned ${DENO_VERSION}`,
      ),
    );
    expect(mockedRunCaptured).toHaveBeenCalledTimes(1);
    expect(String(mockedRunCaptured.mock.calls[0]?.[0]?.[4])).toContain("ln -sfn");
  });

  it("repairs current/bin symlinks when the pinned binary is already present", async () => {
    installSpawnMocks({
      hostDeno: null,
      executable: new Set([PINNED_DENO, VENDORED_DENO_BIN]),
    });
    const onOutput = vi.fn();
    await ensureBootstrapDeno(onOutput);
    expect(mockedRunCaptured).toHaveBeenCalledTimes(1);
    const cmd = mockedRunCaptured.mock.calls[0]?.[0];
    if (!Array.isArray(cmd)) {
      throw new TypeError("expected runCaptured command argv");
    }
    expect(cmd.slice(0, 4)).toEqual(["sudo", "-n", "bash", "-c"]);
    expect(String(cmd[4])).toContain("ln -sfn");
    expect(mockedRunCaptured.mock.calls[0]?.[1]).toBe(onOutput);
  });

  it("installs from dl.deno.land when the pin is missing and python3 is available", async () => {
    let installed = false;
    installSpawnMocks({ hostDeno: null, python3: true });
    mockedSpawnSync.mockImplementation((command, args) => {
      const script = Array.isArray(args) ? String(args[1] ?? "") : "";
      if (command === "/bin/sh" && script === "command -v deno") {
        return syncResult(1, "");
      }
      if (command === "/bin/sh" && script === "command -v python3") {
        return syncResult(0);
      }
      if (command === "/bin/sh" && script.startsWith("test -x ")) {
        return syncResult(installed ? 0 : 1);
      }
      return syncResult(1);
    });
    mockedRunCaptured.mockImplementation(async () => {
      installed = true;
      return 0;
    });

    await ensureBootstrapDeno();
    const cmd = mockedRunCaptured.mock.calls[0]?.[0];
    if (!Array.isArray(cmd)) {
      throw new TypeError("expected install argv");
    }
    const script = String(cmd[4]);
    expect(script).toContain("dl.deno.land/release/v${VERSION}");
    expect(script).toContain(`VERSION=${shellQuote(DENO_VERSION)}`);
  });

  it("throws when python3 is missing and nothing is vendored", async () => {
    installSpawnMocks({ hostDeno: null, python3: false });
    await expect(ensureBootstrapDeno()).rejects.toThrow(/python3-minimal/);
    expect(mockedRunCaptured).not.toHaveBeenCalled();
  });

  it("does not download when symlink repair fails but the pin is present", async () => {
    installSpawnMocks({
      hostDeno: null,
      python3: false,
      executable: new Set([PINNED_DENO]),
    });
    mockedRunCaptured.mockResolvedValue(1);
    const onOutput = vi.fn();
    await expect(ensureBootstrapDeno(onOutput)).resolves.toBeUndefined();
    expect(mockedRunCaptured).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(
      expect.stringContaining(PINNED_DENO),
    );
  });

  it("writes symlinks without sudo when RUNTIMES_DIR is writable", async () => {
    installSpawnMocks({
      hostDeno: null,
      writableRuntimes: true,
      executable: new Set([PINNED_DENO, VENDORED_DENO_BIN]),
    });
    await ensureBootstrapDeno();
    expect(mockedRunCaptured).toHaveBeenCalledTimes(1);
    const cmd = mockedRunCaptured.mock.calls[0]?.[0];
    if (!Array.isArray(cmd)) {
      throw new TypeError("expected runCaptured command argv");
    }
    expect(cmd.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(String(cmd[2])).toContain("ln -sfn");
  });

  it("escalates to sudo when the direct write into RUNTIMES_DIR fails", async () => {
    installSpawnMocks({
      hostDeno: null,
      writableRuntimes: true,
      executable: new Set([PINNED_DENO, VENDORED_DENO_BIN]),
    });
    mockedRunCaptured.mockImplementation(async (cmd) =>
      Array.isArray(cmd) && cmd[0] === "sudo" ? 0 : 1
    );
    await ensureBootstrapDeno();
    expect(mockedRunCaptured).toHaveBeenCalledTimes(2);
    expect(mockedRunCaptured.mock.calls[1]?.[0]?.slice(0, 4)).toEqual([
      "sudo",
      "-n",
      "bash",
      "-c",
    ]);
  });

  it("mentions a CDN retry when the download script exits non-zero", async () => {
    installSpawnMocks({ hostDeno: null, python3: true });
    mockedRunCaptured.mockResolvedValue(1);
    await expect(ensureBootstrapDeno()).rejects.toThrow(/dl\.deno\.land CDN/);
  });

  it("omits the CDN hint when extract succeeded but the pin is still unusable", async () => {
    installSpawnMocks({ hostDeno: null, python3: true });
    mockedRunCaptured.mockResolvedValue(0);
    await expect(ensureBootstrapDeno()).rejects.toThrow(
      `Failed to install Deno ${DENO_VERSION} to ${VENDORED_DENO_BIN}`,
    );
    await expect(ensureBootstrapDeno()).rejects.not.toThrow(/CDN/);
  });

  it("embeds aarch64 vs x86_64 triples from process.arch", async () => {
    installSpawnMocks({ hostDeno: null, python3: true });
    mockedRunCaptured.mockResolvedValue(1);

    const archSpy = vi.spyOn(process, "arch", "get");
    archSpy.mockReturnValue("arm64");
    await expect(ensureBootstrapDeno()).rejects.toThrow(/Deno/);
    expect(String(mockedRunCaptured.mock.calls.at(-1)?.[0]?.[4])).toContain(
      "deno-aarch64-unknown-linux-gnu.zip",
    );

    mockedRunCaptured.mockClear();
    mockedRunCaptured.mockResolvedValue(1);
    archSpy.mockReturnValue("x64");
    await expect(ensureBootstrapDeno()).rejects.toThrow(/Deno/);
    expect(String(mockedRunCaptured.mock.calls.at(-1)?.[0]?.[4])).toContain(
      "deno-x86_64-unknown-linux-gnu.zip",
    );

    mockedRunCaptured.mockClear();
    archSpy.mockReturnValue("ia32");
    await expect(ensureBootstrapDeno()).rejects.toThrow(
      /Unsupported CPU architecture/,
    );
    expect(mockedRunCaptured).not.toHaveBeenCalled();
    archSpy.mockRestore();
  });
});

describe("ensureOrchestrationDenoBin", () => {
  it("ensures then resolves the host Deno binary", async () => {
    installSpawnMocks({
      hostDeno: "/usr/bin/deno",
      denoVersions: { "/usr/bin/deno": DENO_VERSION },
    });
    await expect(ensureOrchestrationDenoBin()).resolves.toBe("/usr/bin/deno");
  });

  it("resolves the pinned binary when a stale current cannot be relinked", async () => {
    installSpawnMocks({
      hostDeno: null,
      python3: true,
      executable: new Set([PINNED_DENO, VENDORED_DENO_BIN]),
      denoVersions: {
        [PINNED_DENO]: DENO_VERSION,
        [VENDORED_DENO_BIN]: STALE_DENO_VERSION,
      },
    });
    mockedRunCaptured.mockResolvedValue(1);

    const onOutput = vi.fn();
    await expect(ensureOrchestrationDenoBin(onOutput)).resolves.toBe(PINNED_DENO);
    expect(mockedRunCaptured).toHaveBeenCalledTimes(1);
    expect(mockedRunCaptured.mock.calls[0]?.[0]?.slice(0, 4)).toEqual([
      "sudo",
      "-n",
      "bash",
      "-c",
    ]);
    expect(onOutput).toHaveBeenCalledWith(expect.stringContaining(PINNED_DENO));
  });
});

describe("orchestrationActionCommand / bootstrapOrchestrationCommand", () => {
  it("uses an explicit denoBin and quotes every argv token", () => {
    const cmd = orchestrationActionCommand(["instance-dev-install", "--if-needed"], {
      denoBin: "/opt/deno",
    });
    expect(cmd).toBe(
      [
        "/opt/deno",
        "run",
        "--config",
        daemonDenoConfig(),
        "--allow-read",
        "--allow-run",
        "--allow-env",
        "--allow-write",
        "--allow-net",
        daemonOrchestrationScript(),
        "instance-dev-install",
        "--if-needed",
      ].map(shellQuote).join(" "),
    );
  });

  it("resolves Deno itself in development and production", () => {
    installSpawnMocks({
      hostDeno: "/usr/bin/deno",
      denoVersions: { "/usr/bin/deno": DENO_VERSION },
    });
    vi.stubEnv("TURBOPANEL_RUNTIME", "development");
    expect(orchestrationActionCommand(["ping"])).toContain(shellQuote("/usr/bin/deno"));

    vi.stubEnv("TURBOPANEL_RUNTIME", "production");
    expect(orchestrationActionCommand(["ping"])).toContain(shellQuote("/usr/bin/deno"));
    expect(bootstrapOrchestrationCommand()).toBe(
      [
        "/usr/bin/deno",
        "run",
        "--config",
        daemonDenoConfig(),
        "--allow-net",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-env",
        daemonBootstrapScript(),
      ].map(shellQuote).join(" "),
    );

    vi.stubEnv("TURBOPANEL_RUNTIME", "development");
    expect(bootstrapOrchestrationCommand()).toContain(
      shellQuote(daemonBootstrapScript()),
    );
  });
});
