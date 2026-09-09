import React, { useEffect, useMemo, useState } from "react";
import { useDaemonEnv } from "../hooks/use-daemon-env.ts";
import { Box, Text, useInput } from "ink";
import type { DevServiceStatus } from "../dev-services.ts";
import {
  cellTraceToggleLabel,
  DAEMON_ACTION_LABELS,
  developerMenuActions,
  type DaemonActionId,
} from "../lib/daemon-actions.ts";
import type { ConsoleLogLine } from "../lib/service-restart.ts";
import type { ServiceLogByteFloor } from "../lib/service-log.ts";
import type { DaemonOperation } from "../lib/spinners.ts";
import { useLogScroll } from "../hooks/use-log-scroll.ts";
import { useServiceLog } from "../hooks/use-service-log.ts";
import { LIST_SELECT_BG, LIST_SELECT_FG } from "../theme.ts";
import { CellTraceView } from "./cell-trace-view.tsx";
import { PlainLogView } from "./plain-log-view.tsx";
import { PurgeDaemonPanel } from "./purge-daemon-panel.tsx";
import { RunTestsView } from "./run-tests-view.tsx";

const RESTART_HEADER_ROWS = 2;

function DeveloperRestartOverlay({
  width,
  height,
  restartLabel,
  restartOverlayServiceId,
  restartLogOverlay,
  logFollowResetKey,
  instanceLogByteFloor,
}: Readonly<{
  width: number;
  height: number;
  restartLabel: string;
  restartOverlayServiceId: string;
  restartLogOverlay: ConsoleLogLine[];
  logFollowResetKey?: number;
  instanceLogByteFloor?: ServiceLogByteFloor | null;
}>) {
  const { lines: fileLogLines } = useServiceLog(restartOverlayServiceId, instanceLogByteFloor);
  const logLines = useMemo(
    () => [
      ...fileLogLines,
      ...restartLogOverlay.map((line) => ({ text: line.text, time: line.time })),
    ],
    [fileLogLines, restartLogOverlay],
  );
  const logHeight = Math.max(1, height - RESTART_HEADER_ROWS);
  const { scrollIndex: logScrollIndex } = useLogScroll({
    lineCount: logLines.length,
    viewportHeight: logHeight,
    focused: false,
    resetKey: restartOverlayServiceId,
    followResetKey: logFollowResetKey,
  });

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      paddingX={1}
      paddingY={1}
    >
      <Text bold>Restarting {restartLabel}</Text>
      <Box marginTop={1} flexGrow={1}>
        <PlainLogView
          lines={logLines}
          width={width}
          height={logHeight}
          selectedIndex={logScrollIndex}
          focused={false}
        />
      </Box>
    </Box>
  );
}

function developerActionLabel(action: DaemonActionId): string {
  if (action === "toggle-cell-trace") {
    return cellTraceToggleLabel();
  }
  return DAEMON_ACTION_LABELS[action];
}

function DeveloperMenuPanel({
  width,
  height,
  daemonStatus,
  onDaemonAction,
  inputBlocked = false,
}: Readonly<{
  width: number;
  height: number;
  daemonStatus?: DevServiceStatus;
  onDaemonAction?: (action: DaemonActionId) => void | Promise<void>;
  inputBlocked?: boolean;
}>) {
  // Memoized: `developerMenuActions` reads daemon.env, so calling it in the
  // render body cost ~54ms per repaint on hosts where that needs sudo.
  const daemonEnv = useDaemonEnv();
  const actions = useMemo(
    () => developerMenuActions(daemonStatus, daemonEnv),
    [daemonStatus, daemonEnv],
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setSelectedIndex(0);
    setMessage(null);
  }, [daemonStatus]);

  useEffect(() => {
    if (selectedIndex >= actions.length) {
      setSelectedIndex(Math.max(0, actions.length - 1));
    }
  }, [actions.length, selectedIndex]);

  useInput((_input, key) => {
    if (inputBlocked) {
      return;
    }
    if (actions.length === 0 || !onDaemonAction) {
      return;
    }

    const lastIndex = actions.length - 1;
    if (key.upArrow) {
      setSelectedIndex((index) => Math.max(0, index - 1));
      setMessage(null);
    }
    if (key.downArrow) {
      setSelectedIndex((index) => Math.min(lastIndex, index + 1));
      setMessage(null);
    }
    if (_input.toLowerCase() === "u" && actions.includes("rebuild-daemon-upgrade")) {
      void Promise.resolve(onDaemonAction("rebuild-daemon-upgrade")).catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        setMessage(text);
      });
      return;
    }
    if (key.return) {
      const action = actions[selectedIndex];
      if (action) {
        void Promise.resolve(onDaemonAction(action)).catch((error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          setMessage(text);
        });
      }
    }
  });

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      paddingX={1}
      paddingY={1}
    >
      <Text bold>Developer</Text>
      <Box marginTop={1}>
        <Text dimColor>TurboPanel development console</Text>
      </Box>

      {actions.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {actions.map((action, index) => {
            const selected = index === selectedIndex;
            return (
              <Box
                key={action}
                width={Math.max(1, width - 2)}
                backgroundColor={selected ? LIST_SELECT_BG : undefined}
                flexDirection="row"
              >
                <Text color={selected ? LIST_SELECT_FG : undefined} bold={selected}>
                  {developerActionLabel(action)}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {message && (
        <Box marginTop={1}>
          <Text color="red">{message}</Text>
        </Box>
      )}
    </Box>
  );
}

export function DeveloperPanel({
  width,
  height,
  daemonStatus,
  daemonOperation,
  developerView = "menu",
  onCloseDeveloperView,
  onDaemonAction,
  onPurgeDone,
  onRefreshServices,
  restartInProgress,
  restartOverlayServiceId,
  restartLogOverlay,
  logFollowResetKey,
  instanceLogByteFloor,
  inputBlocked = false,
}: Readonly<{
  width: number;
  height: number;
  daemonStatus?: DevServiceStatus;
  daemonOperation?: DaemonOperation | null;
  developerView?: "menu" | "cell-trace" | "run-tests";
  onCloseDeveloperView?: () => void;
  onDaemonAction?: (action: DaemonActionId) => void | Promise<void>;
  onPurgeDone?: () => void;
  onRefreshServices?: () => void;
  restartInProgress?: string | null;
  restartOverlayServiceId?: string | null;
  restartLogOverlay?: ConsoleLogLine[];
  logFollowResetKey?: number;
  instanceLogByteFloor?: ServiceLogByteFloor | null;
  inputBlocked?: boolean;
}>) {
  useEffect(() => {
    if (restartInProgress) {
      onRefreshServices?.();
    }
  }, [restartInProgress, onRefreshServices]);

  if (daemonOperation === "purge" && onPurgeDone) {
    return (
      <PurgeDaemonPanel
        width={width}
        height={height}
        onDone={onPurgeDone}
      />
    );
  }

  if (restartInProgress && restartOverlayServiceId) {
    return (
      <DeveloperRestartOverlay
        width={width}
        height={height}
        restartLabel={restartInProgress}
        restartOverlayServiceId={restartOverlayServiceId}
        restartLogOverlay={restartLogOverlay ?? []}
        logFollowResetKey={logFollowResetKey}
        instanceLogByteFloor={instanceLogByteFloor}
      />
    );
  }

  if (developerView === "cell-trace" && onCloseDeveloperView) {
    return (
      <CellTraceView
        width={width}
        height={height}
        focused
        onClose={onCloseDeveloperView}
      />
    );
  }

  if (developerView === "run-tests" && onCloseDeveloperView) {
    return (
      <RunTestsView
        width={width}
        height={height}
        focused
        onClose={onCloseDeveloperView}
      />
    );
  }

  return (
    <DeveloperMenuPanel
      width={width}
      height={height}
      daemonStatus={daemonStatus}
      onDaemonAction={onDaemonAction}
      inputBlocked={inputBlocked}
    />
  );
}
