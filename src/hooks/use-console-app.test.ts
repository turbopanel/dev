import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevService } from "../dev-services.ts";
import type { OptionalDevServiceSelection } from "../lib/optional-dev-services.ts";
import { mountHook, type MountedHook } from "./ink-hook-render.ts";
import {
  initialAutoInstallState,
  initialDaemonOperation,
  useConsoleApp,
} from "./use-console-app.ts";

const harness = vi.hoisted(() => {
  const optional: OptionalDevServiceSelection = {
    dbstudio: false,
    smtp: true,
    ui: true,
    website: true,
    redisinsight: false,
    stripe: false,
  };
  return {
    services: [] as DevService[],
    convergeActive: false,
    optional,
    refreshServices: vi.fn(),
    startDevEnvConverge: vi.fn(),
    dismissError: vi.fn(),
    convergeOnFinished: undefined as ((success: boolean) => void) | undefined,
  };
});

vi.mock("../lib/dev-env-readiness.ts", () => ({
  resolveDevEnvStartupPlan: vi.fn(),
}));

vi.mock("../dev-services.ts", () => ({
  getVisibleServices: vi.fn(() => harness.services),
}));

vi.mock("./use-visible-services.ts", () => ({
  useVisibleServices: () => ({
    services: harness.services,
    refresh: harness.refreshServices,
  }),
}));

vi.mock("./use-dev-env-converge.ts", () => ({
  useDevEnvConverge: (onFinished: (success: boolean) => void) => {
    harness.convergeOnFinished = onFinished;
    return {
      state: {
        active: harness.convergeActive,
        tasks: [],
        recap: null,
        error: null,
        errorLogPath: null,
        servicePhases: {},
      },
      start: harness.startDevEnvConverge,
      dismissError: harness.dismissError,
    };
  },
}));

vi.mock("../lib/turbopanel-permissions.ts", () => ({
  refreshDevPermissionsQuietly: vi.fn(),
}));

vi.mock("../lib/service-actions.ts", () => ({
  canRunServiceAction: vi.fn(),
  runServiceAction: vi.fn(),
}));

vi.mock("../lib/service-restart.ts", () => ({
  consoleLogLine: (text: string) => ({ text, time: "t" }),
  watchServiceRestart: vi.fn(),
}));

vi.mock("../lib/daemon-env.ts", () => ({
  readInstanceRuntime: vi.fn(),
  isDeveloperSurfaceInstance: vi.fn(() => true),
}));

vi.mock("../lib/instance-trace-env.ts", () => ({
  readCellTraceEnabled: vi.fn(),
  setCellTraceEnabled: vi.fn(),
}));

vi.mock("../lib/daemon-log.ts", () => ({
  readDaemonLogFileStat: vi.fn(),
}));

vi.mock("../lib/instance-runtime.ts", () => ({
  watchInstanceRuntimeSwitch: vi.fn(),
}));

vi.mock("../lib/service-log.ts", () => ({
  readServiceLogFileStat: vi.fn(),
}));

vi.mock("../lib/optional-dev-services.ts", () => ({
  applyOptionalDevServices: vi.fn(),
  persistOptionalServiceToggle: vi.fn(),
  readOptionalDevServices: vi.fn(),
}));

vi.mock("../lib/duckdb-ui.ts", () => ({
  openDuckDbUi: vi.fn(),
}));

import { resolveDevEnvStartupPlan } from "../lib/dev-env-readiness.ts";
import { canRunServiceAction, runServiceAction } from "../lib/service-actions.ts";
import { watchServiceRestart } from "../lib/service-restart.ts";
import { readInstanceRuntime } from "../lib/daemon-env.ts";
import {
  readCellTraceEnabled,
  setCellTraceEnabled,
} from "../lib/instance-trace-env.ts";
import { readDaemonLogFileStat } from "../lib/daemon-log.ts";
import { watchInstanceRuntimeSwitch } from "../lib/instance-runtime.ts";
import { readServiceLogFileStat } from "../lib/service-log.ts";
import {
  applyOptionalDevServices,
  persistOptionalServiceToggle,
  readOptionalDevServices,
} from "../lib/optional-dev-services.ts";
import { refreshDevPermissionsQuietly } from "../lib/turbopanel-permissions.ts";
import { openDuckDbUi } from "../lib/duckdb-ui.ts";

function svc(
  id: string,
  status: DevService["status"] = "running",
): DevService {
  return { id, label: id, status };
}

describe("initialDaemonOperation", () => {
  it("returns install when auto-install is requested", () => {
    expect(initialDaemonOperation(true)).toBe("install");
  });

  it("returns null when the host is already idle", () => {
    expect(initialDaemonOperation(false)).toBeNull();
  });
});

describe("initialAutoInstallState", () => {
  beforeEach(() => {
    vi.mocked(resolveDevEnvStartupPlan).mockReset();
  });

  it("bootstraps on a fresh host", () => {
    vi.mocked(resolveDevEnvStartupPlan).mockReturnValue({
      action: "bootstrap",
      reasons: ["missing daemon checkout"],
    });
    expect(initialAutoInstallState()).toEqual({
      shouldAutoInstall: true,
      selectedServiceIndex: 0,
    });
  });

  it("stays idle when the startup plan does not bootstrap", () => {
    vi.mocked(resolveDevEnvStartupPlan).mockReturnValue({
      action: "idle",
      reasons: [],
    });
    expect(initialAutoInstallState()).toEqual({
      shouldAutoInstall: false,
      selectedServiceIndex: 0,
    });
  });
});

describe("useConsoleApp", () => {
  type Hook = ReturnType<typeof useConsoleApp>;
  let mounted: MountedHook<Hook> | undefined;

  beforeEach(() => {
    harness.services = [svc("instance"), svc("daemon"), svc("ui")];
    harness.convergeActive = false;
    harness.convergeOnFinished = undefined;
    harness.refreshServices.mockReset();
    harness.startDevEnvConverge.mockReset();
    harness.dismissError.mockReset();
    vi.mocked(resolveDevEnvStartupPlan).mockReset();
    vi.mocked(resolveDevEnvStartupPlan).mockReturnValue({
      action: "idle",
      reasons: [],
    });
    vi.mocked(canRunServiceAction).mockReset();
    vi.mocked(canRunServiceAction).mockReturnValue(true);
    vi.mocked(runServiceAction).mockReset();
    vi.mocked(runServiceAction).mockResolvedValue(undefined);
    vi.mocked(watchServiceRestart).mockReset();
    vi.mocked(watchServiceRestart).mockResolvedValue(true);
    vi.mocked(readInstanceRuntime).mockReset();
    vi.mocked(readInstanceRuntime).mockReturnValue("deno");
    vi.mocked(readCellTraceEnabled).mockReset();
    vi.mocked(readCellTraceEnabled).mockReturnValue(false);
    vi.mocked(setCellTraceEnabled).mockReset();
    vi.mocked(readDaemonLogFileStat).mockReset();
    vi.mocked(readDaemonLogFileStat).mockReturnValue({
      stdoutSize: 11,
      stdoutMtimeMs: 1,
      stderrSize: 22,
      stderrMtimeMs: 2,
    });
    vi.mocked(watchInstanceRuntimeSwitch).mockReset();
    vi.mocked(watchInstanceRuntimeSwitch).mockResolvedValue(undefined);
    vi.mocked(readServiceLogFileStat).mockReset();
    vi.mocked(readServiceLogFileStat).mockReturnValue({ stdout: 3, stderr: 4 });
    vi.mocked(applyOptionalDevServices).mockReset();
    vi.mocked(applyOptionalDevServices).mockResolvedValue(undefined);
    vi.mocked(persistOptionalServiceToggle).mockReset();
    vi.mocked(readOptionalDevServices).mockReset();
    vi.mocked(readOptionalDevServices).mockReturnValue(harness.optional);
    vi.mocked(refreshDevPermissionsQuietly).mockReset();
    vi.mocked(openDuckDbUi).mockReset();
    vi.mocked(openDuckDbUi).mockResolvedValue(undefined);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    vi.useRealTimers();
  });

  async function mountApp(): Promise<Hook> {
    mounted = mountHook(() => useConsoleApp());
    await mounted.flush();
    return mounted.get();
  }

  async function settle(): Promise<Hook> {
    if (!mounted) {
      throw new TypeError("console app is not mounted");
    }
    mounted.rerender();
    await mounted.flush();
    return mounted.get();
  }

  it("starts idle on the services area and switches with arrow keys", async () => {
    const app = await mountApp();
    expect(app.activeArea).toBe("services");
    expect(app.provisioning).toBe(false);
    expect(refreshDevPermissionsQuietly).toHaveBeenCalled();

    mounted?.stdin.write("\x1b[C");
    await mounted?.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mounted?.flush();
    expect(mounted?.get().activeArea).toBe("developer");

    mounted?.stdin.write("\x1b[D");
    await mounted?.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mounted?.flush();
    expect(mounted?.get().activeArea).toBe("services");
  });

  it("ignores arrow keys while a modal or operation is active", async () => {
    const app = await mountApp();
    await app.handleDaemonAction("optional-services");
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().pendingOptionalServices?.mode).toBe("manage");

    mounted?.stdin.write("\x1b[C");
    await mounted?.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await mounted?.flush();
    expect(mounted?.get().activeArea).toBe("services");
  });

  it("installs, purges, and opens developer views", async () => {
    const app = await mountApp();
    await app.handleDaemonAction("install");
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().daemonOperation).toBe("install");
    expect(mounted?.get().activeArea).toBe("bootstrap");
    expect(mounted?.get().selectedService?.id).toBe("daemon");

    await mounted?.get().handleDaemonAction("purge");
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().pendingDestructiveAction).toBe("purge");
    expect(mounted?.get().daemonOperation).toBe("install");

    mounted?.get().confirmDestructiveAction();
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().pendingDestructiveAction).toBeNull();
    expect(mounted?.get().daemonOperation).toBe("purge");
    expect(mounted?.get().activeArea).toBe("developer");

    await mounted?.get().handleDaemonAction("view-cell-trace");
    await mounted?.get().handleDaemonAction("run-tests");
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().developerView).toBe("run-tests");
    mounted?.get().closeDeveloperView();
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().developerView).toBe("menu");
  });

  it("opens converge and manage optional-service pickers", async () => {
    const app = await mountApp();
    await app.handleDaemonAction("start-dev-env");
    expect((await settle()).pendingOptionalServices).toEqual({
      mode: "converge",
      convergeMode: "force",
      selection: harness.optional,
    });

    (await settle()).cancelOptionalServices();
    expect((await settle()).pendingOptionalServices).toBeNull();

    await (await settle()).handleDaemonAction("optional-services");
    (await settle()).confirmOptionalServices(harness.optional);
    await vi.waitFor(() => {
      expect(applyOptionalDevServices).toHaveBeenCalledWith(harness.optional);
    });
    expect(harness.refreshServices).toHaveBeenCalled();
  });

  it("starts a force converge from the optional-services picker", async () => {
    const app = await mountApp();
    await app.handleDaemonAction("start-dev-env");
    (await settle()).confirmOptionalServices(harness.optional);
    const next = await settle();
    expect(harness.startDevEnvConverge).toHaveBeenCalledWith(
      "force",
      harness.optional,
    );
    expect(next.daemonOperation).toBe("dev-env");
    expect(next.selectedService?.id).toBe("daemon");
  });

  it("rejects start/reset when the daemon is missing or uninstalled", async () => {
    harness.services = [svc("instance")];
    const app = await mountApp();
    await expect(app.handleDaemonAction("start-dev-env")).rejects.toThrow(
      "Install the daemon before starting the development environment.",
    );

    harness.services = [svc("daemon", "uninstalled")];
    mounted?.rerender();
    await mounted?.flush();
    await expect(mounted?.get().handleDaemonAction("reset-dev-env")).rejects
      .toThrow("Install the daemon before resetting the development environment.");
    await expect(mounted?.get().handleDaemonAction("reset-dev-db")).rejects
      .toThrow("Install the daemon before resetting the dev database.");
  });

  it("starts bootstrap operations when the daemon is installed", async () => {
    const app = await mountApp();
    await app.handleDaemonAction("reset-dev-env");
    expect((await settle()).pendingDestructiveAction).toBe("reset-dev-env");
    (await settle()).confirmDestructiveAction();
    expect((await settle()).daemonOperation).toBe("reset-dev-env");
    await (await settle()).handleDaemonAction("reset-dev-db");
    expect((await settle()).pendingDestructiveAction).toBe("reset-dev-db");
    (await settle()).confirmDestructiveAction();
    expect((await settle()).daemonOperation).toBe("reset-dev-db");
    await (await settle()).handleDaemonAction("sync-dev-build");
    expect((await settle()).daemonOperation).toBe("sync-dev-build");
    await (await settle()).handleDaemonAction("rebuild-daemon-upgrade");
    expect((await settle()).daemonOperation).toBe("rebuild-daemon-upgrade");
    await (await settle()).handleDaemonAction("repair");
    expect((await settle()).daemonOperation).toBe("install");
    await (await settle()).handleDaemonAction("restart");
  });

  it("cancels a pending destructive action without running it", async () => {
    const app = await mountApp();
    await app.handleDaemonAction("reset-dev-db");
    expect((await settle()).pendingDestructiveAction).toBe("reset-dev-db");
    (await settle()).cancelDestructiveAction();
    const next = await settle();
    expect(next.pendingDestructiveAction).toBeNull();
    expect(next.daemonOperation).toBeNull();
  });

  it("toggles cell trace and restarts instance with an overlay", async () => {
    vi.mocked(watchServiceRestart).mockImplementation(
      async (_serviceId, _label, appendLog) => {
        appendLog({ text: "restarting", time: "t" });
        return true;
      },
    );
    const app = await mountApp();
    await app.handleDaemonAction("toggle-cell-trace");
    expect(setCellTraceEnabled).toHaveBeenCalledWith(true);
    expect(watchServiceRestart).toHaveBeenCalledWith(
      "instance",
      "instance",
      expect.any(Function),
    );
    expect(readServiceLogFileStat).toHaveBeenCalledWith("instance");
    expect(harness.refreshServices).toHaveBeenCalled();
  });

  it("confirms a daemon restart and records the log byte floor", async () => {
    const app = await mountApp();
    await app.handleServiceAction("daemon", "restart");
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().pendingRestart).toEqual({
      serviceId: "daemon",
      label: "daemon",
    });
    (await settle()).confirmServiceRestart();
    await vi.waitFor(() => {
      expect(watchServiceRestart).toHaveBeenCalled();
    });
    expect(readDaemonLogFileStat).toHaveBeenCalled();
    expect((await settle()).pendingRestart).toBeNull();
  });

  it("cancels a pending restart and no-ops confirm without one", async () => {
    const app = await mountApp();
    app.confirmServiceRestart();
    await app.handleServiceAction("instance", "restart");
    mounted?.get().cancelServiceRestart();
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().pendingRestart).toBeNull();
    await app.handleServiceAction("missing", "open");
    expect(runServiceAction).not.toHaveBeenCalled();
  });

  it("runs enable/disable, runtime switch, and skipped actions", async () => {
    const app = await mountApp();
    await app.handleServiceAction("ui", "enable");
    expect(persistOptionalServiceToggle).toHaveBeenCalledWith("ui", true);
    await app.handleServiceAction("ui", "disable");
    expect(persistOptionalServiceToggle).toHaveBeenCalledWith("ui", false);

    vi.mocked(canRunServiceAction).mockReturnValueOnce(false);
    await app.handleServiceAction("ui", "open");
    expect(runServiceAction).toHaveBeenCalledTimes(2);

    await app.handleServiceAction("instance", "switch-deno");
    expect(watchInstanceRuntimeSwitch).not.toHaveBeenCalled();

    await app.handleServiceAction("instance", "switch-workers");
    expect(watchInstanceRuntimeSwitch).toHaveBeenCalledWith(
      "workers",
      "deno",
      expect.any(Function),
    );

    vi.mocked(watchInstanceRuntimeSwitch).mockRejectedValueOnce(
      new Error("switch failed"),
    );
    await app.handleServiceAction("instance", "switch-workers");
    vi.mocked(watchInstanceRuntimeSwitch).mockRejectedValueOnce("nope");
    await app.handleServiceAction("instance", "switch-workers");
  });

  it("handles install finished polling and provisioning callbacks", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const app = await mountApp();
    app.handleInstallFinished(false);
    expect(harness.refreshServices).toHaveBeenCalledTimes(1);

    app.handleInstallFinished(true);
    await vi.advanceTimersByTimeAsync(500 * 6);
    expect(harness.refreshServices.mock.calls.length).toBeGreaterThanOrEqual(8);

    app.handleProvisioningDone();
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().provisioning).toBe(false);
    expect(mounted?.get().activeArea).toBe("services");

    app.handleDaemonInstallDone();
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().pendingOptionalServices?.convergeMode).toBe(
      "if-needed",
    );
  });

  it("applies converge finished callbacks and service test navigation", async () => {
    const app = await mountApp();
    if (typeof harness.convergeOnFinished !== "function") {
      throw new TypeError("converge finished callback was not registered");
    }
    harness.convergeOnFinished(true);
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().activeArea).toBe("services");
    expect(mounted?.get().provisioning).toBe(false);

    harness.convergeOnFinished(false);
    expect(harness.refreshServices).toHaveBeenCalled();

    app.openServiceTests("instance");
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().serviceTestsRepoId).toBe("turbopanel");
    app.openServiceTests("db");
    app.closeServiceTests();
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().serviceTestsRepoId).toBeNull();

    app.setSelectedServiceIndex(1);
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().selectedService?.id).toBe("daemon");
  });

  it("selects the first row of the first scan, not whatever mounted empty", async () => {
    // The status scan is async, so the first render sees an empty list. The
    // cursor must land on row 0 of the real list (instance), not fall back to
    // the daemon.
    harness.services = [];
    await mountApp();
    expect(mounted?.get().selectedService).toBeNull();

    harness.services = [svc("instance"), svc("daemon"), svc("ui")];
    await settle();
    expect(mounted?.get().selectedServiceIndex).toBe(0);
    expect(mounted?.get().selectedService?.id).toBe("instance");

    // And that choice is then preserved across a reordering refresh.
    harness.services = [svc("instance"), svc("daemon"), svc("caddy"), svc("ui")];
    await settle();
    expect(mounted?.get().selectedService?.id).toBe("instance");
  });

  it("clamps the selected service when the row disappears", async () => {
    const app = await mountApp();
    app.setSelectedServiceIndex(1);
    mounted?.rerender();
    await mounted?.flush();
    harness.services = [svc("caddy")];
    app.handleProvisioningDone();
    mounted?.rerender();
    await mounted?.flush();
    expect(mounted?.get().selectedServiceIndex).toBe(0);
    expect(mounted?.get().selectedService?.id).toBe("caddy");
  });

  it("no-ops optional confirm when nothing is pending", async () => {
    const app = await mountApp();
    app.confirmOptionalServices(harness.optional);
    expect(harness.startDevEnvConverge).not.toHaveBeenCalled();
    expect(applyOptionalDevServices).not.toHaveBeenCalled();
  });

  it("opens the DuckDB UI from the developer menu", async () => {
    const app = await mountApp();
    await app.handleDaemonAction("open-duckdb-ui");
    expect(openDuckDbUi).toHaveBeenCalled();
    expect((await settle()).activeArea).toBe("developer");
  });

  it("no-ops confirmDestructiveAction and restart when nothing is pending", async () => {
    const app = await mountApp();
    app.confirmDestructiveAction();
    await app.handleServiceAction("missing", "restart");
    expect((await settle()).pendingDestructiveAction).toBeNull();
    expect((await settle()).pendingRestart).toBeNull();
    expect(watchServiceRestart).not.toHaveBeenCalled();
  });

  it("skips a confirmed restart after the service row disappears", async () => {
    const app = await mountApp();
    await app.handleServiceAction("ui", "restart");
    expect((await settle()).pendingRestart?.serviceId).toBe("ui");
    harness.services = [svc("daemon")];
    mounted?.rerender();
    await mounted?.flush();
    (await settle()).confirmServiceRestart();
    await mounted?.flush();
    expect(watchServiceRestart).not.toHaveBeenCalled();
  });

  it("restarts instance without a visible instance row", async () => {
    harness.services = [svc("daemon")];
    const app = await mountApp();
    await app.handleDaemonAction("toggle-cell-trace");
    expect(watchServiceRestart).toHaveBeenCalledWith(
      "instance",
      "instance",
      expect.any(Function),
    );
  });
});
