import {
  buildPlatformRepoEntries,
  DAEMON_ENV_PATH,
  DAEMON_ENV_TRUNK_BRANCH_KEY,
  devOrchestrationDir,
  platformCaCertPath,
  resolveDevRoot,
  TURBOPANEL_TRUNK_BRANCH,
} from "./paths.ts";
import { resolveDevIdentity } from "./dev-identity.ts";
import {
  mergeEnvFile,
  parseEnvEntries,
  readEnvFile,
  readEnvFileAsync,
} from "./env-file.ts";
import { caddyBrowserUrl } from "./service-urls.ts";

const INSTANCE_OPT_IN_KEY = "TURBOPANEL_DEV_INSTANCE";
const RUNTIME_KEY = "TURBOPANEL_INSTANCE_RUNTIME";
const WORKERS_INSTANCE_URL_KEYS = [
  "TURBOPANEL_INSTANCE_URL",
  "TURBOPANEL_INSTANCE_CA",
] as const;

/** Build the managed daemon.env entries the dev console writes (testable contract). */
export function buildDaemonBaseEnvEntries(
  extra?: Record<string, string>,
): Record<string, string> {
  const dev = resolveDevIdentity();
  return {
    TURBOPANEL_MODE: "development",
    TURBOPANEL_DEV_ROOT: resolveDevRoot(),
    TURBOPANEL_DEV_ORCHESTRATION_DIR: devOrchestrationDir(),
    ...buildPlatformRepoEntries(),
    [DAEMON_ENV_TRUNK_BRANCH_KEY]: TURBOPANEL_TRUNK_BRANCH,
    TURBOPANEL_DEV_USER: dev.user,
    TURBOPANEL_DEV_UID: String(dev.uid),
    TURBOPANEL_DEV_GID: String(dev.gid),
    ...extra,
  };
}

function buildDaemonBaseEntries(extra?: Record<string, string>): Record<string, string> {
  return buildDaemonBaseEnvEntries(extra);
}

function mergeDaemonEnv(
  entries: Record<string, string>,
  options?: { removeKeys?: string[] },
): void {
  mergeEnvFile(DAEMON_ENV_PATH, entries, options);
}

/** Write co-located dev identity keys without the instance activation marker. */
export function writeDaemonBaseEnv(extra?: Record<string, string>): void {
  mergeDaemonEnv(buildDaemonBaseEntries(extra), {
    removeKeys: [INSTANCE_OPT_IN_KEY],
  });
}

function resolveRuntimeForWrite(
  extra?: Record<string, string>,
): "deno" | "workers" {
  if (extra?.[RUNTIME_KEY] === "workers") {
    return "workers";
  }
  if (extra?.[RUNTIME_KEY] === "deno") {
    return "deno";
  }
  return readInstanceRuntime();
}

/**
 * Opt in to co-located instance provisioning via the daemon `.env` marker.
 *
 * Also applies runtime-aware daemon connectivity: workers mode writes
 * `TURBOPANEL_INSTANCE_URL` + `TURBOPANEL_INSTANCE_CA`; deno mode removes them
 * so the daemon falls back to the local Unix socket.
 */
export function writeDaemonInstanceEnv(extra?: Record<string, string>): void {
  const runtime = resolveRuntimeForWrite(extra);
  const entries: Record<string, string> = {
    ...buildDaemonBaseEntries(),
    [INSTANCE_OPT_IN_KEY]: "1",
    ...extra,
  };
  const removeKeys: string[] = [];

  if (runtime === "workers") {
    entries.TURBOPANEL_INSTANCE_URL = caddyBrowserUrl();
    entries.TURBOPANEL_INSTANCE_CA = platformCaCertPath();
  } else {
    removeKeys.push(...WORKERS_INSTANCE_URL_KEYS);
  }

  mergeDaemonEnv(entries, { removeKeys });
}

function readDaemonEnvEntries(): Map<string, string> {
  return parseEnvEntries(readEnvFile(DAEMON_ENV_PATH));
}

/**
 * Every `daemon.env`-derived flag a status scan needs, from **one** file read.
 *
 * `readInstanceRuntime()` and friends each re-read and re-parse the file, and
 * when it is not readable by the dev user each of those falls back to a
 * `sudo -n cat` subprocess. Callers that need more than one flag (or that run
 * per repaint) must take a snapshot instead of calling them individually.
 */
export type DaemonEnvSnapshot = {
  runtime: "deno" | "workers";
  uiMode: "dev" | "static";
  runMode: "source" | "compiled";
  devInstanceEnabled: boolean;
};

function snapshotFromEntries(entries: Map<string, string>): DaemonEnvSnapshot {
  return {
    runtime: entries.get(RUNTIME_KEY) === "workers" ? "workers" : "deno",
    uiMode: entries.get("TURBOPANEL_UI_MODE") === "static" ? "static" : "dev",
    runMode: entries.get("TURBOPANEL_INSTANCE_RUN_MODE") === "compiled"
      ? "compiled"
      : "source",
    devInstanceEnabled: entries.get(INSTANCE_OPT_IN_KEY) === "1",
  };
}

export function readDaemonEnvSnapshot(): DaemonEnvSnapshot {
  return snapshotFromEntries(readDaemonEnvEntries());
}

/** Async sibling of {@link readDaemonEnvSnapshot} — never blocks the event loop. */
export async function readDaemonEnvSnapshotAsync(): Promise<DaemonEnvSnapshot> {
  return snapshotFromEntries(parseEnvEntries(await readEnvFileAsync(DAEMON_ENV_PATH)));
}

export function readInstanceRuntime(): "deno" | "workers" {
  const runtime = readDaemonEnvEntries().get("TURBOPANEL_INSTANCE_RUNTIME");
  return runtime === "workers" ? "workers" : "deno";
}

/** UI serving mode the converge applies (defaults to dev, like the converge). */
export function readInstanceUiMode(): "dev" | "static" {
  const mode = readDaemonEnvEntries().get("TURBOPANEL_UI_MODE");
  return mode === "static" ? "static" : "dev";
}

/** Instance run mode the converge applies (defaults to source, like the converge). */
export function readInstanceRunMode(): "source" | "compiled" {
  const mode = readDaemonEnvEntries().get("TURBOPANEL_INSTANCE_RUN_MODE");
  return mode === "compiled" ? "compiled" : "source";
}

/**
 * True when the co-located instance runs the developer-surface build
 * (`src/deno-dev.ts` with `TURBOPANEL_DEV_SURFACE=1`) — the only build that
 * mounts `registerDeveloperRoutes()` and serves `/api/developer/v1/*`.
 * Mirrors the instance unit template (turbopanel-instance.service.j2): Deno
 * runtime, `source` run mode, and `dev` UI mode. Workers, compiled binaries
 * (`deno task compile` targets `src/deno.ts`), and static-UI builds execute
 * the non-developer entry, so developer-surface actions must stay hidden.
 */
export function isDeveloperSurfaceInstance(
  snapshot: DaemonEnvSnapshot = readDaemonEnvSnapshot(),
): boolean {
  return snapshot.runtime === "deno" &&
    snapshot.runMode === "source" &&
    snapshot.uiMode === "dev";
}

export function isDevInstanceEnabled(): boolean {
  return readDaemonEnvEntries().get(INSTANCE_OPT_IN_KEY) === "1";
}
