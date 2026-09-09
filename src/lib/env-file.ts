import {
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveDevIdentity } from "./dev-identity.ts";
import {
  spawnSyncTrusted,
  spawnSyncTrustedText,
  spawnTrustedText,
} from "./spawn-trusted.ts";

export function readEnvFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    const result = spawnSyncTrustedText("sudo", ["-n", "cat", path], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? (result.stdout ?? "") : "";
  }
}

/** Async sibling of {@link readEnvFile} — never blocks the Ink event loop. */
export async function readEnvFileAsync(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    const result = await spawnTrustedText("sudo", ["-n", "cat", path]);
    return result.status === 0 ? result.stdout : "";
  }
}

export function writeEnvFile(path: string, content: string): void {
  try {
    writeFileSync(path, content);
    return;
  } catch {
    // Fall through when the config dir isn't yet writable by the dev user.
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "turbopanel-env-"));
  const tmpPath = join(tmpDir, "env");
  try {
    writeFileSync(tmpPath, content);
    // /etc/turbopanel may not exist yet on the very first run (before any converge).
    const mkdir = spawnSyncTrusted("sudo", ["-n", "mkdir", "-p", dirname(path)], {
      stdio: "ignore",
    });
    if (mkdir.status !== 0) {
      throw new Error(`Failed to create ${dirname(path)}`);
    }
    const result = spawnSyncTrusted("sudo", ["-n", "cp", tmpPath, path], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(`Failed to write ${path}`);
    }
    const dev = resolveDevIdentity();
    spawnSyncTrusted(
      "sudo",
      ["-n", "chown", `${dev.user}:${dev.gid}`, path],
      { stdio: "ignore" },
    );
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

const ENV_LINE_RE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;
const ENV_KEY_PREFIX_RE = /^([A-Z_][A-Z0-9_]*)=/;

export function parseEnvEntries(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split("\n")) {
    const match = ENV_LINE_RE.exec(line);
    if (match) {
      entries.set(match[1]!, match[2]!);
    }
  }
  return entries;
}

function mergeEnvLine(
  line: string,
  entries: Record<string, string>,
  managedKeys: Set<string>,
  removeKeys: Set<string>,
  updated: Set<string>,
): string | null {
  const match = ENV_KEY_PREFIX_RE.exec(line);
  if (!match) {
    return line;
  }

  const key = match[1]!;
  if (removeKeys.has(key)) {
    return null;
  }
  if (!managedKeys.has(key)) {
    return line;
  }
  if (updated.has(key)) {
    return null;
  }

  updated.add(key);
  return `${key}=${entries[key]}`;
}

export function mergeEnvFile(
  path: string,
  entries: Record<string, string>,
  options?: { removeKeys?: string[] },
): void {
  const managedKeys = new Set(Object.keys(entries));
  const removeKeys = new Set(options?.removeKeys ?? []);
  const updated = new Set<string>();
  const lines: string[] = [];
  const content = readEnvFile(path);

  if (content.length > 0) {
    for (const line of content.split("\n")) {
      const merged = mergeEnvLine(line, entries, managedKeys, removeKeys, updated);
      if (merged !== null) {
        lines.push(merged);
      }
    }
  }

  for (const [key, value] of Object.entries(entries)) {
    if (!updated.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }

  writeEnvFile(path, `${lines.join("\n")}\n`);
}
