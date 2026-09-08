import { existsSync } from "node:fs";
import { isDevInstanceEnabled, readInstanceRuntime } from "./lib/daemon-env.ts";
import { daemonRepoPath, DAEMON_SYSTEMD_UNIT, platformRepoPath } from "./lib/paths.ts";
import { spawnDocker } from "./lib/docker-access.ts";
import {
  MAILPIT_CONTAINER_NAME,
  POSTGRES_CONTAINER_NAME,
  RABBITMQ_CONTAINER_NAME,
  REDIS_INSIGHT_CONTAINER_NAME,
} from "./lib/platform-docker-resources.ts";
import { spawnSyncTrusted, spawnSyncTrustedText } from "./lib/spawn-trusted.ts";
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
  { id: "cache", label: "cache", unit: "turbopanel-redis" },
  { id: "redisinsight", label: "redisinsight", kind: "redisinsight" as const },
  // queue lives in turbopanel-system Compose (not a per-service unit).
  { id: "queue", label: "queue", kind: "queue" as const },
  // Stripe CLI webhook forwarder — a plain unit, off unless a test key is set.
  // Only useful with a Workers (wrangler dev) instance: billing exists only in
  // the Workers build, so a Deno instance has no /webhook/stripe to forward to.
  // Neither runtime's unit reads stripe.env; copy its values into .dev.vars.
  { id: "stripe", label: "stripe", unit: "turbopanel-stripe-listen" },
] as const;

const ANCILLARY_WORKERS_DEFS = [
  { id: "db", label: "db", kind: "postgres" as const },
  { id: "smtp", label: "smtp", kind: "mailpit" as const },
] as const;

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

export function isDaemonRepoInstalled(): boolean {
  try {
    if (existsSync(daemonRepoPath())) {
      return true;
    }
  } catch {
    // Platform checkout may be turbopanel-owned and not visible to the dev user.
  }

  return isDaemonSystemdInstalled();
}

function isSystemdUnitInstalled(unit: string): boolean {
  const loadState = systemctlProperty(unit, "LoadState");
  return loadState === "loaded" || loadState === "masked";
}

export function isDaemonSystemdInstalled(): boolean {
  return isSystemdUnitInstalled(DAEMON_UNIT);
}

function isRepoInstalled(repoDir: string): boolean {
  try {
    return existsSync(repoDir);
  } catch {
    // Platform checkout may be turbopanel-owned and not visible to the dev user.
    return false;
  }
}

function parseDockerRunningOutput(stdout: string | undefined): boolean | null {
  const value = (stdout ?? "").trim();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

function dockerContainerRunning(name: string): boolean | null {
  const result = spawnDocker([
    "inspect",
    "-f",
    "{{.State.Running}}",
    name,
  ]);
  if (!result) {
    return null;
  }
  return parseDockerRunningOutput(result.stdout);
}

function dockerContainerExists(name: string): boolean {
  return dockerContainerRunning(name) !== null;
}

function postgresSocketReady(): boolean {
  try {
    if (existsSync(POSTGRES_SOCKET)) {
      return true;
    }
  } catch {
    // The postgres socket dir is not traversable by the dev user.
  }

  const sudoResult = spawnSyncTrusted("sudo", ["-n", "test", "-S", POSTGRES_SOCKET], {
    stdio: "ignore",
  });
  return sudoResult.status === 0;
}

function dockerServiceStatus(container: string): DevServiceStatus {
  const running = dockerContainerRunning(container);
  if (running === true) {
    return "running";
  }
  if (running === false) {
    return "stopped";
  }
  if (dockerContainerExists(container)) {
    return "stopped";
  }

  return "uninstalled";
}

function postgresStatus(): DevServiceStatus {
  if (postgresSocketReady()) {
    return "running";
  }

  return dockerServiceStatus(POSTGRES_CONTAINER);
}

function unitOrDockerStatus(unit: string, container: string): DevServiceStatus {
  return systemdServiceStatus(unit) ?? dockerServiceStatus(container);
}

function mailpitStatus(): DevServiceStatus {
  return unitOrDockerStatus("turbopanel-mailpit", MAILPIT_CONTAINER);
}

function redisInsightStatus(): DevServiceStatus {
  return unitOrDockerStatus("turbopanel-redis-insight", REDIS_INSIGHT_CONTAINER);
}

function queueStatus(): DevServiceStatus {
  return dockerServiceStatus(RABBITMQ_CONTAINER);
}

function systemdServiceStatus(unit: string): DevServiceStatus | null {
  if (!isSystemdUnitInstalled(unit)) {
    return null;
  }

  const activeState = systemctlProperty(unit, "ActiveState");
  const subState = systemctlProperty(unit, "SubState");

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

function serviceStatus(unit: string, repoDir?: string): DevServiceStatus {
  const fromSystemd = systemdServiceStatus(unit);
  if (fromSystemd !== null) {
    return fromSystemd;
  }

  if (repoDir && isRepoInstalled(repoDir)) {
    return "pending";
  }

  return "uninstalled";
}

function daemonStatus(): DevServiceStatus {
  const fromSystemd = systemdServiceStatus(DAEMON_UNIT);
  if (fromSystemd !== null) {
    return fromSystemd;
  }

  if (isDaemonRepoInstalled()) {
    return "pending";
  }

  return "uninstalled";
}

function downstreamServices(): DevService[] {
  return DOWNSTREAM_SERVICE_DEFS
    .filter(({ unit, repoDir }) => {
      return isSystemdUnitInstalled(unit) || isRepoInstalled(repoDir);
    })
    .map(({ id, label, unit, repoDir }) => ({
      id,
      label,
      status: serviceStatus(unit, repoDir),
    }));
}

function shouldShowAncillaryServices(): boolean {
  if (isDevInstanceEnabled()) {
    return true;
  }
  if (dockerContainerExists(POSTGRES_CONTAINER)) {
    return true;
  }
  if (isSystemdUnitInstalled("turbopanel-redis")) {
    return true;
  }
  if (isSystemdUnitInstalled(SYSTEM_STACK_UNIT)) {
    return true;
  }
  if (dockerContainerExists(RABBITMQ_CONTAINER)) {
    return true;
  }
  if (dockerContainerExists(MAILPIT_CONTAINER)) {
    return true;
  }
  if (dockerContainerExists(REDIS_INSIGHT_CONTAINER)) {
    return true;
  }
  return downstreamServices().length > 0;
}

function ancillaryServices(): DevService[] {
  if (!shouldShowAncillaryServices()) {
    return [];
  }

  const defs = readInstanceRuntime() === "workers"
    ? ANCILLARY_WORKERS_DEFS
    : ANCILLARY_DENO_DEFS;

  return defs.map((def) => {
    if ("kind" in def && def.kind === "postgres") {
      return {
        id: def.id,
        label: def.label,
        status: postgresStatus(),
      };
    }

    if ("kind" in def && def.kind === "mailpit") {
      return {
        id: def.id,
        label: def.label,
        status: mailpitStatus(),
      };
    }

    if ("kind" in def && def.kind === "redisinsight") {
      return {
        id: def.id,
        label: def.label,
        status: redisInsightStatus(),
      };
    }

    if ("kind" in def && def.kind === "queue") {
      return {
        id: def.id,
        label: def.label,
        status: queueStatus(),
      };
    }

    const status = systemdServiceStatus(def.unit);
    return {
      id: def.id,
      label: def.label,
      status: status ?? "uninstalled",
    };
  });
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

export function getVisibleServices(): DevService[] {
  const daemon: DevService = {
    id: "daemon",
    label: "daemon",
    status: daemonStatus(),
  };

  const downstream = downstreamServices();
  const instance = downstream.find((service) => service.id === "instance");
  const restDownstream = downstream.filter((service) => service.id !== "instance");

  if (instance) {
    return mergeCatalogIfStackPresent(
      [instance, daemon, ...restDownstream, ...ancillaryServices()],
    );
  }

  return mergeCatalogIfStackPresent([
    daemon,
    ...downstream,
    ...ancillaryServices(),
  ]);
}

function mergeCatalogIfStackPresent(services: DevService[]): DevService[] {
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
  return mergeCatalogOptionalServices(services, readInstanceRuntime());
}
