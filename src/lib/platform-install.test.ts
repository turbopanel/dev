import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, test, vi } from "vitest";

vi.mock("./apt.ts", () => ({
  aptGetInstall: vi.fn(async () => 0),
}));

vi.mock("./install-output.ts", () => ({
  runCaptured: vi.fn(async () => 0),
}));

vi.mock("./spawn-trusted.ts", () => ({
  spawnSyncTrusted: vi.fn(() => ({ status: 0 })),
  spawnSyncTrustedText: vi.fn(() => ({
    status: 1,
    stdout: "",
    stderr: "",
    pid: 1,
    output: ["", "", ""],
    signal: null,
  })),
}));

import { aptGetInstall } from "./apt.ts";
import { runCaptured } from "./install-output.ts";
import { spawnSyncTrusted, spawnSyncTrustedText } from "./spawn-trusted.ts";
import {
  ensureAllGitHooksPaths,
  installDaemon,
  isUsableDaemonCheckout,
} from "./platform-install.ts";

const mockedAptGetInstall = vi.mocked(aptGetInstall);
const mockedRunCaptured = vi.mocked(runCaptured);
const mockedSpawnSyncTrusted = vi.mocked(spawnSyncTrusted);
const mockedSpawnSyncTrustedText = vi.mocked(spawnSyncTrustedText);

const tempRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  mockedAptGetInstall.mockReset();
  mockedRunCaptured.mockReset();
  mockedSpawnSyncTrusted.mockReset();
  mockedSpawnSyncTrustedText.mockReset();
  mockedAptGetInstall.mockResolvedValue(0);
  mockedRunCaptured.mockResolvedValue(0);
  mockedSpawnSyncTrusted.mockReturnValue({
    status: 0,
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    pid: 1,
    output: [null, Buffer.from(""), Buffer.from("")],
    signal: null,
  });
  mockedSpawnSyncTrustedText.mockReturnValue({
    status: 1,
    stdout: "",
    stderr: "",
    pid: 1,
    output: ["", "", ""],
    signal: null,
  });
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "tp-platform-install-"));
  tempRoots.push(root);
  return root;
}

function stubCheckoutRoot(root: string): void {
  vi.stubEnv("TURBOPANEL_DEV_ROOT", root);
  vi.stubEnv("TURBOPANEL_DAEMON_REPO", join(root, "turbopaneld"));
  vi.stubEnv("TURBOPANEL_INSTANCE_REPO", join(root, "turbopanel"));
  vi.stubEnv("TURBOPANEL_UI_REPO", join(root, "ui"));
  vi.stubEnv("TURBOPANEL_WEBSITE_REPO", join(root, "website"));
  vi.stubEnv("TURBOPANEL_DEV_REPO", join(root, "dev"));
}

function writeDaemonTree(target: string, kind: "main" | "ansible" = "main"): void {
  mkdirSync(target, { recursive: true });
  if (kind === "main") {
    writeFileSync(join(target, "main.ts"), "// daemon entry\n");
    return;
  }
  mkdirSync(join(target, "orchestration"), { recursive: true });
  writeFileSync(join(target, "orchestration", "ansible.cfg"), "[defaults]\n");
}

function writePreCommitHook(target: string): string {
  const hookDir = join(target, ".githooks");
  mkdirSync(hookDir, { recursive: true });
  const hook = join(hookDir, "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 0\n");
  return hook;
}

function gitTextResult(success: boolean, stdout = "") {
  return {
    status: success ? 0 : 1,
    stdout,
    stderr: success ? "" : "failed",
    pid: 1,
    output: ["", stdout, ""] as [string, string, string],
    signal: null,
  };
}

describe("isUsableDaemonCheckout", () => {
  test("accepts a tree with main.ts (Vagrant mount without working .git)", () => {
    const root = tempDir();
    writeFileSync(join(root, "main.ts"), "// daemon entry\n");
    expect(isUsableDaemonCheckout(root)).toBe(true);
  });

  test("accepts a tree with orchestration/ansible.cfg", () => {
    const root = tempDir();
    mkdirSync(join(root, "orchestration"), { recursive: true });
    writeFileSync(join(root, "orchestration", "ansible.cfg"), "[defaults]\n");
    expect(isUsableDaemonCheckout(root)).toBe(true);
  });

  test("rejects an empty directory", () => {
    const root = tempDir();
    expect(isUsableDaemonCheckout(root)).toBe(false);
  });

  test("rejects a missing path", () => {
    expect(isUsableDaemonCheckout(join(tempDir(), "missing"))).toBe(false);
  });
});

describe("installDaemon", () => {
  it("uses an existing usable checkout and does not clone", async () => {
    const root = tempDir();
    stubCheckoutRoot(root);
    writeDaemonTree(join(root, "turbopaneld"));
    mockedSpawnSyncTrusted.mockReturnValue({
      status: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 1,
      output: [null, Buffer.from(""), Buffer.from("")],
      signal: null,
    });
    const steps: Array<{ label: string; status: string }> = [];

    await installDaemon((label, status) => steps.push({ label, status }));

    expect(mockedRunCaptured).not.toHaveBeenCalled();
    expect(mockedAptGetInstall).not.toHaveBeenCalled();
    expect(steps).toEqual([
      { label: "Use existing turbopaneld checkout", status: "ok" },
      { label: "Daemon repository ready", status: "ok" },
    ]);
  });

  it("rejects a present but unusable tree", async () => {
    const root = tempDir();
    stubCheckoutRoot(root);
    mkdirSync(join(root, "turbopaneld"), { recursive: true });
    mockedSpawnSyncTrusted.mockReturnValue({
      status: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 1,
      output: [null, Buffer.from(""), Buffer.from("")],
      signal: null,
    });

    await expect(installDaemon()).rejects.toThrow(/not a usable daemon checkout/);
    expect(mockedRunCaptured).not.toHaveBeenCalled();
  });

  it("clones when the checkout path is missing", async () => {
    const root = tempDir();
    stubCheckoutRoot(root);
    mockedSpawnSyncTrusted.mockReturnValue({
      status: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 1,
      output: [null, Buffer.from(""), Buffer.from("")],
      signal: null,
    });
    mockedRunCaptured.mockResolvedValue(0);
    const steps: Array<{ label: string; status: string }> = [];

    await installDaemon((label, status) => steps.push({ label, status }));

    expect(mockedRunCaptured).toHaveBeenCalledWith(
      [
        "git",
        "clone",
        "--branch",
        "trunk",
        "git@github.com:TurboPanel/turbopaneld.git",
        join(root, "turbopaneld"),
      ],
      undefined,
    );
    expect(steps).toEqual([
      { label: "Clone turbopaneld", status: "running" },
      { label: "Clone turbopaneld", status: "ok" },
      { label: "Daemon repository ready", status: "ok" },
    ]);
  });

  it("marks clone failed when git clone exits non-zero", async () => {
    const root = tempDir();
    stubCheckoutRoot(root);
    mockedSpawnSyncTrusted.mockReturnValue({
      status: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 1,
      output: [null, Buffer.from(""), Buffer.from("")],
      signal: null,
    });
    mockedRunCaptured.mockResolvedValue(1);
    const steps: Array<{ label: string; status: string }> = [];

    await expect(
      installDaemon((label, status) => steps.push({ label, status })),
    ).rejects.toThrow("Failed to clone turbopaneld");
    expect(steps).toEqual([
      { label: "Clone turbopaneld", status: "running" },
      { label: "Clone turbopaneld", status: "failed" },
    ]);
  });

  it("installs git via apt when it is missing", async () => {
    const root = tempDir();
    stubCheckoutRoot(root);
    writeDaemonTree(join(root, "turbopaneld"), "ansible");
    let gitLooksInstalled = false;
    mockedSpawnSyncTrusted.mockImplementation(() => ({
      status: gitLooksInstalled ? 0 : 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 1,
      output: [null, Buffer.from(""), Buffer.from("")],
      signal: null,
    }));
    mockedAptGetInstall.mockImplementation(async () => {
      gitLooksInstalled = true;
      return 0;
    });
    const steps: Array<{ label: string; status: string }> = [];

    await installDaemon((label, status) => steps.push({ label, status }));

    expect(mockedAptGetInstall).toHaveBeenCalledWith(["git"], undefined, {
      update: true,
    });
    expect(steps[0]).toEqual({ label: "Install git", status: "running" });
    expect(steps[1]).toEqual({ label: "Install git", status: "ok" });
  });

  it("fails when apt cannot install git", async () => {
    const root = tempDir();
    stubCheckoutRoot(root);
    mockedSpawnSyncTrusted.mockReturnValue({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 1,
      output: [null, Buffer.from(""), Buffer.from("")],
      signal: null,
    });
    mockedAptGetInstall.mockResolvedValue(1);
    const steps: Array<{ label: string; status: string }> = [];

    await expect(
      installDaemon((label, status) => steps.push({ label, status })),
    ).rejects.toThrow("Failed to install git");
    expect(steps).toEqual([
      { label: "Install git", status: "running" },
      { label: "Install git", status: "failed" },
    ]);
  });

  it("fails when apt succeeds but git is still missing", async () => {
    const root = tempDir();
    stubCheckoutRoot(root);
    mockedSpawnSyncTrusted.mockReturnValue({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 1,
      output: [null, Buffer.from(""), Buffer.from("")],
      signal: null,
    });
    mockedAptGetInstall.mockResolvedValue(0);

    await expect(installDaemon()).rejects.toThrow("Failed to install git");
  });
});

describe("ensureAllGitHooksPaths", () => {
  it("skips trees without a pre-commit hook", () => {
    const root = tempDir();
    stubCheckoutRoot(root);
    writeDaemonTree(join(root, "turbopaneld"));
    ensureAllGitHooksPaths();
    expect(mockedSpawnSyncTrustedText).not.toHaveBeenCalled();
  });

  it("skips a hook tree that is not a git repo", () => {
    const root = tempDir();
    stubCheckoutRoot(root);
    const target = join(root, "turbopaneld");
    writeDaemonTree(target);
    writePreCommitHook(target);
    mockedSpawnSyncTrustedText.mockReturnValue(gitTextResult(false));
    const steps: Array<{ label: string; status: string }> = [];

    ensureAllGitHooksPaths((label, status) => steps.push({ label, status }));

    expect(steps).toEqual([]);
    expect(mockedSpawnSyncTrustedText).toHaveBeenCalled();
  });

  it("sets core.hooksPath when a git checkout is not yet wired", () => {
    const root = tempDir();
    stubCheckoutRoot(root);
    const target = join(root, "ui");
    mkdirSync(target, { recursive: true });
    writePreCommitHook(target);
    mockedSpawnSyncTrustedText.mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs.includes("rev-parse")) return gitTextResult(true, ".git");
      if (gitArgs.includes("--get")) return gitTextResult(true, "");
      if (gitArgs.at(-1) === ".githooks") return gitTextResult(true);
      return gitTextResult(false);
    });
    const steps: Array<{ label: string; status: string }> = [];

    ensureAllGitHooksPaths((label, status) => steps.push({ label, status }));

    expect(steps.some((step) => step.label.includes(target) && step.status === "ok"))
      .toBe(true);
  });

  it("does not rewrite hooksPath when it is already .githooks", () => {
    const root = tempDir();
    stubCheckoutRoot(root);
    const target = join(root, "website");
    mkdirSync(target, { recursive: true });
    writePreCommitHook(target);
    mockedSpawnSyncTrustedText.mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs.includes("rev-parse")) return gitTextResult(true, ".git");
      if (gitArgs.includes("--get")) return gitTextResult(true, ".githooks");
      return gitTextResult(false, "should not set");
    });

    ensureAllGitHooksPaths();

    const setCalls = mockedSpawnSyncTrustedText.mock.calls.filter((call) => {
      const gitArgs = call[1] as string[];
      return gitArgs.includes("core.hooksPath") && gitArgs.at(-1) === ".githooks" &&
        !gitArgs.includes("--get");
    });
    expect(setCalls).toHaveLength(0);
  });

  it("treats missing git stdout and stderr as empty strings", () => {
    const root = tempDir();
    stubCheckoutRoot(root);
    const target = join(root, "website");
    mkdirSync(target, { recursive: true });
    writePreCommitHook(target);
    mockedSpawnSyncTrustedText.mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs.includes("rev-parse") || gitArgs.includes("--get")) {
        return {
          status: 0,
          stdout: undefined as unknown as string,
          stderr: undefined as unknown as string,
          pid: 1,
          output: ["", "", ""],
          signal: null,
        };
      }
      if (gitArgs.at(-1) === ".githooks") return gitTextResult(true);
      return gitTextResult(false);
    });
    const steps: Array<{ label: string; status: string }> = [];

    ensureAllGitHooksPaths((label, status) => steps.push({ label, status }));

    expect(steps.some((step) => step.label.includes(target) && step.status === "ok"))
      .toBe(true);
  });

  it("throws when setting core.hooksPath fails", () => {
    const root = tempDir();
    stubCheckoutRoot(root);
    const target = join(root, "dev");
    mkdirSync(target, { recursive: true });
    writePreCommitHook(target);
    mockedSpawnSyncTrustedText.mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs.includes("rev-parse")) return gitTextResult(true, ".git");
      if (gitArgs.includes("--get")) return gitTextResult(true, "");
      return gitTextResult(false, "config error");
    });
    const steps: Array<{ label: string; status: string }> = [];

    expect(() =>
      ensureAllGitHooksPaths((label, status) => steps.push({ label, status })),
    ).toThrow(`Failed to set core.hooksPath in ${target}`);
    expect(steps.some((step) => step.status === "failed")).toBe(true);
  });
});
