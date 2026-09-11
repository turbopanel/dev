import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  DEFAULT_OPTIONAL_DEV_SERVICES,
  OPTIONAL_DEV_SERVICE_DEFS,
  applyOptionalDevServices,
  assertOptionalDevServiceId,
  defaultOptionalSelection,
  normalizeOptionalSelection,
  optionalDevServiceBackingContainers,
  optionalDevServiceCatalogIdsForRuntime,
  optionalServicesOrchestrationEnv,
  persistOptionalServiceToggle,
  readOptionalDevServices,
  writeOptionalDevServices,
} from "./optional-dev-services.ts";
import {
  MAILPIT_CONTAINER_NAME,
  REDIS_INSIGHT_BRIDGE_CONTAINER_NAME,
  REDIS_INSIGHT_CONTAINER_NAME,
} from "./platform-docker-resources.ts";

const tempDirs: string[] = [];

vi.mock("./install-output.ts", () => ({
  runCaptured: vi.fn(async () => 0),
}));

vi.mock("./spawn-trusted.ts", () => ({
  spawnSyncTrustedText: vi.fn(() => ({ status: 0, stdout: "loaded" })),
}));

vi.mock("./docker-access.ts", () => ({
  spawnDocker: vi.fn(() => ({ status: 0, stdout: "true" })),
}));

import { runCaptured } from "./install-output.ts";
import { spawnDocker } from "./docker-access.ts";
import { spawnSyncTrustedText } from "./spawn-trusted.ts";

const mockedRunCaptured = vi.mocked(runCaptured);
const mockedSpawnDocker = vi.mocked(spawnDocker);
const mockedSpawnSyncTrustedText = vi.mocked(spawnSyncTrustedText);

beforeEach(() => {
  mockedRunCaptured.mockClear();
  mockedSpawnDocker.mockClear();
  mockedSpawnSyncTrustedText.mockClear();
  mockedRunCaptured.mockResolvedValue(0);
  mockedSpawnDocker.mockReturnValue({
    status: 0,
    stdout: "true",
    stderr: "",
    pid: 0,
    output: ["", "true", ""],
    signal: null,
  });
  mockedSpawnSyncTrustedText.mockReturnValue({
    status: 0,
    stdout: "loaded",
    stderr: "",
    pid: 0,
    output: ["", "loaded", ""],
    signal: null,
  });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempPrefsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tp-optional-"));
  tempDirs.push(dir);
  return join(dir, "optional-services.json");
}

test("defaults enable ui, website, mailpit, and drizzle studio; redis insight and stripe off", () => {
  expect(DEFAULT_OPTIONAL_DEV_SERVICES).toEqual({
    dbstudio: true,
    smtp: true,
    ui: true,
    website: true,
    redisinsight: false,
    stripe: false,
  });
});

test("normalizeOptionalSelection fills missing keys from defaults", () => {
  expect(normalizeOptionalSelection({ ui: false, redisinsight: true })).toEqual({
    dbstudio: true,
    smtp: true,
    ui: false,
    website: true,
    redisinsight: true,
    stripe: false,
  });
});

test("normalizeOptionalSelection ignores invalid payloads", () => {
  expect(normalizeOptionalSelection(null)).toEqual(defaultOptionalSelection());
  expect(normalizeOptionalSelection("nope")).toEqual(defaultOptionalSelection());
  expect(normalizeOptionalSelection({ ui: "yes" })).toEqual(
    defaultOptionalSelection(),
  );
});

test("read/write round-trips preferences", () => {
  const path = tempPrefsPath();
  const selection = {
    ...defaultOptionalSelection(),
    website: false,
    redisinsight: true,
  };
  writeOptionalDevServices(selection, path);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(selection);
  expect(readOptionalDevServices(path)).toEqual(selection);
});

test("readOptionalDevServices returns defaults when file missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-optional-miss-"));
  tempDirs.push(dir);
  expect(readOptionalDevServices(join(dir, "missing.json"))).toEqual(
    defaultOptionalSelection(),
  );
});

test("optionalServicesOrchestrationEnv emits TURBOPANEL_OPTIONAL_* flags", () => {
  const env = optionalServicesOrchestrationEnv({
    dbstudio: true,
    smtp: false,
    ui: false,
    website: true,
    redisinsight: true,
    stripe: true,
  });
  expect(env).toEqual([
    "TURBOPANEL_OPTIONAL_DBSTUDIO=true",
    "TURBOPANEL_OPTIONAL_MAILPIT=false",
    "TURBOPANEL_OPTIONAL_UI=false",
    "TURBOPANEL_OPTIONAL_WEBSITE=true",
    "TURBOPANEL_OPTIONAL_REDIS_INSIGHT=true",
    "TURBOPANEL_OPTIONAL_STRIPE_LISTEN=true",
  ]);
});

test("assertOptionalDevServiceId rejects unknown ids", () => {
  expect(assertOptionalDevServiceId("ui")).toBe("ui");
  expect(assertOptionalDevServiceId("smtp")).toBe("smtp");
  expect(assertOptionalDevServiceId("stripe")).toBe("stripe");
  expect(() => assertOptionalDevServiceId("daemon")).toThrow(TypeError);
});

test("persistOptionalServiceToggle writes E/X into prefs", () => {
  const path = tempPrefsPath();
  expect(persistOptionalServiceToggle("dbstudio", false, path)).toEqual({
    ...defaultOptionalSelection(),
    dbstudio: false,
  });
  expect(readOptionalDevServices(path).dbstudio).toBe(false);
  expect(persistOptionalServiceToggle("smtp", false, path)?.smtp).toBe(false);
  expect(persistOptionalServiceToggle("daemon", true, path)).toBeNull();
});

test("optionalDevServiceCatalogIdsForRuntime omits Deno-only tools on Workers", () => {
  expect(optionalDevServiceCatalogIdsForRuntime("deno")).toContain(
    "redisinsight",
  );
  expect(optionalDevServiceCatalogIdsForRuntime("deno")).not.toContain(
    "stripe",
  );
  expect(optionalDevServiceCatalogIdsForRuntime("workers")).not.toContain(
    "redisinsight",
  );
  expect(optionalDevServiceCatalogIdsForRuntime("workers")).toContain("stripe");
});

test("applyOptionalDevServices stops docker-backed containers when unit is disabled", async () => {
  await applyOptionalDevServices({ ...defaultOptionalSelection(), smtp: false });

  const dockerCalls = mockedRunCaptured.mock.calls
    .map(([cmd]) => cmd)
    .filter((cmd): cmd is string[] => Array.isArray(cmd) && cmd.includes("docker"));

  expect(
    dockerCalls.some(
      (cmd) =>
        cmd.includes("update") &&
        cmd.includes("--restart=no") &&
        cmd.includes(MAILPIT_CONTAINER_NAME),
    ),
  ).toBe(true);
  expect(
    dockerCalls.some(
      (cmd) => cmd.includes("stop") && cmd.includes(MAILPIT_CONTAINER_NAME),
    ),
  ).toBe(true);
});

test("applyOptionalDevServices stops Redis Insight bridge when unit is disabled", async () => {
  await applyOptionalDevServices({
    ...defaultOptionalSelection(),
    redisinsight: false,
  });

  const dockerCalls = mockedRunCaptured.mock.calls
    .map(([cmd]) => cmd)
    .filter((cmd): cmd is string[] => Array.isArray(cmd) && cmd.includes("docker"));

  for (const container of [
    REDIS_INSIGHT_CONTAINER_NAME,
    REDIS_INSIGHT_BRIDGE_CONTAINER_NAME,
  ]) {
    expect(
      dockerCalls.some(
        (cmd) =>
          cmd.includes("update") &&
          cmd.includes("--restart=no") &&
          cmd.includes(container),
      ),
    ).toBe(true);
    expect(
      dockerCalls.some((cmd) => cmd.includes("stop") && cmd.includes(container)),
    ).toBe(true);
  }
});

test("optionalDevServiceBackingContainers returns empty when unset", () => {
  const ui = OPTIONAL_DEV_SERVICE_DEFS.find((def) => def.id === "ui");
  if (!ui) {
    throw new TypeError("expected ui optional service def");
  }
  expect(optionalDevServiceBackingContainers(ui)).toEqual([]);
  const smtp = OPTIONAL_DEV_SERVICE_DEFS.find((def) => def.id === "smtp");
  if (!smtp) {
    throw new TypeError("expected smtp optional service def");
  }
  expect(optionalDevServiceBackingContainers(smtp)).toEqual([
    MAILPIT_CONTAINER_NAME,
  ]);
});

test("applyOptionalDevServices treats a masked unit as installed", async () => {
  mockedSpawnSyncTrustedText.mockReturnValue({
    status: 0,
    stdout: "masked",
    stderr: "",
    pid: 0,
    output: ["", "masked", ""],
    signal: null,
  });
  await applyOptionalDevServices({ ...defaultOptionalSelection(), ui: true });
  expect(
    mockedRunCaptured.mock.calls.some(
      ([cmd]) =>
        Array.isArray(cmd) &&
        cmd.includes("systemctl") &&
        cmd.includes("enable") &&
        cmd.includes("turbopanel-ui"),
    ),
  ).toBe(true);
});

test("applyOptionalDevServices enables installed units with --now", async () => {
  const lines: string[] = [];
  await applyOptionalDevServices(
    { ...defaultOptionalSelection(), ui: true },
    (line) => lines.push(line),
  );
  expect(
    mockedRunCaptured.mock.calls.some(
      ([cmd]) =>
        Array.isArray(cmd) &&
        cmd.includes("systemctl") &&
        cmd.includes("enable") &&
        cmd.includes("turbopanel-ui"),
    ),
  ).toBe(true);
  expect(lines.some((line) => line.includes("Enabling optional service"))).toBe(
    true,
  );
});

test("applyOptionalDevServices reports missing unit-only services when wanted", async () => {
  mockedSpawnSyncTrustedText.mockReturnValue({
    status: 0,
    stdout: "not-found",
    stderr: "",
    pid: 0,
    output: ["", "not-found", ""],
    signal: null,
  });
  mockedSpawnDocker.mockReturnValue({
    status: 1,
    stdout: "",
    stderr: "",
    pid: 0,
    output: ["", "", ""],
    signal: null,
  });
  const lines: string[] = [];
  await applyOptionalDevServices(
    { ...defaultOptionalSelection(), ui: true, smtp: true },
    (line) => lines.push(line),
  );
  expect(
    lines.some((line) => line.includes("UI (Expo) is not installed yet")),
  ).toBe(true);
  expect(
    lines.some((line) => line.includes("Mailpit is not installed yet")),
  ).toBe(true);
});

test("applyOptionalDevServices throws when systemctl enable fails", async () => {
  mockedRunCaptured.mockResolvedValue(1);
  await expect(
    applyOptionalDevServices({
      dbstudio: true,
      smtp: true,
      ui: true,
      website: true,
      redisinsight: true,
      stripe: true,
    }),
  ).rejects.toThrow("systemctl enable --now turbopanel-dbstudio failed");
});

test("applyOptionalDevServices throws when docker start/stop both fail", async () => {
  mockedRunCaptured.mockImplementation(async (cmd) => {
    if (Array.isArray(cmd) && cmd.includes("docker")) {
      return 1;
    }
    return 0;
  });
  await expect(
    applyOptionalDevServices({ ...defaultOptionalSelection(), smtp: false }),
  ).rejects.toThrow(`docker update --restart=no ${MAILPIT_CONTAINER_NAME} failed`);
});

test("applyOptionalDevServices falls back to sudo docker when the first docker call fails", async () => {
  mockedRunCaptured.mockImplementation(async (cmd) => {
    if (!Array.isArray(cmd) || !cmd.includes("docker")) {
      return 0;
    }
    if (cmd[0] === "docker") {
      return 1;
    }
    return 0;
  });
  await applyOptionalDevServices({
    ...defaultOptionalSelection(),
    smtp: false,
  });
  const dockerCalls = mockedRunCaptured.mock.calls
    .map(([cmd]) => cmd)
    .filter((cmd): cmd is string[] => Array.isArray(cmd) && cmd.includes("docker"));
  expect(
    dockerCalls.some(
      (cmd) =>
        cmd[0] === "docker" &&
        cmd.includes("update") &&
        cmd.includes(MAILPIT_CONTAINER_NAME),
    ),
  ).toBe(true);
  expect(
    dockerCalls.some(
      (cmd) =>
        cmd[0] === "sudo" &&
        cmd.includes("docker") &&
        cmd.includes("update") &&
        cmd.includes(MAILPIT_CONTAINER_NAME),
    ),
  ).toBe(true);
});

test("applyOptionalDevServices treats a failed systemctl show as not installed", async () => {
  mockedSpawnSyncTrustedText.mockReturnValue({
    status: 1,
    stdout: "loaded",
    stderr: "",
    pid: 0,
    output: ["", "loaded", ""],
    signal: null,
  });
  const lines: string[] = [];
  await applyOptionalDevServices(
    { ...defaultOptionalSelection(), ui: true, smtp: false },
    (line) => lines.push(line),
  );
  expect(
    mockedRunCaptured.mock.calls.some(
      ([cmd]) => Array.isArray(cmd) && cmd.includes("systemctl"),
    ),
  ).toBe(false);
  expect(lines.some((line) => line.includes("UI (Expo) is not installed yet"))).toBe(
    true,
  );
});

test("applyOptionalDevServices treats blank systemctl output as not installed", async () => {
  mockedSpawnSyncTrustedText.mockReturnValue({
    status: 0,
    stdout: "   ",
    stderr: "",
    pid: 0,
    output: ["", "   ", ""],
    signal: null,
  });
  const lines: string[] = [];
  await applyOptionalDevServices(
    { ...defaultOptionalSelection(), ui: true },
    (line) => lines.push(line),
  );
  expect(lines.some((line) => line.includes("UI (Expo) is not installed yet"))).toBe(
    true,
  );
});

test("applyOptionalDevServices skips missing containers when starting or stopping", async () => {
  mockedSpawnSyncTrustedText.mockReturnValue({
    status: 0,
    stdout: "not-found",
    stderr: "",
    pid: 0,
    output: ["", "not-found", ""],
    signal: null,
  });
  mockedSpawnDocker.mockImplementation((_args) => {
    const name = String(_args[1] ?? "");
    if (name === REDIS_INSIGHT_CONTAINER_NAME) {
      return {
        status: 0,
        stdout: "true",
        stderr: "",
        pid: 0,
        output: ["", "true", ""],
        signal: null,
      };
    }
    return {
      status: 1,
      stdout: "",
      stderr: "",
      pid: 0,
      output: ["", "", ""],
      signal: null,
    };
  });

  await applyOptionalDevServices({
    ...defaultOptionalSelection(),
    redisinsight: true,
    smtp: false,
    ui: false,
    website: false,
    dbstudio: false,
  });
  let dockerCalls = mockedRunCaptured.mock.calls
    .map(([cmd]) => cmd)
    .filter((cmd): cmd is string[] => Array.isArray(cmd) && cmd.includes("docker"));
  expect(
    dockerCalls.some((cmd) => cmd.includes(REDIS_INSIGHT_CONTAINER_NAME)),
  ).toBe(true);
  expect(
    dockerCalls.some((cmd) => cmd.includes(REDIS_INSIGHT_BRIDGE_CONTAINER_NAME)),
  ).toBe(false);

  mockedRunCaptured.mockClear();
  await applyOptionalDevServices({
    ...defaultOptionalSelection(),
    redisinsight: false,
    smtp: false,
    ui: false,
    website: false,
    dbstudio: false,
  });
  dockerCalls = mockedRunCaptured.mock.calls
    .map(([cmd]) => cmd)
    .filter((cmd): cmd is string[] => Array.isArray(cmd) && cmd.includes("docker"));
  expect(
    dockerCalls.some(
      (cmd) =>
        cmd.includes("stop") && cmd.includes(REDIS_INSIGHT_CONTAINER_NAME),
    ),
  ).toBe(true);
  expect(
    dockerCalls.some((cmd) => cmd.includes(REDIS_INSIGHT_BRIDGE_CONTAINER_NAME)),
  ).toBe(false);
});

test("applyOptionalDevServices disables a unit-only service without docker", async () => {
  const lines: string[] = [];
  await applyOptionalDevServices(
    {
      dbstudio: true,
      smtp: true,
      ui: false,
      website: true,
      redisinsight: true,
      stripe: false,
    },
    (line) => lines.push(line),
  );
  expect(
    mockedRunCaptured.mock.calls.some(
      ([cmd]) =>
        Array.isArray(cmd) &&
        cmd.includes("systemctl") &&
        cmd.includes("disable") &&
        cmd.includes("turbopanel-ui"),
    ),
  ).toBe(true);
  expect(
    mockedRunCaptured.mock.calls.some(
      ([cmd]) => Array.isArray(cmd) && cmd.includes("docker"),
    ),
  ).toBe(false);
  expect(lines.some((line) => line.includes("Disabling optional service"))).toBe(
    true,
  );
});

test("applyOptionalDevServices treats missing systemctl stdout as not installed", async () => {
  mockedSpawnSyncTrustedText.mockReturnValue({
    status: 0,
    stdout: undefined as unknown as string,
    stderr: "",
    pid: 0,
    output: ["", "", ""],
    signal: null,
  });
  const lines: string[] = [];
  await applyOptionalDevServices(
    { ...defaultOptionalSelection(), ui: true },
    (line) => lines.push(line),
  );
  expect(lines.some((line) => line.includes("UI (Expo) is not installed yet"))).toBe(
    true,
  );
});

test("stripe is a unit-only optional service with the stripe_listen ansible stem", () => {
  const stripe = OPTIONAL_DEV_SERVICE_DEFS.find((def) => def.id === "stripe");
  if (!stripe) {
    throw new TypeError("expected stripe optional service def");
  }
  expect(stripe.unit).toBe("turbopanel-stripe-listen");
  expect(stripe.ansibleStem).toBe("stripe_listen");
  expect(optionalDevServiceBackingContainers(stripe)).toEqual([]);
  expect(optionalDevServiceCatalogIdsForRuntime("deno")).not.toContain("stripe");
  expect(optionalDevServiceCatalogIdsForRuntime("workers")).toContain("stripe");
});

test("applyOptionalDevServices reports a missing stripe unit when wanted", async () => {
  mockedSpawnSyncTrustedText.mockReturnValue({
    status: 0,
    stdout: "not-found",
    stderr: "",
    pid: 0,
    output: ["", "not-found", ""],
    signal: null,
  });
  const lines: string[] = [];
  await applyOptionalDevServices(
    { ...defaultOptionalSelection(), stripe: true },
    (line) => lines.push(line),
  );
  expect(
    lines.some((line) => line.includes("Stripe CLI (webhook forward) is not installed yet")),
  ).toBe(true);
});

test("applyOptionalDevServices starts container-only services when unit is missing", async () => {
  mockedSpawnSyncTrustedText.mockReturnValue({
    status: 0,
    stdout: "not-found",
    stderr: "",
    pid: 0,
    output: ["", "not-found", ""],
    signal: null,
  });
  mockedSpawnDocker.mockReturnValue({
    status: 0,
    stdout: "true",
    stderr: "",
    pid: 0,
    output: ["", "true", ""],
    signal: null,
  });
  await applyOptionalDevServices({
    ...defaultOptionalSelection(),
    smtp: true,
    ui: false,
    website: false,
  });
  const dockerCalls = mockedRunCaptured.mock.calls
    .map(([cmd]) => cmd)
    .filter((cmd): cmd is string[] => Array.isArray(cmd) && cmd.includes("docker"));
  expect(
    dockerCalls.some(
      (cmd) =>
        cmd.includes("update") &&
        cmd.includes("--restart=unless-stopped") &&
        cmd.includes(MAILPIT_CONTAINER_NAME),
    ),
  ).toBe(true);
  expect(
    dockerCalls.some(
      (cmd) => cmd.includes("start") && cmd.includes(MAILPIT_CONTAINER_NAME),
    ),
  ).toBe(true);
});