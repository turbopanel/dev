import { serviceDisplayName } from "../dev-services.ts";
import { LogFileTailer } from "./log-file-tail.ts";
import { spawnDocker } from "./docker-access.ts";
import { runCaptured } from "./install-output.ts";
import { SERVICE_FILE_LOG_PATHS } from "./service-log.ts";
import { DAEMON_SYSTEMD_UNIT } from "./paths.ts";
import {
  MAILPIT_CONTAINER_NAME,
  POSTGRES_CONTAINER_NAME,
  RABBITMQ_CONTAINER_NAME,
  REDIS_INSIGHT_CONTAINER_NAME,
} from "./platform-docker-resources.ts";
import { spawnSyncTrustedText } from "./spawn-trusted.ts";

const SYSTEMD_UNITS: Record<string, string> = {
  daemon: DAEMON_SYSTEMD_UNIT,
  instance: "turbopanel-instance",
  caddy: "turbopanel-caddy",
  dbstudio: "turbopanel-dbstudio",
  ui: "turbopanel-ui",
  website: "turbopanel-website",
  cache: "turbopanel-redis",
  redisinsight: "turbopanel-redis-insight",
  smtp: "turbopanel-mailpit",
  stripe: "turbopanel-stripe-listen",
};

const DOCKER_CONTAINERS: Record<string, string> = {
  db: POSTGRES_CONTAINER_NAME,
  smtp: MAILPIT_CONTAINER_NAME,
  redisinsight: REDIS_INSIGHT_CONTAINER_NAME,
  queue: RABBITMQ_CONTAINER_NAME,
};

export type ServiceActiveState =
  | "active"
  | "inactive"
  | "activating"
  | "deactivating"
  | "failed"
  | "unknown";

export type ConsoleLogLine = {
  text: string;
  time: string;
};

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function resolveSystemdUnit(serviceId: string): string | null {
  const unit = SYSTEMD_UNITS[serviceId];
  if (!unit || !isSystemdUnitInstalled(unit)) {
    return null;
  }
  return unit;
}

function resolveDockerContainer(serviceId: string): string | null {
  const container = DOCKER_CONTAINERS[serviceId];
  if (!container) {
    return null;
  }
  const result = spawnDocker(["inspect", container]);
  return result?.status === 0 ? container : null;
}

function mapSystemdState(value: string | null): ServiceActiveState {
  switch (value) {
    case "active":
      return "active";
    case "inactive":
    case "dead":
      return "inactive";
    case "activating":
      return "activating";
    case "deactivating":
      return "deactivating";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

export function serviceRestartTarget(
  serviceId: string,
): { kind: "systemd"; unit: string } | { kind: "docker"; container: string } | null {
  const unit = resolveSystemdUnit(serviceId);
  if (unit) {
    return { kind: "systemd", unit };
  }
  const container = resolveDockerContainer(serviceId);
  if (container) {
    return { kind: "docker", container };
  }
  return null;
}

export function queryServiceActiveState(serviceId: string): ServiceActiveState {
  const target = serviceRestartTarget(serviceId);
  if (!target) {
    return "unknown";
  }

  if (target.kind === "systemd") {
    return mapSystemdState(systemctlProperty(target.unit, "ActiveState"));
  }

  const result = spawnDocker(["inspect", "-f", "{{.State.Running}}", target.container]);
  const value = (result?.stdout ?? "").trim();
  if (value === "true") {
    return "active";
  }
  if (value === "false") {
    return "inactive";
  }
  return "unknown";
}

export function consoleLogLine(text: string): ConsoleLogLine {
  return { text, time: new Date().toISOString() };
}

function restartDisplayName(serviceId: string, label: string): string {
  return serviceDisplayName(serviceId, label);
}

async function runSystemctl(args: string[]): Promise<void> {
  const code = await runCaptured(["sudo", "-n", "systemctl", ...args]);
  if (code !== 0) {
    throw new Error(`systemctl ${args.join(" ")} failed`);
  }
}

async function runDocker(args: string[]): Promise<void> {
  const attempts: string[][] = [
    ["docker", ...args],
    ["sudo", "-n", "docker", ...args],
  ];

  for (const cmd of attempts) {
    const code = await runCaptured(cmd);
    if (code === 0) {
      return;
    }
  }

  throw new Error(`docker ${args.join(" ")} failed`);
}

async function requestServiceRestart(
  serviceId: string,
  onLog: (line: ConsoleLogLine) => void,
): Promise<void> {
  const target = serviceRestartTarget(serviceId);
  if (!target) {
    throw new Error(`No systemd unit or Docker container found for ${serviceId}`);
  }

  const name = restartDisplayName(serviceId, serviceId);
  if (target.kind === "systemd") {
    onLog(consoleLogLine(`[console] requesting restart of ${name}…`));
    await runSystemctl(["restart", "--no-block", target.unit]);
    return;
  }

  onLog(consoleLogLine(`[console] requesting restart of container ${name}…`));
  onLog(consoleLogLine(`[console] ${name} shutting down…`));
  await runDocker(["restart", target.container]);
}

type SystemdRestartLogFlags = {
  loggedStopping: boolean;
  loggedStopped: boolean;
  loggedStarting: boolean;
};

function logSystemdRestartProgress(
  name: string,
  state: ServiceActiveState,
  wasActive: boolean,
  hasLogTailer: boolean,
  flags: SystemdRestartLogFlags,
  onLog: (line: ConsoleLogLine) => void,
): void {
  if (
    !hasLogTailer &&
    wasActive &&
    (state === "deactivating" || state === "inactive") &&
    !flags.loggedStopping
  ) {
    flags.loggedStopping = true;
    onLog(consoleLogLine(`[console] ${name} shutting down (systemd: ${state})`));
  }

  if (!hasLogTailer && wasActive && state === "inactive" && !flags.loggedStopped) {
    flags.loggedStopped = true;
    onLog(consoleLogLine(`[console] ${name} stopped`));
  }

  if (!hasLogTailer && flags.loggedStopped && state === "activating" && !flags.loggedStarting) {
    flags.loggedStarting = true;
    onLog(consoleLogLine(`[console] ${name} starting up (systemd: activating)`));
  }
}

async function waitForSystemdRestartActive(
  serviceId: string,
  name: string,
  wasActive: boolean,
  logTailer: LogFileTailer | null,
  onLog: (line: ConsoleLogLine) => void,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const started = Date.now();
  const flags: SystemdRestartLogFlags = {
    loggedStopping: false,
    loggedStopped: false,
    loggedStarting: false,
  };

  while (Date.now() - started < timeoutMs) {
    logTailer?.drain((line) => {
      onLog(consoleLogLine(line));
    });
    const state = queryServiceActiveState(serviceId);
    logSystemdRestartProgress(name, state, wasActive, logTailer !== null, flags, onLog);

    if (state === "active") {
      logTailer?.drain((line) => {
        onLog(consoleLogLine(line));
      });
      onLog(consoleLogLine(`[console] ${name} is active`));
      return true;
    }

    await sleep(pollMs);
  }

  return false;
}

export async function watchServiceRestart(
  serviceId: string,
  label: string,
  onLog: (line: ConsoleLogLine) => void,
  options: {
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_WAIT_POLL_MS;
  const name = restartDisplayName(serviceId, label);
  const target = serviceRestartTarget(serviceId);
  const wasActive = queryServiceActiveState(serviceId) === "active";
  const logPaths = SERVICE_FILE_LOG_PATHS[serviceId];
  const logTailer = logPaths && logPaths.length > 0
    ? new LogFileTailer(logPaths)
    : null;

  const drainServiceLogs = () => {
    logTailer?.drain((line) => {
      onLog(consoleLogLine(line));
    });
  };

  await requestServiceRestart(serviceId, onLog);
  drainServiceLogs();

  if (target?.kind === "docker") {
    drainServiceLogs();
    const active = queryServiceActiveState(serviceId) === "active";
    if (active) {
      onLog(consoleLogLine(`[console] ${name} is active`));
    } else {
      onLog(consoleLogLine(`[console] ${name} did not become active`));
    }
    return active;
  }

  const active = await waitForSystemdRestartActive(
    serviceId,
    name,
    wasActive,
    logTailer,
    onLog,
    timeoutMs,
    pollMs,
  );
  if (active) {
    return true;
  }

  drainServiceLogs();
  const finalState = queryServiceActiveState(serviceId);
  if (finalState === "active") {
    onLog(consoleLogLine(`[console] ${name} is active`));
    return true;
  }

  onLog(consoleLogLine(`[console] ${name} did not become active (last state: ${finalState})`));
  return false;
}
