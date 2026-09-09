import { fileURLToPath } from "node:url";
import React, { useEffect, useState } from "react";
import { render, useWindowSize } from "ink";
import { createServer, normalizePath, type ViteDevServer } from "vite";
import type { AppView as AppViewComponent, AREAS as AppAreas } from "../src/app.tsx";
import { BootScreen } from "../src/components/boot-screen.tsx";
import { useConsoleApp } from "../src/hooks/use-console-app.ts";
import { useInstanceRuntime } from "../src/hooks/use-instance-runtime.ts";
import { openConsoleStdin } from "../src/lib/console-stdin.ts";

type AppModule = {
  AppView: typeof AppViewComponent;
  AREAS: typeof AppAreas;
};

const ENTRY = "/src/app.tsx";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const configFile = fileURLToPath(new URL("../vite.config.ts", import.meta.url));

async function loadAppModule(server: ViteDevServer): Promise<AppModule> {
  server.moduleGraph.invalidateAll();
  return await server.ssrLoadModule(`${ENTRY}?t=${Date.now()}`) as AppModule;
}

function HotReloadApp({
  server,
  initialModule,
}: Readonly<{
  server: ViteDevServer;
  initialModule: AppModule;
}>) {
  const { columns, rows } = useWindowSize();
  const [appModule, setAppModule] = useState(initialModule);
  const consoleApp = useConsoleApp();
  const instanceRuntime = useInstanceRuntime();

  useEffect(() => {
    let timeout: NodeJS.Timeout | undefined;
    let disposed = false;

    const reload = () => {
      clearTimeout(timeout);
      timeout = setTimeout(async () => {
        try {
          const nextModule = await loadAppModule(server);
          if (!disposed) setAppModule(nextModule);
        } catch (error) {
          process.stderr.write(`${String(error)}\n`);
        }
      }, 50);
    };

    const shouldReload = (path: string) => {
      const normalized = normalizePath(path);
      return normalized.startsWith(normalizePath(`${repoRoot}/src/`));
    };

    const onChange = (path: string) => {
      if (shouldReload(path)) reload();
    };

    server.watcher.on("change", onChange);
    server.watcher.on("add", onChange);
    server.watcher.on("unlink", onChange);

    return () => {
      disposed = true;
      clearTimeout(timeout);
      server.watcher.off("change", onChange);
      server.watcher.off("add", onChange);
      server.watcher.off("unlink", onChange);
    };
  }, [server]);

  const AppView = appModule.AppView;
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
      devEnvConverge={consoleApp.devEnvConverge}
      onDismissDevEnvConvergeError={consoleApp.dismissDevEnvConvergeError}
      developerView={consoleApp.developerView}
      onCloseDeveloperView={consoleApp.closeDeveloperView}
    />
  );
}

function Root() {
  const [ready, setReady] = useState<{
    server: ViteDevServer;
    initialModule: AppModule;
  } | null>(null);
  const [message, setMessage] = useState("Loading console modules…");

  useEffect(() => {
    const slowTimer = setTimeout(() => {
      setMessage("Still loading — compiling TypeScript modules…");
    }, 2_000);
    const slowerTimer = setTimeout(() => {
      setMessage("Still loading — first launch may take a moment…");
    }, 8_000);

    let server: ViteDevServer | undefined;

    void (async () => {
      try {
        server = await createServer({
          configFile,
          appType: "custom",
          server: {
            middlewareMode: true,
            hmr: false,
            watch: {
              ignored: ["**/node_modules/**", "**/.git/**"],
            },
          },
        });
        const initialModule = await loadAppModule(server);
        setReady({ server, initialModule });
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "Failed to load console",
        );
      } finally {
        clearTimeout(slowTimer);
        clearTimeout(slowerTimer);
      }
    })();

    return () => {
      clearTimeout(slowTimer);
      clearTimeout(slowerTimer);
      server?.close()?.catch(() => undefined);
    };
  }, []);

  if (!ready) {
    return <BootScreen message={message} />;
  }

  return (
    <HotReloadApp server={ready.server} initialModule={ready.initialModule} />
  );
}

const stdin = openConsoleStdin();

const { waitUntilExit } = render(<Root />, {
  stdin,
  alternateScreen: true,
  exitOnCtrlC: true,
  patchConsole: true,
});

try {
  await waitUntilExit();
} finally {
  // HotReloadApp owns the server lifecycle via Root cleanup on unmount.
}
