import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceLogLine } from "../lib/service-log.ts";
import { mountHook, type MountedHook } from "./ink-hook-render.ts";
import {
  applyServiceLogRefresh,
  initialLogState,
  resetServiceLogCache,
  serviceLogCacheKey,
  useServiceLog,
} from "./use-service-log.ts";

vi.mock("../lib/service-log.ts", () => ({
  readServiceLogTail: vi.fn(),
}));

import { readServiceLogTail } from "../lib/service-log.ts";

describe("serviceLogCacheKey", () => {
  it("uses the service id when no byte floor is set", () => {
    expect(serviceLogCacheKey("daemon")).toBe("daemon");
    expect(serviceLogCacheKey("daemon", null)).toBe("daemon");
    expect(serviceLogCacheKey("daemon", {})).toBe("daemon");
  });

  it("appends a stable sorted byte-floor suffix", () => {
    expect(
      serviceLogCacheKey("instance", { stderr: 12, stdout: 34 }),
    ).toBe('instance:[["stderr",12],["stdout",34]]');
  });
});

describe("initialLogState", () => {
  it("returns an idle empty state without a service id", () => {
    expect(initialLogState(null)).toEqual({
      cacheKey: null,
      lines: [],
      loading: false,
    });
  });

  it("starts loading when the cache is cold", () => {
    resetServiceLogCache();
    expect(initialLogState("test-cache-miss-service")).toEqual({
      cacheKey: "test-cache-miss-service",
      lines: [],
      loading: true,
    });
  });
});

describe("applyServiceLogRefresh", () => {
  it("keeps the current snapshot when the cache key is stale", () => {
    const current = {
      cacheKey: "svc-b",
      lines: [{ text: "kept", time: "t" }],
      loading: false,
    };
    expect(
      applyServiceLogRefresh(current, "svc-a", [{ text: "late", time: "t" }]),
    ).toBe(current);
  });

  it("reuses the current line array when the first read matches an empty tail", () => {
    const current = { cacheKey: "svc", lines: [], loading: true };
    const next: ServiceLogLine[] = [];
    const applied = applyServiceLogRefresh(current, "svc", next);
    expect(applied.loading).toBe(false);
    expect(applied.lines).toBe(current.lines);
  });
});

describe("useServiceLog", () => {
  type HookState = { lines: ServiceLogLine[]; loading: boolean };
  let mounted: MountedHook<HookState> | undefined;

  beforeEach(() => {
    resetServiceLogCache();
    vi.mocked(readServiceLogTail).mockReset();
    vi.mocked(readServiceLogTail).mockReturnValue([]);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    vi.useRealTimers();
  });

  it("stays idle when no service is selected", async () => {
    mounted = mountHook(() => useServiceLog(null));
    await mounted.flush();
    expect(mounted.get()).toEqual({ lines: [], loading: false });
    expect(readServiceLogTail).not.toHaveBeenCalled();
  });

  it("loads a cold cache after the paint delay and skips duplicate polls", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const lines = [{ text: "boot", time: "t1" }];
    vi.mocked(readServiceLogTail).mockReturnValue(lines);
    mounted = mountHook(() => useServiceLog("svc-cold"));
    await mounted.flush();
    expect(mounted.get().loading).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 60));
    await mounted.flush();
    expect(mounted.get()).toEqual({ lines, loading: false });
    expect(readServiceLogTail).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await mounted.flush();
    expect(readServiceLogTail).toHaveBeenCalledTimes(2);
    expect(mounted.get().lines).toBe(lines);
  });

  it("skips the first read on a cache hit and still polls", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const cached = [{ text: "cached", time: "t0" }];
    vi.mocked(readServiceLogTail).mockReturnValue(cached);
    mounted = mountHook(() => useServiceLog("svc-warm"));
    await mounted.flush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await mounted.flush();
    mounted.unmount();

    vi.mocked(readServiceLogTail).mockClear();
    vi.mocked(readServiceLogTail).mockReturnValue(cached);
    mounted = mountHook(() => useServiceLog("svc-warm"));
    await mounted.flush();
    expect(mounted.get()).toEqual({ lines: cached, loading: false });
    expect(readServiceLogTail).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(readServiceLogTail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await mounted.flush();
    expect(readServiceLogTail).toHaveBeenCalled();
  });

  it("resets when the service id changes and ignores a stale in-flight read", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    const serviceId = { current: "svc-a" as string | null };
    vi.mocked(readServiceLogTail).mockImplementation((id: string) => {
      if (id === "svc-a") {
        serviceId.current = "svc-b";
        mounted?.rerender();
      }
      return [{ text: String(id), time: "t" }];
    });
    mounted = mountHook(() => useServiceLog(serviceId.current));
    await mounted.flush();
    await vi.advanceTimersByTimeAsync(50);
    await mounted.flush();
    await vi.advanceTimersByTimeAsync(50);
    await mounted.flush();
    expect(mounted.get().lines).toEqual([{ text: "svc-b", time: "t" }]);
  });

  it("keeps the current line array when the first read is empty", async () => {
    mounted = mountHook(() => useServiceLog("svc-empty-first"));
    await mounted.flush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await mounted.flush();
    expect(mounted.get()).toEqual({ lines: [], loading: false });
  });

  it("drops a refresh that finishes after unmount", async () => {
    vi.mocked(readServiceLogTail).mockImplementation(() => {
      mounted?.unmount();
      mounted = undefined;
      return [{ text: "late", time: "t" }];
    });
    mounted = mountHook(() => useServiceLog("svc-cancel"));
    await mounted.flush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(readServiceLogTail).toHaveBeenCalled();
  });
});
