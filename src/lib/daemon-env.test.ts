import { expect, test, vi } from "vitest";
import { mergeEnvFile, readEnvFile, readEnvFileAsync } from "./env-file.ts";
import {
  buildDaemonBaseEnvEntries,
  isDeveloperSurfaceInstance,
  isDevInstanceEnabled,
  readDaemonEnvSnapshotAsync,
  readInstanceRunMode,
  readInstanceRuntime,
  readInstanceUiMode,
  writeDaemonBaseEnv,
  writeDaemonInstanceEnv,
} from "./daemon-env.ts";
import { daemonRepoPath, platformCaCertPath } from "./paths.ts";

vi.mock("./env-file.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./env-file.ts")>();
  return {
    ...actual,
    mergeEnvFile: vi.fn(),
    readEnvFile: vi.fn(() => ""),
    readEnvFileAsync: vi.fn(async () => ""),
  };
});

test("managed daemon.env must not place TURBOPANEL_DAEMON_STATE_DIR under the daemon checkout", () => {
  const entries = buildDaemonBaseEnvEntries();
  const daemonRepo = daemonRepoPath();
  const stateDir = entries.TURBOPANEL_DAEMON_STATE_DIR;

  expect(
    stateDir === undefined ||
      (!stateDir.startsWith(`${daemonRepo}/`) && stateDir !== daemonRepo),
    `TURBOPANEL_DAEMON_STATE_DIR must not live under the daemon checkout (got ${stateDir})`,
  ).toBe(true);
});

test("isDeveloperSurfaceInstance is true only for source-run-mode dev-UI Deno instances", () => {
  const mockedReadEnvFile = vi.mocked(readEnvFile);

  // Converge defaults (deno / source / dev UI) run src/deno-dev.ts.
  mockedReadEnvFile.mockReturnValue("");
  expect(isDeveloperSurfaceInstance()).toBe(true);

  mockedReadEnvFile.mockReturnValue("TURBOPANEL_INSTANCE_RUNTIME=workers\n");
  expect(isDeveloperSurfaceInstance()).toBe(false);

  // Compiled binaries are built from src/deno.ts (deno task compile).
  mockedReadEnvFile.mockReturnValue("TURBOPANEL_INSTANCE_RUN_MODE=compiled\n");
  expect(isDeveloperSurfaceInstance()).toBe(false);

  // Static UI mode drops TURBOPANEL_DEV_SURFACE and runs src/deno.ts.
  mockedReadEnvFile.mockReturnValue("TURBOPANEL_UI_MODE=static\n");
  expect(isDeveloperSurfaceInstance()).toBe(false);

  mockedReadEnvFile.mockReturnValue("");
});

test("writeDaemonInstanceEnv workers mode points TURBOPANEL_INSTANCE_CA at the durable CA bundle", () => {
  writeDaemonInstanceEnv({ TURBOPANEL_INSTANCE_RUNTIME: "workers" });
  expect(platformCaCertPath()).toBe("/var/lib/turbopanel/tls/ca-bundle.pem");
  expect(vi.mocked(mergeEnvFile)).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      TURBOPANEL_INSTANCE_CA: platformCaCertPath(),
    }),
    expect.objectContaining({ removeKeys: expect.any(Array) }),
  );
});

test("writeDaemonBaseEnv writes identity keys and strips the instance opt-in", () => {
  writeDaemonBaseEnv({ EXTRA: "1" });
  expect(vi.mocked(mergeEnvFile)).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      TURBOPANEL_MODE: "development",
      EXTRA: "1",
    }),
    expect.objectContaining({
      removeKeys: ["TURBOPANEL_DEV_INSTANCE"],
    }),
  );
});

test("writeDaemonInstanceEnv deno extra removes workers URL keys", () => {
  writeDaemonInstanceEnv({ TURBOPANEL_INSTANCE_RUNTIME: "deno" });
  const call = vi.mocked(mergeEnvFile).mock.calls.at(-1);
  if (call === undefined) {
    throw new TypeError("expected mergeEnvFile call");
  }
  expect(call[1]).not.toHaveProperty("TURBOPANEL_INSTANCE_URL");
  expect(call[2]).toEqual({
    removeKeys: ["TURBOPANEL_INSTANCE_URL", "TURBOPANEL_INSTANCE_CA"],
  });
});

test("writeDaemonInstanceEnv without a runtime extra uses the existing daemon.env runtime", () => {
  vi.mocked(readEnvFile).mockReturnValue("TURBOPANEL_INSTANCE_RUNTIME=workers\n");
  writeDaemonInstanceEnv();
  expect(vi.mocked(mergeEnvFile)).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      TURBOPANEL_INSTANCE_CA: platformCaCertPath(),
    }),
    expect.any(Object),
  );
});

test("isDevInstanceEnabled is true only when TURBOPANEL_DEV_INSTANCE=1", () => {
  const mockedReadEnvFile = vi.mocked(readEnvFile);
  mockedReadEnvFile.mockReturnValue("TURBOPANEL_DEV_INSTANCE=1\n");
  expect(isDevInstanceEnabled()).toBe(true);
  mockedReadEnvFile.mockReturnValue("TURBOPANEL_DEV_INSTANCE=0\n");
  expect(isDevInstanceEnabled()).toBe(false);
  mockedReadEnvFile.mockReturnValue("");
  expect(isDevInstanceEnabled()).toBe(false);
});

test("readInstanceRuntime is workers only when the env value is workers", () => {
  const mockedReadEnvFile = vi.mocked(readEnvFile);
  mockedReadEnvFile.mockReturnValue("TURBOPANEL_INSTANCE_RUNTIME=workers\n");
  expect(readInstanceRuntime()).toBe("workers");
  mockedReadEnvFile.mockReturnValue("TURBOPANEL_INSTANCE_RUNTIME=deno\n");
  expect(readInstanceRuntime()).toBe("deno");
  mockedReadEnvFile.mockReturnValue("");
  expect(readInstanceRuntime()).toBe("deno");
});

test("readInstanceUiMode is static only when TURBOPANEL_UI_MODE=static", () => {
  const mockedReadEnvFile = vi.mocked(readEnvFile);
  mockedReadEnvFile.mockReturnValue("TURBOPANEL_UI_MODE=static\n");
  expect(readInstanceUiMode()).toBe("static");
  mockedReadEnvFile.mockReturnValue("TURBOPANEL_UI_MODE=dev\n");
  expect(readInstanceUiMode()).toBe("dev");
  mockedReadEnvFile.mockReturnValue("");
  expect(readInstanceUiMode()).toBe("dev");
});

test("readInstanceRunMode is compiled only when TURBOPANEL_INSTANCE_RUN_MODE=compiled", () => {
  const mockedReadEnvFile = vi.mocked(readEnvFile);
  mockedReadEnvFile.mockReturnValue("TURBOPANEL_INSTANCE_RUN_MODE=compiled\n");
  expect(readInstanceRunMode()).toBe("compiled");
  mockedReadEnvFile.mockReturnValue("TURBOPANEL_INSTANCE_RUN_MODE=source\n");
  expect(readInstanceRunMode()).toBe("source");
  mockedReadEnvFile.mockReturnValue("");
  expect(readInstanceRunMode()).toBe("source");
});

test("readDaemonEnvSnapshotAsync parses the same flags as the sync snapshot", async () => {
  vi.mocked(readEnvFileAsync).mockResolvedValue(
    [
      "TURBOPANEL_INSTANCE_RUNTIME=workers",
      "TURBOPANEL_UI_MODE=static",
      "TURBOPANEL_INSTANCE_RUN_MODE=compiled",
      "TURBOPANEL_DEV_INSTANCE=1",
    ].join("\n"),
  );

  await expect(readDaemonEnvSnapshotAsync()).resolves.toEqual({
    runtime: "workers",
    uiMode: "static",
    runMode: "compiled",
    devInstanceEnabled: true,
  });

  vi.mocked(readEnvFileAsync).mockResolvedValue("");
  await expect(readDaemonEnvSnapshotAsync()).resolves.toEqual({
    runtime: "deno",
    uiMode: "dev",
    runMode: "source",
    devInstanceEnabled: false,
  });
});
