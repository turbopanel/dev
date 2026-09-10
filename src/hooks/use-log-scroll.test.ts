import { afterEach, describe, expect, it } from "vitest";
import type { Key } from "ink";
import { mountHook, type MountedHook } from "./ink-hook-render.ts";
import {
  applyLogScrollKey,
  lastLogScrollIndex,
  useLogScroll,
  type LogScrollState,
} from "./use-log-scroll.ts";

function key(partial: Partial<Key>): Key {
  return partial as Key;
}

describe("lastLogScrollIndex", () => {
  it("returns zero for empty logs", () => {
    expect(lastLogScrollIndex(0)).toBe(0);
  });

  it("returns the last zero-based index", () => {
    expect(lastLogScrollIndex(5)).toBe(4);
  });
});

describe("applyLogScrollKey", () => {
  const base: LogScrollState = { scrollIndex: 5, followTail: false };

  it("returns null for unhandled keys", () => {
    expect(applyLogScrollKey(base, key({}), 10, 3)).toBeNull();
  });

  it("scrolls up one line and disables tail follow", () => {
    expect(applyLogScrollKey(base, key({ upArrow: true }), 10, 3)).toEqual({
      scrollIndex: 4,
      followTail: false,
    });
  });

  it("clamps upward scroll at zero", () => {
    expect(
      applyLogScrollKey(
        { scrollIndex: 0, followTail: true },
        key({ upArrow: true }),
        10,
        3,
      ),
    ).toEqual({ scrollIndex: 0, followTail: false });
  });

  it("scrolls up one page", () => {
    expect(applyLogScrollKey(base, key({ pageUp: true }), 20, 4)).toEqual({
      scrollIndex: 1,
      followTail: false,
    });
  });

  it("scrolls down one line without re-enabling follow before the tail", () => {
    expect(applyLogScrollKey(base, key({ downArrow: true }), 10, 3)).toEqual({
      scrollIndex: 6,
      followTail: false,
    });
  });

  it("re-enables follow when down-arrow reaches the tail", () => {
    expect(
      applyLogScrollKey(
        { scrollIndex: 8, followTail: false },
        key({ downArrow: true }),
        10,
        3,
      ),
    ).toEqual({ scrollIndex: 9, followTail: true });
  });

  it("scrolls down one page and follows when landing on the tail", () => {
    expect(
      applyLogScrollKey(
        { scrollIndex: 6, followTail: false },
        key({ pageDown: true }),
        10,
        4,
      ),
    ).toEqual({ scrollIndex: 9, followTail: true });
  });

  it("scrolls down one page without re-enabling follow before the tail", () => {
    expect(
      applyLogScrollKey(
        { scrollIndex: 2, followTail: false },
        key({ pageDown: true }),
        20,
        3,
      ),
    ).toEqual({ scrollIndex: 5, followTail: false });
  });

  it("jumps to the tail on End", () => {
    expect(applyLogScrollKey(base, key({ end: true }), 10, 3)).toEqual({
      scrollIndex: 9,
      followTail: true,
    });
  });

  it("jumps to the top on Home", () => {
    expect(applyLogScrollKey(base, key({ home: true }), 10, 3)).toEqual({
      scrollIndex: 0,
      followTail: false,
    });
  });
});

describe("useLogScroll", () => {
  type ScrollProps = {
    lineCount: number;
    viewportHeight: number;
    focused: boolean;
    resetKey?: string | number;
    followResetKey?: number;
  };

  let mounted: MountedHook<{
    scrollIndex: number;
    handleLogKey: (next: Key) => void;
  }> | undefined;

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("pins to the tail on mount and follows growing logs", async () => {
    const props: ScrollProps = {
      lineCount: 5,
      viewportHeight: 3,
      focused: true,
    };
    mounted = mountHook(() => useLogScroll(props));
    await mounted.flush();
    expect(mounted.get().scrollIndex).toBe(4);

    props.lineCount = 6;
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().scrollIndex).toBe(5);
  });

  it("re-pins when reset keys change and when focus returns", async () => {
    const props: ScrollProps = {
      lineCount: 6,
      viewportHeight: 3,
      focused: false,
      resetKey: "a",
      followResetKey: 0,
    };
    mounted = mountHook(() => useLogScroll(props));
    await mounted.flush();
    mounted.get().handleLogKey(key({ upArrow: true }));
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().scrollIndex).toBe(4);

    props.resetKey = "b";
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().scrollIndex).toBe(5);

    props.followResetKey = 1;
    mounted.rerender();
    await mounted.flush();
    mounted.get().handleLogKey(key({ home: true }));
    await mounted.flush();
    expect(mounted.get().scrollIndex).toBe(0);

    props.focused = true;
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().scrollIndex).toBe(5);
  });

  it("applies key handlers and ignores unhandled keys", async () => {
    const props: ScrollProps = {
      lineCount: 10,
      viewportHeight: 4,
      focused: true,
    };
    mounted = mountHook(() => useLogScroll(props));
    await mounted.flush();
    mounted.get().handleLogKey(key({}));
    mounted.get().handleLogKey(key({ pageUp: true }));
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().scrollIndex).toBe(6);
    mounted.get().handleLogKey(key({ end: true }));
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().scrollIndex).toBe(9);
  });

  it("does not follow the tail after the user scrolls into history", async () => {
    const props: ScrollProps = {
      lineCount: 10,
      viewportHeight: 3,
      focused: true,
    };
    mounted = mountHook(() => useLogScroll(props));
    await mounted.flush();
    mounted.get().handleLogKey(key({ upArrow: true }));
    mounted.get().handleLogKey(key({ upArrow: true }));
    mounted.rerender();
    await mounted.flush();
    const held = mounted.get().scrollIndex;
    props.lineCount = 14;
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().scrollIndex).toBe(held);
  });
});
