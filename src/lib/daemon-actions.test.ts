import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevServiceStatus } from "../dev-services.ts";
import {
  daemonRepoPath,
  DAEMON_SYSTEMD_UNIT,
  RUNTIMES_DIR,
  TURBOPANEL_ROOT,
} from "./paths.ts";
import { shellQuote } from "./shell-quote.ts";
import type { DaemonSyncResult, SyncDevResponse } from "./developer-client.ts";

vi.mock("../dev-services.ts", () => ({
  isDaemonSystemdInstalled: vi.fn(() => true),
}));

vi.mock("./daemon-env.ts", () => ({
  readInstanceRuntime: vi.fn(() => "deno"),
  isDeveloperSurfaceInstance: vi.fn(() => true),
}));

vi.mock("./spawn-trusted.ts", () => ({
  spawnSyncTrustedText: vi.fn(() => ({
    status: 0,
    stdout: "inactive",
    stderr: "",
    pid: 1,
    output: ["", "inactive", ""],
    signal: null,
  })),
}));

vi.mock("./install-output.ts", () => ({
  runCaptured: vi.fn(async () => 0),
}));

vi.mock("./developer-client.ts", () => ({
  syncDevToAllDaemons: vi.fn(),
  updateConnectedDaemons: vi.fn(),
}));

vi.mock("./daemon-exec.ts", () => ({
  ensureOrchestrationDenoBin: vi.fn(async () => "/opt/turbopanel/vendor/deno/current/deno"),
}));

vi.mock("./run-repo-tests.ts", () => ({
  testRunnerPathEnv: vi.fn(() => ({ PATH: "/opt/turbopanel/vendor/deno/current" })),
}));

import { isDaemonSystemdInstalled } from "../dev-services.ts";
import { isDeveloperSurfaceInstance, readInstanceRuntime } from "./daemon-env.ts";
import { spawnSyncTrustedText } from "./spawn-trusted.ts";
import { runCaptured } from "./install-output.ts";
import { syncDevToAllDaemons, updateConnectedDaemons } from "./developer-client.ts";
import { ensureOrchestrationDenoBin } from "./daemon-exec.ts";
import { testRunnerPathEnv } from "./run-repo-tests.ts";
import {
  canRestartDaemon,
  cellTraceToggleLabel,
  daemonMenuActions,
  DAEMON_ACTION_LABELS,
  developerMenuActions,
  enableAndStartDaemon,
  isDaemonServiceActive,
  purgeDaemon,
  rebuildDaemonAndUpgradeConnectedServers,
  requestDaemonRestart,
  syncDevBuildToDaemons,
  waitForDaemonRunning,
} from "./daemon-actions.ts";

const mockedIsDaemonSystemdInstalled = vi.mocked(isDaemonSystemdInstalled);
const mockedReadInstanceRuntime = vi.mocked(readInstanceRuntime);
const mockedIsDeveloperSurfaceInstance = vi.mocked(isDeveloperSurfaceInstance);
const mockedSpawnSyncTrustedText = vi.mocked(spawnSyncTrustedText);
const mockedRunCaptured = vi.mocked(runCaptured);
const mockedSyncDev = vi.mocked(syncDevToAllDaemons);
const mockedUpdateDaemons = vi.mocked(updateConnectedDaemons);
const mockedEnsureDeno = vi.mocked(ensureOrchestrationDenoBin);

function textResult(stdout: string, status = 0) {
  return {
    status,
    stdout,
    stderr: "",
    pid: 1,
    output: ["", stdout, ""] as [string, string, string],
    signal: null,
  };
}

function syncResponse(results: DaemonSyncResult[]): SyncDevResponse {
  return { ok: true, results };
}

beforeEach(() => {
  mockedIsDaemonSystemdInstalled.mockReturnValue(true);
  mockedReadInstanceRuntime.mockReturnValue("deno");
  mockedIsDeveloperSurfaceInstance.mockReturnValue(true);
  mockedSpawnSyncTrustedText.mockReturnValue(textResult("inactive"));
  mockedRunCaptured.mockResolvedValue(0);
  mockedEnsureDeno.mockResolvedValue("/opt/turbopanel/vendor/deno/current/deno");
});

afterEach(() => {
  vi.useRealTimers();
  mockedRunCaptured.mockReset();
  mockedRunCaptured.mockResolvedValue(0);
  mockedSyncDev.mockReset();
  mockedUpdateDaemons.mockReset();
});

describe("daemon menus", () => {
  it("daemonMenuActions is empty for every status", () => {
    const statuses: DevServiceStatus[] = [
      "running",
      "starting",
      "failed",
      "stopped",
      "pending",
      "uninstalled",
    ];
    for (const status of statuses) {
      expect(daemonMenuActions(status)).toEqual([]);
    }
  });

  it("developerMenuActions is empty until the daemon is installed", () => {
    expect(developerMenuActions(undefined)).toEqual([]);
    expect(developerMenuActions("uninstalled")).toEqual([]);
  });

  it("includes Deno-only sync/rebuild when the instance runtime is deno", () => {
    mockedReadInstanceRuntime.mockReturnValue("deno");
    expect(developerMenuActions("running")).toEqual([
      "repair",
      "start-dev-env",
      "optional-services",
      "reset-dev-env",
      "reset-dev-db",
      "run-tests",
      "toggle-cell-trace",
      "view-cell-trace",
      "open-duckdb-ui",
      "sync-dev-build",
      "rebuild-daemon-upgrade",
      "purge",
    ]);
  });

  it("omits Deno-only actions on the Workers runtime", () => {
    mockedReadInstanceRuntime.mockReturnValue("workers");
    mockedIsDeveloperSurfaceInstance.mockReturnValue(false);
    const actions = developerMenuActions("stopped");
    expect(actions).not.toContain("open-duckdb-ui");
    expect(actions).not.toContain("sync-dev-build");
    expect(actions).not.toContain("rebuild-daemon-upgrade");
    expect(actions).toContain("save-tier-catalogue");
    expect(actions.at(-1)).toBe("purge");
    expect(actions[0]).toBe("repair");
  });

  it("offers the tier catalogue save only where billing exists (Workers)", () => {
    mockedReadInstanceRuntime.mockReturnValue("deno");
    expect(developerMenuActions("running")).not.toContain("save-tier-catalogue");
    expect(DAEMON_ACTION_LABELS["save-tier-catalogue"]).toContain("tiers.json");
  });

  it("hides open-duckdb-ui without the developer-surface build even on Deno", () => {
    mockedReadInstanceRuntime.mockReturnValue("deno");
    mockedIsDeveloperSurfaceInstance.mockReturnValue(false);
    const actions = developerMenuActions("running");
    expect(actions).not.toContain("open-duckdb-ui");
    expect(actions).toContain("sync-dev-build");
    expect(actions).toContain("rebuild-daemon-upgrade");
  });

  it("labels every action id", () => {
    mockedReadInstanceRuntime.mockReturnValue("deno");
    for (const id of developerMenuActions("running")) {
      expect(DAEMON_ACTION_LABELS[id].length).toBeGreaterThan(0);
    }
  });

  it("re-exports cellTraceToggleLabel", () => {
    expect(typeof cellTraceToggleLabel).toBe("function");
  });
});

describe("canRestartDaemon / isDaemonServiceActive", () => {
  it("canRestartDaemon follows the systemd unit probe", () => {
    mockedIsDaemonSystemdInstalled.mockReturnValueOnce(true);
    expect(canRestartDaemon()).toBe(true);
    mockedIsDaemonSystemdInstalled.mockReturnValueOnce(false);
    expect(canRestartDaemon()).toBe(false);
  });

  it("isDaemonServiceActive is true only for stdout active", () => {
    mockedSpawnSyncTrustedText.mockReturnValue(textResult("active"));
    expect(isDaemonServiceActive()).toBe(true);
    expect(mockedSpawnSyncTrustedText).toHaveBeenCalledWith(
      "systemctl",
      ["is-active", DAEMON_SYSTEMD_UNIT],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    mockedSpawnSyncTrustedText.mockReturnValue(textResult("  active\n"));
    expect(isDaemonServiceActive()).toBe(true);

    mockedSpawnSyncTrustedText.mockReturnValue(textResult("inactive"));
    expect(isDaemonServiceActive()).toBe(false);

    mockedSpawnSyncTrustedText.mockReturnValue({
      ...textResult(""),
      stdout: undefined as unknown as string,
    });
    expect(isDaemonServiceActive()).toBe(false);
  });
});

describe("waitForDaemonRunning", () => {
  it("returns immediately when the unit is already active", async () => {
    mockedSpawnSyncTrustedText.mockReturnValue(textResult("active"));
    await expect(waitForDaemonRunning({ timeoutMs: 50, pollMs: 10 })).resolves.toBe(
      true,
    );
  });

  it("polls until active and reports elapsed time", async () => {
    vi.useFakeTimers();
    mockedSpawnSyncTrustedText
      .mockReturnValueOnce(textResult("inactive"))
      .mockReturnValueOnce(textResult("active"));
    const onPoll = vi.fn();
    const pending = waitForDaemonRunning({
      timeoutMs: 5_000,
      pollMs: 250,
      onPoll,
    });
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBe(true);
    expect(onPoll).toHaveBeenCalled();
    expect(onPoll.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(0);
  });

  it("returns the final probe after the timeout elapses", async () => {
    vi.useFakeTimers();
    mockedSpawnSyncTrustedText.mockReturnValue(textResult("inactive"));
    const pending = waitForDaemonRunning({ timeoutMs: 400, pollMs: 200 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(false);
  });

  it("returns true when the unit becomes active on the post-timeout probe", async () => {
    vi.useFakeTimers();
    let probes = 0;
    mockedSpawnSyncTrustedText.mockImplementation(() => {
      probes += 1;
      return textResult(probes >= 2 ? "active" : "inactive");
    });
    const pending = waitForDaemonRunning({ timeoutMs: 200, pollMs: 200 });
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toBe(true);
  });
});

describe("enableAndStartDaemon / requestDaemonRestart / purgeDaemon", () => {
  it("enableAndStartDaemon runs systemctl enable --now", async () => {
    const lines: string[] = [];
    await enableAndStartDaemon((line) => lines.push(line));
    expect(mockedRunCaptured).toHaveBeenCalledWith(
      ["sudo", "-n", "systemctl", "enable", "--now", DAEMON_SYSTEMD_UNIT],
      expect.any(Function),
    );
    const append = mockedRunCaptured.mock.calls[0]?.[1];
    append?.("Started.");
    expect(lines).toEqual(["Started."]);
  });

  it("enableAndStartDaemon throws the last output line on failure", async () => {
    mockedRunCaptured.mockImplementation(async (_cmd, onLine) => {
      onLine?.("permission denied");
      return 1;
    });
    await expect(enableAndStartDaemon()).rejects.toThrow("permission denied");
  });

  it("enableAndStartDaemon falls back to a default message when silent", async () => {
    mockedRunCaptured.mockResolvedValue(1);
    await expect(enableAndStartDaemon()).rejects.toThrow(
      `Failed to enable and start ${DAEMON_SYSTEMD_UNIT}`,
    );
  });

  it("requestDaemonRestart uses --no-block", async () => {
    await requestDaemonRestart();
    expect(mockedRunCaptured).toHaveBeenCalledWith(
      ["sudo", "systemctl", "restart", "--no-block", DAEMON_SYSTEMD_UNIT],
      expect.any(Function),
    );
  });

  it("requestDaemonRestart throws last line or default", async () => {
    mockedRunCaptured.mockImplementation(async (_cmd, onLine) => {
      onLine?.("restart failed");
      return 1;
    });
    await expect(requestDaemonRestart()).rejects.toThrow("restart failed");

    mockedRunCaptured.mockResolvedValue(1);
    await expect(requestDaemonRestart()).rejects.toThrow("Failed to restart daemon");
  });

  it("purgeDaemon stops the unit and removes quoted trees", async () => {
    await purgeDaemon();
    const cmd = mockedRunCaptured.mock.calls[0]?.[0];
    if (!Array.isArray(cmd)) {
      throw new TypeError("expected purge argv");
    }
    expect(cmd.slice(0, 3)).toEqual(["sudo", "bash", "-c"]);
    const script = String(cmd[3]);
    expect(script).toContain(`systemctl stop ${DAEMON_SYSTEMD_UNIT}`);
    expect(script).toContain("systemctl daemon-reload");
    expect(script).toContain(`rm -rf ${shellQuote(daemonRepoPath())}`);
    expect(script).toContain(`rm -rf ${shellQuote(RUNTIMES_DIR)}`);
    expect(script).toContain(`rm -rf ${shellQuote(`${TURBOPANEL_ROOT}/.cache`)}`);
  });

  it("purgeDaemon throws when the script fails", async () => {
    mockedRunCaptured.mockResolvedValue(1);
    await expect(purgeDaemon()).rejects.toThrow("Failed to purge daemon");
  });
});

describe("syncDevBuildToDaemons", () => {
  it("wraps API errors", async () => {
    mockedSyncDev.mockRejectedValue(new Error("socket down"));
    await expect(syncDevBuildToDaemons()).rejects.toThrow(
      /Could not reach the instance developer API: socket down/,
    );

    mockedSyncDev.mockRejectedValue("nope");
    await expect(syncDevBuildToDaemons()).rejects.toThrow(
      /Could not reach the instance developer API: nope/,
    );
  });

  it("reports when no daemons are connected", async () => {
    mockedSyncDev.mockResolvedValue(syncResponse([]));
    const lines: string[] = [];
    await syncDevBuildToDaemons((line) => lines.push(line));
    expect(lines.some((line) => /No attached daemons/.test(line))).toBe(true);
  });

  it("prints skipped / ok / failed rows and throws when any fail", async () => {
    mockedSyncDev.mockResolvedValue(
      syncResponse([
        { daemonId: "a", ok: true, skipped: true },
        { daemonId: "b", ok: false, error: "timeout" },
        { daemonId: "c", ok: true },
      ]),
    );
    const lines: string[] = [];
    await expect(syncDevBuildToDaemons((line) => lines.push(line))).rejects.toThrow(
      /1 of 3 daemon\(s\) failed to sync/,
    );
    expect(lines.some((line) => line.includes("skipped") && line.includes("a"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("timeout"))).toBe(true);
    expect(lines.some((line) => line.includes("synced") && line.includes("c"))).toBe(
      true,
    );
  });

  it("uses fallback copy when skip/fail omit error text", async () => {
    mockedSyncDev.mockResolvedValue(
      syncResponse([
        { daemonId: "local", ok: true, skipped: true },
        { daemonId: "remote", ok: false },
      ]),
    );
    const lines: string[] = [];
    await expect(syncDevBuildToDaemons((line) => lines.push(line))).rejects.toThrow(
      /failed to sync/,
    );
    expect(lines.some((line) => /co-located dev daemon/.test(line))).toBe(true);
    expect(lines.some((line) => /sync failed/.test(line))).toBe(true);
  });

  it("summarizes a successful remote sync", async () => {
    mockedSyncDev.mockResolvedValue(
      syncResponse([{ daemonId: "remote-1", ok: true }]),
    );
    const lines: string[] = [];
    await syncDevBuildToDaemons((line) => lines.push(line));
    expect(lines.at(-1)).toMatch(/Synced 1 daemon/);
  });

  it("explains when every connected daemon was skipped", async () => {
    mockedSyncDev.mockResolvedValue(
      syncResponse([{ daemonId: "local", ok: true, skipped: true, error: "co-located" }]),
    );
    const lines: string[] = [];
    await syncDevBuildToDaemons((line) => lines.push(line));
    expect(lines.at(-1)).toMatch(/No remote source checkouts to sync/);
  });

  it("treats missing results as empty", async () => {
    mockedSyncDev.mockResolvedValue({ ok: true });
    const lines: string[] = [];
    await syncDevBuildToDaemons((line) => lines.push(line));
    expect(lines.some((line) => /No attached daemons/.test(line))).toBe(true);
  });
});

describe("rebuildDaemonAndUpgradeConnectedServers", () => {
  it("fails fast when release:dev exits non-zero", async () => {
    mockedRunCaptured.mockResolvedValue(1);
    await expect(rebuildDaemonAndUpgradeConnectedServers()).rejects.toThrow(
      /Failed to package the local daemon overlay catalog/,
    );
    expect(mockedUpdateDaemons).not.toHaveBeenCalled();
  });

  it("runs deno task release:dev in the daemon checkout", async () => {
    mockedUpdateDaemons.mockResolvedValue(syncResponse([]));
    await rebuildDaemonAndUpgradeConnectedServers();
    expect(mockedEnsureDeno).toHaveBeenCalled();
    expect(mockedRunCaptured).toHaveBeenCalledWith(
      ["/opt/turbopanel/vendor/deno/current/deno", "task", "release:dev"],
      expect.any(Function),
      { cwd: daemonRepoPath(), env: testRunnerPathEnv() },
    );
  });

  it("wraps update API errors", async () => {
    mockedUpdateDaemons.mockRejectedValue(new Error("401"));
    await expect(rebuildDaemonAndUpgradeConnectedServers()).rejects.toThrow(
      /Could not reach the instance developer API: 401/,
    );

    mockedUpdateDaemons.mockRejectedValue(42);
    await expect(rebuildDaemonAndUpgradeConnectedServers()).rejects.toThrow(
      /Could not reach the instance developer API: 42/,
    );
  });

  it("reports an empty connected set", async () => {
    mockedUpdateDaemons.mockResolvedValue(syncResponse([]));
    const lines: string[] = [];
    await rebuildDaemonAndUpgradeConnectedServers((line) => lines.push(line));
    expect(lines.some((line) => /No attached daemons/.test(line))).toBe(true);
  });

  it("prints skipped / queued / failed rows and throws on failure", async () => {
    mockedUpdateDaemons.mockResolvedValue(
      syncResponse([
        { daemonId: "a", ok: true, skipped: true },
        { daemonId: "b", ok: false, error: "offline" },
        { daemonId: "c", ok: true },
      ]),
    );
    const lines: string[] = [];
    await expect(
      rebuildDaemonAndUpgradeConnectedServers((line) => lines.push(line)),
    ).rejects.toThrow(/1 of 3 daemon\(s\) failed to upgrade/);
    expect(lines.some((line) => /upgrade queued/.test(line))).toBe(true);
    expect(lines.some((line) => /offline/.test(line))).toBe(true);
  });

  it("uses fallback copy when skip/fail omit error text", async () => {
    mockedUpdateDaemons.mockResolvedValue(
      syncResponse([
        { daemonId: "local", ok: true, skipped: true },
        { daemonId: "remote", ok: false },
      ]),
    );
    const lines: string[] = [];
    await expect(
      rebuildDaemonAndUpgradeConnectedServers((line) => lines.push(line)),
    ).rejects.toThrow(/failed to upgrade/);
    expect(lines.some((line) => /co-located/.test(line))).toBe(true);
    expect(lines.some((line) => /update failed/.test(line))).toBe(true);
  });

  it("summarizes a successful remote upgrade", async () => {
    mockedUpdateDaemons.mockResolvedValue(
      syncResponse([{ daemonId: "remote-1", ok: true }]),
    );
    const lines: string[] = [];
    await rebuildDaemonAndUpgradeConnectedServers((line) => lines.push(line));
    expect(lines.at(-1)).toMatch(/Upgraded 1 remote daemon/);
  });

  it("explains when only the co-located daemon is present", async () => {
    mockedUpdateDaemons.mockResolvedValue(
      syncResponse([{ daemonId: "local", ok: true, skipped: true }]),
    );
    const lines: string[] = [];
    await rebuildDaemonAndUpgradeConnectedServers((line) => lines.push(line));
    expect(lines.at(-1)).toMatch(/No remote servers to upgrade/);
  });
});
