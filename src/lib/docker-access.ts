import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { spawnTrustedText, type TrustedTextResult } from "./spawn-trusted.ts";

type SpawnResult = SpawnSyncReturns<string>;

function spawnFirst(attempts: string[][]): SpawnResult | null {
  for (const cmd of attempts) {
    const result = spawnSync(cmd[0]!, cmd.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      return result;
    }
  }
  return null;
}

export function spawnDocker(args: string[]): SpawnResult | null {
  // Try the dev user's own docker access first, then fall back to sudo for the
  // window before the dev user's docker group membership has taken effect.
  return spawnFirst([
    ["docker", ...args],
    ["sudo", "-n", "docker", ...args],
  ]);
}

export function dockerOutputLines(result: SpawnResult): string[] {
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return combined
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

/** Async sibling of {@link spawnDocker} — same dev-user-then-sudo fallback. */
export async function spawnDockerAsync(
  args: readonly string[],
): Promise<TrustedTextResult | null> {
  const attempts: string[][] = [
    ["docker", ...args],
    ["sudo", "-n", "docker", ...args],
  ];
  for (const [command, ...rest] of attempts) {
    const result = await spawnTrustedText(command!, rest);
    if (result.status === 0) {
      return result;
    }
  }
  return null;
}
