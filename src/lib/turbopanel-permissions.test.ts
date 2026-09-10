import { expect, test, vi } from "vitest";

vi.mock("./dev-identity.ts", () => ({
  tryResolveDevIdentity: vi.fn(() => null),
}));

vi.mock("./install-output.ts", () => ({
  runCaptured: vi.fn(async () => 0),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
  };
});

import { spawnSync } from "node:child_process";
import { tryResolveDevIdentity } from "./dev-identity.ts";
import { runCaptured } from "./install-output.ts";
import {
  ensureDevUserDockerAccess,
  ensureFhsTreeOwnership,
  isDevEnvironment,
  refreshDevPermissionsQuietly,
} from "./turbopanel-permissions.ts";

const mockedTryResolve = vi.mocked(tryResolveDevIdentity);
const mockedRunCaptured = vi.mocked(runCaptured);
const mockedSpawnSync = vi.mocked(spawnSync);

test("isDevEnvironment is false when TURBOPANEL_RUNTIME=production", () => {
  const prev = process.env.TURBOPANEL_RUNTIME;
  process.env.TURBOPANEL_RUNTIME = "production";
  mockedTryResolve.mockReturnValue({ user: "dev", uid: 1000, gid: 1000 });
  try {
    expect(isDevEnvironment()).toBe(false);
  } finally {
    if (prev === undefined) {
      delete process.env.TURBOPANEL_RUNTIME;
    } else {
      process.env.TURBOPANEL_RUNTIME = prev;
    }
  }
});

test("isDevEnvironment requires a resolvable non-root identity", () => {
  const prev = process.env.TURBOPANEL_RUNTIME;
  delete process.env.TURBOPANEL_RUNTIME;
  mockedTryResolve.mockReturnValue(null);
  try {
    expect(isDevEnvironment()).toBe(false);
    mockedTryResolve.mockReturnValue({ user: "dev", uid: 1000, gid: 1000 });
    expect(isDevEnvironment()).toBe(true);
  } finally {
    if (prev !== undefined) {
      process.env.TURBOPANEL_RUNTIME = prev;
    }
  }
});

test("ensureFhsTreeOwnership no-ops outside development", async () => {
  mockedTryResolve.mockReturnValue(null);
  mockedRunCaptured.mockClear();
  await ensureFhsTreeOwnership();
  expect(mockedRunCaptured).not.toHaveBeenCalled();
});

test("ensureFhsTreeOwnership chowns via sudo when identity resolves", async () => {
  mockedTryResolve.mockReturnValue({ user: "dev", uid: 1000, gid: 1000 });
  mockedRunCaptured.mockResolvedValue(0);
  await ensureFhsTreeOwnership();
  expect(mockedRunCaptured).toHaveBeenCalled();
  const cmd = mockedRunCaptured.mock.calls[0]![0] as string[];
  expect(cmd.slice(0, 3)).toEqual(["sudo", "-n", "bash"]);
  expect(String(cmd[4])).toContain("chown");
  expect(String(cmd[4])).toContain("dev");
});

function spawnRet(
  status: number,
  stdout = "",
  stderr = "",
): ReturnType<typeof spawnSync> {
  return {
    status,
    stdout,
    stderr,
    pid: 0,
    output: ["", stdout, stderr],
    signal: null,
  } as ReturnType<typeof spawnSync>;
}

test("ensureDevUserDockerAccess returns false when docker is absent", async () => {
  mockedTryResolve.mockReturnValue({ user: "dev", uid: 1000, gid: 1000 });
  mockedSpawnSync.mockReturnValue(spawnRet(1));
  await expect(ensureDevUserDockerAccess()).resolves.toBe(false);
});

test("ensureDevUserDockerAccess returns false when identity is missing", async () => {
  mockedTryResolve.mockReturnValue(null);
  mockedSpawnSync.mockReturnValue(spawnRet(0, "docker:x:999:"));
  await expect(ensureDevUserDockerAccess()).resolves.toBe(false);
});

test("ensureDevUserDockerAccess returns true when usermod reports changed", async () => {
  mockedTryResolve.mockReturnValue({ user: "dev", uid: 1000, gid: 1000 });
  mockedSpawnSync.mockImplementation((command) => {
    const cmd = String(command);
    if (cmd === "getent") {
      return spawnRet(0, "docker:x:999:");
    }
    if (cmd === "sudo") {
      return spawnRet(0, "changed\n");
    }
    return spawnRet(1);
  });
  await expect(ensureDevUserDockerAccess()).resolves.toBe(true);
  const sudoCall = mockedSpawnSync.mock.calls.find(
    ([command]) => String(command) === "sudo",
  );
  if (sudoCall === undefined) {
    throw new TypeError("expected sudo usermod invocation");
  }
  expect(String(sudoCall[1]?.[3])).toContain("usermod -aG docker");
});

test("ensureDevUserDockerAccess returns false when the user is already in docker", async () => {
  mockedTryResolve.mockReturnValue({ user: "dev", uid: 1000, gid: 1000 });
  mockedSpawnSync.mockImplementation((command) => {
    const cmd = String(command);
    if (cmd === "getent") {
      return spawnRet(0, "docker:x:999:dev");
    }
    if (cmd === "sudo") {
      return spawnRet(0, "unchanged\n");
    }
    return spawnRet(1);
  });
  await expect(ensureDevUserDockerAccess()).resolves.toBe(false);
});

test("ensureDevUserDockerAccess throws when sudo usermod fails", async () => {
  mockedTryResolve.mockReturnValue({ user: "dev", uid: 1000, gid: 1000 });
  const lines: string[] = [];
  mockedSpawnSync.mockImplementation((command) => {
    const cmd = String(command);
    if (cmd === "getent") {
      return spawnRet(0, "docker:x:999:");
    }
    if (cmd === "sudo") {
      return spawnRet(1, "", "usermod: permission denied\n");
    }
    return spawnRet(1);
  });
  await expect(ensureDevUserDockerAccess((line) => lines.push(line))).rejects.toThrow(
    "Failed to add dev user to docker group",
  );
  expect(lines).toContain("usermod: permission denied");
});

test("refreshDevPermissionsQuietly no-ops when not in development", () => {
  mockedTryResolve.mockReturnValue(null);
  mockedRunCaptured.mockClear();
  refreshDevPermissionsQuietly();
  expect(mockedRunCaptured).not.toHaveBeenCalled();
});

test("ensureFhsTreeOwnership no-ops when identity vanishes after the env check", async () => {
  mockedTryResolve
    .mockReturnValueOnce({ user: "dev", uid: 1000, gid: 1000 })
    .mockReturnValueOnce(null);
  mockedRunCaptured.mockClear();
  await ensureFhsTreeOwnership();
  expect(mockedRunCaptured).not.toHaveBeenCalled();
});

test("ensureDevUserDockerAccess treats a docker socket as present", async () => {
  mockedTryResolve.mockReturnValue({ user: "dev", uid: 1000, gid: 1000 });
  mockedSpawnSync.mockImplementation((command) => {
    const cmd = String(command);
    if (cmd === "getent") {
      return spawnRet(1);
    }
    if (cmd === "test") {
      return spawnRet(0);
    }
    if (cmd === "sudo") {
      return spawnRet(0, "changed\n");
    }
    return spawnRet(1);
  });
  await expect(ensureDevUserDockerAccess()).resolves.toBe(true);
});

test("ensureDevUserDockerAccess falls back to command -v docker", async () => {
  mockedTryResolve.mockReturnValue({ user: "dev", uid: 1000, gid: 1000 });
  mockedSpawnSync.mockImplementation((command) => {
    const cmd = String(command);
    if (cmd === "sudo") {
      return { ...spawnRet(0), stdout: undefined as unknown as string };
    }
    if (cmd === "sh") {
      return spawnRet(0);
    }
    return spawnRet(1);
  });
  await expect(ensureDevUserDockerAccess()).resolves.toBe(false);
});

test("ensureDevUserDockerAccess throws when sudo usermod fails without stderr", async () => {
  mockedTryResolve.mockReturnValue({ user: "dev", uid: 1000, gid: 1000 });
  const lines: string[] = [];
  mockedSpawnSync.mockImplementation((command) => {
    const cmd = String(command);
    if (cmd === "getent") {
      return spawnRet(0, "docker:x:999:");
    }
    if (cmd === "sudo") {
      return { ...spawnRet(1), stderr: undefined as unknown as string };
    }
    return spawnRet(1);
  });
  await expect(ensureDevUserDockerAccess((line) => lines.push(line))).rejects.toThrow(
    "Failed to add dev user to docker group",
  );
  expect(lines).toEqual([""]);
});

test("refreshDevPermissionsQuietly refreshes ownership in development", async () => {
  mockedTryResolve.mockReturnValue({ user: "dev", uid: 1000, gid: 1000 });
  mockedRunCaptured.mockResolvedValue(0);
  mockedSpawnSync.mockImplementation((command) => {
    const cmd = String(command);
    if (cmd === "getent") {
      return spawnRet(0, "docker:x:999:");
    }
    if (cmd === "sudo") {
      return spawnRet(0, "changed\n");
    }
    return spawnRet(1);
  });
  refreshDevPermissionsQuietly();
  await vi.waitFor(() => {
    expect(mockedRunCaptured).toHaveBeenCalled();
  });
});

test("refreshDevPermissionsQuietly swallows refresh failures", async () => {
  mockedTryResolve.mockReturnValue({ user: "dev", uid: 1000, gid: 1000 });
  mockedRunCaptured.mockRejectedValue(new Error("sudo failed"));
  refreshDevPermissionsQuietly();
  await vi.waitFor(() => {
    expect(mockedRunCaptured).toHaveBeenCalled();
  });
});
