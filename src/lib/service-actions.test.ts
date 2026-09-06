import { afterEach, describe, expect, test, vi } from "vitest";

const spawnHarness = vi.hoisted(() => ({
  spawnSyncTrustedText: vi.fn(),
  spawnDocker: vi.fn(),
  runCaptured: vi.fn(),
  openServiceInBrowser: vi.fn(),
  switchInstanceRuntime: vi.fn(),
}));

vi.mock("./spawn-trusted.ts", () => ({
  spawnSyncTrustedText: spawnHarness.spawnSyncTrustedText,
  spawnSyncTrusted: vi.fn(),
}));

vi.mock("./docker-access.ts", () => ({
  spawnDocker: spawnHarness.spawnDocker,
}));

vi.mock("./install-output.ts", () => ({
  runCaptured: spawnHarness.runCaptured,
}));

vi.mock("./service-open.ts", () => ({
  openServiceInBrowser: spawnHarness.openServiceInBrowser,
}));

vi.mock("./instance-runtime.ts", () => ({
  switchInstanceRuntime: spawnHarness.switchInstanceRuntime,
}));

import {
  canRunServiceAction,
  isManagedService,
  runServiceAction,
  serviceActionForKey,
  serviceListSpecialAction,
} from "./service-actions.ts";
import { DAEMON_SYSTEMD_UNIT } from "./paths.ts";
import {
  MAILPIT_CONTAINER_NAME,
  POSTGRES_CONTAINER_NAME,
  RABBITMQ_CONTAINER_NAME,
} from "./platform-docker-resources.ts";

function textResult(
  status: number,
  stdout = "",
): { status: number; stdout: string; stderr: string } {
  return { status, stdout, stderr: "" };
}

function installUnits(loadStates: Record<string, string>): void {
  spawnHarness.spawnSyncTrustedText.mockImplementation((_cmd, args: string[]) => {
    const unit = args[1] ?? "";
    const state = loadStates[unit];
    if (state === undefined) {
      return textResult(1);
    }
    return textResult(0, `${state}\n`);
  });
}

function inspectOk(container: string): void {
  spawnHarness.spawnDocker.mockImplementation((args: string[]) => {
    if (args[0] === "inspect" && args[1] === container) {
      return { status: 0 };
    }
    return { status: 1 };
  });
}

afterEach(() => {
  spawnHarness.spawnSyncTrustedText.mockReset();
  spawnHarness.spawnDocker.mockReset();
  spawnHarness.runCaptured.mockReset();
  spawnHarness.openServiceInBrowser.mockReset();
  spawnHarness.switchInstanceRuntime.mockReset();
  spawnHarness.spawnSyncTrustedText.mockReturnValue(textResult(1));
  spawnHarness.spawnDocker.mockReturnValue({ status: 1 });
  spawnHarness.runCaptured.mockResolvedValue(0);
  spawnHarness.openServiceInBrowser.mockResolvedValue(undefined);
  spawnHarness.switchInstanceRuntime.mockResolvedValue(undefined);
});

describe("isManagedService", () => {
  test("accepts catalog services and rejects unknown ids", () => {
    expect(isManagedService("daemon")).toBe(true);
    expect(isManagedService("queue")).toBe(true);
    expect(isManagedService("unknown")).toBe(false);
  });
});

describe("serviceListSpecialAction", () => {
  test("maps L to logs on every service", () => {
    expect(serviceListSpecialAction("daemon", "L")).toBe("logs");
    expect(serviceListSpecialAction("db", "l")).toBe("logs");
  });

  test("maps T to tests only on source services", () => {
    expect(serviceListSpecialAction("daemon", "t")).toBe("tests");
    expect(serviceListSpecialAction("instance", "T")).toBe("tests");
    expect(serviceListSpecialAction("caddy", "t")).toBe("tests");
    expect(serviceListSpecialAction("ui", "t")).toBe("tests");
    expect(serviceListSpecialAction("website", "t")).toBe("tests");
    expect(serviceListSpecialAction("db", "t")).toBeNull();
    expect(serviceListSpecialAction("smtp", "t")).toBeNull();
  });

  test("maps U to rebuild remotes only on the daemon", () => {
    expect(serviceListSpecialAction("daemon", "u")).toBe("rebuild-remotes");
    expect(serviceListSpecialAction("instance", "u")).toBeNull();
    expect(serviceListSpecialAction("daemon", "z")).toBeNull();
  });
});

describe("serviceActionForKey", () => {
  test("returns null for unmanaged services", () => {
    expect(serviceActionForKey("unknown", "r", "deno")).toBeNull();
  });

  test("maps lifecycle and open keys", () => {
    expect(serviceActionForKey("daemon", "R", "deno")).toBe("restart");
    expect(serviceActionForKey("daemon", "x", "deno")).toBe("disable");
    expect(serviceActionForKey("daemon", "E", "deno")).toBe("enable");
    expect(serviceActionForKey("ui", "o", "deno")).toBe("open");
    expect(serviceActionForKey("daemon", "o", "deno")).toBeNull();
    expect(serviceActionForKey("daemon", "z", "deno")).toBeNull();
  });

  test("maps instance runtime switches only for the opposite runtime", () => {
    expect(serviceActionForKey("instance", "w", "deno")).toBe("switch-workers");
    expect(serviceActionForKey("instance", "w", "workers")).toBeNull();
    expect(serviceActionForKey("instance", "d", "workers")).toBe("switch-deno");
    expect(serviceActionForKey("instance", "d", "deno")).toBeNull();
    expect(serviceActionForKey("ui", "w", "deno")).toBeNull();
  });
});

describe("canRunServiceAction", () => {
  test("gates runtime switches on the instance and current runtime", () => {
    expect(canRunServiceAction("instance", "switch-workers", "running", "deno"))
      .toBe(true);
    expect(canRunServiceAction("ui", "switch-workers", "running", "deno")).toBe(
      false,
    );
    expect(canRunServiceAction("instance", "switch-deno", "running", "workers"))
      .toBe(true);
    expect(canRunServiceAction("instance", "switch-deno", "running", "deno"))
      .toBe(false);
  });

  test("open requires a browser URL plus an installed start target", () => {
    installUnits({ "turbopanel-caddy": "loaded" });
    expect(canRunServiceAction("ui", "open", "stopped", "deno")).toBe(true);
    expect(canRunServiceAction("daemon", "open", "running", "deno")).toBe(false);

    installUnits({});
    expect(canRunServiceAction("ui", "open", "running", "deno")).toBe(false);

    inspectOk(RABBITMQ_CONTAINER_NAME);
    expect(canRunServiceAction("queue", "open", "stopped", "deno")).toBe(true);
  });

  test("treats a masked unit as installed and empty show output as missing", () => {
    installUnits({ "turbopanel-instance": "masked" });
    expect(canRunServiceAction("instance", "restart", "running", "deno")).toBe(
      true,
    );

    spawnHarness.spawnSyncTrustedText.mockReturnValue(textResult(0, "   "));
    expect(canRunServiceAction("instance", "restart", "running", "deno")).toBe(
      false,
    );
  });

  test("blocks restart on uninstalled rows and enable/disable on current state", () => {
    installUnits({ [DAEMON_SYSTEMD_UNIT]: "loaded" });
    expect(canRunServiceAction("daemon", "restart", "uninstalled", "deno")).toBe(
      false,
    );
    expect(canRunServiceAction("daemon", "enable", "uninstalled", "deno")).toBe(
      true,
    );
    expect(canRunServiceAction("daemon", "enable", "running", "deno")).toBe(
      false,
    );
    expect(canRunServiceAction("daemon", "disable", "stopped", "deno")).toBe(
      false,
    );
    expect(canRunServiceAction("daemon", "disable", "running", "deno")).toBe(
      true,
    );
  });

  test("rejects unmanaged ids and docker-only rows without a container", () => {
    expect(canRunServiceAction("unknown", "restart", "running", "deno")).toBe(
      false,
    );
    spawnHarness.spawnDocker.mockReturnValue(null);
    expect(canRunServiceAction("db", "restart", "stopped", "deno")).toBe(false);

    inspectOk(POSTGRES_CONTAINER_NAME);
    expect(canRunServiceAction("db", "restart", "stopped", "deno")).toBe(true);
  });
});

describe("runServiceAction", () => {
  test("starts the open unit then hands off to the browser helper", async () => {
    installUnits({ "turbopanel-caddy": "loaded" });
    spawnHarness.openServiceInBrowser.mockImplementation(
      async (_serviceId, startUnit: () => Promise<void>) => {
        await startUnit();
      },
    );

    await runServiceAction("ui", "open");
    expect(spawnHarness.runCaptured).toHaveBeenCalledWith(
      ["sudo", "-n", "systemctl", "start", "turbopanel-caddy"],
      undefined,
    );
  });

  test("throws when the open start unit is not installed", async () => {
    installUnits({});
    spawnHarness.openServiceInBrowser.mockImplementation(
      async (_serviceId, startUnit: () => Promise<void>) => {
        await startUnit();
      },
    );

    await expect(runServiceAction("smtp", "open")).rejects.toThrow(
      "turbopanel-mailpit is not installed",
    );
  });

  test("starts a configured open container and falls back to docker inspect", async () => {
    spawnHarness.openServiceInBrowser.mockImplementation(
      async (_serviceId, startUnit: () => Promise<void>) => {
        await startUnit();
      },
    );

    await runServiceAction("queue", "open");
    expect(spawnHarness.runCaptured).toHaveBeenCalledWith(
      ["docker", "start", RABBITMQ_CONTAINER_NAME],
      undefined,
    );

    spawnHarness.runCaptured.mockClear();
    inspectOk(POSTGRES_CONTAINER_NAME);
    await runServiceAction("db", "open");
    expect(spawnHarness.runCaptured).toHaveBeenCalledWith(
      ["docker", "start", POSTGRES_CONTAINER_NAME],
      undefined,
    );
  });

  test("throws when open has no start unit or container", async () => {
    spawnHarness.spawnDocker.mockReturnValue(null);
    spawnHarness.openServiceInBrowser.mockImplementation(
      async (_serviceId, startUnit: () => Promise<void>) => {
        await startUnit();
      },
    );

    await expect(runServiceAction("cache", "open")).rejects.toThrow(
      "No start unit configured for cache",
    );
  });

  test("switches instance runtime through the dynamic import", async () => {
    const onOutput = vi.fn();
    await runServiceAction("instance", "switch-workers", onOutput);
    expect(spawnHarness.switchInstanceRuntime).toHaveBeenCalledWith(
      "workers",
      onOutput,
    );

    await runServiceAction("instance", "switch-deno", onOutput);
    expect(spawnHarness.switchInstanceRuntime).toHaveBeenCalledWith(
      "deno",
      onOutput,
    );
  });

  test("runs systemd restart, disable, and enable when the unit is loaded", async () => {
    installUnits({ [DAEMON_SYSTEMD_UNIT]: "loaded" });

    await runServiceAction("daemon", "restart");
    expect(spawnHarness.runCaptured).toHaveBeenCalledWith(
      ["sudo", "-n", "systemctl", "restart", "--no-block", DAEMON_SYSTEMD_UNIT],
      undefined,
    );

    await runServiceAction("daemon", "disable");
    expect(spawnHarness.runCaptured).toHaveBeenCalledWith(
      ["sudo", "-n", "systemctl", "disable", "--now", DAEMON_SYSTEMD_UNIT],
      undefined,
    );

    await runServiceAction("daemon", "enable");
    expect(spawnHarness.runCaptured).toHaveBeenCalledWith(
      ["sudo", "-n", "systemctl", "enable", "--now", DAEMON_SYSTEMD_UNIT],
      undefined,
    );
  });

  test("throws when systemctl returns a non-zero status", async () => {
    installUnits({ [DAEMON_SYSTEMD_UNIT]: "loaded" });
    spawnHarness.runCaptured.mockResolvedValue(1);
    await expect(runServiceAction("daemon", "restart")).rejects.toThrow(
      `systemctl restart --no-block ${DAEMON_SYSTEMD_UNIT} failed`,
    );
  });

  test("uses docker lifecycle when no systemd unit is present", async () => {
    installUnits({});
    inspectOk(POSTGRES_CONTAINER_NAME);

    await runServiceAction("db", "restart");
    expect(spawnHarness.runCaptured).toHaveBeenCalledWith(
      ["docker", "restart", POSTGRES_CONTAINER_NAME],
      undefined,
    );

    spawnHarness.runCaptured.mockClear();
    await runServiceAction("db", "disable");
    expect(spawnHarness.runCaptured).toHaveBeenNthCalledWith(
      1,
      ["docker", "update", "--restart=no", POSTGRES_CONTAINER_NAME],
      undefined,
    );
    expect(spawnHarness.runCaptured).toHaveBeenNthCalledWith(
      2,
      ["docker", "stop", POSTGRES_CONTAINER_NAME],
      undefined,
    );

    spawnHarness.runCaptured.mockClear();
    await runServiceAction("db", "enable");
    expect(spawnHarness.runCaptured).toHaveBeenNthCalledWith(
      1,
      ["docker", "update", "--restart=unless-stopped", POSTGRES_CONTAINER_NAME],
      undefined,
    );
    expect(spawnHarness.runCaptured).toHaveBeenNthCalledWith(
      2,
      ["docker", "start", POSTGRES_CONTAINER_NAME],
      undefined,
    );
  });

  test("retries docker through sudo and throws when both attempts fail", async () => {
    installUnits({});
    inspectOk(MAILPIT_CONTAINER_NAME);
    spawnHarness.runCaptured
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    await runServiceAction("smtp", "restart");
    expect(spawnHarness.runCaptured).toHaveBeenNthCalledWith(
      1,
      ["docker", "restart", MAILPIT_CONTAINER_NAME],
      undefined,
    );
    expect(spawnHarness.runCaptured).toHaveBeenNthCalledWith(
      2,
      ["sudo", "-n", "docker", "restart", MAILPIT_CONTAINER_NAME],
      undefined,
    );

    spawnHarness.runCaptured.mockResolvedValue(1);
    await expect(runServiceAction("smtp", "restart")).rejects.toThrow(
      `docker restart ${MAILPIT_CONTAINER_NAME} failed`,
    );
  });

  test("throws when neither a unit nor a container can be resolved", async () => {
    installUnits({});
    spawnHarness.spawnDocker.mockReturnValue(null);
    await expect(runServiceAction("cache", "restart")).rejects.toThrow(
      "No systemd unit or Docker container found for cache",
    );
  });
});
