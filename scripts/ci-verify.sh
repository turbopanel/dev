#!/usr/bin/env sh
# Run the GitHub Actions verify/build jobs locally (minus the Sonar upload).
#
# Each sibling's `verify:ci` matches that repo's workflow steps: static gates,
# then the same `test:coverage` command CI uses to produce `coverage/lcov.info`
# for Sonar-way Coverage on New Code ≥ 80%. The Sonar scan itself stays in
# GitHub Actions (`SONAR_TOKEN` + `sonar.qualitygate.wait=true`).
#
# Must run inside the Vagrant guest (host VirtFS trees have no usable
# node_modules). From the host `dev` checkout this script re-execs via
# `vagrant ssh`. From the guest:
#
#   ~/dev/scripts/ci-verify.sh
#   ~/dev/scripts/ci-verify.sh ui website
#   ~/dev/scripts/ci-verify.sh --coverage-only turbopanel
#
# Repos: dev turbopaneld turbopanel ui website  (default: all)

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

# shellcheck source=scripts/lib/paths.sh
. "$SCRIPT_DIR/lib/paths.sh"

GUEST_PATH_PREFIX="/opt/turbopanel/vendor/node/current/bin:/opt/turbopanel/vendor/deno/current:/opt/turbopanel/vendor/ansible/current/bin"

tp_in_guest() {
  [ -x /opt/turbopanel/vendor/node/current/bin/node ]
}

tp_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

tp_usage() {
  cat <<'EOF' >&2
Usage: ci-verify.sh [--coverage-only] [dev|turbopaneld|turbopanel|ui|website]...

Run each checkout's GitHub Actions verify job (tests + LCOV + static gates).
Omits the SonarCloud upload. Default: every sibling repo.

  --coverage-only   skip static gates; run only test:coverage (same LCOV as CI)
EOF
}

if ! tp_in_guest; then
  if ! command -v vagrant >/dev/null 2>&1; then
    echo "ci-verify: run inside the Vagrant guest (or install vagrant on the host)." >&2
    echo "  From the host dev checkout: vagrant ssh -c '\$HOME/dev/scripts/ci-verify.sh'" >&2
    exit 1
  fi
  cd "$REPO_ROOT"
  quoted=
  for arg in "$@"; do
    quoted="$quoted $(tp_quote "$arg")"
  done
  echo "ci-verify: re-exec inside the Vagrant guest" >&2
  # shellcheck disable=SC2086
  exec vagrant ssh -c "export PATH=\"$GUEST_PATH_PREFIX:\$PATH\"; \$HOME/dev/scripts/ci-verify.sh$quoted"
fi

COVERAGE_ONLY=0
REPOS=

for arg in "$@"; do
  case "$arg" in
    -h | --help)
      tp_usage
      exit 0
      ;;
    --coverage-only)
      COVERAGE_ONLY=1
      ;;
    dev | turbopaneld | turbopanel | ui | website)
      REPOS="$REPOS $arg"
      ;;
    *)
      echo "ci-verify: unknown argument: $arg" >&2
      tp_usage
      exit 1
      ;;
  esac
done

if [ -z "$REPOS" ]; then
  REPOS="dev turbopaneld turbopanel ui website"
fi

export PATH="$GUEST_PATH_PREFIX${PATH:+:$PATH}"

# Fail fast on unclaimed instance suites before spending minutes on coverage.
# This repo does not glob *.test.ts — an unlisted file never reaches LCOV.
case " $REPOS " in
  *" turbopanel "*)
    _instance=$(tp_platform_repo_path turbopanel)
    if [ -d "$_instance" ]; then
      echo "======== ci-verify preflight: turbopanel test inventory ========"
      (cd "$_instance" && pnpm check:test-inventory)
    fi
    ;;
esac

# Instance CI starts Postgres and sets TURBOPANEL_DATABASE_URL. Guest
# runtime.env does not carry it — read it from the running instance process.
# Never print the value.
if [ -z "${TURBOPANEL_DATABASE_URL:-}" ]; then
  INSTANCE_ENV=/etc/turbopanel/instance/runtime.env
  if [ -r "$INSTANCE_ENV" ]; then
    TURBOPANEL_DATABASE_URL=$(sed -n 's/^TURBOPANEL_DATABASE_URL=//p' "$INSTANCE_ENV" | tail -n 1)
  fi
  if [ -z "${TURBOPANEL_DATABASE_URL:-}" ] && command -v systemctl >/dev/null 2>&1; then
    _pid=$(systemctl show turbopanel-instance -p MainPID --value 2>/dev/null || true)
    case "$_pid" in
      '' | 0) ;;
      *)
        if [ -r "/proc/${_pid}/environ" ]; then
          TURBOPANEL_DATABASE_URL=$(
            tr '\0' '\n' < "/proc/${_pid}/environ" |
              sed -n 's/^TURBOPANEL_DATABASE_URL=//p' |
              tail -n 1
          )
        fi
        ;;
    esac
  fi
  if [ -n "${TURBOPANEL_DATABASE_URL:-}" ]; then
    export TURBOPANEL_DATABASE_URL
  fi
fi

run_repo() {
  _repo=$1
  _root=$(tp_platform_repo_path "$_repo")
  if [ ! -d "$_root" ]; then
    echo "ci-verify: skip $_repo (checkout missing: $_root)" >&2
    return 0
  fi

  echo ""
  echo "======== ci-verify: $_repo ========"
  echo "cwd: $_root"
  cd "$_root"

  if [ "$COVERAGE_ONLY" -eq 1 ]; then
    case "$_repo" in
      turbopaneld) deno task test:coverage ;;
      *) pnpm test:coverage ;;
    esac
    return
  fi

  case "$_repo" in
    turbopaneld) deno task verify:ci ;;
    *) pnpm verify:ci ;;
  esac
}

failed=
failed_count=0
ran=0

for repo in $REPOS; do
  ran=$((ran + 1))
  if run_repo "$repo"; then
    echo "ci-verify: $repo OK"
  else
    echo "ci-verify: $repo FAILED" >&2
    failed="$failed $repo"
    failed_count=$((failed_count + 1))
  fi
done

echo ""
echo "======== ci-verify summary ========"
if [ "$failed_count" -eq 0 ]; then
  echo "All $ran repo(s) passed (LCOV at <repo>/coverage/lcov.info)."
  echo "Sonar upload is CI-only; this is the same coverage file the scan imports."
  exit 0
fi

echo "Failed ($failed_count/$ran):$failed" >&2
exit 1
