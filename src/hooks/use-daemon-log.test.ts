import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonLogLine } from "../lib/daemon-log.ts";
import { mountHook, type MountedHook } from "./ink-hook-render.ts";
import {
  applyDaemonLogRefresh,
  emptyDaemonSnapshot,
  floorKey,
  initialDaemonState,
  resetDaemonLogCache,
  snapshotEqual,
  useDaemonLog,
} from "./use-daemon-log.ts";

vi.mock("../lib/daemon-log.ts", () => ({
  readDaemonLogFileStat: vi.fn(),
  readDaemonLogTail: vi.fn(),
}));

import { readDaemonLogFileStat, readDaemonLogTail } from "../lib/daemon-log.ts";

function line(message: string): DaemonLogLine {
  return {
    time: "t",
    level: "info",
    component: "daemon",
    message,
  };
}

describe("floorKey", () => {
  it("joins stdout and stderr byte floors", () => {
    expect(floorKey({ stdout: 10, stderr: 20 })).toBe("10:20");
    expect(floorKey(null)).toBe(":");
    expect(floorKey()).toBe(":");
  });
});

describe("snapshotEqual", () => {
  it("compares line content and file stat fields", () => {
    const left = {
      stat: {
        stdoutSize: 1,
        stdoutMtimeMs: 2,
        stderrSize: 3,
        stderrMtimeMs: 4,
      },
      lines: [line("a")],
    };
    const right = {
      ...left,
      lines: [line("a")],
    };
    expect(snapshotEqual(left, right)).toBe(true);
    expect(
      snapshotEqual(left, {
        ...right,
        lines: [line("b")],
      }),
    ).toBe(false);
    expect(
      snapshotEqual(left, {
        ...right,
        stat: { ...left.stat, stderrSize: 99 },
      }),
    ).toBe(false);
  });
});

describe("emptyDaemonSnapshot", () => {
  it("returns zeroed stats and no lines", () => {
    expect(emptyDaemonSnapshot()).toEqual({
      stat: {
        stdoutSize: 0,
        stdoutMtimeMs: 0,
        stderrSize: 0,
        stderrMtimeMs: 0,
      },
      lines: [],
    });
  });
});

describe("initialDaemonState", () => {
  it("marks loading when the module cache is cold", () => {
    resetDaemonLogCache();
    const state = initialDaemonState(0);
    expect(state.refreshKey).toBe(0);
    expect(state.floorKey).toBe(":");
    expect(state.snapshot.lines).toEqual([]);
    expect(state.loading).toBe(true);
  });
});

describe("applyDaemonLogRefresh", () => {
  it("keeps the current snapshot when the refresh key or floor changes", () => {
    const current = {
      refreshKey: 1,
      floorKey: "1:2",
      snapshot: emptyDaemonSnapshot(),
      loading: false,
    };
    const next = {
      stat: {
        stdoutSize: 4,
        stdoutMtimeMs: 0,
        stderrSize: 0,
        stderrMtimeMs: 0,
      },
      lines: [line("late")],
    };
    expect(applyDaemonLogRefresh(current, 0, "1:2", next)).toBe(current);
    expect(applyDaemonLogRefresh(current, 1, "9:9", next)).toBe(current);
  });
});

describe("useDaemonLog", () => {
  type HookState = { lines: DaemonLogLine[]; loading: boolean };
  const emptyStat = {
    stdoutSize: 0,
    stdoutMtimeMs: 0,
    stderrSize: 0,
    stderrMtimeMs: 0,
  };

  let mounted: MountedHook<HookState> | undefined;

  beforeEach(() => {
    resetDaemonLogCache();
    vi.mocked(readDaemonLogFileStat).mockReset();
    vi.mocked(readDaemonLogTail).mockReset();
    vi.mocked(readDaemonLogFileStat).mockReturnValue(emptyStat);
    vi.mocked(readDaemonLogTail).mockReturnValue([]);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    vi.useRealTimers();
  });

  it("loads a cold snapshot then ignores unchanged polls", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const lines = [line("hello")];
    vi.mocked(readDaemonLogTail).mockReturnValue(lines);
    vi.mocked(readDaemonLogFileStat).mockReturnValue({
      ...emptyStat,
      stdoutSize: 4,
    });
    mounted = mountHook(() => useDaemonLog());
    await mounted.flush();
    expect(mounted.get().loading).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 60));
    await mounted.flush();
    expect(mounted.get()).toEqual({ lines, loading: false });

    await vi.advanceTimersByTimeAsync(5_000);
    await mounted.flush();
    expect(readDaemonLogTail).toHaveBeenCalledTimes(2);
    expect(mounted.get().lines).toBe(lines);
  });

  it("skips the first read on a warm cache", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const lines = [line("warm")];
    vi.mocked(readDaemonLogTail).mockReturnValue(lines);
    mounted = mountHook(() => useDaemonLog());
    await mounted.flush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await mounted.flush();
    mounted.unmount();

    vi.mocked(readDaemonLogTail).mockClear();
    vi.mocked(readDaemonLogFileStat).mockClear();
    mounted = mountHook(() => useDaemonLog());
    await mounted.flush();
    expect(mounted.get()).toEqual({ lines, loading: false });
    expect(readDaemonLogTail).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(readDaemonLogTail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await mounted.flush();
    expect(readDaemonLogTail).toHaveBeenCalled();
  });

  it("resets when the refresh key changes during an in-flight read", async () => {
    const refreshKey = { current: 0 };
    vi.mocked(readDaemonLogTail).mockImplementation(() => {
      if (refreshKey.current === 0) {
        refreshKey.current = 1;
        mounted?.rerender();
      }
      return [line(`k${refreshKey.current}`)];
    });
    mounted = mountHook(() => useDaemonLog(null, refreshKey.current));
    await mounted.flush();
    await new Promise((resolve) => setTimeout(resolve, 160));
    await mounted.flush();
    expect(mounted.get().lines).toEqual([line("k1")]);
  });

  it("drops a refresh that finishes after unmount", async () => {
    vi.mocked(readDaemonLogTail).mockImplementation(() => {
      mounted?.unmount();
      mounted = undefined;
      return [line("late")];
    });
    mounted = mountHook(() => useDaemonLog());
    await mounted.flush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(readDaemonLogTail).toHaveBeenCalled();
  });
});
