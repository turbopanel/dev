#!/usr/bin/env node
/**
 * Generate or check THIRD_PARTY_NOTICES.md from the resolved pnpm graph.
 *
 * Run it through pnpm (`npm_execpath` names the pnpm CLI to spawn):
 *   pnpm notices:generate
 *   pnpm notices:check
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  enrichMissingPackageLicenses,
  evaluateLicensePolicy,
  NOTICE_POLICY_REPO_LICENSE,
  fingerprintCommentValue,
  formatPolicyFailures,
  NOTICES_FILE_NAME,
  noticePackageKey,
  noticesAreCurrent,
  packagesFromPnpmLicenses,
  pnpmLicenseKeys,
  pnpmPackagePaths,
  renderThirdPartyNotices,
} from '../src/lib/notices.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @typedef {import('../src/lib/notices.ts').PnpmLicenseEntry} PnpmLicenseEntry
 */

export function runGenerateNotices({
  root = ROOT,
  argv = process.argv.slice(2),
  io = console,
  exit,
  spawnPnpmLicenses = (prodOnly) => loadPnpmLicenses(root, prodOnly),
  readFile = (target, encoding) => fs.readFileSync(target, encoding),
  writeFile = (target, contents) => fs.writeFileSync(target, contents),
  exists = (target) => fs.existsSync(target),
} = {}) {
  const check = argv.includes('--check')
  const leave = exit ?? ((code) => process.exit(code))

  let allGrouped
  let prodGrouped
  try {
    allGrouped = spawnPnpmLicenses(false)
    prodGrouped = spawnPnpmLicenses(true)
  } catch (error) {
    io.error(
      error instanceof Error
        ? error.message
        : 'generate-notices: failed to read pnpm licenses',
    )
    leave(1)
    return 1
  }

  const packages = enrichMissingPackageLicenses(
    packagesFromPnpmLicenses(allGrouped, pnpmLicenseKeys(prodGrouped)),
    (pkg) => readPnpmInstallLicense(root, allGrouped, pkg, exists, readFile),
  )
  const policy = evaluateLicensePolicy(packages, {
    repoLicense: NOTICE_POLICY_REPO_LICENSE,
  })
  if (policy.length > 0) {
    io.error('generate-notices: unreviewed license class:\n')
    io.error(formatPolicyFailures(policy))
    leave(1)
    return 1
  }

  const markdown = renderThirdPartyNotices(packages, {
    repoLicense: 'AGPL-3.0-only',
    productName: 'TurboPanel Development Environment',
    regenerateCommand: 'pnpm notices:generate',
    lockfileFingerprints: {
      'pnpm-lock.yaml': fingerprintCommentValue(hashFile(root, 'pnpm-lock.yaml', readFile)),
    },
  })

  const noticesPath = path.join(root, NOTICES_FILE_NAME)
  if (check) {
    if (!exists(noticesPath)) {
      io.error(`generate-notices: missing ${NOTICES_FILE_NAME} — run pnpm notices:generate`)
      leave(1)
      return 1
    }
    if (!noticesAreCurrent(readFile(noticesPath, 'utf8'), markdown)) {
      io.error(
        `generate-notices: ${NOTICES_FILE_NAME} is stale relative to the lockfile. Run pnpm notices:generate and commit the result.`,
      )
      leave(1)
      return 1
    }
    io.log(`generate-notices: ${NOTICES_FILE_NAME} is current.`)
    return 0
  }

  writeFile(noticesPath, markdown)
  io.log(`generate-notices: wrote ${NOTICES_FILE_NAME} (${packages.length} packages).`)
  return 0
}

/**
 * Absolute path to the pnpm CLI running this script, from the lifecycle-script
 * env. Spawning it via `process.execPath` keeps both the command and the CLI
 * fixed paths rather than a PATH lookup (javascript:S4036).
 */
export function pnpmCliPath(env = process.env) {
  const execPath = env.npm_execpath?.trim()
  if (!execPath || !path.basename(execPath).startsWith('pnpm')) return undefined
  return execPath
}

function isJavascriptPnpmCli(cli) {
  return /\.[cm]?js$/i.test(cli)
}

export function loadPnpmLicenses(root, prodOnly) {
  const cli = pnpmCliPath()
  if (!cli) {
    throw new Error(
      'generate-notices: no pnpm CLI in npm_execpath — run `pnpm notices:generate` or `pnpm notices:check`',
    )
  }
  // pnpm 12 ships a native binary (`pnpm-native`). Spawn that directly;
  // `node <elf>` throws SyntaxError. Older JS CLIs (`.cjs` / `.js` / `.mjs`)
  // still run through `process.execPath`.
  const jsCli = isJavascriptPnpmCli(cli)
  const command = jsCli ? process.execPath : cli
  const args = jsCli
    ? [cli, 'licenses', 'list', '--json', '--long']
    : ['licenses', 'list', '--json', '--long']
  if (prodOnly) args.push('--prod')
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `generate-notices: pnpm licenses list failed (${result.status}): ${result.stderr || result.stdout || 'no output'}`,
    )
  }
  const start = result.stdout.indexOf('{')
  if (start === -1) {
    throw new TypeError('generate-notices: no JSON in pnpm licenses output')
  }
  const parsed = JSON.parse(result.stdout.slice(start))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('generate-notices: unexpected pnpm licenses JSON')
  }
  return parsed
}

export function readPnpmInstallLicense(root, grouped, pkg, exists, readFile) {
  const rel = pnpmPackagePaths(grouped).get(noticePackageKey(pkg))
  if (!rel) return undefined
  const dir = path.isAbsolute(rel) ? rel : path.join(root, rel)
  return (
    licenseFromPackageJson(dir, exists, readFile) ??
    licenseFromLicenseFile(dir, exists, readFile)
  )
}

function licenseFromPackageJson(dir, exists, readFile) {
  const pkgJsonPath = path.join(dir, 'package.json')
  if (!exists(pkgJsonPath)) return undefined
  try {
    const parsed = JSON.parse(readFile(pkgJsonPath, 'utf8'))
    const field = parsed.license ?? parsed.licenses?.[0]?.type
    if (typeof field === 'string' && field.trim()) return field.trim()
  } catch {
    // Unparseable manifest — fall back to the LICENSE text probe.
  }
  return undefined
}

/** Last-resort license identification from the LICENSE file's own wording. */
const LICENSE_TEXT_MARKERS = [
  { pattern: /Permission is hereby granted, free of charge/i, license: 'MIT' },
  { pattern: /ISC License/i, license: 'ISC' },
  { pattern: /Apache License[\s\S]{0,80}Version 2\.0/i, license: 'Apache-2.0' },
]

function licenseFromLicenseFile(dir, exists, readFile) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    const candidate = path.join(dir, name)
    if (!exists(candidate)) continue
    const text = readFile(candidate, 'utf8')
    const marker = LICENSE_TEXT_MARKERS.find((entry) => entry.pattern.test(text))
    if (marker) return marker.license
  }
  return undefined
}

function hashFile(root, rel, readFile) {
  const contents = readFile(path.join(root, rel))
  const buf = typeof contents === 'string' ? Buffer.from(contents) : contents
  return createHash('sha256').update(buf).digest('hex')
}

export function isExecutedAsCli(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  return Boolean(argv1) && metaUrl === pathToFileURL(path.resolve(argv1)).href
}

if (isExecutedAsCli()) {
  runGenerateNotices()
}
