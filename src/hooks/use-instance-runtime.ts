import { useDaemonEnv } from "./use-daemon-env.ts";

/**
 * The instance runtime, polled off the render path.
 *
 * Delegates to {@link useDaemonEnv} so every consumer shares one poller and one
 * warm cache — reading `daemon.env` synchronously per render stalled Ink, and
 * a second independent cache made the Developer menu flicker on first paint.
 */
export function useInstanceRuntime(): "deno" | "workers" {
  return useDaemonEnv().runtime;
}
