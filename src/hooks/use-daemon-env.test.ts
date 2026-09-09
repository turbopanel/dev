import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonEnvSnapshot } from "../lib/daemon-env.ts";
import { mountHook, type MountedHook } from "./ink-hook-render.ts";
import {
  daemonEnvEqual,
  resetDaemonEnvCache,
  useDaemonEnv,
} from "./use-daemon-env.ts";

vi.mock("../lib/daemon-env.ts", () => ({
  readDaemonEnvSnapshotAsync: vi.fn(),
}));

import { readDaemonEnvSnapshotAsync } from "../lib/daemon-env.ts";

function snapshot(overrides: Partial<DaemonEnvSnapshot> = {}): DaemonEnvSnapshot {
  return {
    runtime: "deno",
    uiMode: "dev",
    runMode: "source",
    devInstanceEnabled: true,
    ...overrides,
  };
}

describe("daemonEnvEqual", () => {
  it("compares every field", () => {
    expect(daemonEnvEqual(snapshot(), snapshot())).toBe(true);
    expect(daemonEnvEqual(snapshot(), snapshot({ runtime: "workers" }))).toBe(false);
    expect(daemonEnvEqual(snapshot(), snapshot({ uiMode: "static" }))).toBe(false);
    expect(daemonEnvEqual(snapshot(), snapshot({ runMode: "compiled" }))).toBe(false);
    expect(daemonEnvEqual(snapshot(), snapshot({ devInstanceEnabled: false })))
      .toBe(false);
  });
});

describe("useDaemonEnv", () => {
  let mounted: MountedHook<DaemonEnvSnapshot> | undefined;

  beforeEach(() => {
    resetDaemonEnvCache();
    vi.mocked(readDaemonEnvSnapshotAsync).mockReset();
    vi.mocked(readDaemonEnvSnapshotAsync).mockResolvedValue(snapshot());
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    vi.useRealTimers();
  });

  it("polls off the render path and keeps the same object when unchanged", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    mounted = mountHook(() => useDaemonEnv());
    await mounted.flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mounted.flush();
    expect(mounted.get().runtime).toBe("deno");

    const held = mounted.get();
    await vi.advanceTimersByTimeAsync(5_000);
    await mounted.flush();
    expect(mounted.get()).toBe(held);

    vi.mocked(readDaemonEnvSnapshotAsync)
      .mockResolvedValue(snapshot({ runtime: "workers" }));
    await vi.advanceTimersByTimeAsync(5_000);
    await mounted.flush();
    expect(mounted.get().runtime).toBe("workers");
  });

  it("paints a usable snapshot before the first read resolves", async () => {
    let resolveRead: ((value: DaemonEnvSnapshot) => void) | undefined;
    vi.mocked(readDaemonEnvSnapshotAsync).mockImplementation(
      () => new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    mounted = mountHook(() => useDaemonEnv());
    // First paint happens with the read still in flight — never blocked on it.
    expect(mounted.get()).toEqual(expect.objectContaining({ runtime: "deno" }));

    resolveRead!(snapshot({ runtime: "workers" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mounted.flush();
    expect(mounted.get().runtime).toBe("workers");
  });
});
