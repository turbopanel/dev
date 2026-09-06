import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("./instance-install.ts", () => ({
  installDevEnvironment: vi.fn(async () => {}),
}));

vi.mock("./install-output.ts", () => ({
  runCaptured: vi.fn(async () => 0),
}));

import { installDevEnvironment } from "./instance-install.ts";
import { runCaptured } from "./install-output.ts";
import {
  resetDevEnvironment,
  type ResetDevEnvironmentDeps,
} from "./reset-dev-environment.ts";

const mockedInstall = vi.mocked(installDevEnvironment);
const mockedRunCaptured = vi.mocked(runCaptured);
const tempRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  mockedInstall.mockReset();
  mockedRunCaptured.mockReset();
  mockedInstall.mockResolvedValue(undefined);
  mockedRunCaptured.mockResolvedValue(0);
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function stubCheckoutRoot(root: string): void {
  vi.stubEnv("TURBOPANEL_DEV_ROOT", root);
  vi.stubEnv("TURBOPANEL_DAEMON_REPO", join(root, "turbopaneld"));
  vi.stubEnv("TURBOPANEL_INSTANCE_REPO", join(root, "turbopanel"));
  vi.stubEnv("TURBOPANEL_UI_REPO", join(root, "ui"));
  vi.stubEnv("TURBOPANEL_WEBSITE_REPO", join(root, "website"));
}

function tempCheckoutRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tp-reset-dev-"));
  tempRoots.push(root);
  stubCheckoutRoot(root);
  return root;
}

test("resetDevEnvironment always rebuilds with force mode after teardown", async () => {
  const installCalls: Array<{ mode?: "if-needed" | "force" }> = [];
  const shellLabels: string[] = [];
  const resetRepos: string[] = [];

  const deps: ResetDevEnvironmentDeps = {
    runShellStep: async (label, _command, _onOutput, onStep) => {
      shellLabels.push(label);
      onStep(label, "running");
      onStep(label, "ok");
    },
    resetRepo: async (repo, _onOutput, onStep) => {
      resetRepos.push(repo);
      onStep(`Reset repo: ${repo}`, "running");
      onStep(`Reset repo: ${repo}`, "ok");
    },
    installDevEnvironment: async (
      _onEvent,
      _onOutput,
      _onStep,
      _installDeps,
      mode,
    ) => {
      installCalls.push({ mode });
    },
  };

  await resetDevEnvironment(() => {}, () => {}, deps);

  expect(shellLabels).toEqual([
    "Stop platform services",
    "Remove Docker containers",
    "Remove Docker volumes",
  ]);
  expect(resetRepos).toEqual(["turbopaneld", "turbopanel", "ui", "website"]);
  expect(installCalls).toEqual([{ mode: "force" }]);
});

test("reset must not call installDevEnvironment without an explicit force mode", async () => {
  const modes: Array<"if-needed" | "force" | undefined> = [];
  const deps: ResetDevEnvironmentDeps = {
    runShellStep: async () => {},
    resetRepo: async () => {},
    installDevEnvironment: async (
      _onEvent,
      _onOutput,
      _onStep,
      _installDeps,
      mode,
    ) => {
      modes.push(mode);
    },
  };

  await resetDevEnvironment(() => {}, () => {}, deps);

  expect(modes).toHaveLength(1);
  expect(modes[0]).toBe("force");
  expect(modes[0]).not.toBe("if-needed");
  expect(modes[0]).not.toBeUndefined();
});

test("default runShellStep records ok when the captured command succeeds", async () => {
  const root = tempCheckoutRoot();
  const steps: Array<{ label: string; status: string }> = [];

  await resetDevEnvironment(
    () => {},
    (label, status) => steps.push({ label, status }),
  );

  expect(mockedRunCaptured.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(
    mockedRunCaptured.mock.calls.every(([cmd]) =>
      Array.isArray(cmd) && cmd[0] === "sudo",
    ),
  ).toBe(true);
  expect(steps.filter((step) => step.status === "ok").length).toBeGreaterThanOrEqual(
    3,
  );
  expect(mockedInstall).toHaveBeenCalledWith(
    expect.any(Function),
    expect.any(Function),
    expect.any(Function),
    undefined,
    "force",
  );
  expect(root.length).toBeGreaterThan(0);
});

test("default runShellStep fails the step when the captured command exits non-zero", async () => {
  tempCheckoutRoot();
  mockedRunCaptured.mockResolvedValue(1);
  const steps: Array<{ label: string; status: string }> = [];

  await expect(
    resetDevEnvironment(
      () => {},
      (label, status) => steps.push({ label, status }),
    ),
  ).rejects.toThrow("Step failed: Stop platform services");
  expect(steps).toEqual([
    { label: "Stop platform services", status: "running" },
    { label: "Stop platform services", status: "failed" },
  ]);
  expect(mockedInstall).not.toHaveBeenCalled();
});

test("default resetRepo skips missing checkouts", async () => {
  tempCheckoutRoot();
  const gitCalls: string[][] = [];
  mockedRunCaptured.mockImplementation(async (cmd) => {
    if (Array.isArray(cmd) && cmd[0] === "bash") {
      gitCalls.push(cmd);
    }
    return 0;
  });

  await resetDevEnvironment(() => {}, () => {});

  expect(gitCalls).toEqual([]);
  expect(mockedInstall).toHaveBeenCalledOnce();
});

test("default resetRepo hard-resets present checkouts as the invoking user", async () => {
  const root = tempCheckoutRoot();
  for (const repo of ["turbopaneld", "turbopanel", "ui", "website"]) {
    mkdirSync(join(root, repo));
  }
  const gitCalls: string[][] = [];
  mockedRunCaptured.mockImplementation(async (cmd) => {
    if (Array.isArray(cmd) && cmd[0] === "bash") {
      gitCalls.push(cmd);
    }
    return 0;
  });
  const steps: Array<{ label: string; status: string }> = [];

  await resetDevEnvironment(
    () => {},
    (label, status) => steps.push({ label, status }),
  );

  expect(gitCalls).toHaveLength(4);
  expect(gitCalls.every((cmd) => cmd[0] === "bash" && cmd[1] === "-c")).toBe(
    true,
  );
  expect(gitCalls[0]?.[2]).toContain("git -C");
  expect(gitCalls[0]?.[2]).toContain("reset --hard origin/trunk");
  expect(
    steps.some(
      (step) =>
        step.label === "Reset repo: turbopaneld" && step.status === "ok",
    ),
  ).toBe(true);
});

test("default resetRepo fails the step when git exits non-zero", async () => {
  const root = tempCheckoutRoot();
  mkdirSync(join(root, "turbopaneld"));
  mockedRunCaptured.mockImplementation(async (cmd) => {
    if (Array.isArray(cmd) && cmd[0] === "bash") {
      return 1;
    }
    return 0;
  });
  const steps: Array<{ label: string; status: string }> = [];

  await expect(
    resetDevEnvironment(
      () => {},
      (label, status) => steps.push({ label, status }),
    ),
  ).rejects.toThrow("Step failed: Reset repo: turbopaneld");
  expect(
    steps.some(
      (step) =>
        step.label === "Reset repo: turbopaneld" && step.status === "failed",
    ),
  ).toBe(true);
  expect(mockedInstall).not.toHaveBeenCalled();
});
