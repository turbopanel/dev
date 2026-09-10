import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevService } from "../dev-services.ts";
import { mountHook, type MountedHook } from "./ink-hook-render.ts";
import { servicesEqual, useVisibleServices } from "./use-visible-services.ts";

vi.mock("../dev-services.ts", () => ({
  readVisibleServices: vi.fn(),
}));

import { readVisibleServices } from "../dev-services.ts";

function service(
  partial: Partial<DevService> & Pick<DevService, "id">,
): DevService {
  return {
    label: partial.id,
    status: "running",
    ...partial,
  };
}

describe("servicesEqual", () => {
  it("returns true for identical ordered lists", () => {
    const list = [
      service({ id: "daemon", label: "daemon", status: "running" }),
      service({ id: "instance", label: "instance", status: "stopped" }),
    ];
    expect(servicesEqual(list, [...list])).toBe(true);
  });

  it("returns false when lengths differ", () => {
    const left = [service({ id: "daemon" })];
    const right = [service({ id: "daemon" }), service({ id: "instance" })];
    expect(servicesEqual(left, right)).toBe(false);
  });

  it("returns false when id, label, or status differs", () => {
    const base = [service({ id: "daemon", label: "daemon", status: "running" })];
    expect(servicesEqual(base, [service({ id: "instance" })])).toBe(false);
    expect(
      servicesEqual(base, [service({ id: "daemon", label: "other" })]),
    ).toBe(false);
    expect(
      servicesEqual(base, [service({ id: "daemon", status: "stopped" })]),
    ).toBe(false);
  });
});

describe("useVisibleServices", () => {
  const daemon = service({ id: "daemon", label: "daemon", status: "running" });
  const instance = service({
    id: "instance",
    label: "instance",
    status: "stopped",
  });

  let mounted: MountedHook<{
    services: DevService[];
    loading: boolean;
    refresh: () => void;
  }> | undefined;

  beforeEach(() => {
    vi.mocked(readVisibleServices).mockReset();
    vi.mocked(readVisibleServices).mockResolvedValue([daemon]);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    vi.useRealTimers();
  });

  it("loads the initial snapshot and refreshes on the poll interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    mounted = mountHook(() => useVisibleServices());
    await mounted.flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mounted.flush();
    expect(mounted.get().services).toEqual([daemon]);

    vi.mocked(readVisibleServices).mockResolvedValue([daemon, instance]);
    await vi.advanceTimersByTimeAsync(15_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mounted.flush();
    expect(mounted.get().services).toEqual([daemon, instance]);
  });

  it("reports loading until the first scan lands, then paints the list", async () => {
    let resolveScan: ((services: DevService[]) => void) | undefined;
    vi.mocked(readVisibleServices).mockImplementation(
      () => new Promise((resolve) => {
        resolveScan = resolve;
      }),
    );
    mounted = mountHook(() => useVisibleServices());
    await mounted.flush();
    expect(mounted.get().loading).toBe(true);
    expect(mounted.get().services).toEqual([]);

    resolveScan!([daemon]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mounted.flush();
    expect(mounted.get().loading).toBe(false);
    expect(mounted.get().services).toEqual([daemon]);
  });

  it("clears loading and keeps the last list when a scan throws", async () => {
    vi.mocked(readVisibleServices).mockRejectedValue(new Error("systemctl gone"));
    mounted = mountHook(() => useVisibleServices());
    await mounted.flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mounted.flush();
    expect(mounted.get().loading).toBe(false);
    expect(mounted.get().services).toEqual([]);
  });

  it("keeps the current list when the snapshot is unchanged", async () => {
    mounted = mountHook(() => useVisibleServices());
    await mounted.flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mounted.flush();
    const first = mounted.get().services;
    vi.mocked(readVisibleServices).mockResolvedValue([
      service({ id: "daemon", label: "daemon", status: "running" }),
    ]);
    mounted.get().refresh();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mounted.flush();
    expect(mounted.get().services).toBe(first);
  });

  it("queues a refresh raised while a scan is in flight instead of dropping it", async () => {
    mounted = mountHook(() => useVisibleServices());
    await mounted.flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mounted.flush();

    let calls = 0;
    vi.mocked(readVisibleServices).mockImplementation(async () => {
      calls += 1;
      // Re-entrant request: must not start a second concurrent scan, but must
      // still run once this one finishes.
      if (calls === 1) {
        mounted?.get().refresh();
      }
      return [instance];
    });
    mounted.get().refresh();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mounted.flush();
    expect(calls).toBe(2);
    expect(mounted.get().services).toEqual([instance]);
  });

  it("drops a scan that resolves after unmount", async () => {
    let resolveScan: ((services: DevService[]) => void) | undefined;
    vi.mocked(readVisibleServices).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        }),
    );
    mounted = mountHook(() => useVisibleServices());
    await mounted.flush();
    expect(mounted.get().loading).toBe(true);
    expect(mounted.get().services).toEqual([]);
    const snapshot = mounted.get();
    mounted.unmount();
    mounted = undefined;
    resolveScan!([daemon]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(snapshot.loading).toBe(true);
    expect(snapshot.services).toEqual([]);
  });

  it("drops a failed scan that rejects after unmount", async () => {
    let rejectScan: ((error: Error) => void) | undefined;
    vi.mocked(readVisibleServices).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectScan = reject;
        }),
    );
    mounted = mountHook(() => useVisibleServices());
    await mounted.flush();
    expect(mounted.get().loading).toBe(true);
    expect(mounted.get().services).toEqual([]);
    const snapshot = mounted.get();
    mounted.unmount();
    mounted = undefined;
    rejectScan!(new Error("systemctl gone"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(snapshot.loading).toBe(true);
    expect(snapshot.services).toEqual([]);
  });
});
