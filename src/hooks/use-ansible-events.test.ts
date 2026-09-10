import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SetStateAction } from "react";
import type { AnsibleTaskRow } from "@turbopanel/components/ansible-task-list.tsx";
import { formatAnsibleHostFailure } from "../lib/ansible-failure.ts";
import { CONSOLE_LAST_TASK_ERROR_LOG } from "../lib/paths.ts";
import { writeTaskErrorLog } from "../lib/task-error-log.ts";
import { mountHook, type MountedHook } from "./ink-hook-render.ts";
import {
  buildAnsibleTaskView,
  dispatchAnsibleUiEvent,
  resolveDevConvergeSkippedUi,
  useAnsibleEvents,
  type AnsibleUiSetters,
} from "./use-ansible-events.ts";

vi.mock("../lib/task-error-log.ts", () => ({
  writeTaskErrorLog: vi.fn(async () => true),
}));

const HERE = dirname(fileURLToPath(import.meta.url));

describe("resolveDevConvergeSkippedUi", () => {
  it("sets recap and done immediately for a skip event", () => {
    const reason = "dev converge stamp matches (orchestration inputs unchanged)";
    expect(
      resolveDevConvergeSkippedUi({
        _event: "dev_converge_skipped",
        reason,
      }),
    ).toEqual({
      recap: `Development environment already converged — ${reason}`,
      done: true,
    });
  });

  it("returns null for ordinary Ansible stats so the hook keeps processing", () => {
    expect(
      resolveDevConvergeSkippedUi({
        _event: "v2_playbook_on_stats",
        stats: { localhost: { ok: 1, changed: 0, failures: 0 } },
      }),
    ).toBeNull();
  });

  it("returns null for malformed skip payloads", () => {
    expect(resolveDevConvergeSkippedUi(null)).toBeNull();
    expect(
      resolveDevConvergeSkippedUi({
        _event: "dev_converge_skipped",
        reason: 12,
      }),
    ).toBeNull();
  });
});

describe("formatAnsibleHostFailure", () => {
  it("appends stderr when Ansible only reports non-zero return code", () => {
    expect(
      formatAnsibleHostFailure({
        localhost: {
          msg: "non-zero return code",
          stderr: "bootstrap-dev-db: missing drizzle-kit — run pnpm install\n",
        },
      }),
    ).toBe(
      "non-zero return code\nbootstrap-dev-db: missing drizzle-kit — run pnpm install",
    );
  });

  it("falls back to stdout when stderr is empty", () => {
    expect(
      formatAnsibleHostFailure({
        localhost: {
          msg: "non-zero return code",
          stdout: "pnpm migrate failed",
        },
      }),
    ).toBe("non-zero return code\npnpm migrate failed");
  });

  it("returns task failed when the host result has no text", () => {
    expect(formatAnsibleHostFailure({ localhost: {} })).toBe("task failed");
  });

  it("surfaces drizzle-kit stderr when msg is only non-zero return code", () => {
    expect(
      formatAnsibleHostFailure({
        localhost: {
          msg: "non-zero return code",
          stderr: "Please install latest version of drizzle-orm\n",
        },
      }),
    ).toBe(
      "non-zero return code\nPlease install latest version of drizzle-orm",
    );
  });
});

describe("useAnsibleEvents skip wiring", () => {
  it("applies skipped UI state via resolveDevConvergeSkippedUi then returns", () => {
    const source = readFileSync(join(HERE, "use-ansible-events.ts"), "utf8");
    const onEventStart = source.indexOf("const onEvent = useCallback");
    expect(onEventStart).toBeGreaterThanOrEqual(0);
    const body = source.slice(onEventStart);
    const resolveCall = body.indexOf("resolveDevConvergeSkippedUi(event)");
    const setRecap = body.indexOf("setRecap(skipped.recap)");
    const setDone = body.indexOf("setDone(skipped.done)");
    const earlyReturn = body.indexOf("return;", setDone);
    expect(resolveCall).toBeGreaterThanOrEqual(0);
    expect(setRecap).toBeGreaterThan(resolveCall);
    expect(setDone).toBeGreaterThan(setRecap);
    expect(earlyReturn).toBeGreaterThan(setDone);
  });
});

type AnsibleUiState = {
  tasks: AnsibleTaskRow[];
  recap: string | null;
  error: string | null;
  errorLogPath: string | null;
  done: boolean;
};

function applyUpdate<T>(current: T, update: SetStateAction<T>): T {
  if (typeof update === "function") {
    return (update as (prev: T) => T)(current);
  }
  return update;
}

function createUi(): { state: AnsibleUiState; setters: AnsibleUiSetters } {
  const state: AnsibleUiState = {
    tasks: [],
    recap: null,
    error: null,
    errorLogPath: null,
    done: false,
  };
  const setters: AnsibleUiSetters = {
    setTasks: (update) => {
      state.tasks = applyUpdate(state.tasks, update);
    },
    setRecap: (update) => {
      state.recap = applyUpdate(state.recap, update);
    },
    setError: (update) => {
      state.error = applyUpdate(state.error, update);
    },
    setErrorLogPath: (update) => {
      state.errorLogPath = applyUpdate(state.errorLogPath, update);
    },
    setDone: (update) => {
      state.done = applyUpdate(state.done, update);
    },
  };
  return { state, setters };
}

describe("dispatchAnsibleUiEvent", () => {
  beforeEach(() => {
    vi.mocked(writeTaskErrorLog).mockReset();
    vi.mocked(writeTaskErrorLog).mockResolvedValue(true);
  });

  it("starts a play by uuid and closes a previous running play", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_playbook_on_play_start", {
      play: { name: "First", uuid: "one" },
    }, setters);
    dispatchAnsibleUiEvent("v2_playbook_on_play_start", {
      play: { name: "Second", uuid: "two" },
    }, setters);
    expect(state.tasks).toEqual([
      { id: "play:one", label: "First", status: "ok", depth: 1 },
      { id: "play:two", label: "Second", status: "running", depth: 1 },
    ]);
  });

  it("falls back to play when the play name is missing", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_playbook_on_play_start", {
      play: { uuid: "anon" },
    }, setters);
    expect(state.tasks[0]).toEqual({
      id: "play:anon",
      label: "play",
      status: "running",
      depth: 1,
    });
  });

  it("falls back to the play name when uuid is missing", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_playbook_on_play_start", {
      play: { name: "  postgres  " },
    }, setters);
    expect(state.tasks[0]).toEqual({
      id: "play:postgres",
      label: "postgres",
      status: "running",
      depth: 1,
    });
  });

  it("leaves non-running plays in place when a later play starts", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_playbook_on_play_start", {
      play: { name: "First", uuid: "one" },
    }, setters);
    dispatchAnsibleUiEvent("v2_playbook_on_task_start", {
      task: { id: "t1", name: "Work" },
    }, setters);
    dispatchAnsibleUiEvent("v2_playbook_on_play_start", {
      play: { name: "Second", uuid: "two" },
    }, setters);
    expect(state.tasks).toEqual([
      { id: "play:one", label: "First", status: "ok", depth: 1 },
      {
        id: "task:t1",
        label: "Work",
        status: "running",
        depth: 2,
      },
      { id: "play:two", label: "Second", status: "running", depth: 1 },
    ]);
  });

  it("starts tasks from start and handler events", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_playbook_on_task_start", {
      task: { id: "t1", name: "postgres : Create user" },
    }, setters);
    dispatchAnsibleUiEvent("v2_playbook_on_handler_task_start", {
      task: { name: "Restart caddy" },
    }, setters);
    dispatchAnsibleUiEvent("v2_runner_on_start", {
      task: { id: "t1", name: "postgres : Create user" },
    }, setters);
    expect(state.tasks).toEqual([
      {
        id: "task:t1",
        label: "postgres › Create user",
        status: "running",
        depth: 2,
      },
      {
        id: "task:Restart caddy",
        label: "Restart caddy",
        status: "running",
        depth: 2,
      },
    ]);
  });

  it("uses a generic task name when the event omits one", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_playbook_on_task_start", {
      task: { id: "t1" },
    }, setters);
    expect(state.tasks[0]).toEqual({
      id: "task:t1",
      label: "task",
      status: "running",
      depth: 2,
    });
  });

  it("marks runner ok as changed when the host result changed", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_runner_on_ok", {
      task: { id: "t1", name: "Install" },
      hosts: { localhost: { changed: true } },
    }, setters);
    expect(state.tasks[0]?.status).toBe("changed");
  });

  it("marks runner ok as ok when hosts are missing", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_runner_on_ok", {
      task: { id: "t1", name: "Install" },
    }, setters);
    expect(state.tasks[0]?.status).toBe("ok");
  });

  it("marks runner ok as ok when the host result is unchanged", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_runner_on_ok", {
      task: { id: "t1", name: "Install" },
      hosts: { localhost: { changed: false } },
    }, setters);
    expect(state.tasks[0]?.status).toBe("ok");
  });

  it("marks skipped runner results", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_runner_on_skipped", {
      task: { id: "t1", name: "Optional" },
    }, setters);
    expect(state.tasks[0]?.status).toBe("skipped");
  });

  it("marks failed runner results and records the error log path", async () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_runner_on_failed", {
      task: { id: "t1", name: "Boom" },
      hosts: { localhost: { msg: "non-zero return code", stderr: "nope" } },
    }, setters);
    expect(state.tasks[0]?.status).toBe("failed");
    expect(state.error).toBe("non-zero return code\nnope");
    await Promise.resolve();
    expect(state.errorLogPath).toBe(CONSOLE_LAST_TASK_ERROR_LOG);
  });

  it("uses task failed when a failure has no host results", async () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_runner_on_unreachable", {
      task: { name: "Ping" },
    }, setters);
    expect(state.tasks[0]).toMatchObject({
      id: "task:Ping",
      status: "failed",
    });
    expect(state.error).toBe("task failed");
    await Promise.resolve();
    expect(state.errorLogPath).toBe(CONSOLE_LAST_TASK_ERROR_LOG);
  });

  it("leaves the error log path unset when the write fails", async () => {
    vi.mocked(writeTaskErrorLog).mockResolvedValueOnce(false);
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_runner_on_failed", {
      task: { id: "t1", name: "Boom" },
    }, setters);
    await Promise.resolve();
    expect(state.error).toBe("task failed");
    expect(state.errorLogPath).toBeNull();
  });

  it("counts missing recap fields as zero and leaves finished tasks alone", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_playbook_on_task_start", {
      task: { id: "t1", name: "Work" },
    }, setters);
    dispatchAnsibleUiEvent("v2_runner_on_ok", {
      task: { id: "t1", name: "Work" },
    }, setters);
    dispatchAnsibleUiEvent("v2_playbook_on_task_start", {
      task: { id: "t2", name: "More" },
    }, setters);
    dispatchAnsibleUiEvent("v2_playbook_on_stats", {
      stats: { localhost: {} },
    }, setters);
    expect(state.tasks.map((task) => task.status)).toEqual(["ok", "ok"]);
    expect(state.recap).toBe("ok=0 changed=0 failed=0");
    expect(state.done).toBe(false);
  });

  it("completes running tasks and sets recap on successful stats", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_playbook_on_task_start", {
      task: { id: "t1", name: "Work" },
    }, setters);
    dispatchAnsibleUiEvent("v2_playbook_on_stats", {
      stats: { localhost: { ok: 2, changed: 1, failures: 0 } },
    }, setters);
    expect(state.tasks[0]?.status).toBe("ok");
    expect(state.recap).toBe("ok=2 changed=1 failed=0");
    expect(state.done).toBe(false);
  });

  it("marks a failed recap done when stats report failures", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_playbook_on_task_start", {
      task: { id: "t1", name: "Work" },
    }, setters);
    dispatchAnsibleUiEvent("v2_playbook_on_stats", {
      stats: { localhost: { ok: 0, changed: 0, failed: 1 } },
    }, setters);
    expect(state.tasks[0]?.status).toBe("failed");
    expect(state.recap).toBe("ok=0 changed=0 failed=1");
    expect(state.done).toBe(true);
  });

  it("completes running tasks without a recap when stats are omitted", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_playbook_on_task_start", {
      task: { id: "t1", name: "Work" },
    }, setters);
    dispatchAnsibleUiEvent("v2_playbook_on_stats", {}, setters);
    expect(state.tasks[0]?.status).toBe("ok");
    expect(state.recap).toBeNull();
    expect(state.done).toBe(false);
  });

  it("ignores unknown event types", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_playbook_on_no_hosts_matched", {}, setters);
    expect(state.tasks).toEqual([]);
    expect(state.done).toBe(false);
  });

  it("keeps the raw task name when the role/task split is empty", () => {
    const { state, setters } = createUi();
    dispatchAnsibleUiEvent("v2_playbook_on_task_start", {
      task: { name: "postgres :" },
    }, setters);
    dispatchAnsibleUiEvent("v2_playbook_on_task_start", {
      task: { name: ": Create user" },
    }, setters);
    expect(state.tasks.map((task) => task.label)).toEqual([
      "postgres :",
      ": Create user",
    ]);
  });
});

describe("buildAnsibleTaskView", () => {
  function row(
    id: string,
    status: AnsibleTaskRow["status"],
  ): AnsibleTaskRow {
    return { id, label: id, status, depth: 1 };
  }

  it("returns an empty view for no tasks", () => {
    expect(buildAnsibleTaskView([], 8)).toEqual({
      visibleTasks: [],
      hiddenCount: 0,
      followIndex: 0,
    });
  });

  it("shows every task when the list fits the budget", () => {
    const tasks = [row("a", "ok"), row("b", "running")];
    const view = buildAnsibleTaskView(tasks, 5);
    expect(view.visibleTasks).toEqual(tasks);
    expect(view.hiddenCount).toBe(0);
    expect(view.followIndex).toBe(1);
  });

  it("slides a window over a long list and keeps the last pinned task in view", () => {
    const tasks = [
      row("1", "ok"),
      row("2", "ok"),
      row("3", "ok"),
      row("4", "running"),
    ];
    const view = buildAnsibleTaskView(tasks, 3);
    expect(view.hiddenCount).toBeGreaterThan(0);
    expect(view.visibleTasks.at(-1)?.id).toBe("4");
  });

  it("clamps the window when pinned tasks span more than the budget", () => {
    const tasks = [
      row("1", "failed"),
      row("2", "ok"),
      row("3", "ok"),
      row("4", "ok"),
      row("5", "running"),
    ];
    const view = buildAnsibleTaskView(tasks, 2);
    expect(view.visibleTasks.length).toBeLessThanOrEqual(2);
    expect(view.visibleTasks.some((task) => task.status === "running")).toBe(
      true,
    );
  });

  it("treats a zero row budget as one visible row", () => {
    const tasks = [row("1", "ok"), row("2", "ok")];
    const view = buildAnsibleTaskView(tasks, 0);
    expect(view.visibleTasks).toHaveLength(1);
  });
});

describe("useAnsibleEvents", () => {
  type Hook = ReturnType<typeof useAnsibleEvents>;
  let mounted: MountedHook<Hook> | undefined;

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("skips converge-already-done events and ignores malformed payloads", async () => {
    mounted = mountHook(() => useAnsibleEvents());
    await mounted.flush();
    mounted.get().onEvent({
      _event: "dev_converge_skipped",
      reason: "stamp matches",
    });
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().recap).toContain("already converged");
    expect(mounted.get().done).toBe(true);

    mounted.get().onEvent(null);
    mounted.get().onEvent({ play: { name: "no event type" } });
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().tasks).toEqual([]);
  });

  it("dispatches play events, emitStep, and reset", async () => {
    mounted = mountHook(() => useAnsibleEvents());
    await mounted.flush();
    mounted.get().onEvent({
      _event: "v2_playbook_on_play_start",
      play: { name: "postgres", uuid: "p1" },
    });
    mounted.get().emitStep("Bootstrap Deno", "running");
    mounted.get().emitStep("Converge", "running");
    mounted.get().emitStep("Converge", "ok");
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().tasks.map((task) => task.label)).toEqual([
      "postgres",
      "Bootstrap Deno",
      "Converge",
    ]);
    expect(mounted.get().tasks.find((task) => task.label === "Bootstrap Deno")?.status)
      .toBe("ok");
    expect(mounted.get().tasks.find((task) => task.label === "Converge")?.status)
      .toBe("ok");

    mounted.get().reset();
    mounted.rerender();
    await mounted.flush();
    expect(mounted.get().tasks).toEqual([]);
    expect(mounted.get().recap).toBeNull();
    expect(mounted.get().done).toBe(false);
  });
});

