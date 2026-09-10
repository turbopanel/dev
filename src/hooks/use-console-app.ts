import { useApp, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isDestructiveDaemonAction,
  type DaemonActionId,
} from "../lib/daemon-actions.ts";
import {
  canRunServiceAction,
  runServiceAction,
  type ServiceActionId,
} from "../lib/service-actions.ts";
import {
  type ConsoleLogLine,
  consoleLogLine,
  watchServiceRestart,
} from "../lib/service-restart.ts";
import { readInstanceRuntime } from "../lib/daemon-env.ts";
import { openDuckDbUi } from "../lib/duckdb-ui.ts";
import {
  resolveDevEnvStartupPlan,
  type DevEnvStartupPlan,
} from "../lib/dev-env-readiness.ts";
import {
  readCellTraceEnabled,
  setCellTraceEnabled,
} from "../lib/instance-trace-env.ts";
import type { DaemonLogByteFloor } from "../lib/daemon-log.ts";
import { readDaemonLogFileStat } from "../lib/daemon-log.ts";
import { watchInstanceRuntimeSwitch } from "../lib/instance-runtime.ts";
import type { ServiceLogByteFloor } from "../lib/service-log.ts";
import { readServiceLogFileStat } from "../lib/service-log.ts";
import { testRepoForServiceId, type TestRepoId } from "../lib/run-repo-tests.ts";
import type { DaemonOperation } from "../lib/spinners.ts";
import { refreshDevPermissionsQuietly } from "../lib/turbopanel-permissions.ts";
import {
  applyOptionalDevServices,
  persistOptionalServiceToggle,
  readOptionalDevServices,
  type OptionalDevServiceSelection,
} from "../lib/optional-dev-services.ts";
import type { OptionalServicesModalMode } from "../components/optional-services-modal.tsx";
import { useDevEnvConverge } from "./use-dev-env-converge.ts";
import { useVisibleServices } from "./use-visible-services.ts";

export type ActiveArea = "developer" | "services" | "bootstrap";

export type ServiceOperation = {
  serviceId: string;
  action: ServiceActionId;
};

export type PendingRestart = {
  serviceId: string;
  label: string;
};

export type PendingOptionalServices = {
  mode: OptionalServicesModalMode;
  /** When mode is converge, which installDevEnvironment mode to run after confirm. */
  convergeMode?: "if-needed" | "force";
  selection: OptionalDevServiceSelection;
};

export function initialDaemonOperation(shouldAutoInstall: boolean): DaemonOperation | null {
  if (shouldAutoInstall) {
    return "install";
  }
  return null;
}

/** Idle launches never auto-bootstrap later; this is the mount-time fallback only. */
export function runAutoBootstrapIfNeeded(args: {
  allowAutoBootstrap: boolean;
  autoInstallStarted: { current: boolean };
  daemonOperation: DaemonOperation | null;
  resolvePlan: () => DevEnvStartupPlan;
  startDaemonInstall: () => void;
}): void {
  if (!args.allowAutoBootstrap || args.autoInstallStarted.current || args.daemonOperation) {
    return;
  }
  const plan = args.resolvePlan();
  if (plan.action === "bootstrap") {
    args.autoInstallStarted.current = true;
    args.startDaemonInstall();
  }
}

export function resolveConvergeMode(
  convergeMode: PendingOptionalServices["convergeMode"],
): "if-needed" | "force" {
  return convergeMode ?? "force";
}

export function initialAutoInstallState(): {
  shouldAutoInstall: boolean;
  selectedServiceIndex: number;
} {
  const plan = resolveDevEnvStartupPlan();
  return {
    shouldAutoInstall: plan.action === "bootstrap",
    selectedServiceIndex: 0,
  };
}

export type DeveloperView = "menu" | "cell-trace" | "run-tests";

export function useConsoleApp() {
  const { exit } = useApp();
  // Lazily, ONCE. `initialAutoInstallState()` shells out to `command -v deno`,
  // `deno --version` and `systemctl show` (~60ms); calling it in the render body
  // froze Ink for that long on every repaint.
  const [initialAutoInstall] = useState(initialAutoInstallState);
  const [activeArea, setActiveArea] = useState<ActiveArea>(
    initialAutoInstall.shouldAutoInstall ? "bootstrap" : "services",
  );
  const [provisioning, setProvisioning] = useState(initialAutoInstall.shouldAutoInstall);
  const [selectedServiceIndex, setSelectedServiceIndex] = useState(
    initialAutoInstall.selectedServiceIndex,
  );
  const [daemonOperation, setDaemonOperation] = useState<DaemonOperation | null>(
    initialDaemonOperation(initialAutoInstall.shouldAutoInstall),
  );
  const [installFinished, setInstallFinished] = useState(false);
  const [serviceOperation, setServiceOperation] = useState<ServiceOperation | null>(null);
  const [pendingRestart, setPendingRestart] = useState<PendingRestart | null>(null);
  const [pendingOptionalServices, setPendingOptionalServices] =
    useState<PendingOptionalServices | null>(null);
  const [pendingDestructiveAction, setPendingDestructiveAction] =
    useState<DaemonActionId | null>(null);
  const [restartInProgress, setRestartInProgress] = useState<string | null>(null);
  const [restartOverlayServiceId, setRestartOverlayServiceId] = useState<string | null>(null);
  const [restartLogOverlay, setRestartLogOverlay] = useState<ConsoleLogLine[]>([]);
  const [logFollowResetKey, setLogFollowResetKey] = useState(0);
  const [daemonLogByteFloor, setDaemonLogByteFloor] = useState<DaemonLogByteFloor | null>(
    null,
  );
  const [instanceLogByteFloor, setInstanceLogByteFloor] = useState<ServiceLogByteFloor | null>(
    null,
  );
  const [developerView, setDeveloperView] = useState<DeveloperView>("menu");
  const [serviceTestsRepoId, setServiceTestsRepoId] = useState<TestRepoId | null>(
    null,
  );
  const {
    services: visibleServices,
    loading: servicesLoading,
    refresh: refreshServices,
  } = useVisibleServices();
  const autoInstallStarted = useRef(initialAutoInstall.shouldAutoInstall);
  // Idle launches must never auto-bootstrap later (e.g. after rebuild). The
  // post-bootstrap optional-services → converge chain is install-only.
  const allowAutoBootstrap = useRef(initialAutoInstall.shouldAutoInstall);
  const devEnvConvergeSelectionPinned = useRef(false);
  // Null until the first scan lands, then adopted from the list's first row.
  // Seeding it with a `getVisibleServices()` call re-ran the whole systemd/Docker
  // fan-out (~220ms) on every render — a `useRef` argument is evaluated each time.
  const selectedServiceIdRef = useRef<string | null>(null);

  const handleDevEnvConvergeFinished = useCallback((success: boolean) => {
    allowAutoBootstrap.current = false;
    if (success) {
      setProvisioning(false);
      setActiveArea("services");
      setDaemonOperation(null);
      setInstallFinished(false);
      refreshServices();
      return;
    }
    setDaemonOperation(null);
    refreshServices();
  }, [refreshServices]);

  const { state: devEnvConverge, start: startDevEnvConverge, dismissError: dismissDevEnvConvergeError } =
    useDevEnvConverge(handleDevEnvConvergeFinished);

  const openOptionalServicesPicker = useCallback((
    mode: OptionalServicesModalMode,
    convergeMode?: "if-needed" | "force",
  ) => {
    setPendingOptionalServices({
      mode,
      convergeMode,
      selection: readOptionalDevServices(),
    });
  }, []);

  const beginConverge = useCallback((
    mode: "if-needed" | "force",
    selection: OptionalDevServiceSelection,
  ) => {
    setInstallFinished(false);
    setActiveArea("services");
    setProvisioning(false);
    setDaemonOperation("dev-env");
    startDevEnvConverge(mode, selection);
  }, [startDevEnvConverge]);

  const beginBootstrapOperation = useCallback((operation: DaemonOperation) => {
    // Ink may flush each setState immediately. Set the operation *before*
    // switching to the bootstrap area so ProvisionerPanel never mounts with
    // the default "daemon" phase (full bootstrap → optional services → converge).
    setInstallFinished(false);
    setDaemonOperation(operation);
    setProvisioning(true);
    setActiveArea("bootstrap");
  }, []);

  const startDaemonInstall = useCallback(() => {
    selectedServiceIdRef.current = "daemon";
    const index = visibleServices.findIndex((service) => service.id === "daemon");
    if (index >= 0) {
      setSelectedServiceIndex(index);
    }
    beginBootstrapOperation("install");
  }, [beginBootstrapOperation, visibleServices]);

  useEffect(() => {
    refreshDevPermissionsQuietly();
  }, []);

  useEffect(() => {
    runAutoBootstrapIfNeeded({
      allowAutoBootstrap: allowAutoBootstrap.current,
      autoInstallStarted,
      daemonOperation,
      resolvePlan: resolveDevEnvStartupPlan,
      startDaemonInstall,
    });
  }, [visibleServices, daemonOperation, startDaemonInstall]);

  const restartInstanceWithOverlay = useCallback(async () => {
    const service = visibleServices.find((entry) => entry.id === "instance");
    const label = service?.label ?? "instance";

    setRestartInProgress("instance");
    setRestartOverlayServiceId("instance");
    setRestartLogOverlay([]);
    setInstanceLogByteFloor(readServiceLogFileStat("instance"));

    const appendLog = (line: ConsoleLogLine) => {
      setRestartLogOverlay((current) => [...current, line]);
    };

    try {
      await watchServiceRestart("instance", label, appendLog);
    } finally {
      setRestartInProgress(null);
      setRestartOverlayServiceId(null);
      setRestartLogOverlay([]);
      setLogFollowResetKey((key) => key + 1);
      refreshServices();
    }
  }, [refreshServices, visibleServices]);

  const requireDaemonInstalled = useCallback((message: string) => {
    const daemon = visibleServices.find((service) => service.id === "daemon");
    if (!daemon || daemon.status === "uninstalled") {
      throw new Error(message);
    }
  }, [visibleServices]);

  const performDaemonAction = useCallback(async (action: DaemonActionId) => {
    switch (action) {
      case "install":
      case "repair":
        startDaemonInstall();
        return;
      case "purge":
        setActiveArea("developer");
        setDaemonOperation("purge");
        return;
      case "start-dev-env": {
        requireDaemonInstalled(
          "Install the daemon before starting the development environment.",
        );
        openOptionalServicesPicker("converge", "force");
        return;
      }
      case "optional-services": {
        openOptionalServicesPicker("manage");
        return;
      }
      case "reset-dev-env":
        beginBootstrapOperation("reset-dev-env");
        return;
      case "reset-dev-db":
        beginBootstrapOperation("reset-dev-db");
        return;
      case "save-tier-catalogue":
        beginBootstrapOperation("save-tier-catalogue");
        return;
      case "sync-dev-build":
        beginBootstrapOperation("sync-dev-build");
        return;
      case "rebuild-daemon-upgrade":
        beginBootstrapOperation("rebuild-daemon-upgrade");
        return;
      case "toggle-cell-trace":
        setActiveArea("developer");
        setCellTraceEnabled(!readCellTraceEnabled());
        await restartInstanceWithOverlay();
        return;
      case "view-cell-trace":
        setDeveloperView("cell-trace");
        return;
      case "open-duckdb-ui":
        setActiveArea("developer");
        await openDuckDbUi();
        return;
      case "run-tests":
        setServiceTestsRepoId(null);
        setDeveloperView("run-tests");
        return;
      case "restart":
        return;
    }
  }, [
    beginBootstrapOperation,
    openOptionalServicesPicker,
    requireDaemonInstalled,
    restartInstanceWithOverlay,
    startDaemonInstall,
  ]);

  const handleDaemonAction = useCallback(async (action: DaemonActionId) => {
    if (isDestructiveDaemonAction(action)) {
      // Surface precondition errors before asking for confirmation.
      if (action === "reset-dev-env") {
        requireDaemonInstalled(
          "Install the daemon before resetting the development environment.",
        );
      }
      if (action === "reset-dev-db") {
        requireDaemonInstalled(
          "Install the daemon before resetting the dev database.",
        );
      }
      setPendingDestructiveAction(action);
      return;
    }
    await performDaemonAction(action);
  }, [performDaemonAction, requireDaemonInstalled]);

  const confirmDestructiveAction = useCallback(() => {
    const action = pendingDestructiveAction;
    setPendingDestructiveAction(null);
    if (!action) {
      return;
    }
    performDaemonAction(action).catch(() => undefined);
  }, [pendingDestructiveAction, performDaemonAction]);

  const cancelDestructiveAction = useCallback(() => {
    setPendingDestructiveAction(null);
  }, []);

  const requestServiceRestart = useCallback((serviceId: string) => {
    const service = visibleServices.find((entry) => entry.id === serviceId);
    if (!service) {
      return;
    }
    setPendingRestart({ serviceId, label: service.label });
  }, [visibleServices]);

  const cancelServiceRestart = useCallback(() => {
    setPendingRestart(null);
  }, []);

  const performServiceRestart = useCallback(async (serviceId: string) => {
    const service = visibleServices.find((entry) => entry.id === serviceId);
    if (!service) {
      return;
    }

    setRestartInProgress(serviceId);
    setRestartOverlayServiceId(serviceId);
    setRestartLogOverlay([]);

    if (serviceId === "daemon") {
      const stat = readDaemonLogFileStat();
      setDaemonLogByteFloor({
        stdout: stat.stdoutSize,
        stderr: stat.stderrSize,
      });
    }

    const appendLog = (line: ConsoleLogLine) => {
      setRestartLogOverlay((current) => [...current, line]);
    };

    try {
      await watchServiceRestart(serviceId, service.label, appendLog);
    } finally {
      setRestartInProgress(null);
      setRestartOverlayServiceId(null);
      setRestartLogOverlay([]);
      setLogFollowResetKey((key) => key + 1);
      refreshServices();
    }
  }, [refreshServices, visibleServices]);

  const confirmServiceRestart = useCallback(() => {
    if (!pendingRestart) {
      return;
    }
    const { serviceId } = pendingRestart;
    setPendingRestart(null);
    performServiceRestart(serviceId).catch(() => undefined);
  }, [pendingRestart, performServiceRestart]);

  const cancelOptionalServices = useCallback(() => {
    setPendingOptionalServices(null);
  }, []);

  const confirmOptionalServices = useCallback((
    selection: OptionalDevServiceSelection,
  ) => {
    const pending = pendingOptionalServices;
    setPendingOptionalServices(null);
    if (!pending) {
      return;
    }

    if (pending.mode === "converge") {
      beginConverge(resolveConvergeMode(pending.convergeMode), selection);
      return;
    }

    setRestartInProgress("optional services");
    void (async () => {
      try {
        await applyOptionalDevServices(selection);
        refreshServices();
      } finally {
        setRestartInProgress(null);
      }
    })();
  }, [beginConverge, pendingOptionalServices, refreshServices]);

  const handleServiceAction = useCallback(async (
    serviceId: string,
    action: ServiceActionId,
  ) => {
    if (action === "restart") {
      requestServiceRestart(serviceId);
      return;
    }

    const service = visibleServices.find((entry) => entry.id === serviceId);
    if (!service) {
      return;
    }

    const runtime = readInstanceRuntime();
    if (!canRunServiceAction(serviceId, action, service.status, runtime)) {
      return;
    }

    if (action === "switch-workers" || action === "switch-deno") {
      const target = action === "switch-workers" ? "workers" : "deno";
      const from = runtime;
      if (from === target) {
        return;
      }

      setRestartInProgress(`instance (${from} → ${target})`);
      setRestartOverlayServiceId("instance");
      setRestartLogOverlay([]);
      setInstanceLogByteFloor(readServiceLogFileStat("instance"));

      const appendLog = (line: ConsoleLogLine) => {
        setRestartLogOverlay((current) => [...current, line]);
      };

      try {
        await watchInstanceRuntimeSwitch(target, from, appendLog);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendLog(consoleLogLine(`[console] Runtime switch failed: ${message}`));
      } finally {
        setRestartInProgress(null);
        setRestartOverlayServiceId(null);
        setRestartLogOverlay([]);
        setLogFollowResetKey((key) => key + 1);
        refreshServices();
      }
      return;
    }

    setServiceOperation({ serviceId, action });
    try {
      await runServiceAction(serviceId, action);
      if (action === "enable" || action === "disable") {
        persistOptionalServiceToggle(serviceId, action === "enable");
      }
      refreshServices();
    } finally {
      setServiceOperation(null);
    }
  }, [refreshServices, requestServiceRestart, visibleServices]);

  const handleInstallFinished = useCallback((success: boolean) => {
    setInstallFinished(true);
    refreshServices();
    if (success) {
      let attempts = 0;
      const id = setInterval(() => {
        refreshServices();
        attempts += 1;
        if (attempts >= 6) {
          clearInterval(id);
        }
      }, 500);
    }
  }, [refreshServices]);

  const handleProvisioningDone = useCallback(() => {
    allowAutoBootstrap.current = false;
    setProvisioning(false);
    setActiveArea("services");
    setDaemonOperation(null);
    setInstallFinished(false);
    refreshServices();
  }, [refreshServices]);

  const handleDaemonInstallDone = useCallback(() => {
    allowAutoBootstrap.current = false;
    setActiveArea("services");
    setProvisioning(false);
    setDaemonOperation(null);
    setInstallFinished(false);
    openOptionalServicesPicker("converge", "if-needed");
  }, [openOptionalServicesPicker]);

  const handlePurgeDone = useCallback(() => {
    exit();
  }, [exit]);

  useEffect(() => {
    const inDevEnvConverge =
      daemonOperation === "dev-env" || devEnvConverge.active;

    if (inDevEnvConverge) {
      if (!devEnvConvergeSelectionPinned.current) {
        devEnvConvergeSelectionPinned.current = true;
        const daemonIndex = visibleServices.findIndex(
          (service) => service.id === "daemon",
        );
        if (daemonIndex >= 0) {
          selectedServiceIdRef.current = "daemon";
          setSelectedServiceIndex(daemonIndex);
        }
      }
      return;
    }

    devEnvConvergeSelectionPinned.current = false;

    // First non-empty scan: start on the list's first row (instance when the
    // stack is up, otherwise the daemon), matching the pre-async behaviour.
    if (selectedServiceIdRef.current === null) {
      const first = visibleServices[initialAutoInstall.selectedServiceIndex];
      if (!first) {
        return;
      }
      selectedServiceIdRef.current = first.id;
      setSelectedServiceIndex(initialAutoInstall.selectedServiceIndex);
      return;
    }

    const preservedIndex = visibleServices.findIndex(
      (service) => service.id === selectedServiceIdRef.current,
    );
    if (preservedIndex >= 0) {
      setSelectedServiceIndex(preservedIndex);
      return;
    }

    setSelectedServiceIndex((index) =>
      Math.min(index, Math.max(0, visibleServices.length - 1)),
    );
  }, [
    visibleServices,
    daemonOperation,
    devEnvConverge.active,
    initialAutoInstall.selectedServiceIndex,
  ]);

  const setSelectedServiceIndexById = useCallback((index: number) => {
    const service = visibleServices[index];
    if (service) {
      selectedServiceIdRef.current = service.id;
    }
    setSelectedServiceIndex(index);
  }, [visibleServices]);

  const closeDeveloperView = useCallback(() => {
    setDeveloperView("menu");
  }, []);

  const openServiceTests = useCallback((serviceId: string) => {
    const repoId = testRepoForServiceId(serviceId);
    if (!repoId) {
      return;
    }
    setServiceTestsRepoId(repoId);
  }, []);

  const closeServiceTests = useCallback(() => {
    setServiceTestsRepoId(null);
  }, []);

  useInput((_input, key) => {
    if (
      provisioning ||
      daemonOperation ||
      serviceOperation ||
      pendingRestart ||
      pendingOptionalServices ||
      pendingDestructiveAction ||
      restartInProgress
    ) {
      return;
    }

    if (
      developerView === "cell-trace" ||
      developerView === "run-tests" ||
      serviceTestsRepoId
    ) {
      return;
    }

    if (key.leftArrow) {
      setActiveArea((area) => (area === "developer" ? "services" : area));
    }
    if (key.rightArrow) {
      setActiveArea((area) => (area === "services" ? "developer" : area));
    }
  });

  const selectedService = visibleServices[selectedServiceIndex] ?? null;

  return {
    activeArea,
    provisioning,
    servicesLoading,
    selectedServiceIndex,
    selectedService,
    visibleServices,
    daemonOperation,
    serviceOperation,
    pendingRestart,
    pendingOptionalServices,
    pendingDestructiveAction,
    restartInProgress,
    restartOverlayServiceId,
    restartLogOverlay,
    logFollowResetKey,
    daemonLogByteFloor,
    instanceLogByteFloor,
    installFinished,
    handleDaemonAction,
    handleProvisioningDone,
    handleDaemonInstallDone,
    handleInstallFinished,
    handleServiceAction,
    handlePurgeDone,
    devEnvConverge,
    dismissDevEnvConvergeError,
    confirmServiceRestart,
    cancelServiceRestart,
    confirmOptionalServices,
    cancelOptionalServices,
    confirmDestructiveAction,
    cancelDestructiveAction,
    developerView,
    closeDeveloperView,
    serviceTestsRepoId,
    openServiceTests,
    closeServiceTests,
    setSelectedServiceIndex: setSelectedServiceIndexById,
    refreshServices,
  };
}
