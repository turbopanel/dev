import { spawnSync } from "node:child_process";
import {
  daemonBootstrapScript,
  daemonDenoConfig,
  daemonOrchestrationScript,
  DENO_VERSION,
  RUNTIMES_DIR,
  VENDORED_DENO_BIN,
} from "./paths.ts";
import { type InstallOutputHandler, runCaptured } from "./install-output.ts";
import { shellQuote } from "./shell-quote.ts";
import { spawnSyncTrusted } from "./spawn-trusted.ts";

/** True when the host runs the production runtime contract (compiled entrypoints). */
export function isProductionRuntime(): boolean {
  return process.env.TURBOPANEL_RUNTIME === "production";
}

/** Resolve Deno from the developer host PATH (not managed by turbopanel-dev). */
export function lookupHostDenoBin(): string | null {
  const result = spawnSync("/bin/sh", ["-c", "command -v deno"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const bin = (result.stdout ?? "").trim();
  if (result.status !== 0 || bin.length === 0) {
    return null;
  }
  return bin;
}

/** Resolve Deno from the developer host PATH (not managed by turbopanel-dev). */
export function resolveHostDenoBin(): string {
  const bin = lookupHostDenoBin();
  if (!bin) {
    throw new Error(
      "Deno is not on PATH — install Deno on the host for development bootstrap",
    );
  }
  return bin;
}

/** Report the version a Deno binary announces, or null when it will not run. */
export function resolveDenoBinVersion(bin: string): string | null {
  const result = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  const stdout = result.stdout ?? "";
  const newline = stdout.indexOf("\n");
  const first = newline === -1 ? stdout : stdout.slice(0, newline);
  return /^deno\s+([\d.]+)/.exec(first.trim())?.[1] ?? null;
}

/** True when a host Deno is the exact version orchestration pins. */
export function hostDenoMatchesPin(bin: string): boolean {
  return resolveDenoBinVersion(bin) === DENO_VERSION;
}

function pathIsExecutable(path: string): boolean {
  const direct = spawnSync("/bin/sh", ["-c", `test -x ${shellQuote(path)}`], {
    stdio: "ignore",
  });
  if (direct.status === 0) {
    return true;
  }
  const sudo = spawnSyncTrusted("sudo", ["-n", "test", "-x", path], {
    stdio: "ignore",
  });
  return sudo.status === 0;
}

/** True when RUNTIMES_DIR can be written without escalating to sudo. */
function runtimesDirWritable(): boolean {
  const result = spawnSync(
    "/bin/sh",
    ["-c", `test -w ${shellQuote(RUNTIMES_DIR)}`],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

/**
 * Run a vendor-tree script unprivileged when RUNTIMES_DIR is already writable,
 * escalating to `sudo -n` only when that is impossible or fails.
 *
 * Dev hosts that own the vendor tree need no escalation at all, so a missing or
 * password-prompting sudoers entry stops being the thing that decides whether
 * the console can repair its own runtime.
 */
async function runRuntimesScript(
  script: string,
  onOutput?: InstallOutputHandler,
): Promise<number> {
  if (runtimesDirWritable()) {
    const direct = await runCaptured(["bash", "-c", script], onOutput);
    if (direct === 0) {
      return 0;
    }
  }
  return await runCaptured(["sudo", "-n", "bash", "-c", script], onOutput);
}

/** Point `current` / `bin/deno` at the pinned version directory. */
function denoSymlinkScript(): string {
  return [
    "set -euo pipefail",
    `RUNTIMES_DIR=${shellQuote(RUNTIMES_DIR)}`,
    `VERSION=${shellQuote(DENO_VERSION)}`,
    'mkdir -p "$RUNTIMES_DIR/deno/bin"',
    'ln -sfn "$RUNTIMES_DIR/deno/$VERSION" "$RUNTIMES_DIR/deno/current"',
    'ln -sfn ../current/deno "$RUNTIMES_DIR/deno/bin/deno"',
  ].join("\n");
}

/** The pinned Deno binary, addressed by version rather than via `current`. */
export const PINNED_VENDORED_DENO_BIN =
  `${RUNTIMES_DIR}/deno/${DENO_VERSION}/deno`;

/** True when the pinned Deno binary exists under vendor/deno/<DENO_VERSION>/. */
function pinnedVendoredDenoUsable(): boolean {
  return pathIsExecutable(PINNED_VENDORED_DENO_BIN);
}

/** True when vendor/deno/current/deno resolves to an executable (any version). */
function vendoredDenoUsable(): boolean {
  return pathIsExecutable(VENDORED_DENO_BIN);
}

/**
 * True when vendor/deno/current/deno both runs and reports the pinned version.
 *
 * Executability alone says nothing about which release `current` points at, and
 * a `current` left behind by a superseded pin is exactly the case a pin bump has
 * to stop the console from exec'ing.
 */
function vendoredDenoMatchesPin(): boolean {
  return vendoredDenoUsable() &&
    resolveDenoBinVersion(VENDORED_DENO_BIN) === DENO_VERSION;
}

/**
 * Resolve the Deno the console should exec, pin first.
 *
 * A host Deno on PATH stays the developer-friendly default, but only while it
 * is the pinned version — otherwise the vendored pin wins, so the console and
 * orchestration agree on one runtime. The vendored answer is never
 * version-blind: `current` is returned only once it is known to report the pin,
 * and when it is stale the pinned versioned binary is exec'd directly instead.
 * A mismatched host is still better than nothing, so it remains the last resort
 * before throwing.
 */
export function resolveBootstrapDenoBin(): string {
  const host = lookupHostDenoBin();
  if (host && hostDenoMatchesPin(host)) {
    return host;
  }
  if (pinnedVendoredDenoUsable()) {
    return vendoredDenoMatchesPin()
      ? VENDORED_DENO_BIN
      : PINNED_VENDORED_DENO_BIN;
  }
  if (host) {
    return host;
  }
  if (vendoredDenoMatchesPin()) {
    return VENDORED_DENO_BIN;
  }
  throw new Error(
    `Deno is not installed — expected ${VENDORED_DENO_BIN} (pinned ${DENO_VERSION}) ` +
      "or Deno on PATH; re-run the Ensure Deno runtime step or install host Deno",
  );
}

/**
 * Ensure Deno is available (host PATH or vendored pin), then resolve its path.
 *
 * Callers that invoke orchestration via Deno should await this before
 * {@link orchestrationActionCommand} so converge/playbook paths do not fail
 * with a missing binary when only `ensureBootstrapDeno` was never run.
 */
export async function ensureOrchestrationDenoBin(
  onOutput?: InstallOutputHandler,
): Promise<string> {
  await ensureBootstrapDeno(onOutput);
  return resolveBootstrapDenoBin();
}

function resolveProductionDenoBin(): string {
  return resolveBootstrapDenoBin();
}

function denoRunBootstrapInvocation(denoBin: string): string {
  return [
    denoBin,
    "run",
    "--config",
    daemonDenoConfig(),
    "--allow-net",
    "--allow-read",
    "--allow-write",
    "--allow-run",
    "--allow-env",
    daemonBootstrapScript(),
  ].map(shellQuote).join(" ");
}

function resolveDenoAssetTriple(): string {
  const arch = process.arch;
  switch (arch) {
    case "arm64":
      return "aarch64-unknown-linux-gnu";
    case "x64":
      return "x86_64-unknown-linux-gnu";
    default:
      throw new Error(`Unsupported CPU architecture for Deno bootstrap: ${arch}`);
  }
}

function hostPython3Available(): boolean {
  const result = spawnSync("/bin/sh", ["-c", "command -v python3"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

/**
 * Install the pinned Deno under vendor/deno/<DENO_VERSION> and point
 * `current` / `bin/deno` at it (dl.deno.land release zip + python3 stdlib
 * extract — same CDN as `run.sh` / the `deno-runtime` Ansible role; avoid
 * `github.com/.../releases/download` which intermittently 503s from VMs).
 *
 * Writes go direct when RUNTIMES_DIR is already writable and fall back to
 * `sudo -n` only when they have to, so an unprivileged dev host can still repair
 * its own vendor tree.
 *
 * A host Deno on PATH short-circuits only when it *is* the pin; a mismatched
 * host warns and falls through so the pinned version gets vendored. An older
 * vendored `current` alone is not enough either — the pinned version must exist
 * (mirrors `tp_install_deno_runtime` in run.sh). Once it does, a `current` /
 * `bin/deno` relink that cannot be performed is reported and tolerated:
 * {@link resolveBootstrapDenoBin} execs {@link PINNED_VENDORED_DENO_BIN}
 * directly, so a stale symlink is drift to note, not a bootstrap failure.
 */
export async function ensureBootstrapDeno(
  onOutput?: InstallOutputHandler,
): Promise<void> {
  const hostBin = lookupHostDenoBin();
  if (hostBin) {
    const hostVersion = resolveDenoBinVersion(hostBin);
    if (hostVersion === DENO_VERSION) {
      return;
    }
    onOutput?.(
      `Host Deno ${hostVersion ?? "(unknown version)"} does not match pinned ` +
        `${DENO_VERSION} — vendoring pinned Deno for orchestration parity`,
    );
  }
  if (pinnedVendoredDenoUsable()) {
    // Repair drifted symlinks even when the pinned binary is already present.
    const linkCode = await runRuntimesScript(denoSymlinkScript(), onOutput);
    if (linkCode === 0 && vendoredDenoUsable()) {
      return;
    }
    // The relink is a convenience, not the contract: with the pinned binary on
    // disk `resolveBootstrapDenoBin` execs vendor/deno/<version>/deno directly.
    // A stale `current` we could not rewrite (no sudo, read-only vendor tree)
    // must therefore not send the console down the download path or fail the
    // bootstrap outright — the runtime it needs is already installed.
    onOutput?.(
      `Could not relink ${RUNTIMES_DIR}/deno/current to ${DENO_VERSION} — ` +
        `running the pinned ${PINNED_VENDORED_DENO_BIN} directly`,
    );
    return;
  }

  if (!hostPython3Available()) {
    throw new Error(
      "Deno is not installed — install host Deno, vendor it via stack converge, " +
        "or install python3-minimal to extract the release zip",
    );
  }

  const triple = resolveDenoAssetTriple();
  const installScript = [
    "set -euo pipefail",
    `RUNTIMES_DIR=${shellQuote(RUNTIMES_DIR)}`,
    `VERSION=${shellQuote(DENO_VERSION)}`,
    'DEST="$RUNTIMES_DIR/deno/$VERSION/deno"',
    'if [ ! -x "$DEST" ]; then',
    `ASSET="deno-${triple}.zip"`,
    'URL="https://dl.deno.land/release/v${VERSION}/${ASSET}"',
    'TMP="$(mktemp -d)"',
    'curl -fsSL -o "$TMP/$ASSET" "$URL"',
    `python3 - "$TMP/$ASSET" "$DEST" <<'PY'
import shutil, sys, tempfile, zipfile
from pathlib import Path

archive, dest = Path(sys.argv[1]), Path(sys.argv[2])
dest.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="deno-zip-") as tmp:
    tmp_path = Path(tmp)
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(tmp_path)
    candidates = list(tmp_path.rglob("deno"))
    if not candidates:
        raise SystemExit("deno binary not found in release zip")
    shutil.copy2(candidates[0], dest)
dest.chmod(0o755)
PY`,
    'rm -rf "$TMP"',
    "fi",
    'mkdir -p "$RUNTIMES_DIR/deno/bin"',
    'ln -sfn "$RUNTIMES_DIR/deno/$VERSION" "$RUNTIMES_DIR/deno/current"',
    'ln -sfn ../current/deno "$RUNTIMES_DIR/deno/bin/deno"',
  ].join("\n");

  const code = await runRuntimesScript(installScript, onOutput);
  if (code !== 0 || !pinnedVendoredDenoUsable() || !vendoredDenoUsable()) {
    const hint = code !== 0
      ? " — download or extract failed (often a transient dl.deno.land CDN error; retry)"
      : "";
    throw new Error(
      `Failed to install Deno ${DENO_VERSION} to ${VENDORED_DENO_BIN}${hint}`,
    );
  }
}

function denoRunOrchestrationInvocation(denoBin: string, actionArgs: string[]): string {
  return [
    denoBin,
    "run",
    "--config",
    daemonDenoConfig(),
    "--allow-read",
    "--allow-run",
    "--allow-env",
    "--allow-write",
    "--allow-net",
    daemonOrchestrationScript(),
    ...actionArgs,
  ].map(shellQuote).join(" ");
}

export type OrchestrationActionCommandOptions = {
  /** Pre-resolved Deno binary; skips host/vendored resolution when set. */
  denoBin?: string;
};

/** Shell command to exec run-orchestration-action.ts for the current runtime contract. */
export function orchestrationActionCommand(
  actionArgs: readonly string[],
  options?: OrchestrationActionCommandOptions,
): string {
  const denoBin = options?.denoBin ?? (
    isProductionRuntime() ? resolveProductionDenoBin() : resolveBootstrapDenoBin()
  );
  return denoRunOrchestrationInvocation(denoBin, [...actionArgs]);
}

/**
 * Shell command to exec bootstrap-orchestration for the current runtime contract.
 *
 * In dev the console always bootstraps orchestration **from the source checkout**
 * via Deno (`scripts/bootstrap-orchestration.ts`) — it never runs the compiled
 * `bin/turbopaneld` binary. That compiled entrypoint (and its
 * `bin/turbopaneld.js` fallback) only exists on managed/production installs,
 * which the dev console does not drive; bootstrap there is handled by
 * `run.sh` + Ansible, not this path.
 */
export function bootstrapOrchestrationCommand(): string {
  if (isProductionRuntime()) {
    return denoRunBootstrapInvocation(resolveProductionDenoBin());
  }
  return denoRunBootstrapInvocation(resolveBootstrapDenoBin());
}
