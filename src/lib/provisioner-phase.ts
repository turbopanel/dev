import type { DaemonOperation } from "./spinners.ts";

export type ProvisionerPhase =
  | "daemon"
  | "dev-env"
  | "reset-dev-env"
  | "reset-dev-db"
  | "save-tier-catalogue"
  | "sync-dev-build"
  | "rebuild-daemon-upgrade";

/**
 * Map the active developer operation onto a ProvisionerPanel phase.
 *
 * Rebuild / sync / reset must never fall through to `"daemon"` — that phase
 * runs full bootstrap and then the optional-services picker → converge.
 */
export function provisionerPhaseForDaemonOperation(
  operation: DaemonOperation | null | undefined,
): ProvisionerPhase {
  switch (operation) {
    case "dev-env":
      return "dev-env";
    case "reset-dev-env":
      return "reset-dev-env";
    case "reset-dev-db":
      return "reset-dev-db";
    case "save-tier-catalogue":
      return "save-tier-catalogue";
    case "sync-dev-build":
      return "sync-dev-build";
    case "rebuild-daemon-upgrade":
      return "rebuild-daemon-upgrade";
    case "install":
    case "purge":
    case "restart":
    case undefined:
    case null:
      return "daemon";
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}
