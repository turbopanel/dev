import { describe, expect, it } from "vitest";
import { createTtyStream, mountHook } from "./ink-hook-render.ts";

describe("createTtyStream", () => {
  it("looks like an interactive TTY so Ink will accept it as stdin", () => {
    const stream = createTtyStream();
    expect(stream.isTTY).toBe(true);
    expect(stream.columns).toBe(80);
    expect(stream.rows).toBe(24);
    stream.setRawMode(true);
    stream.ref();
    stream.unref();
  });
});

describe("mountHook", () => {
  it("throws when the hook has not produced a value", () => {
    const mounted = mountHook(() => undefined as undefined);
    try {
      expect(() => mounted.get()).toThrow(TypeError);
      expect(() => mounted.get()).toThrow("hook has not rendered");
    } finally {
      mounted.unmount();
    }
  });

  it("returns the hook value after a successful render", async () => {
    const mounted = mountHook(() => 7);
    try {
      await mounted.flush();
      expect(mounted.get()).toBe(7);
      mounted.rerender();
      await mounted.flush();
      expect(mounted.get()).toBe(7);
    } finally {
      mounted.unmount();
    }
  });
});
