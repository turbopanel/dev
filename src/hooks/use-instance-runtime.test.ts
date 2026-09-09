import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountHook, type MountedHook } from "./ink-hook-render.ts";
import { useInstanceRuntime } from "./use-instance-runtime.ts";

vi.mock("./use-daemon-env.ts", () => ({
  useDaemonEnv: vi.fn(),
}));

import { useDaemonEnv } from "./use-daemon-env.ts";

function envSnapshot(runtime: "deno" | "workers") {
  return {
    runtime,
    uiMode: "dev" as const,
    runMode: "source" as const,
    devInstanceEnabled: true,
  };
}

describe("useInstanceRuntime", () => {
  let mounted: MountedHook<"deno" | "workers"> | undefined;

  beforeEach(() => {
    vi.mocked(useDaemonEnv).mockReset();
    vi.mocked(useDaemonEnv).mockReturnValue(envSnapshot("deno"));
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    vi.useRealTimers();
  });

  it("reports the runtime from the shared daemon.env poller", async () => {
    mounted = mountHook(() => useInstanceRuntime());
    await mounted.flush();
    expect(mounted.get()).toBe("deno");

    vi.mocked(useDaemonEnv).mockReturnValue(envSnapshot("workers"));
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get()).toBe("workers");
  });
});
