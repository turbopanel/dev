import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { RUN_CAPTURED_ABORTED_EXIT } from "./install-output.ts";
import { NODE_BIN, PNPM_BIN, RUNTIMES_DIR } from "./paths.ts";

vi.mock("./daemon-exec.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./daemon-exec.ts")>();
  return {
    ...actual,
    resolveBootstrapDenoBin: vi.fn(() => "/opt/fake/resolved-deno"),
  };
});

import { resolveBootstrapDenoBin } from "./daemon-exec.ts";
import {
  buildTestCommand,
  findTestRepo,
  findTestSuite,
  listAvailableTestRepos,
  runRepoTests,
  TEST_REPO_CATALOG,
  testRepoForServiceId,
  testRunnerPathEnv,
} from "./run-repo-tests.ts";

const tempRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(resolveBootstrapDenoBin).mockClear();
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
  vi.stubEnv("TURBOPANEL_DEV_REPO", join(root, "dev"));
}

test("TEST_REPO_CATALOG covers every checkout dir with at least one suite", () => {
  const ids = TEST_REPO_CATALOG.map((repo) => repo.id).sort((a, b) =>
    a.localeCompare(b)
  );
  expect(ids).toEqual(["dev", "turbopanel", "turbopaneld", "ui", "website"]);
  for (const repo of TEST_REPO_CATALOG) {
    expect(repo.suites.length).toBeGreaterThan(0);
  }
});

test("testRepoForServiceId maps source services onto checkouts", () => {
  expect(testRepoForServiceId("daemon")).toBe("turbopaneld");
  expect(testRepoForServiceId("instance")).toBe("turbopanel");
  expect(testRepoForServiceId("caddy")).toBe("turbopanel");
  expect(testRepoForServiceId("ui")).toBe("ui");
  expect(testRepoForServiceId("website")).toBe("website");
  expect(testRepoForServiceId("db")).toBeNull();
  expect(testRepoForServiceId("smtp")).toBeNull();
});

test("findTestRepo / findTestSuite locate catalog entries", () => {
  const instance = findTestRepo("turbopanel");
  expect(instance?.label).toBe("turbopanel");
  expect(findTestSuite(instance!, "test:coverage")?.detail).toBe(
    "pnpm test:coverage",
  );
  expect(findTestSuite(instance!, "test")).toBeUndefined();
});

test("listAvailableTestRepos filters by presence probe", () => {
  const available = listAvailableTestRepos(
    [
      {
        id: "turbopaneld",
        label: "turbopaneld",
        suites: [{ id: "test", label: "Unit tests", detail: "deno task test" }],
      },
      {
        id: "website",
        label: "website",
        suites: [{ id: "typecheck", label: "Typecheck", detail: "pnpm typecheck" }],
      },
      {
        id: "ui",
        label: "ui",
        suites: [{ id: "test", label: "Unit tests", detail: "pnpm test" }],
      },
    ],
    (repo) => repo === "turbopaneld" || repo === "website",
  );
  expect(available.map((repo) => repo.id)).toEqual(["turbopaneld", "website"]);
});

test("buildTestCommand uses Deno tasks for turbopaneld and pnpm elsewhere", () => {
  const daemon = buildTestCommand("turbopaneld", "test:coverage", {
    resolveDenoBin: () => "/opt/fake/deno",
  });
  expect(daemon.cmd).toEqual(["/opt/fake/deno", "task", "test:coverage"]);
  expect(daemon.cwd).toMatch(/\/turbopaneld$/);

  const instance = buildTestCommand("turbopanel", "test:do", {
    nodeBin: "/opt/fake/node",
    pnpmBin: "/opt/fake/pnpm",
  });
  expect(instance.cmd).toEqual(["/opt/fake/node", "/opt/fake/pnpm", "test:do"]);
  expect(instance.cwd).toMatch(/\/turbopanel$/);
});

test("buildTestCommand rejects suites not offered for the repo", () => {
  expect(() => buildTestCommand("website", "test:do")).toThrow(TypeError);
});

test("every catalog repo offers CI verify and coverage", () => {
  for (const repo of TEST_REPO_CATALOG) {
    expect(findTestSuite(repo, "verify:ci")).toBeDefined();
    expect(findTestSuite(repo, "test:coverage")).toBeDefined();
  }
});

test("buildTestCommand rejects unknown repo ids", () => {
  expect(() =>
    buildTestCommand("missing" as never, "test"),
  ).toThrow(TypeError);
});

test("testRunnerPathEnv prepends vendored Node and Deno bins", () => {
  const env = testRunnerPathEnv("/usr/bin:/bin");
  const parts = env.PATH.split(":");
  expect(parts[0]).toMatch(/\/node\/current\/bin$/);
  expect(parts[1]).toMatch(/\/deno\/current$/);
  expect(parts.slice(-2)).toEqual(["/usr/bin", "/bin"]);
});

test("testRunnerPathEnv defaults to trusted FHS dirs, not the user PATH", () => {
  const env = testRunnerPathEnv();
  const parts = env.PATH.split(":");
  expect(parts[0]).toMatch(/\/node\/current\/bin$/);
  expect(parts[1]).toMatch(/\/deno\/current$/);
  expect(parts).toContain("/usr/bin");
  expect(parts).not.toContain("/home/vagrant/.local/bin");
});

test("testRunnerPathEnv treats a missing or empty base PATH as empty", () => {
  expect(testRunnerPathEnv(undefined).PATH.split(":")[0]).toMatch(
    /\/node\/current\/bin$/,
  );
  expect(testRunnerPathEnv("").PATH.split(":")[0]).toMatch(
    /\/node\/current\/bin$/,
  );
});

test("testRunnerPathEnv does not duplicate vendored prefixes already on PATH", () => {
  const nodePrefix = `${RUNTIMES_DIR}/node/current/bin`;
  const denoPrefix = `${RUNTIMES_DIR}/deno/current`;
  const env = testRunnerPathEnv(`${nodePrefix}:${denoPrefix}:/usr/bin`);
  expect(env.PATH.split(":").filter((part) => part === nodePrefix)).toHaveLength(
    1,
  );
  expect(env.PATH.split(":").filter((part) => part === denoPrefix)).toHaveLength(
    1,
  );
});

test("listAvailableTestRepos uses the default checkout probe", () => {
  const root = mkdtempSync(join(tmpdir(), "tp-run-repo-"));
  tempRoots.push(root);
  stubCheckoutRoot(root);
  mkdirSync(join(root, "turbopaneld"));
  writeFileSync(join(root, "turbopaneld", "deno.json"), "{}\n");
  mkdirSync(join(root, "ui"));
  writeFileSync(join(root, "ui", "package.json"), "{}\n");

  const available = listAvailableTestRepos();
  expect(available.map((repo) => repo.id).sort((a, b) => a.localeCompare(b)))
    .toEqual(["turbopaneld", "ui"]);
});

test("the default turbopaneld probe accepts main.ts or ansible.cfg", () => {
  const root = mkdtempSync(join(tmpdir(), "tp-run-repo-daemon-"));
  tempRoots.push(root);
  stubCheckoutRoot(root);

  mkdirSync(join(root, "turbopaneld", "orchestration"), { recursive: true });
  writeFileSync(
    join(root, "turbopaneld", "orchestration", "ansible.cfg"),
    "[defaults]\n",
  );
  expect(listAvailableTestRepos().map((repo) => repo.id)).toEqual([
    "turbopaneld",
  ]);

  rmSync(join(root, "turbopaneld"), { recursive: true, force: true });
  mkdirSync(join(root, "turbopaneld"));
  writeFileSync(join(root, "turbopaneld", "main.ts"), "// daemon\n");
  expect(listAvailableTestRepos().map((repo) => repo.id)).toEqual([
    "turbopaneld",
  ]);
});

test("buildTestCommand uses vendored node and pnpm when bins are omitted", () => {
  const ui = buildTestCommand("ui", "test");
  expect(ui.cmd).toEqual([NODE_BIN, PNPM_BIN, "test"]);
  expect(ui.label).toBe("pnpm test");
});

test("buildTestCommand resolves Deno itself when resolveDenoBin is omitted", () => {
  const daemon = buildTestCommand("turbopaneld", "test");
  expect(resolveBootstrapDenoBin).toHaveBeenCalledOnce();
  expect(daemon.cmd).toEqual(["/opt/fake/resolved-deno", "task", "test"]);
  expect(daemon.label).toBe("deno task test");
});

test("runRepoTests streams banner lines and reports exit code", async () => {
  const lines: string[] = [];
  const result = await runRepoTests("ui", "test", (line) => lines.push(line), {
    persistLog: false,
    deps: {
      buildCommand: () => ({
        cwd: "/tmp/ui",
        cmd: ["echo", "ok"],
        label: "pnpm test",
      }),
      run: async (_cmd, onLine) => {
        onLine?.("ok");
        return 0;
      },
      pathEnv: () => ({ PATH: "/tmp" }),
    },
  });

  expect(result).toEqual({ exitCode: 0, aborted: false, logPath: null });
  expect(lines[0]).toBe("$ pnpm test");
  expect(lines[1]).toBe("cwd: /tmp/ui");
  expect(lines[2]).toBe("ok");
});

test("runRepoTests marks aborted exits", async () => {
  const result = await runRepoTests("dev", "typecheck", undefined, {
    persistLog: false,
    signal: AbortSignal.abort(),
    deps: {
      buildCommand: () => ({
        cwd: "/tmp/dev",
        cmd: ["true"],
        label: "pnpm typecheck",
      }),
      run: async () => RUN_CAPTURED_ABORTED_EXIT,
      pathEnv: () => ({ PATH: "/tmp" }),
    },
  });
  expect(result.aborted).toBe(true);
  expect(result.exitCode).toBe(RUN_CAPTURED_ABORTED_EXIT);
  expect(result.logPath).toBeNull();
});

test("runRepoTests falls back to catalog builders when deps omit them", async () => {
  const result = await runRepoTests("ui", "lint", undefined, {
    persistLog: false,
    deps: {
      run: async () => 0,
    },
  });
  expect(result).toEqual({ exitCode: 0, aborted: false, logPath: null });
});

test("runRepoTests uses runCaptured when deps omit run", async () => {
  const result = await runRepoTests("ui", "lint", undefined, {
    persistLog: false,
    deps: {
      buildCommand: () => ({
        cwd: "/tmp",
        cmd: ["/bin/true"],
        label: "true",
      }),
      pathEnv: () => ({ PATH: "/usr/bin:/bin" }),
    },
  });
  expect(result.exitCode).toBe(0);
  expect(result.aborted).toBe(false);
  expect(result.logPath).toBeNull();
});

test("runRepoTests persists a transcript when openLog is provided", async () => {
  const written: string[] = [];
  let closed = false;
  const result = await runRepoTests("turbopanel", "test:do", undefined, {
    deps: {
      buildCommand: () => ({
        cwd: "/tmp/turbopanel",
        cmd: ["echo", "fail"],
        label: "pnpm test:do",
      }),
      run: async (_cmd, onLine) => {
        onLine?.("AssertionError: boom");
        return 1;
      },
      pathEnv: () => ({ PATH: "/tmp" }),
      openLog: async () => ({
        path: "/tmp/fake-test-run.log",
        writeLine: (line) => written.push(line),
        close: async () => {
          closed = true;
        },
      }),
    },
  });

  expect(result.logPath).toBe("/tmp/fake-test-run.log");
  expect(written.some((line) => line.includes("AssertionError: boom"))).toBe(true);
  expect(closed).toBe(true);
});
