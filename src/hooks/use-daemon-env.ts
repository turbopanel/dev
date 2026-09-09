import { useEffect, useState } from "react";
import {
  readDaemonEnvSnapshotAsync,
  type DaemonEnvSnapshot,
} from "../lib/daemon-env.ts";

const POLL_MS = 5_000;

const DEFAULT_SNAPSHOT: DaemonEnvSnapshot = {
  runtime: "deno",
  uiMode: "dev",
  runMode: "source",
  devInstanceEnabled: false,
};

/** Shared across mounts so a second consumer does not start from the default. */
let cached: DaemonEnvSnapshot = DEFAULT_SNAPSHOT;

/** Drop the shared snapshot so hook tests can exercise a cold start. */
export function resetDaemonEnvCache(): void {
  cached = DEFAULT_SNAPSHOT;
}

export function daemonEnvEqual(
  current: DaemonEnvSnapshot,
  next: DaemonEnvSnapshot,
): boolean {
  return current.runtime === next.runtime &&
    current.uiMode === next.uiMode &&
    current.runMode === next.runMode &&
    current.devInstanceEnabled === next.devInstanceEnabled;
}

/**
 * Poll `daemon.env` off the render path.
 *
 * Components must never call `readInstanceRuntime()` / `isDeveloperSurfaceInstance()`
 * during render: each re-reads and re-parses the file, and falls back to a
 * `sudo -n cat` subprocess when the dev user cannot read it.
 */
export function useDaemonEnv(): DaemonEnvSnapshot {
  const [snapshot, setSnapshot] = useState(cached);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const next = await readDaemonEnvSnapshotAsync();
      cached = next;
      if (!cancelled) {
        setSnapshot((current) => (daemonEnvEqual(current, next) ? current : next));
      }
    };

    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return snapshot;
}
