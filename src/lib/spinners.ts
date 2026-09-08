export const INSTALL_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const PURGE_SPINNER_FRAMES = ["|", "/", "-", "\\"];
export const TASK_SPINNER_FRAMES = [".", "o", "O", "o"];

export type DaemonOperation =
  | "install"
  | "purge"
  | "restart"
  | "dev-env"
  | "reset-dev-env"
  | "reset-dev-db"
  | "save-tier-catalogue"
  | "sync-dev-build"
  | "rebuild-daemon-upgrade";

export function spinnerFrames(operation: DaemonOperation): string[] {
  return operation === "purge" ? PURGE_SPINNER_FRAMES : INSTALL_SPINNER_FRAMES;
}

/** Braille for console steps/plays; dot pulse for Ansible leaf tasks. */
export function ansibleSpinnerFrames(depth: number): string[] {
  return depth >= 2 ? TASK_SPINNER_FRAMES : INSTALL_SPINNER_FRAMES;
}
