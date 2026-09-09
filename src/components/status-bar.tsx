import React, { memo } from "react";
import { Box, Text } from "ink";
import { testRepoForServiceId } from "../lib/run-repo-tests.ts";
import { isManagedService } from "../lib/service-actions.ts";
import { serviceSupportsOpen } from "../lib/service-urls.ts";
import { BORDER_COLOR } from "../theme.ts";

import type { PendingRestart, PendingOptionalServices, DeveloperView } from "../hooks/use-console-app.ts";
import type { DaemonActionId } from "../lib/daemon-actions.ts";

function serviceActionHints(
  selectedServiceId: string | null | undefined,
  instanceRuntime: "deno" | "workers",
): string {
  if (!selectedServiceId || !isManagedService(selectedServiceId)) {
    return "";
  }

  const parts = ["R restart", "X disable", "E enable"];
  if (selectedServiceId === "daemon" && instanceRuntime === "deno") {
    parts.push("U rebuild remotes");
  }
  if (serviceSupportsOpen(selectedServiceId)) {
    parts.push("O open");
  }
  if (selectedServiceId === "instance") {
    parts.push(instanceRuntime === "deno" ? "W worker" : "D deno");
  }
  return ` · ${parts.join(" · ")}`;
}

/** Navigation keys always shown on the Services list (before per-service actions). */
export function servicesNavHints(selectedServiceId?: string | null): string {
  const parts = [
    "← → tabs",
    "↑↓ select",
    "Tab log",
    "↑↓ scroll",
    "L logs",
  ];
  if (selectedServiceId && testRepoForServiceId(selectedServiceId)) {
    parts.push("T tests");
  }
  return parts.join(" · ");
}

export type StatusHintsContext = {
  activeAreaId: string;
  selectedServiceId?: string | null;
  installFinished?: boolean;
  pendingRestart?: PendingRestart | null;
  restartInProgress?: string | null;
  devEnvConverging?: boolean;
  developerView?: DeveloperView;
  pendingOptionalServices?: PendingOptionalServices | null;
  /** When set, a destructive developer action is awaiting confirmation. */
  pendingDestructiveAction?: DaemonActionId | null;
  /** When set, Services is showing the per-service Run tests overlay. */
  serviceTestsRepoId?: string | null;
  /**
   * Instance runtime, passed in rather than read here — `statusHints` runs on
   * every repaint and `daemon.env` reads can cost a `sudo` subprocess.
   */
  instanceRuntime?: "deno" | "workers";
};

function optionalServicesHints(mode: PendingOptionalServices["mode"]): string {
  if (mode === "converge") {
    return "↑ ↓ · Space toggle · Enter continue · Esc cancel · auto in 5s · Ctrl-C exit";
  }
  return "↑ ↓ · Space toggle · Enter apply · Esc cancel · Ctrl-C exit";
}

function servicesAreaHints(ctx: StatusHintsContext): string {
  if (ctx.devEnvConverging) {
    return "Converging development environment · watch tasks · Ctrl-C exit";
  }
  if (ctx.pendingRestart) {
    return "↑ ↓ Yes/No · Enter select · Esc cancel · Ctrl-C exit";
  }
  if (ctx.restartInProgress) {
    return `Restarting ${ctx.restartInProgress} · watch logs · Ctrl-C exit`;
  }
  if (ctx.serviceTestsRepoId) {
    return "↑ ↓ choose · Enter · Esc back/cancel · Ctrl-C exit";
  }
  const actionHints = serviceActionHints(
    ctx.selectedServiceId,
    ctx.instanceRuntime ?? "deno",
  );
  return `${servicesNavHints(ctx.selectedServiceId)}${actionHints} · Ctrl-C exit`;
}

function developerAreaHints(ctx: StatusHintsContext): string {
  if (ctx.pendingDestructiveAction) {
    return "↑ ↓ Yes/Cancel · Enter select · Esc cancel · Ctrl-C exit";
  }
  if (ctx.restartInProgress) {
    return `Restarting ${ctx.restartInProgress} · watch logs · Ctrl-C exit`;
  }
  if (ctx.developerView === "cell-trace") {
    return "↑ ↓ scroll · Esc back · Ctrl-C exit";
  }
  if (ctx.developerView === "run-tests") {
    return "↑ ↓ choose · Enter · Esc back/cancel · Ctrl-C exit";
  }
  return "↑ ↓ choose action · Enter run · ← → switch tabs · Ctrl-C exit";
}

export function statusHints(ctx: StatusHintsContext): string {
  if (ctx.pendingOptionalServices) {
    return optionalServicesHints(ctx.pendingOptionalServices.mode);
  }
  if (ctx.activeAreaId === "services") {
    return servicesAreaHints(ctx);
  }
  if (ctx.activeAreaId === "developer") {
    return developerAreaHints(ctx);
  }
  if (ctx.activeAreaId === "bootstrap") {
    if (ctx.installFinished) {
      return "Finishing install · Ctrl-C exit";
    }
    return "Installing development environment · Ctrl-C exit";
  }
  return "← → switch tabs · Ctrl-C exit";
}

export const StatusBar = memo(function StatusBar({
  width,
  status,
}: {
  width: number;
  status: string;
}) {
  const labelWidth = Math.min(status.length + 2, width - 4);
  const inner = width - 2;
  const dashTotal = Math.max(0, inner - labelWidth);
  const leftDashes = Math.floor(dashTotal / 2);
  const rightDashes = dashTotal - leftDashes;

  const maxLabelChars = Math.max(0, labelWidth - 2);
  const display =
    status.length > maxLabelChars
      ? status.slice(0, Math.max(0, maxLabelChars - 1)) + "…"
      : status;

  return (
    <Box flexDirection="row" width={width} height={1} flexShrink={0}>
      <Text color={BORDER_COLOR}>
        ╰{"─".repeat(leftDashes)}
      </Text>
      <Box
        width={labelWidth}
        height={1}
        justifyContent="center"
        paddingX={1}
      >
        <Text dimColor wrap="truncate">
          {display}
        </Text>
      </Box>
      <Text color={BORDER_COLOR}>
        {"─".repeat(rightDashes)}╯
      </Text>
    </Box>
  );
});
