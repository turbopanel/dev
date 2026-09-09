import type { DevServiceStatus } from "../dev-services.ts";
import { isDaemonSystemdInstalled } from "../dev-services.ts";
import {
  daemonRepoPath,
  DAEMON_SYSTEMD_UNIT,
  RUNTIMES_DIR,
  TURBOPANEL_ROOT,
} from "./paths.ts";
import {
  isDeveloperSurfaceInstance,
  readInstanceRuntime,
  type DaemonEnvSnapshot,
} from "./daemon-env.ts";
import { spawnSyncTrustedText } from "./spawn-trusted.ts";
import { type InstallOutputHandler, runCaptured } from "./install-output.ts";
import { syncDevToAllDaemons, updateConnectedDaemons } from "./developer-client.ts";
import { shellQuote } from "./shell-quote.ts";
import { ensureOrchestrationDenoBin } from "./daemon-exec.ts";
import { testRunnerPathEnv } from "./run-repo-tests.ts";

export type DaemonActionId =
  | "install"
  | "repair"
  | "restart"
  | "purge"
  | "start-dev-env"
  | "optional-services"
  | "reset-dev-env"
  | "reset-dev-db"
  | "save-tier-catalogue"
  | "toggle-cell-trace"
  | "view-cell-trace"
  | "run-tests"
  | "sync-dev-build"
  | "rebuild-daemon-upgrade"
  | "open-duckdb-ui";

const DAEMON_UNIT = DAEMON_SYSTEMD_UNIT;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_POLL_MS = 500;

export const DAEMON_ACTION_LABELS: Record<DaemonActionId, string> = {
  install: "Install",
  repair: "Repair install",
  restart: "Restart",
  purge: "Purge completely",
  "start-dev-env": "Converge / re-converge development environment",
  "optional-services": "Optional services…",
  "reset-dev-env": "Reset development environment",
  "reset-dev-db": "Reset dev database",
  "save-tier-catalogue": "Save tier catalogue to dev/local/tiers.json",
  "toggle-cell-trace": "Toggle verbose cell trace",
  "view-cell-trace": "View cell trace log",
  "run-tests": "Run tests…",
  "sync-dev-build": "Sync source to attached checkouts",
  "rebuild-daemon-upgrade": "Rebuild daemon and upgrade connected servers",
  "open-duckdb-ui": "Open DuckDB UI (metrics)",
};

/**
 * Warning copy for actions that destroy state. Any action listed here must be
 * confirmed in the console before it runs.
 */
export const DESTRUCTIVE_ACTION_WARNINGS: Partial<Record<DaemonActionId, string>> = {
  "reset-dev-env":
    "Stops all platform services, removes their Docker containers and volumes, and hard-resets every attached checkout to origin/trunk — uncommitted changes in those repos are lost. The stack is then rebuilt from scratch.",
  "reset-dev-db":
    "Drops the entire dev Postgres schema — all data is lost. Migrations are re-applied and the instance restarts into the install wizard.",
  purge:
    "Stops and removes the daemon service and deletes its checkout, runtimes, and caches. The console exits when the purge finishes.",
};

export function isDestructiveDaemonAction(action: DaemonActionId): boolean {
  return action in DESTRUCTIVE_ACTION_WARNINGS;
}

export function daemonMenuActions(_status: DevServiceStatus): DaemonActionId[] {
  return [];
}

export { cellTraceToggleLabel } from "./instance-trace-env.ts";

/**
 * @param env Pre-read `daemon.env` snapshot. Pass it from React: without it this
 *   re-reads and re-parses the file up to three times per call (~54ms when the
 *   dev user cannot read it and each read falls back to `sudo -n cat`).
 */
export function developerMenuActions(
  status: DevServiceStatus | undefined,
  env?: DaemonEnvSnapshot,
): DaemonActionId[] {
  if (!status || status === "uninstalled") {
    return [];
  }

  const runtime = env ? env.runtime : readInstanceRuntime();

  // Open DuckDB UI needs /api/developer/v1/metrics/duckdb-ui, which only the
  // developer-surface build (src/deno-dev.ts) mounts — compiled and static
  // Deno builds run src/deno.ts and must not offer the action.
  const developerSurfaceActions: DaemonActionId[] =
    (env ? isDeveloperSurfaceInstance(env) : isDeveloperSurfaceInstance())
      ? ["open-duckdb-ui"]
      : [];

  const denoActions: DaemonActionId[] = runtime === "deno"
    ? ["sync-dev-build", "rebuild-daemon-upgrade"]
    : [];

  // Tiers exist only where billing does (the Workers build). The saved copy is
  // restored by the dev overlay role on converge; this is the write side.
  const workersActions: DaemonActionId[] = runtime === "workers"
    ? ["save-tier-catalogue"]
    : [];

  return [
    "repair",
    "start-dev-env",
    "optional-services",
    "reset-dev-env",
    "reset-dev-db",
    ...workersActions,
    "run-tests",
    "toggle-cell-trace",
    "view-cell-trace",
    ...developerSurfaceActions,
    ...denoActions,
    "purge",
  ];
}

export function canRestartDaemon(): boolean {
  return isDaemonSystemdInstalled();
}

export function isDaemonServiceActive(): boolean {
  const result = spawnSyncTrustedText("systemctl", ["is-active", DAEMON_UNIT], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  return (result.stdout ?? "").trim() === "active";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForDaemonRunning(
  options: {
    timeoutMs?: number;
    pollMs?: number;
    onPoll?: (elapsedMs: number) => void;
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_WAIT_POLL_MS;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (isDaemonServiceActive()) {
      return true;
    }
    options.onPoll?.(Date.now() - started);
    await sleep(pollMs);
  }

  return isDaemonServiceActive();
}

/** First activation after opt-in — enable the unit and start it (not a restart). */
export async function enableAndStartDaemon(
  onOutput?: InstallOutputHandler,
): Promise<void> {
  const lines: string[] = [];
  const append = (line: string) => {
    lines.push(line);
    onOutput?.(line);
  };

  const code = await runCaptured(
    ["sudo", "-n", "systemctl", "enable", "--now", DAEMON_UNIT],
    append,
  );
  if (code !== 0) {
    throw new Error(lines.at(-1) ?? `Failed to enable and start ${DAEMON_UNIT}`);
  }
}

/** Queue a daemon restart without blocking until the service is active again. */
export async function requestDaemonRestart(
  onOutput?: InstallOutputHandler,
): Promise<void> {
  const lines: string[] = [];
  const append = (line: string) => {
    lines.push(line);
    onOutput?.(line);
  };

  const code = await runCaptured(
    ["sudo", "systemctl", "restart", "--no-block", DAEMON_UNIT],
    append,
  );
  if (code !== 0) {
    throw new Error(lines.at(-1) ?? "Failed to restart daemon");
  }
}

export async function purgeDaemon(
  onOutput?: InstallOutputHandler,
): Promise<void> {
  const pathsToRemove = [
    daemonRepoPath(),
    RUNTIMES_DIR,
    `${TURBOPANEL_ROOT}/.cache`,
    `${TURBOPANEL_ROOT}/.ansible`,
    `${TURBOPANEL_ROOT}/.local`,
  ].map(shellQuote);

  // Stop/remove the daemon systemd unit.
  const units = [DAEMON_UNIT];
  const command = [
    ...units.flatMap((unit) => [
      `systemctl stop ${unit} 2>/dev/null || true`,
      `systemctl disable ${unit} 2>/dev/null || true`,
      `rm -f /etc/systemd/system/${unit}.service`,
    ]),
    "systemctl daemon-reload",
    ...pathsToRemove.map((path) => `rm -rf ${path}`),
  ].join(" && ");

  const code = await runCaptured(["sudo", "bash", "-c", command], onOutput);
  if (code !== 0) {
    throw new Error("Failed to purge daemon");
  }
}

/**
 * Push the local daemon source build to every attached daemon via the live
 * instance developer API (`/api/developer/v1/daemon/sync-dev`). This replaces
 * the old local `release:package` binary build — the daemon runs from source and
 * dev pushes are streamed/unpacked by each daemon.
 */
export async function syncDevBuildToDaemons(
  onOutput?: InstallOutputHandler,
): Promise<void> {
  const append = (line: string) => onOutput?.(line);

  append("Packaging local daemon source and syncing to attached daemons…");

  let response;
  try {
    response = await syncDevToAllDaemons();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach the instance developer API: ${message}`);
  }

  const results = response.results ?? [];
  if (results.length === 0) {
    append("No attached daemons are currently connected.");
    return;
  }

  for (const result of results) {
    if (result.skipped) {
      append(`– ${result.daemonId}: skipped (${result.error ?? "co-located dev daemon"})`);
    } else if (result.ok) {
      append(`✓ ${result.daemonId}: synced`);
    } else {
      append(`✗ ${result.daemonId}: ${result.error ?? "sync failed"}`);
    }
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} of ${results.length} daemon(s) failed to sync`,
    );
  }

  const synced = results.filter((result) => result.ok && !result.skipped);
  if (synced.length > 0) {
    append(`Synced ${synced.length} daemon(s) successfully.`);
    return;
  }

  append(
    "No remote source checkouts to sync. Managed installs (compiled turbopaneld) and this co-located daemon skip Sync Dev Build — they update via Rebuild daemon and upgrade connected servers / local edits.",
  );
}

/**
 * Compile the daemon checkout into `dist/`, write a local overlay catalog
 * (`channels.json` / `manifest.json`), then trigger channel reconcile on
 * connected **remote** servers. The co-located daemon keeps running from source.
 */
export async function rebuildDaemonAndUpgradeConnectedServers(
  onOutput?: InstallOutputHandler,
): Promise<void> {
  const append = (line: string) => onOutput?.(line);

  append("Compiling daemon release artifacts from the local checkout…");
  const denoBin = await ensureOrchestrationDenoBin(append);
  const cwd = daemonRepoPath();
  const code = await runCaptured(
    [denoBin, "task", "release:dev"],
    append,
    { cwd, env: testRunnerPathEnv() },
  );
  if (code !== 0) {
    throw new Error("Failed to package the local daemon overlay catalog");
  }

  append("Triggering overlay updates on connected remote servers…");

  let response;
  try {
    response = await updateConnectedDaemons();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach the instance developer API: ${message}`);
  }

  const results = response.results ?? [];
  if (results.length === 0) {
    append("No attached daemons are currently connected.");
    return;
  }

  for (const result of results) {
    if (result.skipped) {
      append(`– ${result.daemonId}: skipped (${result.error ?? "co-located"})`);
    } else if (result.ok) {
      append(`✓ ${result.daemonId}: upgrade queued`);
    } else {
      append(`✗ ${result.daemonId}: ${result.error ?? "update failed"}`);
    }
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} of ${results.length} daemon(s) failed to upgrade`,
    );
  }

  const upgraded = results.filter((result) => result.ok && !result.skipped);
  if (upgraded.length > 0) {
    append(`Upgraded ${upgraded.length} remote daemon(s).`);
    return;
  }

  append(
    "No remote servers to upgrade. This co-located daemon runs from source — connect a managed server first.",
  );
}
