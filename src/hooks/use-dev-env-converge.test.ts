import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Dispatch, SetStateAction } from "react";
import { appendConvergeServiceLogLine } from "../lib/converge-service-log.ts";
import { CONSOLE_LAST_TASK_ERROR_LOG } from "../lib/paths.ts";
import { mountHook, type MountedHook } from "./ink-hook-render.ts";
import {
  resolvePhaseFromAnsibleName,
  taskResultStatus,
  trackConvergeServiceEvent,
  useDevEnvConverge,
  type ConvergeServicePhase,
} from "./use-dev-env-converge.ts";

vi.mock("../lib/converge-service-log.ts", () => ({
  appendConvergeServiceLogLine: vi.fn(),
}));

vi.mock("../lib/instance-install.ts", () => ({
  DEV_ENV_CONVERGE_STEP: "Converge development environment (Ansible)",
  installDevEnvironment: vi.fn(),
}));

vi.mock("../lib/optional-dev-services.ts", () => ({
  applyOptionalDevServices: vi.fn(),
  readOptionalDevServices: vi.fn(),
  writeOptionalDevServices: vi.fn(),
}));

vi.mock("../lib/task-error-log.ts", () => ({
  writeTaskErrorLog: vi.fn(),
}));

import { installDevEnvironment } from "../lib/instance-install.ts";
import {
  applyOptionalDevServices,
  readOptionalDevServices,
  writeOptionalDevServices,
} from "../lib/optional-dev-services.ts";
import { writeTaskErrorLog } from "../lib/task-error-log.ts";

function createTracker() {
  const currentServiceId = { current: null as string | null };
  let phases: Record<string, ConvergeServicePhase> = {};
  const setServicePhases: Dispatch<
    SetStateAction<Record<string, ConvergeServicePhase>>
  > = (update) => {
    if (typeof update === "function") {
      phases = update(phases);
      return;
    }
    phases = update;
  };
  return {
    currentServiceId,
    get phases() {
      return phases;
    },
    track(event: unknown) {
      trackConvergeServiceEvent(event, currentServiceId, setServicePhases);
    },
  };
}

describe("trackConvergeServiceEvent", () => {
  beforeEach(() => {
    vi.mocked(appendConvergeServiceLogLine).mockReset();
  });

  it("ignores non-Ansible JSONL payloads", () => {
    const tracker = createTracker();
    tracker.track(null);
    tracker.track("v2_playbook_on_play_start");
    tracker.track({ play: { name: "postgres" } });
    expect(tracker.currentServiceId.current).toBeNull();
    expect(tracker.phases).toEqual({});
  });

  it("marks a mapped play as installing and a build play as compiling", () => {
    const tracker = createTracker();
    tracker.track({
      _event: "v2_playbook_on_play_start",
      play: { name: "postgres" },
    });
    expect(tracker.currentServiceId.current).toBe("db");
    expect(tracker.phases).toEqual({ db: "installing" });
    tracker.track({
      _event: "v2_playbook_on_play_start",
      play: { name: "instance-build" },
    });
    expect(tracker.currentServiceId.current).toBe("instance");
    expect(tracker.phases).toEqual({ db: "ready", instance: "compiling" });
  });

  it("does not close the current service when the same play repeats", () => {
    const tracker = createTracker();
    tracker.track({
      _event: "v2_playbook_on_play_start",
      play: { name: "postgres" },
    });
    tracker.track({
      _event: "v2_playbook_on_play_start",
      play: { name: "postgres" },
    });
    expect(tracker.phases).toEqual({ db: "installing" });
  });

  it("clears the current service for unmapped play names", () => {
    const tracker = createTracker();
    tracker.track({
      _event: "v2_playbook_on_play_start",
      play: { name: "postgres" },
    });
    tracker.track({
      _event: "v2_playbook_on_play_start",
      play: { name: "unrelated play" },
    });
    expect(tracker.currentServiceId.current).toBeNull();
    expect(tracker.phases).toEqual({ db: "ready" });
  });

  it("advances the current service from a mapped task start", () => {
    const tracker = createTracker();
    tracker.track({
      _event: "v2_playbook_on_task_start",
      task: { name: "docker : Install engine" },
    });
    expect(tracker.currentServiceId.current).toBe("daemon");
    expect(tracker.phases).toEqual({ daemon: "installing" });
    tracker.track({
      _event: "v2_runner_on_start",
      task: { name: "caddy : compile assets" },
    });
    expect(tracker.currentServiceId.current).toBe("caddy");
    expect(tracker.phases.caddy).toBe("compiling");
  });

  it("leaves phases unchanged for an unmapped task name", () => {
    const tracker = createTracker();
    tracker.track({
      _event: "v2_runner_on_start",
      task: { name: "Gather facts" },
    });
    expect(tracker.currentServiceId.current).toBeNull();
    expect(tracker.phases).toEqual({});
  });

  it("appends a converge log line for runner results on the current service", () => {
    const tracker = createTracker();
    tracker.track({
      _event: "v2_playbook_on_play_start",
      play: { name: "caddy" },
    });
    tracker.track({
      _event: "v2_runner_on_ok",
      task: { name: "Reload" },
      hosts: { localhost: { changed: true } },
    });
    tracker.track({
      _event: "v2_runner_on_ok",
      task: { name: "Noop" },
    });
    tracker.track({
      _event: "v2_runner_on_skipped",
      task: { name: "  " },
    });
    expect(appendConvergeServiceLogLine).toHaveBeenCalledTimes(3);
    expect(appendConvergeServiceLogLine).toHaveBeenNthCalledWith(
      1,
      "caddy",
      "Reload [changed]",
      expect.any(String),
    );
    expect(appendConvergeServiceLogLine).toHaveBeenNthCalledWith(
      2,
      "caddy",
      "Noop [ok]",
      expect.any(String),
    );
    expect(appendConvergeServiceLogLine).toHaveBeenNthCalledWith(
      3,
      "caddy",
      "task [skipped]",
      expect.any(String),
    );
  });

  it("does not log runner results before a service is current", () => {
    const tracker = createTracker();
    tracker.track({
      _event: "v2_runner_on_failed",
      task: { name: "Boom" },
    });
    expect(appendConvergeServiceLogLine).not.toHaveBeenCalled();
  });

  it("marks the finishing service ready on stats", () => {
    const tracker = createTracker();
    tracker.track({
      _event: "v2_playbook_on_play_start",
      play: { name: "mailpit" },
    });
    tracker.track({ _event: "v2_playbook_on_stats", stats: {} });
    expect(tracker.currentServiceId.current).toBeNull();
    expect(tracker.phases).toEqual({ smtp: "ready" });
    tracker.track({ _event: "v2_playbook_on_stats", stats: {} });
    expect(tracker.currentServiceId.current).toBeNull();
  });

  it("records unreachable and failed statuses from the current service", () => {
    const tracker = createTracker();
    tracker.track({
      _event: "v2_playbook_on_play_start",
      play: { name: "redis" },
    });
    tracker.track({
      _event: "v2_runner_on_unreachable",
      task: { name: "Ping" },
    });
    tracker.track({
      _event: "v2_runner_on_failed",
      task: { name: "Start" },
    });
    expect(appendConvergeServiceLogLine).toHaveBeenNthCalledWith(
      1,
      "cache",
      "Ping [unreachable]",
      expect.any(String),
    );
    expect(appendConvergeServiceLogLine).toHaveBeenNthCalledWith(
      2,
      "cache",
      "Start [failed]",
      expect.any(String),
    );
  });
});

describe("resolvePhaseFromAnsibleName", () => {
  it("marks build and compile plays as compiling", () => {
    expect(resolvePhaseFromAnsibleName("instance-build")).toBe("compiling");
    expect(resolvePhaseFromAnsibleName("ui-compile")).toBe("compiling");
  });

  it("marks ordinary plays as installing", () => {
    expect(resolvePhaseFromAnsibleName("postgres")).toBe("installing");
  });
});

describe("taskResultStatus", () => {
  it("maps runner results to status labels", () => {
    expect(taskResultStatus("v2_runner_on_ok", { localhost: { changed: true } }))
      .toBe("changed");
    expect(taskResultStatus("v2_runner_on_ok", { localhost: { changed: false } }))
      .toBe("ok");
    expect(taskResultStatus("v2_runner_on_ok", undefined)).toBe("ok");
    expect(taskResultStatus("v2_runner_on_skipped", undefined)).toBe("skipped");
    expect(taskResultStatus("v2_runner_on_unreachable", undefined)).toBe(
      "unreachable",
    );
    expect(taskResultStatus("v2_runner_on_failed", undefined)).toBe("failed");
  });
});

const OPTIONAL_SELECTION = {
  dbstudio: false,
  smtp: true,
  ui: true,
  website: true,
  redisinsight: false,
  stripe: false,
};

describe("useDevEnvConverge", () => {
  type Hook = ReturnType<typeof useDevEnvConverge>;
  let mounted: MountedHook<Hook> | undefined;
  const onFinished = vi.fn();

  beforeEach(() => {
    onFinished.mockReset();
    vi.mocked(installDevEnvironment).mockReset();
    vi.mocked(applyOptionalDevServices).mockReset();
    vi.mocked(readOptionalDevServices).mockReset();
    vi.mocked(writeOptionalDevServices).mockReset();
    vi.mocked(writeTaskErrorLog).mockReset();
    vi.mocked(installDevEnvironment).mockResolvedValue(undefined);
    vi.mocked(applyOptionalDevServices).mockResolvedValue(undefined);
    vi.mocked(readOptionalDevServices).mockReturnValue(OPTIONAL_SELECTION);
    vi.mocked(writeTaskErrorLog).mockResolvedValue(true);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("runs a successful converge and ignores a second start while running", async () => {
    let release!: () => void;
    vi.mocked(installDevEnvironment).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    mounted = mountHook(() => useDevEnvConverge(onFinished));
    await mounted.flush();
    mounted.get().start("force", OPTIONAL_SELECTION);
    mounted.get().start("if-needed", OPTIONAL_SELECTION);
    mounted.rerender();
    await mounted.flush();
    expect(installDevEnvironment).toHaveBeenCalledTimes(1);
    expect(writeOptionalDevServices).toHaveBeenCalledWith(OPTIONAL_SELECTION);
    expect(mounted.get().state.active).toBe(true);

    release();
    await vi.waitFor(() => {
      expect(onFinished).toHaveBeenCalledWith(true);
    });
    mounted.rerender();
    await mounted.flush();
    expect(applyOptionalDevServices).toHaveBeenCalledWith(OPTIONAL_SELECTION);
    expect(mounted.get().state.active).toBe(false);
  });

  it("reads stored optional services when start is called without a selection", async () => {
    mounted = mountHook(() => useDevEnvConverge(onFinished));
    await mounted.flush();
    mounted.get().start("if-needed");
    await vi.waitFor(() => {
      expect(onFinished).toHaveBeenCalledWith(true);
    });
    expect(readOptionalDevServices).toHaveBeenCalled();
    expect(installDevEnvironment).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
      expect.any(Function),
      undefined,
      "if-needed",
      OPTIONAL_SELECTION,
    );
  });

  it("forwards Ansible events into service-phase tracking", async () => {
    vi.mocked(installDevEnvironment).mockImplementation(
      async (onEvent: (event: unknown) => void) => {
        onEvent({
          _event: "v2_playbook_on_play_start",
          play: { name: "postgres" },
        });
      },
    );
    mounted = mountHook(() => useDevEnvConverge(onFinished));
    await mounted.flush();
    mounted.get().start("force", OPTIONAL_SELECTION);
    await vi.waitFor(() => {
      expect(onFinished).toHaveBeenCalledWith(true);
    });
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().state.servicePhases).toEqual({ db: "ready" });
  });

  it("records an Error, writes the log path, and stays on the error view", async () => {
    vi.mocked(installDevEnvironment).mockRejectedValueOnce(
      new Error("ansible exploded"),
    );
    mounted = mountHook(() => useDevEnvConverge(onFinished));
    await mounted.flush();
    mounted.get().start("force", OPTIONAL_SELECTION);
    await vi.waitFor(() => {
      expect(onFinished).toHaveBeenCalledWith(false);
    });
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().state.error).toBe("ansible exploded");
    expect(mounted.get().state.errorLogPath).toBe(CONSOLE_LAST_TASK_ERROR_LOG);
    expect(mounted.get().state.active).toBe(true);
  });

  it("stringifies non-Error failures and omits the log path when the write fails", async () => {
    vi.mocked(installDevEnvironment).mockRejectedValueOnce("boom");
    vi.mocked(writeTaskErrorLog).mockResolvedValueOnce(false);
    mounted = mountHook(() => useDevEnvConverge(onFinished));
    await mounted.flush();
    mounted.get().start("force", OPTIONAL_SELECTION);
    await vi.waitFor(() => {
      expect(onFinished).toHaveBeenCalledWith(false);
    });
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().state.error).toBe("boom");
    expect(mounted.get().state.errorLogPath).toBeNull();
  });

  it("dismisses the error view", async () => {
    vi.mocked(installDevEnvironment).mockRejectedValueOnce(new Error("nope"));
    mounted = mountHook(() => useDevEnvConverge(onFinished));
    await mounted.flush();
    mounted.get().start("force", OPTIONAL_SELECTION);
    await vi.waitFor(() => {
      expect(onFinished).toHaveBeenCalledWith(false);
    });
    mounted.get().dismissError();
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().state.active).toBe(false);
    expect(mounted.get().state.tasks).toEqual([]);
  });
});
