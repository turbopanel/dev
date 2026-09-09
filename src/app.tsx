import React from "react";
import { Box } from "ink";
import { MainPanel } from "@turbopanel/components/main-panel.tsx";
import { MenuBar, type AreaTab } from "@turbopanel/components/menu-bar.tsx";
import { DeveloperPanel } from "@turbopanel/components/developer-panel.tsx";
import { ProvisionerPanel } from "@turbopanel/components/provisioner-panel.tsx";
import { ServicesPanel } from "@turbopanel/components/services-panel.tsx";
import { RunTestsView } from "@turbopanel/components/run-tests-view.tsx";
import { statusHints } from "@turbopanel/components/status-bar.tsx";
import type { DevService } from "./dev-services.ts";
import {
  DAEMON_ACTION_LABELS,
  DESTRUCTIVE_ACTION_WARNINGS,
  type DaemonActionId,
} from "./lib/daemon-actions.ts";
import { ConfirmDangerModal } from "@turbopanel/components/confirm-danger-modal.tsx";
import type { ServiceActionId } from "./lib/service-actions.ts";
import type { PendingRestart, PendingOptionalServices, ServiceOperation, DeveloperView } from "./hooks/use-console-app.ts";
import type { DevEnvConvergeState } from "./hooks/use-dev-env-converge.ts";
import type { DaemonLogByteFloor } from "./lib/daemon-log.ts";
import type { ServiceLogByteFloor } from "./lib/service-log.ts";
import type { ConsoleLogLine } from "./lib/service-restart.ts";
import type { DaemonOperation } from "./lib/spinners.ts";
import type { OptionalDevServiceSelection } from "./lib/optional-dev-services.ts";
import type { TestRepoId } from "./lib/run-repo-tests.ts";
import { provisionerPhaseForDaemonOperation } from "./lib/provisioner-phase.ts";
import { OptionalServicesModal } from "@turbopanel/components/optional-services-modal.tsx";

export const AREAS: AreaTab[] = [
  { id: "services", label: "Services", emoji: "📦" },
  { id: "developer", label: "Developer", emoji: "💻" },
];

export const BOOTSTRAP_AREA: AreaTab = {
  id: "bootstrap",
  label: "Bootstrap",
  emoji: "🚀",
};

const MENU_ROWS = 2;
const STATUS_ROWS = 1;

type MainContentProps = Readonly<{
  activeArea: string;
  width: number;
  height: number;
  selectedServiceIndex: number;
  visibleServices: DevService[];
  servicesLoading?: boolean;
  instanceRuntime?: "deno" | "workers";
  daemonOperation?: DaemonOperation | null;
  serviceOperation?: ServiceOperation | null;
  onServiceAction?: (serviceId: string, action: ServiceActionId) => void | Promise<void>;
  onDaemonAction?: (action: DaemonActionId) => void | Promise<void>;
  onDeveloperDaemonAction?: (action: DaemonActionId) => void | Promise<void>;
  onSelectedServiceIndexChange?: (index: number) => void;
  onProvisioningDone?: () => void;
  onInstallFinished?: (success: boolean) => void;
  onDaemonInstallDone?: () => void;
  onPurgeDone?: () => void;
  onRefreshServices?: () => void;
  pendingRestart?: PendingRestart | null;
  restartInProgress?: string | null;
  restartOverlayServiceId?: string | null;
  restartLogOverlay?: ConsoleLogLine[];
  logFollowResetKey?: number;
  daemonLogByteFloor?: DaemonLogByteFloor | null;
  instanceLogByteFloor?: ServiceLogByteFloor | null;
  onConfirmRestart?: () => void;
  onCancelRestart?: () => void;
  pendingOptionalServices?: PendingOptionalServices | null;
  onConfirmOptionalServices?: (selection: OptionalDevServiceSelection) => void;
  onCancelOptionalServices?: () => void;
  pendingDestructiveAction?: DaemonActionId | null;
  onConfirmDestructiveAction?: () => void;
  onCancelDestructiveAction?: () => void;
  devEnvConverge?: DevEnvConvergeState | null;
  onDismissDevEnvConvergeError?: () => void;
  developerView?: DeveloperView;
  onCloseDeveloperView?: () => void;
  serviceTestsRepoId?: TestRepoId | null;
  onRunServiceTests?: (serviceId: string) => void;
  onCloseServiceTests?: () => void;
}>;

function MainContent({
  activeArea,
  width,
  height,
  selectedServiceIndex,
  visibleServices,
  servicesLoading,
  instanceRuntime,
  onProvisioningDone,
  onInstallFinished,
  onDaemonInstallDone,
  onPurgeDone,
  onRefreshServices,
  daemonOperation,
  serviceOperation,
  onServiceAction,
  onDaemonAction,
  onDeveloperDaemonAction,
  onSelectedServiceIndexChange,
  pendingRestart,
  restartInProgress,
  restartOverlayServiceId,
  restartLogOverlay,
  logFollowResetKey,
  daemonLogByteFloor,
  instanceLogByteFloor,
  onConfirmRestart,
  onCancelRestart,
  pendingOptionalServices,
  onConfirmOptionalServices,
  onCancelOptionalServices,
  pendingDestructiveAction,
  onConfirmDestructiveAction,
  onCancelDestructiveAction,
  devEnvConverge,
  onDismissDevEnvConvergeError,
  developerView,
  onCloseDeveloperView,
  serviceTestsRepoId,
  onRunServiceTests,
  onCloseServiceTests,
}: MainContentProps) {
  const daemon = visibleServices.find((service) => service.id === "daemon");

  const destructiveWarning = pendingDestructiveAction
    ? DESTRUCTIVE_ACTION_WARNINGS[pendingDestructiveAction]
    : undefined;
  const dangerModal = pendingDestructiveAction &&
    destructiveWarning &&
    onConfirmDestructiveAction &&
    onCancelDestructiveAction
    ? (
      <ConfirmDangerModal
        width={width}
        height={height}
        title={DAEMON_ACTION_LABELS[pendingDestructiveAction]}
        warning={destructiveWarning}
        onConfirm={onConfirmDestructiveAction}
        onCancel={onCancelDestructiveAction}
      />
    )
    : null;

  const optionalModal = pendingOptionalServices &&
    onConfirmOptionalServices &&
    onCancelOptionalServices
    ? (
      <OptionalServicesModal
        width={width}
        height={height}
        mode={pendingOptionalServices.mode}
        initialSelection={pendingOptionalServices.selection}
        onConfirm={onConfirmOptionalServices}
        onCancel={onCancelOptionalServices}
      />
    )
    : null;

  switch (activeArea) {
    case "bootstrap":
      return (
        <Box width={width} height={height}>
          <ProvisionerPanel
            phase={provisionerPhaseForDaemonOperation(daemonOperation)}
            width={width}
            height={height}
            onDone={onProvisioningDone!}
            onInstallFinished={onInstallFinished}
            onDaemonInstallDone={
              daemonOperation === "install" ? onDaemonInstallDone : undefined
            }
          />
          {optionalModal}
        </Box>
      );
    case "developer":
      return (
        <Box width={width} height={height}>
          <DeveloperPanel
            width={width}
            height={height}
            daemonStatus={daemon?.status}
            daemonOperation={daemonOperation}
            developerView={developerView}
            onCloseDeveloperView={onCloseDeveloperView}
            onDaemonAction={onDeveloperDaemonAction}
            onPurgeDone={onPurgeDone}
            onRefreshServices={onRefreshServices}
            restartInProgress={restartInProgress}
            restartOverlayServiceId={restartOverlayServiceId}
            restartLogOverlay={restartLogOverlay}
            logFollowResetKey={logFollowResetKey}
            instanceLogByteFloor={instanceLogByteFloor}
            inputBlocked={Boolean(pendingOptionalServices) || Boolean(pendingDestructiveAction)}
          />
          {optionalModal}
          {dangerModal}
        </Box>
      );
    case "services":
      if (serviceTestsRepoId && onCloseServiceTests) {
        return (
          <Box width={width} height={height}>
            <RunTestsView
              key={serviceTestsRepoId}
              width={width}
              height={height}
              focused
              initialRepoId={serviceTestsRepoId}
              onClose={onCloseServiceTests}
            />
            {optionalModal}
          </Box>
        );
      }
      return (
        <Box width={width} height={height}>
          <ServicesPanel
            width={width}
            height={height}
            services={visibleServices}
            servicesLoading={servicesLoading}
            instanceRuntime={instanceRuntime}
            selectedIndex={selectedServiceIndex}
            daemonOperation={daemonOperation}
            onDaemonAction={onDaemonAction}
            onSelectedIndexChange={onSelectedServiceIndexChange}
            onRefreshServices={onRefreshServices}
            serviceOperation={serviceOperation}
            onServiceAction={onServiceAction}
            onRunServiceTests={onRunServiceTests}
            pendingRestart={pendingRestart}
            restartInProgress={restartInProgress}
            restartOverlayServiceId={restartOverlayServiceId}
            restartLogOverlay={restartLogOverlay}
            logFollowResetKey={logFollowResetKey}
            daemonLogByteFloor={daemonLogByteFloor}
            instanceLogByteFloor={instanceLogByteFloor}
            onConfirmRestart={onConfirmRestart}
            onCancelRestart={onCancelRestart}
            pendingOptionalServices={pendingOptionalServices}
            devEnvConverge={devEnvConverge}
            onDismissDevEnvConvergeError={onDismissDevEnvConvergeError}
          />
          {optionalModal}
        </Box>
      );
    default:
      return null;
  }
}

type AppViewProps = Readonly<{
  activeArea: string;
  provisioning: boolean;
  installFinished?: boolean;
  columns: number;
  rows: number;
  selectedServiceIndex: number;
  selectedServiceId?: string | null;
  visibleServices: DevService[];
  servicesLoading?: boolean;
  instanceRuntime?: "deno" | "workers";
  daemonOperation?: DaemonOperation | null;
  serviceOperation?: ServiceOperation | null;
  onServiceAction?: (serviceId: string, action: ServiceActionId) => void | Promise<void>;
  onProvisioningDone?: () => void;
  onInstallFinished?: (success: boolean) => void;
  onDaemonInstallDone?: () => void;
  onPurgeDone?: () => void;
  onDaemonAction?: (action: DaemonActionId) => void | Promise<void>;
  onDeveloperDaemonAction?: (action: DaemonActionId) => void | Promise<void>;
  onSelectedServiceIndexChange?: (index: number) => void;
  onRefreshServices?: () => void;
  pendingRestart?: PendingRestart | null;
  restartInProgress?: string | null;
  restartOverlayServiceId?: string | null;
  restartLogOverlay?: ConsoleLogLine[];
  logFollowResetKey?: number;
  daemonLogByteFloor?: DaemonLogByteFloor | null;
  instanceLogByteFloor?: ServiceLogByteFloor | null;
  onConfirmRestart?: () => void;
  onCancelRestart?: () => void;
  pendingOptionalServices?: PendingOptionalServices | null;
  onConfirmOptionalServices?: (selection: OptionalDevServiceSelection) => void;
  onCancelOptionalServices?: () => void;
  pendingDestructiveAction?: DaemonActionId | null;
  onConfirmDestructiveAction?: () => void;
  onCancelDestructiveAction?: () => void;
  devEnvConverge?: DevEnvConvergeState | null;
  onDismissDevEnvConvergeError?: () => void;
  developerView?: DeveloperView;
  onCloseDeveloperView?: () => void;
  serviceTestsRepoId?: TestRepoId | null;
  onRunServiceTests?: (serviceId: string) => void;
  onCloseServiceTests?: () => void;
}>;

export function AppView({
  activeArea,
  provisioning,
  installFinished,
  columns,
  rows,
  selectedServiceIndex,
  selectedServiceId,
  visibleServices,
  servicesLoading,
  instanceRuntime,
  daemonOperation,
  onProvisioningDone,
  onInstallFinished,
  onDaemonInstallDone,
  onPurgeDone,
  onDaemonAction,
  onDeveloperDaemonAction,
  onSelectedServiceIndexChange,
  onRefreshServices,
  serviceOperation,
  onServiceAction,
  pendingRestart,
  restartInProgress,
  restartOverlayServiceId,
  restartLogOverlay,
  logFollowResetKey,
  daemonLogByteFloor,
  instanceLogByteFloor,
  onConfirmRestart,
  onCancelRestart,
  pendingOptionalServices,
  onConfirmOptionalServices,
  onCancelOptionalServices,
  pendingDestructiveAction,
  onConfirmDestructiveAction,
  onCancelDestructiveAction,
  devEnvConverge,
  onDismissDevEnvConvergeError,
  developerView,
  onCloseDeveloperView,
  serviceTestsRepoId,
  onRunServiceTests,
  onCloseServiceTests,
}: AppViewProps) {
  const activeIndex = AREAS.findIndex((area) => area.id === activeArea);
  const menuActiveIndex = Math.max(activeIndex, 0);
  const innerWidth = columns - 2;
  const contentHeight = rows - MENU_ROWS - STATUS_ROWS;
  const status = statusHints({
    activeAreaId: activeArea,
    selectedServiceId,
    installFinished,
    pendingRestart,
    restartInProgress,
    devEnvConverging: daemonOperation === "dev-env" || Boolean(devEnvConverge?.active),
    developerView,
    pendingOptionalServices,
    pendingDestructiveAction,
    serviceTestsRepoId,
    instanceRuntime,
  });

  return (
    <Box
      flexDirection="column"
      width={columns}
      height={rows}
    >
      <MenuBar
        areas={AREAS}
        activeIndex={menuActiveIndex}
        columns={columns}
        provisioning={provisioning}
        bootstrapArea={BOOTSTRAP_AREA}
      />

      <MainPanel width={columns} status={status}>
        <MainContent
          activeArea={activeArea}
          width={innerWidth}
          height={contentHeight}
          selectedServiceIndex={selectedServiceIndex}
          visibleServices={visibleServices}
          servicesLoading={servicesLoading}
          instanceRuntime={instanceRuntime}
          daemonOperation={daemonOperation}
          onProvisioningDone={onProvisioningDone}
          onInstallFinished={onInstallFinished}
          onDaemonInstallDone={onDaemonInstallDone}
          onPurgeDone={onPurgeDone}
          onDaemonAction={onDaemonAction}
          onDeveloperDaemonAction={onDeveloperDaemonAction}
          onSelectedServiceIndexChange={onSelectedServiceIndexChange}
          onRefreshServices={onRefreshServices}
          serviceOperation={serviceOperation}
          onServiceAction={onServiceAction}
          pendingRestart={pendingRestart}
          restartInProgress={restartInProgress}
          restartOverlayServiceId={restartOverlayServiceId}
          restartLogOverlay={restartLogOverlay}
          logFollowResetKey={logFollowResetKey}
          daemonLogByteFloor={daemonLogByteFloor}
          instanceLogByteFloor={instanceLogByteFloor}
          onConfirmRestart={onConfirmRestart}
          onCancelRestart={onCancelRestart}
          pendingOptionalServices={pendingOptionalServices}
          onConfirmOptionalServices={onConfirmOptionalServices}
          onCancelOptionalServices={onCancelOptionalServices}
          pendingDestructiveAction={pendingDestructiveAction}
          onConfirmDestructiveAction={onConfirmDestructiveAction}
          onCancelDestructiveAction={onCancelDestructiveAction}
          devEnvConverge={devEnvConverge}
          onDismissDevEnvConvergeError={onDismissDevEnvConvergeError}
          developerView={developerView}
          onCloseDeveloperView={onCloseDeveloperView}
          serviceTestsRepoId={serviceTestsRepoId}
          onRunServiceTests={onRunServiceTests}
          onCloseServiceTests={onCloseServiceTests}
        />
      </MainPanel>
    </Box>
  );
}
