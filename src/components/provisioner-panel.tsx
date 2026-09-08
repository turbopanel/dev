import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Box, Text, useInput } from "ink";
import {
  AnsibleTaskList,
  type AnsibleTaskRow,
} from "@turbopanel/components/ansible-task-list.tsx";
import {
  buildAnsibleTaskView,
  useAnsibleEvents,
} from "../hooks/use-ansible-events.ts";
import { useSpinnerFrame } from "../hooks/use-spinner-frame.ts";
import { installDaemon } from "../lib/platform-install.ts";
import { CONSOLE_LAST_TASK_ERROR_LOG } from "../lib/paths.ts";
import { appendOutputLines } from "../lib/install-output.ts";
import { logContentWidth } from "./log-scrollbar.tsx";
import { ScrollableLogList } from "./scrollable-log-list.tsx";
import { writeTaskErrorLog } from "../lib/task-error-log.ts";
import {
  bootstrapOrchestration,
  installDaemonSystemd,
} from "../lib/daemon-install.ts";
import { ensureBootstrapDeno } from "../lib/daemon-exec.ts";
import {
  BOOTSTRAP_ANSIBLE,
  BOOTSTRAP_CONVERGE,
  BOOTSTRAP_DENO,
  BOOTSTRAP_PYTHON,
  BOOTSTRAP_UV,
  bootstrapStepForPhase,
  type BootstrapPhase,
} from "../lib/bootstrap-phase.ts";
import { rebuildDaemonAndUpgradeConnectedServers, syncDevBuildToDaemons } from "../lib/daemon-actions.ts";
import {
  DEV_ENV_CONVERGE_STEP,
  installDevEnvironment,
} from "../lib/instance-install.ts";
import { resetDevEnvironment } from "../lib/reset-dev-environment.ts";
import { resetDevDatabase } from "../lib/reset-dev-database.ts";
import { saveDevTierCatalogue } from "../lib/save-dev-tier-catalogue.ts";

const OUTPUT_LOG_ROWS = 6;
const SYNC_OUTPUT_LOG_ROWS = 200;

function truncateLine(text: string, maxWidth: number): string {
  if (maxWidth < 4) return "…";
  if (text.length <= maxWidth) return text;
  return `${text.slice(0, maxWidth - 1)}…`;
}

type ProvisionerPhase =
  | "daemon"
  | "dev-env"
  | "reset-dev-env"
  | "reset-dev-db"
  | "save-tier-catalogue"
  | "sync-dev-build"
  | "rebuild-daemon-upgrade";

type EmitStep = (
  label: string,
  status: AnsibleTaskRow["status"],
  id?: string,
) => void;

function provisionerTitle(phase: ProvisionerPhase): string {
  switch (phase) {
    case "sync-dev-build":
      return "Syncing source to attached checkouts…";
    case "rebuild-daemon-upgrade":
      return "Rebuilding daemon and upgrading connected servers…";
    case "dev-env":
      return "Starting development environment";
    case "reset-dev-env":
      return "Resetting development environment…";
    case "reset-dev-db":
      return "Resetting dev database…";
    case "save-tier-catalogue":
      return "Saving tier catalogue…";
    case "daemon":
      return "Bootstrapping development environment";
  }
}

function provisionerSuccessMessage(phase: ProvisionerPhase): string {
  switch (phase) {
    case "sync-dev-build":
      return "Source synced to attached checkouts";
    case "rebuild-daemon-upgrade":
      return "Connected servers upgraded to the new daemon build";
    case "dev-env":
      return "Development environment running";
    case "reset-dev-env":
      return "Development environment reset complete";
    case "reset-dev-db":
      return "Dev database reset complete";
    case "save-tier-catalogue":
      return "Tier catalogue saved to dev/local/tiers.json";
    case "daemon":
      return "Development environment ready";
  }
}

function footerRowCount(
  finished: boolean,
  error: string | null,
  errorLogPath: string | null,
  holdUntilKeypress: boolean,
): number {
  if (!finished) return 0;
  if (!error) return holdUntilKeypress ? 2 : 1;
  return errorLogPath ? 3 : 2;
}

function errorMessage(error_: unknown): string {
  return error_ instanceof Error ? error_.message : String(error_);
}

async function reportProvisionerFailure(opts: {
  title: string;
  stepLabel: string;
  error_: unknown;
  emitStep: EmitStep;
  setError: (message: string) => void;
  setErrorLogPath: (path: string) => void;
}): Promise<void> {
  const { title, stepLabel, error_, emitStep, setError, setErrorLogPath } = opts;
  emitStep(stepLabel, "failed");
  const message = errorMessage(error_);
  const saved = await writeTaskErrorLog({
    title,
    message: `step=${stepLabel}\n${message}`,
    tasks: [{ label: stepLabel, status: "failed" }],
    timestamp: new Date().toISOString(),
  });
  if (saved) {
    setErrorLogPath(CONSOLE_LAST_TASK_ERROR_LOG);
  }
  setError(message);
}

function ProvisionerSyncOutput({
  outputWidth,
  syncLogHeight,
  syncLogContentWidth,
  outputLines,
}: Readonly<{
  outputWidth: number;
  syncLogHeight: number;
  syncLogContentWidth: number;
  outputLines: string[];
}>) {
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0} minHeight={0}>
      <Text dimColor>Output</Text>
      <ScrollableLogList
        width={outputWidth}
        height={syncLogHeight}
        selectedIndex={Math.max(0, outputLines.length - 1)}
      >
        {outputLines.map((line, index) => (
          <Text key={`${index}:${line}`} dimColor wrap="truncate">
            {truncateLine(line, syncLogContentWidth)}
          </Text>
        ))}
      </ScrollableLogList>
    </Box>
  );
}

function ProvisionerErrorOutput({
  outputWidth,
  outputLines,
}: Readonly<{
  outputWidth: number;
  outputLines: string[];
}>) {
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Text dimColor>Output</Text>
      {outputLines.map((line, index) => (
        <Text key={`${index}:${line}`} dimColor wrap="truncate">
          {truncateLine(line, outputWidth)}
        </Text>
      ))}
    </Box>
  );
}

function ProvisionerStatusFooter({
  finished,
  error,
  successMessage,
  holdUntilKeypress,
}: Readonly<{
  finished: boolean;
  error: string | null;
  successMessage: string;
  holdUntilKeypress: boolean;
}>) {
  if (!finished) return null;
  if (error !== null) {
    return (
      <Box marginTop={1}>
        <Text dimColor>Press any key to continue</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="green">{successMessage}</Text>
      {holdUntilKeypress && <Text dimColor>Press any key to continue</Text>}
    </Box>
  );
}

function useProvisionerPhaseEffects(opts: {
  phase: ProvisionerPhase;
  appendOutput: (line: string) => void;
  appendSyncOutput: (line: string) => void;
  emitStep: EmitStep;
  setDone: (done: boolean) => void;
  setError: (message: string) => void;
  setErrorLogPath: (path: string) => void;
  onInstallFinished?: (success: boolean) => void;
  onDaemonInstallDone?: () => void;
  trackBootstrapEvent: (event: unknown) => void;
  trackBootstrapOutput: (line: string) => void;
  trackDevEnvStep: (label: string, status: "running" | "ok" | "failed") => void;
  bootstrapPhase: RefObject<BootstrapPhase>;
}): void {
  const {
    phase,
    appendOutput,
    appendSyncOutput,
    emitStep,
    setDone,
    setError,
    setErrorLogPath,
    onInstallFinished,
    onDaemonInstallDone,
    trackBootstrapEvent,
    trackBootstrapOutput,
    trackDevEnvStep,
    bootstrapPhase,
  } = opts;

  useEffect(() => {
    if (phase !== "daemon") return;

    let cancelled = false;

    void (async () => {
      let currentStep = "Ensure daemon repository";
      // True only while bootstrapOrchestration()'s uv→converge work is in flight.
      // Deno is ensured *before* that call (own step) so a GitHub/curl Deno failure
      // does not paint "Install uv package manager" as failed. During the
      // orchestration window we consult bootstrapPhase.current for which of the
      // four uv/python/ansible/converge steps actually failed. Outside that window,
      // `currentStep` already names the real failing step (installDaemon and
      // installDaemonSystemd emit their own "failed" status before throwing).
      let duringBootstrapOrchestration = false;
      try {
        emitStep(currentStep, "running");
        await installDaemon(emitStep, appendOutput);
        if (cancelled) return;
        emitStep(currentStep, "ok");

        // Vendored Deno must exist before the orchestration script can run.
        // Keep this as its own task-list row — ensureBootstrapDeno also runs
        // again inside bootstrapOrchestration (no-op when already usable).
        bootstrapPhase.current = "deno";
        currentStep = BOOTSTRAP_DENO;
        emitStep(BOOTSTRAP_DENO, "running");
        await ensureBootstrapDeno(trackBootstrapOutput);
        if (cancelled) return;
        emitStep(BOOTSTRAP_DENO, "ok");

        bootstrapPhase.current = "uv";
        currentStep = BOOTSTRAP_UV;
        emitStep(BOOTSTRAP_UV, "running");
        duringBootstrapOrchestration = true;
        await bootstrapOrchestration(trackBootstrapEvent, trackBootstrapOutput);
        duringBootstrapOrchestration = false;
        if (cancelled) return;
        emitStep(BOOTSTRAP_UV, "ok");
        emitStep(BOOTSTRAP_PYTHON, "ok");
        emitStep(BOOTSTRAP_ANSIBLE, "ok");
        emitStep(BOOTSTRAP_CONVERGE, "ok");

        currentStep = "Install turbopaneld systemd unit";
        await installDaemonSystemd(appendOutput, emitStep);
        if (cancelled) return;

        onInstallFinished?.(true);
        onDaemonInstallDone?.();
      } catch (error_) {
        if (cancelled) return;
        if (duringBootstrapOrchestration) {
          currentStep = bootstrapStepForPhase(bootstrapPhase.current);
        }
        await reportProvisionerFailure({
          title: "Install daemon",
          stepLabel: currentStep,
          error_,
          emitStep,
          setError,
          setErrorLogPath,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    appendOutput,
    bootstrapPhase,
    emitStep,
    onDaemonInstallDone,
    onInstallFinished,
    phase,
    setError,
    setErrorLogPath,
    trackBootstrapEvent,
    trackBootstrapOutput,
  ]);

  useEffect(() => {
    if (phase !== "dev-env") return;

    let cancelled = false;

    void (async () => {
      const currentStep = DEV_ENV_CONVERGE_STEP;
      try {
        // First-run provision must rebuild unconditionally — never inherit skip.
        await installDevEnvironment(
          trackBootstrapEvent,
          appendOutput,
          trackDevEnvStep,
          undefined,
          "force",
        );
        if (cancelled) return;
        setDone(true);
      } catch (error_) {
        if (cancelled) return;
        await reportProvisionerFailure({
          title: "Converge / re-converge development environment",
          stepLabel: currentStep,
          error_,
          emitStep,
          setError,
          setErrorLogPath,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    appendOutput,
    emitStep,
    phase,
    setDone,
    setError,
    setErrorLogPath,
    trackBootstrapEvent,
    trackDevEnvStep,
  ]);

  useEffect(() => {
    if (phase !== "reset-dev-env") return;

    let cancelled = false;

    void (async () => {
      const currentStep = DEV_ENV_CONVERGE_STEP;
      try {
        await resetDevEnvironment(appendOutput, trackDevEnvStep);
        if (cancelled) return;
        setDone(true);
      } catch (error_) {
        if (cancelled) return;
        await reportProvisionerFailure({
          title: "Reset development environment",
          stepLabel: currentStep,
          error_,
          emitStep,
          setError,
          setErrorLogPath,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    appendOutput,
    emitStep,
    phase,
    setDone,
    setError,
    setErrorLogPath,
    trackDevEnvStep,
  ]);

  useEffect(() => {
    if (phase !== "save-tier-catalogue") return;

    let cancelled = false;

    void (async () => {
      const stepLabel = "Save tier catalogue";
      try {
        emitStep(stepLabel, "running");
        await saveDevTierCatalogue(appendOutput);
        if (cancelled) return;
        emitStep(stepLabel, "ok");
        setDone(true);
      } catch (error_) {
        if (cancelled) return;
        await reportProvisionerFailure({
          title: "Save tier catalogue",
          stepLabel,
          error_,
          emitStep,
          setError,
          setErrorLogPath,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [appendOutput, emitStep, phase, setDone, setError, setErrorLogPath]);

  useEffect(() => {
    if (phase !== "reset-dev-db") return;

    let cancelled = false;

    void (async () => {
      const stepLabel = "Reset dev database";
      try {
        emitStep(stepLabel, "running");
        await resetDevDatabase(appendOutput);
        if (cancelled) return;
        emitStep(stepLabel, "ok");
        setDone(true);
      } catch (error_) {
        if (cancelled) return;
        await reportProvisionerFailure({
          title: "Reset dev database",
          stepLabel,
          error_,
          emitStep,
          setError,
          setErrorLogPath,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    appendOutput,
    emitStep,
    phase,
    setDone,
    setError,
    setErrorLogPath,
  ]);

  useEffect(() => {
    if (phase !== "sync-dev-build") return;

    let cancelled = false;

    void (async () => {
      const stepLabel = "Sync source to attached checkouts";
      try {
        emitStep(stepLabel, "running");
        await syncDevBuildToDaemons(appendSyncOutput);
        if (cancelled) return;
        emitStep(stepLabel, "ok");
        setDone(true);
      } catch (error_) {
        if (cancelled) return;
        await reportProvisionerFailure({
          title: "Sync source",
          stepLabel,
          error_,
          emitStep,
          setError,
          setErrorLogPath,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    appendSyncOutput,
    emitStep,
    phase,
    setDone,
    setError,
    setErrorLogPath,
  ]);

  useEffect(() => {
    if (phase !== "rebuild-daemon-upgrade") return;

    let cancelled = false;

    void (async () => {
      const stepLabel = "Rebuild daemon and upgrade connected servers";
      try {
        emitStep(stepLabel, "running");
        await rebuildDaemonAndUpgradeConnectedServers(appendSyncOutput);
        if (cancelled) return;
        emitStep(stepLabel, "ok");
        setDone(true);
      } catch (error_) {
        if (cancelled) return;
        await reportProvisionerFailure({
          title: "Rebuild daemon",
          stepLabel,
          error_,
          emitStep,
          setError,
          setErrorLogPath,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    appendSyncOutput,
    emitStep,
    phase,
    setDone,
    setError,
    setErrorLogPath,
  ]);
}

export function ProvisionerPanel({
  width,
  height,
  phase = "daemon",
  onDone,
  onInstallFinished,
  onDaemonInstallDone,
}: Readonly<{
  width: number;
  height: number;
  phase?: ProvisionerPhase;
  onDone: () => void;
  onInstallFinished?: (success: boolean) => void;
  onDaemonInstallDone?: () => void;
}>) {
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const bootstrapPhase = useRef<BootstrapPhase>("deno");
  const {
    tasks,
    recap,
    error,
    errorLogPath,
    done,
    onEvent,
    emitStep,
    setDone,
    setError,
    setErrorLogPath,
  } = useAnsibleEvents();

  const isSyncPhase = phase === "sync-dev-build" || phase === "rebuild-daemon-upgrade";
  const finished = done || error !== null;
  const footerRows = footerRowCount(finished, error, errorLogPath, isSyncPhase);
  const showLiveSyncOutput = isSyncPhase && (!finished || outputLines.length > 0);
  const syncLogHeight = showLiveSyncOutput
    ? Math.max(6, Math.min(height - 10, Math.floor(height * 0.55)))
    : 0;
  const syncLogSectionRows = showLiveSyncOutput ? syncLogHeight + 2 : 0;
  const taskRowBudget = Math.max(
    3,
    height - 1 - footerRows - syncLogSectionRows,
  );
  const outputWidth = Math.max(20, width - 2);
  const syncLogContentWidth = logContentWidth(outputWidth);
  const showErrorOutput = Boolean(error) && outputLines.length > 0 && !isSyncPhase;

  const appendOutput = useCallback((line: string) => {
    setOutputLines((lines) => appendOutputLines(lines, line, OUTPUT_LOG_ROWS));
  }, []);

  const appendSyncOutput = useCallback((line: string) => {
    setOutputLines((lines) => appendOutputLines(lines, line, SYNC_OUTPUT_LOG_ROWS));
  }, []);

  const trackBootstrapOutput = useCallback((line: string) => {
    appendOutput(line);
    const lower = line.toLowerCase();

    if (lower.includes("[orchestration] uv") || lower.includes("uv ")) {
      emitStep(BOOTSTRAP_UV, "running");
      bootstrapPhase.current = "uv";
    }
    if (lower.includes("ensuring python")) {
      emitStep(BOOTSTRAP_UV, "ok");
      emitStep(BOOTSTRAP_PYTHON, "running");
      bootstrapPhase.current = "python";
    }
    if (lower.includes("python") && lower.includes("ready")) {
      emitStep(BOOTSTRAP_PYTHON, "ok");
      emitStep(BOOTSTRAP_ANSIBLE, "running");
      bootstrapPhase.current = "ansible";
    }
    if (
      lower.includes("ansible")
      || lower.includes("galaxy")
      || lower.includes("virtualenv")
    ) {
      emitStep(BOOTSTRAP_ANSIBLE, "running");
      bootstrapPhase.current = "ansible";
    }
  }, [appendOutput, emitStep]);

  const trackBootstrapEvent = useCallback((event: unknown) => {
    onEvent(event);
    if (typeof event !== "object" || event === null) {
      return;
    }
    const record = event as Record<string, unknown>;
    const eventType = record._event;
    if (typeof eventType !== "string") {
      return;
    }

    if (eventType === "v2_playbook_on_play_start") {
      emitStep(BOOTSTRAP_ANSIBLE, "ok");
      emitStep(BOOTSTRAP_CONVERGE, "running");
      bootstrapPhase.current = "converge";
      return;
    }

    if (eventType === "v2_playbook_on_stats") {
      const stats = record.stats as Record<string, Record<string, number>> | undefined;
      let failed = 0;
      if (stats) {
        for (const hostStats of Object.values(stats)) {
          failed += hostStats.failures ?? hostStats.failed ?? 0;
        }
      }
      if (failed === 0) {
        emitStep(BOOTSTRAP_CONVERGE, "ok");
      }
    }
  }, [emitStep, onEvent]);

  const trackDevEnvStep = useCallback((
    label: string,
    status: "running" | "ok" | "failed",
  ) => {
    emitStep(label, status);
  }, [emitStep]);

  const view = useMemo(
    () => buildAnsibleTaskView(tasks, taskRowBudget),
    [tasks, taskRowBudget],
  );
  const hasRunningTask = tasks.some((task) => task.status === "running");
  const spinnerFrame = useSpinnerFrame(!finished && hasRunningTask ? 120 : 0);

  useEffect(() => {
    if (done) {
      onInstallFinished?.(true);
    }
  }, [done, onInstallFinished]);

  useEffect(() => {
    if (error !== null) {
      onInstallFinished?.(false);
    }
  }, [error, onInstallFinished]);

  useProvisionerPhaseEffects({
    phase,
    appendOutput,
    appendSyncOutput,
    emitStep,
    setDone,
    setError,
    setErrorLogPath,
    onInstallFinished,
    onDaemonInstallDone,
    trackBootstrapEvent,
    trackBootstrapOutput,
    trackDevEnvStep,
    bootstrapPhase,
  });

  useEffect(() => {
    if (done && error === null && !isSyncPhase) {
      onDone();
    }
  }, [done, error, onDone, isSyncPhase]);

  useInput(() => {
    if (!finished) return;
    if (error === null && !isSyncPhase) return;
    onDone();
  });

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text color="cyan" bold>
        {provisionerTitle(phase)}
      </Text>
      <Box flexDirection="column" marginTop={1} flexGrow={1} minHeight={0}>
        <AnsibleTaskList
          visibleTasks={view.visibleTasks}
          hiddenCount={view.hiddenCount}
          followIndex={view.followIndex}
          height={taskRowBudget}
          recap={recap}
          error={error}
          errorLogPath={errorLogPath}
          columns={outputWidth}
          spinnerFrame={spinnerFrame}
          showLegend={!finished && tasks.length > 0}
        />
      </Box>
      {showLiveSyncOutput && (
        <ProvisionerSyncOutput
          outputWidth={outputWidth}
          syncLogHeight={syncLogHeight}
          syncLogContentWidth={syncLogContentWidth}
          outputLines={outputLines}
        />
      )}
      {showErrorOutput && (
        <ProvisionerErrorOutput
          outputWidth={outputWidth}
          outputLines={outputLines}
        />
      )}
      <ProvisionerStatusFooter
        finished={finished}
        error={error}
        successMessage={provisionerSuccessMessage(phase)}
        holdUntilKeypress={isSyncPhase}
      />
    </Box>
  );
}
