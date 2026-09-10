import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import type { OptionalDevServiceSelection } from "./optional-dev-services.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock("./daemon-exec.ts", () => ({
  ensureOrchestrationDenoBin: vi.fn(async () => "/mock/deno"),
  orchestrationActionCommand: vi.fn(
    (args: readonly string[], options?: { denoBin?: string }) =>
      `${options?.denoBin ?? "deno"} orch ${[...args].join(" ")}`,
  ),
}));

vi.mock("./dev-identity.ts", () => ({
  resolveDevIdentity: vi.fn(() => ({ user: "dev", uid: 1000, gid: 1000 })),
}));

vi.mock("./optional-dev-services.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./optional-dev-services.ts")>();
  return {
    ...actual,
    readOptionalDevServices: vi.fn(() => actual.defaultOptionalSelection()),
  };
});

import { spawn } from "node:child_process";
import { ensureOrchestrationDenoBin, orchestrationActionCommand } from "./daemon-exec.ts";
import { defaultOptionalSelection, readOptionalDevServices } from "./optional-dev-services.ts";
import {
  DEV_ENV_CONVERGE_STEP,
  installDevEnvironment,
  type InstallDevEnvironmentDeps,
  runOrchestrationAction,
} from "./instance-install.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

type Call = { name: string; args?: unknown; options?: unknown };

function makeDeps(
  overrideFactory: (calls: Call[]) => Partial<InstallDevEnvironmentDeps> = () => ({}),
): {
  deps: InstallDevEnvironmentDeps;
  calls: Call[];
} {
  const calls: Call[] = [];
  const deps: InstallDevEnvironmentDeps = {
    ensureDevUserDockerAccess: async () => {
      calls.push({ name: "ensureDevUserDockerAccess" });
      return false;
    },
    ensureOrchestrationDeno: async () => {
      calls.push({ name: "ensureOrchestrationDeno" });
      return "/opt/turbopanel/vendor/deno/current/deno";
    },
    runOrchestrationAction: async (actionArgs, _onEvent, _onOutput, options) => {
      calls.push({ name: "runOrchestrationAction", args: actionArgs, options });
    },
    writeDaemonInstanceEnv: () => {
      calls.push({ name: "writeDaemonInstanceEnv" });
    },
    isDaemonSystemdInstalled: () => {
      calls.push({ name: "isDaemonSystemdInstalled" });
      return true;
    },
    installDaemonSystemd: async () => {
      calls.push({ name: "installDaemonSystemd" });
    },
    isDaemonServiceActive: () => {
      calls.push({ name: "isDaemonServiceActive" });
      return true;
    },
    requestDaemonRestart: async () => {
      calls.push({ name: "requestDaemonRestart" });
    },
    enableAndStartDaemon: async () => {
      calls.push({ name: "enableAndStartDaemon" });
    },
    ...overrideFactory(calls),
  };
  return { deps, calls };
}

test("failed Ansible converge must not write TURBOPANEL_DEV_INSTANCE opt-in", async () => {
  const { deps, calls } = makeDeps((calls) => ({
    runOrchestrationAction: async () => {
      calls.push({ name: "runOrchestrationAction" });
      throw new Error("Install Docker via geerlingguy.docker Galaxy role");
    },
  }));
  const steps: Array<{ label: string; status: string }> = [];

  await expect(
    installDevEnvironment(
      () => {},
      undefined,
      (label, status) => steps.push({ label, status }),
      deps,
    ),
  ).rejects.toThrow(/geerlingguy\.docker/);

  expect(calls.map((call) => call.name)).toEqual([
    "ensureOrchestrationDeno",
    "ensureDevUserDockerAccess",
    "runOrchestrationAction",
  ]);
  expect(calls.some((call) => call.name === "writeDaemonInstanceEnv")).toBe(false);
  expect(calls.some((call) => call.name === "requestDaemonRestart")).toBe(false);
  expect(steps).toEqual([
    { label: "Ensure Deno runtime", status: "running" },
    { label: "Ensure Deno runtime", status: "ok" },
    { label: DEV_ENV_CONVERGE_STEP, status: "running" },
    { label: DEV_ENV_CONVERGE_STEP, status: "failed" },
  ]);
});

test("successful converge writes opt-in only after Ansible, then restarts daemon", async () => {
  const { deps, calls } = makeDeps();
  const steps: Array<{ label: string; status: string }> = [];

  await installDevEnvironment(
    () => {},
    undefined,
    (label, status) => {
      steps.push({ label, status });
    },
    deps,
  );

  expect(calls.map((call) => call.name)).toEqual([
    "ensureOrchestrationDeno",
    "ensureDevUserDockerAccess",
    "runOrchestrationAction",
    "writeDaemonInstanceEnv",
    "isDaemonSystemdInstalled",
    "isDaemonServiceActive",
    "requestDaemonRestart",
  ]);
  expect(steps).toEqual([
    { label: "Ensure Deno runtime", status: "running" },
    { label: "Ensure Deno runtime", status: "ok" },
    { label: DEV_ENV_CONVERGE_STEP, status: "running" },
    { label: DEV_ENV_CONVERGE_STEP, status: "ok" },
  ]);

  const orchIndex = calls.findIndex((call) => call.name === "runOrchestrationAction");
  const optInIndex = calls.findIndex((call) => call.name === "writeDaemonInstanceEnv");
  const restartIndex = calls.findIndex((call) => call.name === "requestDaemonRestart");
  expect(orchIndex).toBeGreaterThanOrEqual(0);
  expect(optInIndex).toBeGreaterThan(orchIndex);
  expect(restartIndex).toBeGreaterThan(optInIndex);
  // Default mode is force so legacy callers never inherit skip-by-stamp.
  expect(calls[orchIndex]?.args).toEqual(["instance-dev-install"]);
  expect(calls[orchIndex]?.options).toEqual({
    denoBin: "/opt/turbopanel/vendor/deno/current/deno",
    mode: "force",
  });
});

test("optionalServices are forwarded to runOrchestrationAction", async () => {
  const { deps, calls } = makeDeps();
  const optionalServices: OptionalDevServiceSelection = {
    dbstudio: true,
    smtp: false,
    ui: true,
    website: false,
    redisinsight: true,
    stripe: false,
  };

  await installDevEnvironment(
    () => {},
    undefined,
    undefined,
    deps,
    "if-needed",
    optionalServices,
  );

  const orch = calls.find((call) => call.name === "runOrchestrationAction");
  expect(orch?.options).toEqual({
    denoBin: "/opt/turbopanel/vendor/deno/current/deno",
    mode: "if-needed",
    optionalServices,
  });
});

test("if-needed mode passes --if-needed and mode option to orchestration", async () => {
  const { deps, calls } = makeDeps();

  await installDevEnvironment(() => {}, undefined, undefined, deps, "if-needed");

  const orch = calls.find((call) => call.name === "runOrchestrationAction");
  expect(orch?.args).toEqual(["instance-dev-install", "--if-needed"]);
  expect(orch?.options).toEqual({
    denoBin: "/opt/turbopanel/vendor/deno/current/deno",
    mode: "if-needed",
  });
});

test("force mode omits --if-needed and passes mode force", async () => {
  const { deps, calls } = makeDeps();

  await installDevEnvironment(() => {}, undefined, undefined, deps, "force");

  const orch = calls.find((call) => call.name === "runOrchestrationAction");
  expect(orch?.args).toEqual(["instance-dev-install"]);
  expect(orch?.options).toEqual({
    denoBin: "/opt/turbopanel/vendor/deno/current/deno",
    mode: "force",
  });
});

test("successful converge restores opt-in after systemd unit install", async () => {
  const { deps, calls } = makeDeps((calls) => ({
    isDaemonSystemdInstalled: () => {
      calls.push({ name: "isDaemonSystemdInstalled" });
      return false;
    },
    isDaemonServiceActive: () => {
      calls.push({ name: "isDaemonServiceActive" });
      return false;
    },
  }));

  await installDevEnvironment(() => {}, undefined, undefined, deps);

  expect(calls.map((call) => call.name)).toEqual([
    "ensureOrchestrationDeno",
    "ensureDevUserDockerAccess",
    "runOrchestrationAction",
    "writeDaemonInstanceEnv",
    "isDaemonSystemdInstalled",
    "installDaemonSystemd",
    "writeDaemonInstanceEnv",
    "isDaemonServiceActive",
    "enableAndStartDaemon",
  ]);
});

test("failed Ensure Deno runtime must not mutate Docker access, run Ansible, or write opt-in", async () => {
  const denoError = new Error("Failed to install Deno");
  const { deps, calls } = makeDeps((calls) => ({
    ensureOrchestrationDeno: async () => {
      calls.push({ name: "ensureOrchestrationDeno" });
      throw denoError;
    },
  }));
  const steps: Array<{ label: string; status: string }> = [];

  await expect(
    installDevEnvironment(
      () => {},
      undefined,
      (label, status) => steps.push({ label, status }),
      deps,
    ),
  ).rejects.toThrow(denoError);

  expect(calls.map((call) => call.name)).toEqual([
    "ensureOrchestrationDeno",
  ]);
  expect(calls.some((call) => call.name === "ensureDevUserDockerAccess")).toBe(false);
  expect(calls.some((call) => call.name === "runOrchestrationAction")).toBe(false);
  expect(calls.some((call) => call.name === "writeDaemonInstanceEnv")).toBe(false);
  expect(steps).toEqual([
    { label: "Ensure Deno runtime", status: "running" },
    { label: "Ensure Deno runtime", status: "failed" },
  ]);
});

test("instance-install.ts source keeps opt-in after the Ansible try/catch", () => {
  // Belt-and-suspenders: even without running the injectable path, the source
  // must not write TURBOPANEL_DEV_INSTANCE before runOrchestrationAction.
  const source = readFileSync(join(HERE, "instance-install.ts"), "utf8");
  const fnStart = source.indexOf("export async function installDevEnvironment");
  expect(fnStart).toBeGreaterThanOrEqual(0);
  const body = source.slice(fnStart);
  const orch = body.indexOf("runOrchestrationAction");
  const firstOptIn = body.indexOf("writeDaemonInstanceEnv");
  expect(orch).toBeGreaterThanOrEqual(0);
  expect(firstOptIn).toBeGreaterThanOrEqual(0);
  expect(firstOptIn).toBeGreaterThan(orch);
});

const mockedSpawn = vi.mocked(spawn);
const mockedEnsureDeno = vi.mocked(ensureOrchestrationDenoBin);
const mockedOrchCommand = vi.mocked(orchestrationActionCommand);
const mockedReadOptional = vi.mocked(readOptionalDevServices);

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

function emitSoon(child: FakeChild, work: () => void): void {
  queueMicrotask(work);
}

function fakeChild(opts: {
  stdoutChunks?: Array<string | Buffer>;
  stderrChunks?: Array<string | Buffer>;
  code?: number | null;
  error?: Error;
}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  emitSoon(child, () => {
    for (const chunk of opts.stdoutChunks ?? []) {
      child.stdout.emit("data", chunk);
    }
    for (const chunk of opts.stderrChunks ?? []) {
      child.stderr.emit("data", chunk);
    }
    if (opts.error) {
      child.emit("error", opts.error);
      return;
    }
    child.emit("close", opts.code ?? 0);
  });
  return child;
}

function stubSpawn(opts: Parameters<typeof fakeChild>[0]): void {
  mockedSpawn.mockImplementation(
    () => fakeChild(opts) as unknown as ReturnType<typeof spawn>,
  );
}

afterEach(() => {
  mockedSpawn.mockReset();
  mockedEnsureDeno.mockReset();
  mockedOrchCommand.mockReset();
  mockedReadOptional.mockReset();
  mockedEnsureDeno.mockResolvedValue("/mock/deno");
  mockedOrchCommand.mockImplementation(
    (args, options) => `${options?.denoBin ?? "deno"} orch ${[...args].join(" ")}`,
  );
  mockedReadOptional.mockImplementation(() => defaultOptionalSelection());
});

describe("runOrchestrationAction", () => {
  it("skips ensure when denoBin is provided and parses JSONL events", async () => {
    const events: unknown[] = [];
    const output: string[] = [];
    stubSpawn({
      stdoutChunks: [
        '{"ok":true,"_event":"ok"}\n',
        "not-json\n",
        "   \n",
        '{"partial":',
        'true}\n',
      ],
    });

    await runOrchestrationAction(
      ["instance-dev-install"],
      (event) => events.push(event),
      (line) => output.push(line),
      { denoBin: "/provided/deno", mode: "if-needed" },
    );

    expect(mockedEnsureDeno).not.toHaveBeenCalled();
    expect(mockedOrchCommand).toHaveBeenCalledWith(["instance-dev-install"], {
      denoBin: "/provided/deno",
    });
    expect(events).toEqual([{ ok: true, _event: "ok" }, { partial: true }]);
    expect(output).toEqual(["not-json"]);

    const envArgs = mockedSpawn.mock.calls[0]?.[1];
    if (!Array.isArray(envArgs)) {
      throw new TypeError("expected /usr/bin/env argv");
    }
    expect(envArgs).not.toContain("TURBOPANEL_FORCE_CONVERGE=1");
    expect(envArgs).toContain("TURBOPANEL_DEV_USER=dev");
    expect(envArgs).toContain("TURBOPANEL_OPTIONAL_DBSTUDIO=true");
  });

  it("ensures Deno when denoBin is omitted and sets FORCE_CONVERGE in force mode", async () => {
    stubSpawn({ stdoutChunks: ['{"ok":true}\n'] });
    const onOutput = vi.fn();
    await runOrchestrationAction(["instance-dev-install"], () => {}, onOutput, {
      mode: "force",
    });
    expect(mockedEnsureDeno).toHaveBeenCalledWith(onOutput);
    const envArgs = mockedSpawn.mock.calls[0]?.[1];
    if (!Array.isArray(envArgs)) {
      throw new TypeError("expected /usr/bin/env argv");
    }
    expect(envArgs).toContain("TURBOPANEL_FORCE_CONVERGE=1");
  });

  it("passes an explicit optional-services selection instead of reading prefs", async () => {
    stubSpawn({});
    const optionalServices: OptionalDevServiceSelection = {
      dbstudio: true,
      smtp: false,
      ui: false,
      website: false,
      redisinsight: true,
      stripe: true,
    };
    await runOrchestrationAction(["ping"], () => {}, undefined, {
      denoBin: "/d",
      optionalServices,
    });
    expect(mockedReadOptional).not.toHaveBeenCalled();
    const envArgs = mockedSpawn.mock.calls[0]?.[1];
    if (!Array.isArray(envArgs)) {
      throw new TypeError("expected /usr/bin/env argv");
    }
    expect(envArgs).toContain("TURBOPANEL_OPTIONAL_DBSTUDIO=true");
    expect(envArgs).toContain("TURBOPANEL_OPTIONAL_REDIS_INSIGHT=true");
    expect(envArgs).toContain("TURBOPANEL_OPTIONAL_STRIPE_LISTEN=true");
    expect(envArgs).toContain("TURBOPANEL_OPTIONAL_UI=false");
  });

  it("flushes a trailing stdout line without a newline on close", async () => {
    const events: unknown[] = [];
    stubSpawn({ stdoutChunks: ['{"flushed":true}'] });
    await runOrchestrationAction(["x"], (event) => events.push(event), undefined, {
      denoBin: "/d",
    });
    expect(events).toEqual([{ flushed: true }]);
  });

  it("prefers an Ansible failed-event message on non-zero exit", async () => {
    stubSpawn({
      code: 1,
      stdoutChunks: [
        JSON.stringify({
          _event: "v2_runner_on_failed",
          task: { name: "Install Docker" },
          hosts: { localhost: { msg: "non-zero return code", stderr: "boom" } },
        }) + "\n",
      ],
    });
    await expect(
      runOrchestrationAction(["x"], () => {}, undefined, { denoBin: "/d" }),
    ).rejects.toThrow(/Install Docker:/);
  });

  it("formats unreachable events and task-only failures", async () => {
    stubSpawn({
      code: 2,
      stdoutChunks: [
        JSON.stringify({
          _event: "v2_runner_on_unreachable",
          task: { name: "Ping host" },
          hosts: null,
        }) + "\n",
      ],
    });
    await expect(
      runOrchestrationAction(["x"], () => {}, undefined, { denoBin: "/d" }),
    ).rejects.toThrow("Ping host");
  });

  it("falls back to Ansible task failed when the event has no task or hosts", async () => {
    stubSpawn({
      code: 1,
      stdoutChunks: [JSON.stringify({ _event: "v2_runner_on_failed" }) + "\n"],
    });
    await expect(
      runOrchestrationAction(["x"], () => {}, undefined, { denoBin: "/d" }),
    ).rejects.toThrow("Ansible task failed");
  });

  it("ignores non-object JSON and non-failure events when building the error", async () => {
    stubSpawn({
      code: 1,
      stdoutChunks: ["null\n", JSON.stringify({ _event: "ok" }) + "\n"],
      stderrChunks: ["stderr exploded\n"],
    });
    await expect(
      runOrchestrationAction(["x"], () => {}, undefined, { denoBin: "/d" }),
    ).rejects.toThrow("stderr exploded");
  });

  it("uses the last non-empty stderr line when per-chunk lines are empty", async () => {
    stubSpawn({
      code: 1,
      stderrChunks: ["\norphan-error\n"],
    });
    await expect(
      runOrchestrationAction(["x"], () => {}, undefined, { denoBin: "/d" }),
    ).rejects.toThrow("orphan-error");
  });

  it("folds blank stderr lines and prefers the last non-empty fragment", async () => {
    stubSpawn({
      code: 1,
      stderrChunks: ["first-error\n", "\n", "   \n", "last-error\n"],
    });
    await expect(
      runOrchestrationAction(["x"], () => {}, undefined, { denoBin: "/d" }),
    ).rejects.toThrow("last-error");
  });

  it("ignores whitespace-only stderr and falls back to stdout", async () => {
    stubSpawn({
      code: 1,
      stderrChunks: ["   \n", "\n  \n"],
      stdoutChunks: ["stdout-fallback\n"],
    });
    await expect(
      runOrchestrationAction(["x"], () => {}, undefined, { denoBin: "/d" }),
    ).rejects.toThrow("stdout-fallback");
  });

  it("falls back to stdout tail then a generic message", async () => {
    stubSpawn({
      code: 1,
      stdoutChunks: ["plain failure text\n"],
    });
    await expect(
      runOrchestrationAction(["x"], () => {}, undefined, { denoBin: "/d" }),
    ).rejects.toThrow("plain failure text");

    stubSpawn({ code: 1 });
    await expect(
      runOrchestrationAction(["x"], () => {}, undefined, { denoBin: "/d" }),
    ).rejects.toThrow("Orchestration action failed");
  });

  it("rejects when spawn emits error", async () => {
    stubSpawn({ error: new Error("ENOENT") });
    await expect(
      runOrchestrationAction(["x"], () => {}, undefined, { denoBin: "/d" }),
    ).rejects.toThrow("ENOENT");
  });

  it("extracts a host-failure detail without a task name", async () => {
    stubSpawn({
      code: 1,
      stdoutChunks: [
        JSON.stringify({
          _event: "v2_runner_on_failed",
          task: "not-an-object",
          hosts: { localhost: { msg: "disk full" } },
        }) + "\n",
      ],
    });
    await expect(
      runOrchestrationAction(["x"], () => {}, undefined, { denoBin: "/d" }),
    ).rejects.toThrow("disk full");
  });
});

