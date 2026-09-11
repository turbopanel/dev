import { existsSync } from "node:fs";
import {
  readDaemonEnvSnapshotAsync,
  type DaemonEnvSnapshot,
} from "./lib/daemon-env.ts";
import { daemonRepoPath, DAEMON_SYSTEMD_UNIT, platformRepoPath } from "./lib/paths.ts";
import { spawnDockerAsync } from "./lib/docker-access.ts";
import {
  MAILPIT_CONTAINER_NAME,
  POSTGRES_CONTAINER_NAME,
  RABBITMQ_CONTAINER_NAME,
  REDIS_INSIGHT_CONTAINER_NAME,
} from "./lib/platform-docker-resources.ts";
import { spawnSyncTrustedText, spawnTrustedText } from "./lib/spawn-trusted.ts";
import { mergeCatalogOptionalServices } from "./lib/service-list-visibility.ts";

export type DevServiceStatus =
  | "running"
  | "starting"
  | "failed"
  | "stopped"
  | "pending"
  | "uninstalled";

export type DevService = {
  id: string;
  label: string;
  status: DevServiceStatus;
};

const DAEMON_UNIT = DAEMON_SYSTEMD_UNIT;
const SYSTEM_STACK_UNIT = "turbopanel-system-stack";
const POSTGRES_CONTAINER = POSTGRES_CONTAINER_NAME;
const RABBITMQ_CONTAINER = RABBITMQ_CONTAINER_NAME;
const MAILPIT_CONTAINER = MAILPIT_CONTAINER_NAME;
const REDIS_INSIGHT_CONTAINER = REDIS_INSIGHT_CONTAINER_NAME;
const POSTGRES_SOCKET = "/var/run/turbopanel/postgres/.s.PGSQL.5432";

const MAILPIT_UNIT = "turbopanel-mailpit";
const REDIS_INSIGHT_UNIT = "turbopanel-redis-insight";
const REDIS_UNIT = "turbopanel-redis";

const DOWNSTREAM_SERVICE_DEFS = [
  {
    id: "instance",
    label: "instance",
    unit: "turbopanel-instance",
    repoDir: platformRepoPath("turbopanel"),
  },
  {
    id: "caddy",
    label: "caddy",
    unit: "turbopanel-caddy",
    repoDir: platformRepoPath("turbopanel"),
  },
  {
    id: "dbstudio",
    label: "dbstudio",
    unit: "turbopanel-dbstudio",
    repoDir: platformRepoPath("turbopanel"),
  },
  {
    id: "ui",
    label: "ui",
    unit: "turbopanel-ui",
    repoDir: platformRepoPath("ui"),
  },
  {
    id: "website",
    label: "website",
    unit: "turbopanel-website",
    repoDir: platformRepoPath("website"),
  },
] as const;

const ANCILLARY_DENO_DEFS = [
  { id: "db", label: "db", kind: "postgres" as const },
  { id: "smtp", label: "smtp", kind: "mailpit" as const },
  { id: "cache", label: "cache", unit: REDIS_UNIT },
  { id: "redisinsight", label: "redisinsight", kind: "redisinsight" as const },
  // queue lives in turbopanel-system Compose (not a per-service unit).
  { id: "queue", label: "queue", kind: "queue" as const },
] as const;

const ANCILLARY_WORKERS_DEFS = [
  { id: "db", label: "db", kind: "postgres" as const },
  { id: "smtp", label: "smtp", kind: "mailpit" as const },
  // Stripe CLI webhook forwarder — a plain unit, off unless a test key is set.
  // Billing exists only in the Workers build; wrangler reads .dev.vars, not stripe.env.
  { id: "stripe", label: "stripe", unit: "turbopanel-stripe-listen" },
] as const;

/**
 * Every unit one status scan needs, probed in a single `systemctl show`.
 *
 * Keep this in sync with the defs above: a unit missing here reads back as
 * not-found (i.e. uninstalled) rather than erroring.
 */
const PROBED_UNITS: readonly string[] = [
  DAEMON_UNIT,
  SYSTEM_STACK_UNIT,
  ...DOWNSTREAM_SERVICE_DEFS.map((def) => def.unit),
  REDIS_UNIT,
  MAILPIT_UNIT,
  REDIS_INSIGHT_UNIT,
  "turbopanel-stripe-listen",
];

// ---------------------------------------------------------------------------
// Snapshot gathering — the only part that touches systemd, Docker, or the disk.
// ---------------------------------------------------------------------------

type UnitState = {
  loadState: string | null;
  activeState: string | null;
  subState: string | null;
};

/**
 * One consistent read of everything {@link computeVisibleServices} needs.
 *
 * Gathering it costs **two** subprocesses (one `systemctl show` for every unit,
 * one `docker ps -a`) plus a handful of `existsSync` calls. It used to cost
 * ~30 `spawnSync` calls — ~220ms on an idle host and worse in the Vagrant
 * guest, where Docker is actually installed — which froze Ink for the whole
 * duration on every repaint that touched the service list.
 */
export type ServiceStatusSnapshot = {
  units: Map<string, UnitState>;
  /** Present only for containers Docker knows about; value is "is running". */
  containers: Map<string, boolean>;
  /** Downstream repo checkout dir → exists. */
  repos: Map<string, boolean>;
  daemonRepoExists: boolean;
  postgresSocketReady: boolean;
  env: DaemonEnvSnapshot;
};

const UNIT_SHOW_PROPERTIES = "--property=Id,LoadState,ActiveState,SubState";

/**
 * Parse the blank-line-separated blocks `systemctl show <unit…>` emits.
 *
 * Blocks arrive in request order and each carries its own `Id=`, so unknown
 * units (which come back `LoadState=not-found`) stay correctly aligned.
 */
export function parseSystemctlShowBlocks(stdout: string): Map<string, UnitState> {
  const units = new Map<string, UnitState>();
  for (const block of stdout.split(/\n\s*\n/)) {
    const values = new Map<string, string>();
    for (const line of block.split("\n")) {
      const index = line.indexOf("=");
      if (index > 0) {
        values.set(line.slice(0, index), line.slice(index + 1));
      }
    }
    const id = values.get("Id");
    if (!id) {
      continue;
    }
    units.set(id.replace(/\.service$/, ""), {
      loadState: values.get("LoadState") || null,
      activeState: values.get("ActiveState") || null,
      subState: values.get("SubState") || null,
    });
  }
  return units;
}

/** Parse `docker ps -a --format '{{.Names}}\t{{.State}}'` into name → running. */
export function parseDockerPsOutput(stdout: string): Map<string, boolean> {
  const containers = new Map<string, boolean>();
  for (const line of stdout.split("\n")) {
    const [name, state] = line.split("\t");
    if (name && name.trim().length > 0) {
      containers.set(name.trim(), state?.trim() === "running");
    }
  }
  return containers;
}

const DOCKER_PS_ARGS = ["ps", "-a", "--format", "{{.Names}}\t{{.State}}"];

function pathExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    // Platform checkout may be turbopanel-owned and not visible to the dev user.
    return false;
  }
}

function repoDirs(): string[] {
  return [...new Set(DOWNSTREAM_SERVICE_DEFS.map((def) => def.repoDir))];
}

function repoSnapshot(): Map<string, boolean> {
  return new Map(repoDirs().map((dir) => [dir, pathExists(dir)]));
}

export async function gatherServiceStatusSnapshot(): Promise<ServiceStatusSnapshot> {
  const [showResult, dockerResult, env, postgresSocketReady] = await Promise.all([
    spawnTrustedText("systemctl", ["show", ...PROBED_UNITS, UNIT_SHOW_PROPERTIES]),
    spawnDockerAsync(DOCKER_PS_ARGS),
    readDaemonEnvSnapshotAsync(),
    postgresSocketReadyAsync(),
  ]);

  return {
    units: showResult.status === 0
      ? parseSystemctlShowBlocks(showResult.stdout)
      : new Map(),
    containers: dockerResult ? parseDockerPsOutput(dockerResult.stdout) : new Map(),
    repos: repoSnapshot(),
    daemonRepoExists: pathExists(daemonRepoPath()),
    postgresSocketReady,
    env,
  };
}

async function postgresSocketReadyAsync(): Promise<boolean> {
  if (pathExists(POSTGRES_SOCKET)) {
    return true;
  }
  // The postgres socket dir may not be traversable by the dev user.
  const result = await spawnTrustedText("sudo", ["-n", "test", "-S", POSTGRES_SOCKET]);
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Pure derivation — no I/O below this line.
// ---------------------------------------------------------------------------

function unitInstalled(snapshot: ServiceStatusSnapshot, unit: string): boolean {
  const loadState = snapshot.units.get(unit)?.loadState;
  return loadState === "loaded" || loadState === "masked";
}

function systemdServiceStatus(
  snapshot: ServiceStatusSnapshot,
  unit: string,
): DevServiceStatus | null {
  if (!unitInstalled(snapshot, unit)) {
    return null;
  }

  const { activeState, subState } = snapshot.units.get(unit)!;

  if (activeState === "active") {
    return "running";
  }

  if (activeState === "failed") {
    return "failed";
  }

  if (activeState === "activating" && subState === "auto-restart") {
    return "starting";
  }

  if (activeState === "activating" || activeState === "reloading") {
    return "starting";
  }

  return "stopped";
}

function dockerServiceStatus(
  snapshot: ServiceStatusSnapshot,
  container: string,
): DevServiceStatus {
  const running = snapshot.containers.get(container);
  if (running === undefined) {
    return "uninstalled";
  }
  return running ? "running" : "stopped";
}

function unitOrDockerStatus(
  snapshot: ServiceStatusSnapshot,
  unit: string,
  container: string,
): DevServiceStatus {
  return systemdServiceStatus(snapshot, unit) ??
    dockerServiceStatus(snapshot, container);
}

function postgresStatus(snapshot: ServiceStatusSnapshot): DevServiceStatus {
  if (snapshot.postgresSocketReady) {
    return "running";
  }
  return dockerServiceStatus(snapshot, POSTGRES_CONTAINER);
}

function serviceStatus(
  snapshot: ServiceStatusSnapshot,
  unit: string,
  repoDir?: string,
): DevServiceStatus {
  const fromSystemd = systemdServiceStatus(snapshot, unit);
  if (fromSystemd !== null) {
    return fromSystemd;
  }

  if (repoDir && snapshot.repos.get(repoDir)) {
    return "pending";
  }

  return "uninstalled";
}

function daemonStatus(snapshot: ServiceStatusSnapshot): DevServiceStatus {
  const fromSystemd = systemdServiceStatus(snapshot, DAEMON_UNIT);
  if (fromSystemd !== null) {
    return fromSystemd;
  }

  if (snapshot.daemonRepoExists) {
    return "pending";
  }

  return "uninstalled";
}

function downstreamServices(snapshot: ServiceStatusSnapshot): DevService[] {
  return DOWNSTREAM_SERVICE_DEFS
    .filter(({ unit, repoDir }) =>
      unitInstalled(snapshot, unit) || Boolean(snapshot.repos.get(repoDir))
    )
    .map(({ id, label, unit, repoDir }) => ({
      id,
      label,
      status: serviceStatus(snapshot, unit, repoDir),
    }));
}

function shouldShowAncillaryServices(
  snapshot: ServiceStatusSnapshot,
  downstream: DevService[],
): boolean {
  return snapshot.env.devInstanceEnabled ||
    snapshot.containers.has(POSTGRES_CONTAINER) ||
    snapshot.containers.has(RABBITMQ_CONTAINER) ||
    snapshot.containers.has(MAILPIT_CONTAINER) ||
    snapshot.containers.has(REDIS_INSIGHT_CONTAINER) ||
    unitInstalled(snapshot, REDIS_UNIT) ||
    unitInstalled(snapshot, SYSTEM_STACK_UNIT) ||
    downstream.length > 0;
}

function ancillaryServices(
  snapshot: ServiceStatusSnapshot,
  downstream: DevService[],
): DevService[] {
  if (!shouldShowAncillaryServices(snapshot, downstream)) {
    return [];
  }

  const defs = snapshot.env.runtime === "workers"
    ? ANCILLARY_WORKERS_DEFS
    : ANCILLARY_DENO_DEFS;

  return defs.map((def) => {
    if ("kind" in def) {
      switch (def.kind) {
        case "postgres":
          return { id: def.id, label: def.label, status: postgresStatus(snapshot) };
        case "mailpit":
          return {
            id: def.id,
            label: def.label,
            status: unitOrDockerStatus(snapshot, MAILPIT_UNIT, MAILPIT_CONTAINER),
          };
        case "redisinsight":
          return {
            id: def.id,
            label: def.label,
            status: unitOrDockerStatus(
              snapshot,
              REDIS_INSIGHT_UNIT,
              REDIS_INSIGHT_CONTAINER,
            ),
          };
        case "queue":
          return {
            id: def.id,
            label: def.label,
            status: dockerServiceStatus(snapshot, RABBITMQ_CONTAINER),
          };
      }
    }

    return {
      id: def.id,
      label: def.label,
      status: systemdServiceStatus(snapshot, def.unit) ?? "uninstalled",
    };
  });
}

/** Derive the visible service list from a snapshot. Pure — safe to call anywhere. */
export function computeVisibleServices(
  snapshot: ServiceStatusSnapshot,
): DevService[] {
  const daemon: DevService = {
    id: "daemon",
    label: "daemon",
    status: daemonStatus(snapshot),
  };

  const downstream = downstreamServices(snapshot);
  const ancillary = ancillaryServices(snapshot, downstream);
  const instance = downstream.find((service) => service.id === "instance");
  const restDownstream = downstream.filter((service) => service.id !== "instance");

  const ordered = instance
    ? [instance, daemon, ...restDownstream, ...ancillary]
    : [daemon, ...downstream, ...ancillary];

  return mergeCatalogIfStackPresent(ordered, snapshot.env.runtime);
}

function mergeCatalogIfStackPresent(
  services: DevService[],
  runtime: "deno" | "workers",
): DevService[] {
  const stackInstalled = services.some((service) => {
    switch (service.status) {
      case "running":
      case "starting":
      case "failed":
      case "stopped":
        return true;
      default:
        return false;
    }
  });
  if (!stackInstalled) {
    return services;
  }
  return mergeCatalogOptionalServices(services, runtime);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the current service list without blocking the Ink event loop.
 *
 * This is the only entry point the console UI should use — see
 * `useVisibleServices`, which renders a skeleton until the first read lands.
 */
export async function readVisibleServices(): Promise<DevService[]> {
  return computeVisibleServices(await gatherServiceStatusSnapshot());
}

export function isDaemonSystemdInstalled(): boolean {
  const loadState = spawnSyncTrustedText(
    "systemctl",
    ["show", DAEMON_UNIT, "--property=LoadState", "--value"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  if (loadState.status !== 0) {
    return false;
  }
  const value = (loadState.stdout ?? "").trim();
  return value === "loaded" || value === "masked";
}

export function isDaemonRepoInstalled(): boolean {
  return pathExists(daemonRepoPath()) || isDaemonSystemdInstalled();
}

export function isDaemonInstallable(status: DevServiceStatus): boolean {
  return status !== "running";
}

/** User-facing service label for progress, status, errors, and empty-log messages. */
export function serviceDisplayName(serviceId: string, label?: string): string {
  const fromDefs = [
    ...DOWNSTREAM_SERVICE_DEFS,
    ...ANCILLARY_DENO_DEFS,
    ...ANCILLARY_WORKERS_DEFS,
  ].find((def) => def.id === serviceId)?.label;
  return label ?? fromDefs ?? serviceId;
}
