import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, test, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn } from "node:child_process";
import { TRUSTED_SYSTEM_PATH } from "./spawn-trusted.ts";
import {
  appendOutputLines,
  captureChildEnv,
  RUN_CAPTURED_ABORTED_EXIT,
  runCaptured,
  sanitizeInstallOutput,
} from "./install-output.ts";

const mockedSpawn = vi.mocked(spawn);

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(opts: {
  stdoutChunks?: Array<string | Buffer>;
  stderrChunks?: Array<string | Buffer>;
  code?: number | null;
  error?: Error;
  holdOpen?: boolean;
}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    child.emit("close", null);
    return true;
  });
  queueMicrotask(() => {
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
    if (!opts.holdOpen) {
      child.emit("close", opts.code === undefined ? 0 : opts.code);
    }
  });
  return child;
}

function stubSpawn(opts: Parameters<typeof fakeChild>[0]): FakeChild {
  const child = fakeChild(opts);
  mockedSpawn.mockImplementation(
    () => child as unknown as ReturnType<typeof spawn>,
  );
  return child;
}

afterEach(() => {
  mockedSpawn.mockReset();
});

test("captureChildEnv defaults PATH to trusted FHS dirs", () => {
  const env = captureChildEnv({ FOO: "bar" });
  expect(env.FOO).toBe("bar");
  expect(env.PATH).toBe(TRUSTED_SYSTEM_PATH);
  expect(env.CI).toBe("1");
});

test("captureChildEnv keeps an explicit caller PATH (vendored Node/Deno)", () => {
  const path = "/opt/turbopanel/vendor/node/current/bin:/usr/bin:/bin";
  const env = captureChildEnv({ PATH: path, FOO: "bar" });
  expect(env.PATH).toBe(path);
  expect(env.FOO).toBe("bar");
});

test("captureChildEnv treats a blank PATH as missing", () => {
  const env = captureChildEnv({ PATH: "" });
  expect(env.PATH).toBe(TRUSTED_SYSTEM_PATH);
});

test("captureChildEnv with no extra still sets trusted PATH", () => {
  expect(captureChildEnv().PATH).toBe(TRUSTED_SYSTEM_PATH);
});

describe("appendOutputLines", () => {
  it("keeps lines when under the cap", () => {
    expect(appendOutputLines(["a"], "b", 4)).toEqual(["a", "b"]);
  });

  it("drops oldest lines when over the default cap of 8", () => {
    const lines = ["1", "2", "3", "4", "5", "6", "7", "8"];
    expect(appendOutputLines(lines, "9")).toEqual([
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
  });
});

describe("sanitizeInstallOutput", () => {
  it("strips OSC BEL sequences, ANSI, and carriage returns", () => {
    const bel = String.fromCodePoint(7);
    const osc = `\u001b]0;title${bel}`;
    const ansi = "\u001b[31mred\u001b[0m";
    expect(sanitizeInstallOutput(`${osc}${ansi}\r leftover  `)).toBe(
      "red leftover",
    );
  });
});

describe("runCaptured", () => {
  it("emits trimmed stdout and stderr lines", async () => {
    stubSpawn({
      stdoutChunks: ["hello\n", "\n", "  \n"],
      stderrChunks: [Buffer.from("warn\n")],
    });
    const lines: string[] = [];
    const code = await runCaptured(["echo", "unused"], (line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines).toEqual(["hello", "warn"]);
  });

  it("ignores chunks when no output handler is provided", async () => {
    stubSpawn({ stdoutChunks: ["silent\n"] });
    await expect(runCaptured(["true"])).resolves.toBe(0);
  });

  it("injects sudo -n when the caller omitted it", async () => {
    stubSpawn({});
    await runCaptured(["sudo", "true"]);
    const argv = mockedSpawn.mock.calls[0];
    if (argv === undefined) {
      throw new TypeError("expected spawn argv");
    }
    expect(argv[0]).toBe("sudo");
    expect(argv[1]).toEqual(["-n", "true"]);
  });

  it("leaves an already-noninteractive sudo command unchanged", async () => {
    stubSpawn({});
    await runCaptured(["sudo", "-n", "true"]);
    const argv = mockedSpawn.mock.calls[0];
    if (argv === undefined) {
      throw new TypeError("expected spawn argv");
    }
    expect(argv[1]).toEqual(["-n", "true"]);
  });

  it("returns the aborted exit code when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const code = await runCaptured(["sleep", "30"], undefined, {
      signal: controller.signal,
    });
    expect(code).toBe(RUN_CAPTURED_ABORTED_EXIT);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("SIGTERMs the child when aborted mid-run", async () => {
    const controller = new AbortController();
    const child = stubSpawn({ holdOpen: true });
    const pending = runCaptured(["sleep", "30"], undefined, {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toBe(RUN_CAPTURED_ABORTED_EXIT);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("resolves 1 when spawn emits error", async () => {
    stubSpawn({ error: new Error("ENOENT") });
    await expect(runCaptured(["/missing/bin"])).resolves.toBe(1);
  });

  it("treats a null close code as failure", async () => {
    stubSpawn({ code: null });
    await expect(runCaptured(["true"])).resolves.toBe(1);
  });
});
