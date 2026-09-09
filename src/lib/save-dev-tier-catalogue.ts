import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type InstallOutputHandler, runCaptured } from "./install-output.ts";
import { resolveDevRoot } from "./paths.ts";
import { POSTGRES_CONTAINER_NAME } from "./platform-docker-resources.ts";

/**
 * Dev-only: save the billing tier catalogue a superadmin bound through
 * Admin → Tiers (label → Stripe product) into the dev checkout's gitignored
 * `local/tiers.json`, so a database reset or a VM rebuild does not mean
 * picking eight products again. The file mirrors the `tier` table's columns
 * verbatim and the restore is `insert … select *`, so a file saved under an
 * older column shape is unrestorable — delete it and save again. The
 * dev overlay role `dev-tier-catalogue` restores the file on converge when
 * the tier table is empty. Nothing in the instance or daemon repos knows this
 * exists: it reads the dev Postgres container directly, exactly like the
 * reset action does.
 */

/** Same values the daemon's postgres role gives the dev stack. */
const POSTGRES_DEV_USER = "turbopanel";
const POSTGRES_DEV_DB = "turbopanel";

/** `json_agg` of the whole table, keys = column names, so the restore can replay it verbatim. */
const EXPORT_SQL = "select coalesce(json_agg(t order by t.rank), '[]'::json) from tier t";

export function devTierCataloguePath(): string {
  return `${resolveDevRoot()}/dev/local/tiers.json`;
}

type TierRow = Record<string, unknown> & { rank?: unknown };

function tierOrder(row: TierRow): number {
  return typeof row.rank === "number" ? row.rank : Number.MAX_SAFE_INTEGER;
}

/**
 * The exported catalogue as it is written to disk: a JSON array of rows,
 * sorted by rank, pretty-printed, trailing newline. Throws
 * on anything that is not a JSON array so a psql error line never lands in
 * the file.
 */
export function normalizeTierCatalogue(raw: string): { text: string; rows: number } {
  const parsed: unknown = JSON.parse(raw.trim() === "" ? "[]" : raw);
  if (!Array.isArray(parsed)) {
    throw new TypeError("tier catalogue export is not a JSON array");
  }
  const rows = (parsed as TierRow[]).filter((row) => typeof row === "object" && row !== null);
  rows.sort((a, b) => tierOrder(a) - tierOrder(b));
  return { text: `${JSON.stringify(rows, null, 2)}\n`, rows: rows.length };
}

export async function saveDevTierCatalogue(
  onOutput?: InstallOutputHandler,
): Promise<void> {
  const captured: string[] = [];
  const code = await runCaptured(
    [
      "docker",
      "exec",
      POSTGRES_CONTAINER_NAME,
      "psql",
      "-U",
      POSTGRES_DEV_USER,
      "-d",
      POSTGRES_DEV_DB,
      "-Atc",
      EXPORT_SQL,
    ],
    (line) => {
      captured.push(line);
    },
  );
  if (code !== 0) {
    onOutput?.(captured.at(-1) ?? "psql failed");
    throw new Error(captured.at(-1) ?? "Failed to read the tier table from the dev database");
  }
  const { text, rows } = normalizeTierCatalogue(captured.join("\n"));
  const path = devTierCataloguePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode: 0o600 });
  onOutput?.(`save-tier-catalogue: ${rows} tier row${rows === 1 ? "" : "s"} written to ${path}`);
  if (rows === 0) {
    onOutput?.("save-tier-catalogue: the tier table is empty — enter tiers in Admin → Tiers first");
  }
}
