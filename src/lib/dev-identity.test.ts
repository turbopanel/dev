import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./spawn-trusted.ts", () => ({
  spawnSyncTrustedText: vi.fn(),
}));

import { spawnSyncTrustedText } from "./spawn-trusted.ts";
import {
  DevIdentityError,
  tryResolveDevIdentity,
} from "./dev-identity.ts";

const mockedGetent = vi.mocked(spawnSyncTrustedText);

function passwdLine(
  user: string,
  uid: number,
  gid: number,
): ReturnType<typeof spawnSyncTrustedText> {
  return {
    status: 0,
    stdout: `${user}:x:${uid}:${gid}::/home/${user}:/bin/bash\n`,
    stderr: "",
    pid: 1,
    output: ["", `${user}:x:${uid}:${gid}::/home/${user}:/bin/bash\n`, ""],
    signal: null,
  };
}

describe("resolveDevIdentity", () => {
  beforeEach(() => {
    mockedGetent.mockReset();
    // Clear the module cache of identity by re-importing after each env change
    // — the module caches in `cachedDevIdentity`. Force a fresh module.
  });

  it("resolves a non-root passwd entry for the process UID", async () => {
    vi.resetModules();
    vi.doMock("./spawn-trusted.ts", () => ({
      spawnSyncTrustedText: vi.fn(() => passwdLine("vagrant", 1000, 1000)),
    }));
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(1000);
    const getgid = vi.spyOn(process, "getgid").mockReturnValue(1000);
    try {
      const { resolveDevIdentity: resolve } = await import("./dev-identity.ts");
      expect(resolve()).toEqual({ user: "vagrant", uid: 1000, gid: 1000 });
      expect(resolve()).toEqual({ user: "vagrant", uid: 1000, gid: 1000 });
    } finally {
      getuid.mockRestore();
      getgid.mockRestore();
      vi.resetModules();
    }
  });

  it("uses SUDO_USER when running as root", async () => {
    vi.resetModules();
    const spawn = vi.fn((_command: string, args: readonly string[]) => {
      const query = String(args[1] ?? "");
      if (query === "dev") {
        return passwdLine("dev", 1001, 1001);
      }
      return { status: 1, stdout: "", stderr: "", pid: 0, output: [], signal: null };
    });
    vi.doMock("./spawn-trusted.ts", () => ({
      spawnSyncTrustedText: spawn,
    }));
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(0);
    const prev = process.env.SUDO_USER;
    process.env.SUDO_USER = "dev";
    try {
      const { resolveDevIdentity: resolve } = await import("./dev-identity.ts");
      expect(resolve()).toEqual({ user: "dev", uid: 1001, gid: 1001 });
    } finally {
      getuid.mockRestore();
      if (prev === undefined) {
        delete process.env.SUDO_USER;
      } else {
        process.env.SUDO_USER = prev;
      }
      vi.resetModules();
    }
  });

  it("rejects root without a valid SUDO_USER", async () => {
    vi.resetModules();
    vi.doMock("./spawn-trusted.ts", () => ({
      spawnSyncTrustedText: vi.fn(() => ({
        status: 1,
        stdout: "",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      })),
    }));
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(0);
    const prev = process.env.SUDO_USER;
    delete process.env.SUDO_USER;
    try {
      const { resolveDevIdentity: resolve, DevIdentityError: Err } = await import(
        "./dev-identity.ts"
      );
      expect(() => resolve()).toThrow(Err);
    } finally {
      getuid.mockRestore();
      if (prev !== undefined) {
        process.env.SUDO_USER = prev;
      }
      vi.resetModules();
    }
  });

  it.each([
    {
      name: "a short or invalid passwd line from getent",
      stdout: "broken:x:not-a-uid\n",
    },
    {
      name: "NaN uid/gid fields even when the line has four columns",
      stdout: "user:x:abc:def::/home/user:/bin/sh\n",
    },
    {
      name: "getent success with empty stdout",
      stdout: "",
    },
  ])("rejects $name", async ({ stdout }) => {
    vi.resetModules();
    vi.doMock("./spawn-trusted.ts", () => ({
      spawnSyncTrustedText: vi.fn(() => ({
        status: 0,
        stdout,
        stderr: "",
        pid: 1,
        output: ["", stdout, ""],
        signal: null,
      })),
    }));
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(1000);
    try {
      const { resolveDevIdentity: resolve, DevIdentityError: Err } = await import(
        "./dev-identity.ts"
      );
      expect(() => resolve()).toThrow(Err);
    } finally {
      getuid.mockRestore();
      vi.resetModules();
    }
  });

  it("rejects SUDO_USER that resolves to root", async () => {
    vi.resetModules();
    vi.doMock("./spawn-trusted.ts", () => ({
      spawnSyncTrustedText: vi.fn(() => passwdLine("root", 0, 0)),
    }));
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(0);
    const prev = process.env.SUDO_USER;
    process.env.SUDO_USER = "rootish";
    try {
      const { resolveDevIdentity: resolve, DevIdentityError: Err } = await import(
        "./dev-identity.ts"
      );
      expect(() => resolve()).toThrow(Err);
    } finally {
      getuid.mockRestore();
      if (prev === undefined) {
        delete process.env.SUDO_USER;
      } else {
        process.env.SUDO_USER = prev;
      }
      vi.resetModules();
    }
  });

  it("rejects a non-root UID whose passwd entry is root", async () => {
    vi.resetModules();
    vi.doMock("./spawn-trusted.ts", () => ({
      spawnSyncTrustedText: vi.fn(() => passwdLine("root", 0, 0)),
    }));
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(1000);
    try {
      const { resolveDevIdentity: resolve, DevIdentityError: Err } = await import(
        "./dev-identity.ts"
      );
      expect(() => resolve()).toThrow(Err);
    } finally {
      getuid.mockRestore();
      vi.resetModules();
    }
  });

  it("rejects when getgid is unavailable", async () => {
    vi.resetModules();
    vi.doMock("./spawn-trusted.ts", () => ({
      spawnSyncTrustedText: vi.fn(() => passwdLine("vagrant", 1000, 1000)),
    }));
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(1000);
    const getgid = vi.spyOn(process, "getgid").mockReturnValue(-1);
    try {
      const { resolveDevIdentity: resolve, DevIdentityError: Err } = await import(
        "./dev-identity.ts"
      );
      expect(() => resolve()).toThrow(Err);
    } finally {
      getuid.mockRestore();
      getgid.mockRestore();
      vi.resetModules();
    }
  });

  it("treats a missing process UID as unresolvable", async () => {
    vi.resetModules();
    vi.doMock("./spawn-trusted.ts", () => ({
      spawnSyncTrustedText: vi.fn(() => passwdLine("vagrant", 1000, 1000)),
    }));
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(
      undefined as unknown as number,
    );
    try {
      const { resolveDevIdentity: resolve, DevIdentityError: Err } = await import(
        "./dev-identity.ts"
      );
      expect(() => resolve()).toThrow(Err);
    } finally {
      getuid.mockRestore();
      vi.resetModules();
    }
  });

  it("falls back to the passwd gid when getgid is missing", async () => {
    vi.resetModules();
    vi.doMock("./spawn-trusted.ts", () => ({
      spawnSyncTrustedText: vi.fn(() => passwdLine("vagrant", 1000, 1000)),
    }));
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(1000);
    const getgid = vi.spyOn(process, "getgid").mockReturnValue(
      undefined as unknown as number,
    );
    try {
      const { resolveDevIdentity: resolve } = await import("./dev-identity.ts");
      expect(resolve()).toEqual({ user: "vagrant", uid: 1000, gid: 1000 });
    } finally {
      getuid.mockRestore();
      getgid.mockRestore();
      vi.resetModules();
    }
  });

  it("rejects root when SUDO_USER is the root account", async () => {
    vi.resetModules();
    vi.doMock("./spawn-trusted.ts", () => ({
      spawnSyncTrustedText: vi.fn(() => passwdLine("root", 0, 0)),
    }));
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(0);
    const prev = process.env.SUDO_USER;
    process.env.SUDO_USER = "root";
    try {
      const { resolveDevIdentity: resolve, DevIdentityError: Err } = await import(
        "./dev-identity.ts"
      );
      expect(() => resolve()).toThrow(Err);
    } finally {
      getuid.mockRestore();
      if (prev === undefined) {
        delete process.env.SUDO_USER;
      } else {
        process.env.SUDO_USER = prev;
      }
      vi.resetModules();
    }
  });

  it("tryResolveDevIdentity returns null on failure", async () => {
    vi.resetModules();
    vi.doMock("./spawn-trusted.ts", () => ({
      spawnSyncTrustedText: vi.fn(() => ({
        status: 1,
        stdout: "",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      })),
    }));
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(-1);
    try {
      const { tryResolveDevIdentity: tryResolve } = await import(
        "./dev-identity.ts"
      );
      expect(tryResolve()).toBeNull();
    } finally {
      getuid.mockRestore();
      vi.resetModules();
    }
  });
});

it("DevIdentityError sets name", () => {
  const err = new DevIdentityError("boom");
  expect(err.name).toBe("DevIdentityError");
  expect(err.message).toBe("boom");
});

// Keep a cheap direct import smoke for the already-loaded module in this process.
it("tryResolveDevIdentity is callable in the current process", () => {
  const identity = tryResolveDevIdentity();
  expect(
    identity === null || typeof identity.user === "string",
  ).toBe(true);
});
