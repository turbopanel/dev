import React from "react";
import { useWindowSize } from "ink";
import { AppView } from "./app.tsx";
import { useConsoleApp } from "./hooks/use-console-app.ts";
import { useInstanceRuntime } from "./hooks/use-instance-runtime.ts";

export function ConsoleApp() {
  const { columns, rows } = useWindowSize();
  const consoleApp = useConsoleApp();
  const instanceRuntime = useInstanceRuntime();

  return (
    <AppView
      activeArea={consoleApp.activeArea}
      provisioning={consoleApp.provisioning}
      installFinished={consoleApp.installFinished}
      columns={columns}
      rows={rows}
      selectedServiceIndex={consoleApp.selectedServiceIndex}
      selectedServiceId={consoleApp.selectedService?.id ?? null}
      visibleServices={consoleApp.visibleServices}
      servicesLoading={consoleApp.servicesLoading}
      instanceRuntime={instanceRuntime}
      daemonOperation={consoleApp.daemonOperation}
      onProvisioningDone={consoleApp.handleProvisioningDone}
      onInstallFinished={consoleApp.handleInstallFinished}
      onDaemonInstallDone={consoleApp.handleDaemonInstallDone}
      onPurgeDone={consoleApp.handlePurgeDone}
      onDaemonAction={consoleApp.handleDaemonAction}
      onDeveloperDaemonAction={consoleApp.handleDaemonAction}
      onSelectedServiceIndexChange={consoleApp.setSelectedServiceIndex}
      onRefreshServices={consoleApp.refreshServices}
      serviceOperation={consoleApp.serviceOperation}
      onServiceAction={consoleApp.handleServiceAction}
      pendingRestart={consoleApp.pendingRestart}
      restartInProgress={consoleApp.restartInProgress}
      restartOverlayServiceId={consoleApp.restartOverlayServiceId}
      restartLogOverlay={consoleApp.restartLogOverlay}
      logFollowResetKey={consoleApp.logFollowResetKey}
      daemonLogByteFloor={consoleApp.daemonLogByteFloor}
      instanceLogByteFloor={consoleApp.instanceLogByteFloor}
      onConfirmRestart={consoleApp.confirmServiceRestart}
      onCancelRestart={consoleApp.cancelServiceRestart}
      pendingOptionalServices={consoleApp.pendingOptionalServices}
      onConfirmOptionalServices={consoleApp.confirmOptionalServices}
      onCancelOptionalServices={consoleApp.cancelOptionalServices}
      pendingDestructiveAction={consoleApp.pendingDestructiveAction}
      onConfirmDestructiveAction={consoleApp.confirmDestructiveAction}
      onCancelDestructiveAction={consoleApp.cancelDestructiveAction}
      devEnvConverge={consoleApp.devEnvConverge}
      onDismissDevEnvConvergeError={consoleApp.dismissDevEnvConvergeError}
      developerView={consoleApp.developerView}
      onCloseDeveloperView={consoleApp.closeDeveloperView}
      serviceTestsRepoId={consoleApp.serviceTestsRepoId}
      onRunServiceTests={consoleApp.openServiceTests}
      onCloseServiceTests={consoleApp.closeServiceTests}
    />
  );
}
