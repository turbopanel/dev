import {
  execFile,
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process";

/** FHS system dirs only — subprocesses must not inherit a user-writable PATH (typescript:S4036). */
export const TRUSTED_SYSTEM_PATH = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
].join(":");

export function trustedSpawnEnv(
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    PATH: TRUSTED_SYSTEM_PATH,
  };
}

export function spawnSyncTrusted(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions & { encoding: BufferEncoding },
): SpawnSyncReturns<string>;
export function spawnSyncTrusted(
  command: string,
  args: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer>;
export function spawnSyncTrusted(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<Buffer | string> {
  const { env: extraEnv, ...rest } = options;
  return spawnSync(command, args, {
    ...rest,
    env: trustedSpawnEnv(extraEnv as Record<string, string> | undefined),
  });
}

/** Like {@link spawnSyncTrusted} but always decodes stdout/stderr as UTF-8 text. */
export function spawnSyncTrustedText(
  command: string,
  args: readonly string[],
  options: Omit<SpawnSyncOptions, "encoding"> = {},
): SpawnSyncReturns<string> {
  return spawnSyncTrusted(command, args, { ...options, encoding: "utf8" });
}

export type TrustedTextResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

/**
 * Async sibling of {@link spawnSyncTrustedText}, on the same trusted PATH.
 *
 * Status probes run off the render path, so they must not block Ink's event
 * loop the way `spawnSync` does — a single `systemctl show` fan-out cost the
 * console ~200ms of frozen UI per repaint before these existed.
 */
export function spawnTrustedText(
  command: string,
  args: readonly string[],
  options: { maxBuffer?: number; extraEnv?: Record<string, string> } = {},
): Promise<TrustedTextResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
        env: trustedSpawnEnv(options.extraEnv),
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          resolve({
            status: typeof code === "number" ? code : 1,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          });
          return;
        }
        resolve({ status: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}
