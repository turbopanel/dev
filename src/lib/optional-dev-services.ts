import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type InstallOutputHandler, runCaptured } from "./install-output.ts";
import { CONSOLE_LOG_DIR } from "./paths.ts";
import { spawnDocker } from "./docker-access.ts";
import {
  MAILPIT_CONTAINER_NAME,
  REDIS_INSIGHT_BRIDGE_CONTAINER_NAME,
  REDIS_INSIGHT_CONTAINER_NAME,
} from "./platform-docker-resources.ts";
import { spawnSyncTrustedText } from "./spawn-trusted.ts";

/** Optional co-located tooling — not required for core control-plane work. */
export const OPTIONAL_DEV_SERVICE_IDS = [
  "dbstudio",
  "smtp",
  "ui",
  "website",
  "redisinsight",
  "stripe",
] as const;

export type OptionalDevServiceId = (typeof OPTIONAL_DEV_SERVICE_IDS)[number];

export type OptionalDevServiceSelection = Record<OptionalDevServiceId, boolean>;

export type OptionalDevServiceDef = {
  id: OptionalDevServiceId;
  /** Short row label in the picker. */
  label: string;
  /** One-line hint under the label. */
  hint: string;
  /** Ansible / env extra-var stem (`turbopanel_optional_<stem>`). */
  ansibleStem: string;
  /** systemd unit when present. */
  unit: string;
  /** Docker container names when the service is container-backed. */
  containers?: readonly string[];
};

/** Optional services that only apply to the Deno self-hosted dev stack. */
export const OPTIONAL_DENO_ONLY_SERVICE_IDS = [
  "redisinsight",
  // The Workers instance reads its secrets from `.dev.vars`, not from the
  // stripe.env file the instance unit loads, so the forwarder is Deno-only.
  "stripe",
] as const satisfies readonly OptionalDevServiceId[];

export const OPTIONAL_DEV_SERVICE_DEFS: readonly OptionalDevServiceDef[] = [
  {
    id: "dbstudio",
    label: "Drizzle Studio",
    hint: "DB browser on :4983 (loopback)",
    ansibleStem: "dbstudio",
    unit: "turbopanel-dbstudio",
  },
  {
    id: "smtp",
    label: "Mailpit",
    hint: "SMTP catcher on :8025 (loopback)",
    ansibleStem: "mailpit",
    unit: "turbopanel-mailpit",
    containers: [MAILPIT_CONTAINER_NAME],
  },
  {
    id: "ui",
    label: "UI (Expo)",
    hint: "Web console via Caddy; skip if testing native elsewhere",
    ansibleStem: "ui",
    unit: "turbopanel-ui",
  },
  {
    id: "website",
    label: "Website",
    hint: "Marketing + docs on :19820",
    ansibleStem: "website",
    unit: "turbopanel-website",
  },
  {
    id: "redisinsight",
    label: "Redis Insight",
    hint: "Cache GUI on :5540",
    ansibleStem: "redis_insight",
    unit: "turbopanel-redis-insight",
    containers: [
      REDIS_INSIGHT_CONTAINER_NAME,
      REDIS_INSIGHT_BRIDGE_CONTAINER_NAME,
    ],
  },
  {
    id: "stripe",
    label: "Stripe CLI (webhook forward)",
    hint: "Forwards Stripe events to /webhook/stripe; needs a test key",
    ansibleStem: "stripe_listen",
    unit: "turbopanel-stripe-listen",
  },
] as const;

/**
 * Defaults: UI, website, Mailpit, and Drizzle Studio on; Redis Insight off;
 * Stripe CLI off (it is useless without a test-mode key in
 * /etc/turbopanel/stripe-listen/stripe.env, which nothing generates).
 */
export const DEFAULT_OPTIONAL_DEV_SERVICES: OptionalDevServiceSelection = {
  dbstudio: true,
  smtp: true,
  ui: true,
  website: true,
  redisinsight: false,
  stripe: false,
};

export const OPTIONAL_SERVICES_PREFS_PATH =
  `${CONSOLE_LOG_DIR}/optional-services.json`;

/** Seconds of idle time before a converge picker auto-confirms. */
export const OPTIONAL_SERVICES_AUTO_CONFIRM_SECONDS = 5;

function isOptionalDevServiceId(value: string): value is OptionalDevServiceId {
  return (OPTIONAL_DEV_SERVICE_IDS as readonly string[]).includes(value);
}

export function cloneOptionalSelection(
  selection: OptionalDevServiceSelection,
): OptionalDevServiceSelection {
  return { ...selection };
}

export function defaultOptionalSelection(): OptionalDevServiceSelection {
  return cloneOptionalSelection(DEFAULT_OPTIONAL_DEV_SERVICES);
}

/**
 * Normalize a partial preference object onto the default selection.
 * Unknown keys are ignored; missing keys keep defaults.
 */
export function normalizeOptionalSelection(
  raw: unknown,
): OptionalDevServiceSelection {
  const next = defaultOptionalSelection();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return next;
  }
  const record = raw as Record<string, unknown>;
  for (const id of OPTIONAL_DEV_SERVICE_IDS) {
    const value = record[id];
    if (typeof value === "boolean") {
      next[id] = value;
    }
  }
  return next;
}

export function readOptionalDevServices(
  path: string = OPTIONAL_SERVICES_PREFS_PATH,
): OptionalDevServiceSelection {
  try {
    const text = readFileSync(path, "utf8");
    return normalizeOptionalSelection(JSON.parse(text) as unknown);
  } catch {
    return defaultOptionalSelection();
  }
}

export function writeOptionalDevServices(
  selection: OptionalDevServiceSelection,
  path: string = OPTIONAL_SERVICES_PREFS_PATH,
): void {
  const normalized = normalizeOptionalSelection(selection);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
}

/**
 * Persist an E/X toggle from the Services list so the next converge does not
 * revert it. Unknown service ids are ignored.
 */
export function persistOptionalServiceToggle(
  serviceId: string,
  enabled: boolean,
  path: string = OPTIONAL_SERVICES_PREFS_PATH,
): OptionalDevServiceSelection | null {
  if (!isOptionalDevServiceId(serviceId)) {
    return null;
  }
  const next = readOptionalDevServices(path);
  next[serviceId] = enabled;
  writeOptionalDevServices(next, path);
  return next;
}

/**
 * Env pairs for the orchestration child (`TURBOPANEL_OPTIONAL_*`).
 * Ansible reads these via daemon `devInstanceExtraArgs`.
 */
/**
 * Gray catalog rows on the Services list — all optional services, minus
 * Deno-only tools when the instance runs on Workers.
 */
export function optionalDevServiceCatalogIdsForRuntime(
  runtime: "deno" | "workers",
): readonly OptionalDevServiceId[] {
  if (runtime === "workers") {
    return OPTIONAL_DEV_SERVICE_IDS.filter(
      (id) =>
        !(OPTIONAL_DENO_ONLY_SERVICE_IDS as readonly string[]).includes(id),
    );
  }
  return OPTIONAL_DEV_SERVICE_IDS;
}

export function optionalDevServiceBackingContainers(
  def: OptionalDevServiceDef,
): readonly string[] {
  return def.containers ?? [];
}

export function optionalServicesOrchestrationEnv(
  selection: OptionalDevServiceSelection,
): string[] {
  const normalized = normalizeOptionalSelection(selection);
  return OPTIONAL_DEV_SERVICE_DEFS.map((def) => {
    const flag = normalized[def.id] ? "true" : "false";
    const envKey = `TURBOPANEL_OPTIONAL_${def.ansibleStem.toUpperCase()}`;
    return `${envKey}=${flag}`;
  });
}

function systemctlProperty(unit: string, property: string): string | null {
  const result = spawnSyncTrustedText(
    "systemctl",
    ["show", unit, `--property=${property}`, "--value"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.status !== 0) {
    return null;
  }
  const value = (result.stdout ?? "").trim();
  return value.length > 0 ? value : null;
}

function isSystemdUnitInstalled(unit: string): boolean {
  const loadState = systemctlProperty(unit, "LoadState");
  return loadState === "loaded" || loadState === "masked";
}

function dockerContainerExists(name: string): boolean {
  const result = spawnDocker(["inspect", name]);
  return result?.status === 0;
}

async function runSystemctl(
  args: string[],
  onOutput?: InstallOutputHandler,
): Promise<void> {
  const code = await runCaptured(["sudo", "-n", "systemctl", ...args], onOutput);
  if (code !== 0) {
    throw new Error(`systemctl ${args.join(" ")} failed`);
  }
}

async function runDocker(
  args: string[],
  onOutput?: InstallOutputHandler,
): Promise<void> {
  const attempts: string[][] = [
    ["docker", ...args],
    ["sudo", "-n", "docker", ...args],
  ];
  for (const cmd of attempts) {
    const code = await runCaptured(cmd, onOutput);
    if (code === 0) {
      return;
    }
  }
  throw new Error(`docker ${args.join(" ")} failed`);
}

async function startOptionalContainers(
  def: OptionalDevServiceDef,
  onOutput?: InstallOutputHandler,
): Promise<void> {
  for (const container of optionalDevServiceBackingContainers(def)) {
    if (!dockerContainerExists(container)) {
      continue;
    }
    onOutput?.(`Starting optional container ${container}`);
    await runDocker(["update", "--restart=unless-stopped", container], onOutput);
    await runDocker(["start", container], onOutput);
  }
}

async function stopOptionalContainers(
  def: OptionalDevServiceDef,
  onOutput?: InstallOutputHandler,
): Promise<void> {
  for (const container of optionalDevServiceBackingContainers(def)) {
    if (!dockerContainerExists(container)) {
      continue;
    }
    onOutput?.(`Stopping optional container ${container}`);
    await runDocker(["update", "--restart=no", container], onOutput);
    await runDocker(["stop", container], onOutput);
  }
}

function hasInstalledOptionalContainers(def: OptionalDevServiceDef): boolean {
  return optionalDevServiceBackingContainers(def).some((container) =>
    dockerContainerExists(container)
  );
}

async function applyInstalledOptionalUnit(
  def: OptionalDevServiceDef,
  want: boolean,
  onOutput?: InstallOutputHandler,
): Promise<void> {
  if (want) {
    onOutput?.(`Enabling optional service ${def.label} (${def.unit})`);
    await runSystemctl(["enable", "--now", def.unit], onOutput);
    return;
  }

  onOutput?.(`Disabling optional service ${def.label} (${def.unit})`);
  await runSystemctl(["disable", "--now", def.unit], onOutput);
  if (optionalDevServiceBackingContainers(def).length > 0) {
    await stopOptionalContainers(def, onOutput);
  }
}

async function applyContainerOnlyOptional(
  def: OptionalDevServiceDef,
  want: boolean,
  onOutput?: InstallOutputHandler,
): Promise<void> {
  if (!hasInstalledOptionalContainers(def)) {
    if (want) {
      onOutput?.(
        `${def.label} is not installed yet — run Converge to provision it`,
      );
    }
    return;
  }

  if (want) {
    onOutput?.(`Starting optional container ${def.label}`);
    await startOptionalContainers(def, onOutput);
    return;
  }

  onOutput?.(`Stopping optional container ${def.label}`);
  await stopOptionalContainers(def, onOutput);
}

/**
 * Start or stop each optional service to match `selection`.
 * Missing units/containers are skipped (converge installs them first).
 */
export async function applyOptionalDevServices(
  selection: OptionalDevServiceSelection,
  onOutput?: InstallOutputHandler,
): Promise<void> {
  const normalized = normalizeOptionalSelection(selection);
  writeOptionalDevServices(normalized);

  for (const def of OPTIONAL_DEV_SERVICE_DEFS) {
    const want = normalized[def.id];
    if (isSystemdUnitInstalled(def.unit)) {
      await applyInstalledOptionalUnit(def, want, onOutput);
      continue;
    }

    if (optionalDevServiceBackingContainers(def).length === 0) {
      if (want) {
        onOutput?.(
          `${def.label} is not installed yet — run Converge to provision it`,
        );
      }
      continue;
    }

    await applyContainerOnlyOptional(def, want, onOutput);
  }
}

/** Test helper — keep the id guard reachable for shape assertions. */
export function assertOptionalDevServiceId(value: string): OptionalDevServiceId {
  if (!isOptionalDevServiceId(value)) {
    throw new TypeError(`unknown optional dev service: ${value}`);
  }
  return value;
}
