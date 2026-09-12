import { existsSync } from "node:fs";
import { resolveBootstrapDenoBin } from "./daemon-exec.ts";
import {
  type InstallOutputHandler,
  RUN_CAPTURED_ABORTED_EXIT,
  runCaptured,
} from "./install-output.ts";
import {
  ALL_DEV_CHECKOUT_DIRS,
  NODE_BIN,
  PNPM_BIN,
  platformRepoPath,
  RUNTIMES_DIR,
} from "./paths.ts";
import { TRUSTED_SYSTEM_PATH } from "./spawn-trusted.ts";
import { openTestRunLog, type TestRunLogHandle } from "./test-run-log.ts";

/** Checkout dirs the Developer → Run tests menu can target. */
export type TestRepoId = (typeof ALL_DEV_CHECKOUT_DIRS)[number];

export type TestSuiteId =
  | "verify:ci"
  | "test"
  | "test:coverage"
  | "test:do"
  | "test:hook"
  | "typecheck"
  | "check"
  | "lint";

export type TestSuiteDef = Readonly<{
  id: TestSuiteId;
  /** Short menu label. */
  label: string;
  /** Optional dim hint under the label (command summary). */
  detail: string;
}>;

export type TestRepoDef = Readonly<{
  id: TestRepoId;
  label: string;
  suites: readonly TestSuiteDef[];
}>;

const PNPM_SUITES = {
  "verify:ci": {
    id: "verify:ci",
    label: "CI verify",
    detail: "pnpm verify:ci (GitHub Actions job minus Sonar upload)",
  },
  test: {
    id: "test",
    label: "Unit tests",
    detail: "pnpm test",
  },
  "test:coverage": {
    id: "test:coverage",
    label: "Coverage",
    detail: "pnpm test:coverage",
  },
  "test:do": {
    id: "test:do",
    label: "Workers / Durable Object tests",
    detail: "pnpm test:do",
  },
  "test:hook": {
    id: "test:hook",
    label: "Pre-commit suite",
    detail: "pnpm test:hook (Vitest + Deno)",
  },
  typecheck: {
    id: "typecheck",
    label: "Typecheck",
    detail: "pnpm typecheck",
  },
  lint: {
    id: "lint",
    label: "Lint",
    detail: "pnpm lint",
  },
} as const satisfies Record<string, TestSuiteDef>;

const DENO_SUITES = {
  "verify:ci": {
    id: "verify:ci",
    label: "CI verify",
    detail: "deno task verify:ci (verify.yml minus Sonar upload)",
  },
  test: {
    id: "test",
    label: "Unit tests",
    detail: "deno task test",
  },
  "test:coverage": {
    id: "test:coverage",
    label: "Coverage",
    detail: "deno task test:coverage",
  },
  check: {
    id: "check",
    label: "Type check",
    detail: "deno task check",
  },
} as const satisfies Record<string, TestSuiteDef>;

/**
 * Services screen **T** → checkout whose suites to offer.
 *
 * `caddy` (the control-plane reverse proxy) shares the instance checkout — there is no Caddy unit suite.
 */
export const SERVICE_TEST_REPOS: Readonly<Record<string, TestRepoId>> = {
  daemon: "turbopaneld",
  instance: "turbopanel",
  caddy: "turbopanel",
  ui: "ui",
  website: "website",
};

/** Checkout to test when **T** is pressed on a Services row, or `null`. */
export function testRepoForServiceId(serviceId: string): TestRepoId | null {
  return SERVICE_TEST_REPOS[serviceId] ?? null;
}

/** Static catalog of repos and suites (presence gated at runtime). */
export const TEST_REPO_CATALOG: readonly TestRepoDef[] = [
  {
    id: "turbopaneld",
    label: "turbopaneld",
    suites: [
      DENO_SUITES["verify:ci"],
      DENO_SUITES["test:coverage"],
      DENO_SUITES.test,
      DENO_SUITES.check,
    ],
  },
  {
    id: "turbopanel",
    label: "turbopanel",
    suites: [
      PNPM_SUITES["verify:ci"],
      PNPM_SUITES["test:coverage"],
      PNPM_SUITES["test:do"],
      PNPM_SUITES["test:hook"],
    ],
  },
  {
    id: "ui",
    label: "ui",
    suites: [
      PNPM_SUITES["verify:ci"],
      PNPM_SUITES["test:coverage"],
      PNPM_SUITES.test,
      PNPM_SUITES.typecheck,
      PNPM_SUITES.lint,
    ],
  },
  {
    id: "website",
    label: "website",
    suites: [
      PNPM_SUITES["verify:ci"],
      PNPM_SUITES["test:coverage"],
      PNPM_SUITES.test,
      PNPM_SUITES.typecheck,
      PNPM_SUITES.lint,
    ],
  },
  {
    id: "dev",
    label: "dev (console)",
    suites: [
      PNPM_SUITES["verify:ci"],
      PNPM_SUITES["test:coverage"],
      PNPM_SUITES.test,
      PNPM_SUITES.typecheck,
    ],
  },
];

function repoLooksPresent(repo: TestRepoId): boolean {
  const root = platformRepoPath(repo);
  if (repo === "turbopaneld") {
    return (
      existsSync(`${root}/deno.json`) ||
      existsSync(`${root}/main.ts`) ||
      existsSync(`${root}/orchestration/ansible.cfg`)
    );
  }
  return existsSync(`${root}/package.json`);
}

/** Repos whose checkout is present on this host. */
export function listAvailableTestRepos(
  catalog: readonly TestRepoDef[] = TEST_REPO_CATALOG,
  isPresent: (repo: TestRepoId) => boolean = repoLooksPresent,
): TestRepoDef[] {
  return catalog.filter((repo) => isPresent(repo.id));
}

export function findTestRepo(
  repoId: TestRepoId,
  catalog: readonly TestRepoDef[] = TEST_REPO_CATALOG,
): TestRepoDef | undefined {
  return catalog.find((repo) => repo.id === repoId);
}

export function findTestSuite(
  repo: TestRepoDef,
  suiteId: TestSuiteId,
): TestSuiteDef | undefined {
  return repo.suites.find((suite) => suite.id === suiteId);
}

/** Prepend vendored Node + Deno bins onto a trusted FHS PATH (not the user PATH). */
export function testRunnerPathEnv(basePath?: string): Record<string, string> {
  const prefixes = [
    `${RUNTIMES_DIR}/node/current/bin`,
    `${RUNTIMES_DIR}/deno/current`,
  ];
  const existing = (basePath ?? TRUSTED_SYSTEM_PATH).split(":").filter(Boolean);
  const merged = [
    ...prefixes.filter((dir) => !existing.includes(dir)),
    ...existing,
  ];
  return { PATH: merged.join(":") };
}

export type BuildTestCommandResult = Readonly<{
  cwd: string;
  cmd: string[];
  label: string;
}>;

/**
 * Resolve argv + cwd for a repo suite.
 *
 * Daemon suites use Deno (`deno task …`); everything else uses vendored pnpm.
 */
export function buildTestCommand(
  repoId: TestRepoId,
  suiteId: TestSuiteId,
  options: {
    resolveDenoBin?: () => string;
    pnpmBin?: string;
    nodeBin?: string;
  } = {},
): BuildTestCommandResult {
  const repo = findTestRepo(repoId);
  if (!repo) {
    throw new TypeError(`Unknown test repo: ${repoId}`);
  }
  const suite = findTestSuite(repo, suiteId);
  if (!suite) {
    throw new TypeError(`Suite ${suiteId} is not offered for ${repoId}`);
  }

  const cwd = platformRepoPath(repoId);
  if (repoId === "turbopaneld") {
    const denoBin = (options.resolveDenoBin ?? resolveBootstrapDenoBin)();
    return {
      cwd,
      cmd: [denoBin, "task", suiteId],
      label: suite.detail,
    };
  }

  // Corepack's pnpm.js shebang is `#!/usr/bin/env node`. Invoke through the
  // vendored node binary so PATH-less / FHS-only spawns still start.
  const nodeBin = options.nodeBin ?? NODE_BIN;
  const pnpmBin = options.pnpmBin ?? PNPM_BIN;
  return {
    cwd,
    cmd: [nodeBin, pnpmBin, suiteId],
    label: suite.detail,
  };
}

export type RunRepoTestsResult = Readonly<{
  exitCode: number;
  aborted: boolean;
  /** Timestamped transcript under `~/.local/console/test-runs/` when persistence worked. */
  logPath: string | null;
}>;

export type RunRepoTestsDeps = Readonly<{
  buildCommand?: typeof buildTestCommand;
  run?: typeof runCaptured;
  pathEnv?: typeof testRunnerPathEnv;
  openLog?: (
    repoId: TestRepoId,
    suiteId: TestSuiteId,
  ) => Promise<TestRunLogHandle | null>;
}>;

/** Spawn the suite and stream sanitized lines until exit or abort. */
export async function runRepoTests(
  repoId: TestRepoId,
  suiteId: TestSuiteId,
  onLine?: InstallOutputHandler,
  options: {
    signal?: AbortSignal;
    deps?: RunRepoTestsDeps;
    /** When false, skip writing `~/.local/console/test-runs/`. Default true. */
    persistLog?: boolean;
  } = {},
): Promise<RunRepoTestsResult> {
  const build = options.deps?.buildCommand ?? buildTestCommand;
  const run = options.deps?.run ?? runCaptured;
  const pathEnv = options.deps?.pathEnv ?? testRunnerPathEnv;
  const openLog = options.deps?.openLog ?? openTestRunLog;
  const persistLog = options.persistLog !== false;

  const log = persistLog ? await openLog(repoId, suiteId) : null;
  const emit = (line: string) => {
    log?.writeLine(line);
    onLine?.(line);
  };

  try {
    const { cwd, cmd, label } = build(repoId, suiteId);
    if (log) {
      emit(`log: ${log.path}`);
    }
    emit(`$ ${label}`);
    emit(`cwd: ${cwd}`);

    const exitCode = await run(cmd, emit, {
      cwd,
      env: pathEnv(),
      signal: options.signal,
    });

    const aborted =
      exitCode === RUN_CAPTURED_ABORTED_EXIT || Boolean(options.signal?.aborted);
    emit(`# finished exit=${exitCode} aborted=${aborted}`);

    return {
      exitCode,
      aborted,
      logPath: log?.path ?? null,
    };
  } finally {
    await log?.close();
  }
}
