# Install the pinned Node release from nodejs.org into the vendored runtime tree
# (default /opt/turbopanel/vendor/node/<version>/ with a current symlink).
# Bump NODE_VERSION in paths.sh; ./console installs or upgrades on the next run.
# Source after privileges.sh, paths.sh, and packages.sh.

tp_node_linux_asset() {
  case $(uname -m) in
    aarch64|arm64) printf '%s' 'arm64' ;;
    x86_64|amd64) printf '%s' 'x64' ;;
    *)
      tp_error "Unsupported Linux architecture for Node: $(uname -m)"
      exit 1
      ;;
  esac
}

tp_node_installed_version() {
  [ -x "$NODE_BIN" ] || return 1
  "$NODE_BIN" --version 2>/dev/null | sed 's/^v//'
}

tp_node_runtime_usable() {
  _tnu_version=$(tp_node_installed_version) || return 1
  [ "$_tnu_version" = "$NODE_VERSION" ]
}

tp_ensure_node_runtime_dir() {
  if [ "$(id -u)" -eq 0 ] || tp_can_write_path "$NODE_RUNTIME_DIR"; then
    mkdir -p "$NODE_VERSION_DIR"
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    tp_error "Installing Node to ${NODE_RUNTIME_DIR} requires root privileges, but sudo is not installed."
    exit 1
  fi
  tp_info "Administrator privileges required to install Node to ${NODE_RUNTIME_DIR}"
  sudo mkdir -p "$NODE_VERSION_DIR"
}

tp_install_node_tree() {
  _int_src_dir=$1
  tp_ensure_node_runtime_dir
  if [ "$(id -u)" -eq 0 ] || tp_can_write_path "$NODE_VERSION_DIR"; then
    cp -R "$_int_src_dir"/bin "$_int_src_dir"/include "$_int_src_dir"/lib "$_int_src_dir"/share "$NODE_VERSION_DIR"/
  else
    sudo cp -R "$_int_src_dir"/bin "$_int_src_dir"/include "$_int_src_dir"/lib "$_int_src_dir"/share "$NODE_VERSION_DIR"/
  fi
  tp_link_node_current
}

tp_link_node_current() {
  if [ "$(id -u)" -eq 0 ] || tp_can_write_path "$NODE_RUNTIME_DIR"; then
    ln -sfn "$NODE_VERSION_DIR" "$NODE_RUNTIME_DIR/current"
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    tp_error "Updating Node current symlink requires root privileges, but sudo is not installed."
    exit 1
  fi
  sudo ln -sfn "$NODE_VERSION_DIR" "$NODE_RUNTIME_DIR/current"
}

tp_download_node_release() {
  _dnr_arch=$(tp_node_linux_asset)
  _dnr_name=node-v${NODE_VERSION}-linux-${_dnr_arch}
  _dnr_tarball=${_dnr_name}.tar.gz
  _dnr_base=${NODE_RELEASE_BASE}/v${NODE_VERSION}
  _dnr_tmp=$(mktemp -d)

  curl -fsSL "${_dnr_base}/${_dnr_tarball}" -o "$_dnr_tmp/$_dnr_tarball"
  curl -fsSL "${_dnr_base}/SHASUMS256.txt" -o "$_dnr_tmp/SHASUMS256.txt"
  (
    cd "$_dnr_tmp" || exit 1
    grep " ${_dnr_tarball}\$" SHASUMS256.txt > "${_dnr_tarball}.sha256"
    sha256sum -c "${_dnr_tarball}.sha256"
  )
  tar -xzf "$_dnr_tmp/$_dnr_tarball" -C "$_dnr_tmp"
  rm -rf "$NODE_VERSION_DIR"
  tp_install_node_tree "$_dnr_tmp/$_dnr_name"
  rm -rf "$_dnr_tmp"
}

tp_install_node_runtime() {
  if tp_node_runtime_usable; then
    return 0
  fi

  _node_upgrading=0
  if [ -x "$NODE_BIN" ]; then
    _node_upgrading=1
  fi

  tp_require_host_commands  # curl, tar, sha256sum — host-base only

  if [ "$_node_upgrading" -eq 1 ]; then
    tp_info "Upgrading Node to v${NODE_VERSION} at ${NODE_BIN}"
  else
    tp_info "Installing Node v${NODE_VERSION} to ${NODE_BIN}"
  fi

  tp_download_node_release

  if ! tp_node_runtime_usable; then
    tp_error "Node install failed — expected v${NODE_VERSION} at ${NODE_BIN}"
    exit 1
  fi

  if [ "$_node_upgrading" -eq 1 ]; then
    tp_success "Node upgraded to v${NODE_VERSION}"
  else
    tp_success "Node v${NODE_VERSION} installed"
  fi
}

tp_read_pnpm_version() {
  _rpv_package_json=$1
  if [ ! -f "$_rpv_package_json" ]; then
    tp_error "package.json not found at ${_rpv_package_json}"
    exit 1
  fi

  _rpv_pm=$(grep '"packageManager"' "$_rpv_package_json" 2>/dev/null \
    | head -1 \
    | sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

  case $_rpv_pm in
    pnpm@*)
      printf '%s' "${_rpv_pm#pnpm@}"
      return 0
      ;;
    *)
      tp_error "package.json must define \"packageManager\": \"pnpm@x.y.z\""
      exit 1
      ;;
  esac
}

tp_corepack_bin() {
  printf '%s' "$NODE_PREFIX/bin/corepack"
}

tp_npm_bin() {
  printf '%s' "$NODE_PREFIX/bin/npm"
}

tp_node_bin_dir() {
  dirname "$NODE_BIN"
}

# Vendored Node is not on the host PATH; npm/corepack/pnpm shims use #!/usr/bin/env node.
tp_export_node_path() {
  PATH="$(tp_node_bin_dir):${PATH:-}"
  export PATH
}

# Pin Corepack to package.json — do not let it silently jump to the newest
# npm release. COREPACK_DEFAULT_TO_LATEST defaults to 1, so `pnpm --version`
# from $HOME (no package.json) after `corepack prepare --activate` reports
# latest (e.g. expected 12.3.4, got 12.4.0) and ./console fails on every
# pnpm bump. AUTO_PIN=0 stops Corepack rewriting packageManager hashes.
tp_corepack_env() {
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  COREPACK_DEFAULT_TO_LATEST=0
  COREPACK_ENABLE_AUTO_PIN=0
  export COREPACK_ENABLE_DOWNLOAD_PROMPT COREPACK_DEFAULT_TO_LATEST COREPACK_ENABLE_AUTO_PIN
}

# Run a command with vendored Node on PATH. Sudo when the prefix is not writable
# (first install into /opt/turbopanel/vendor). Corepack env is always exported so
# enable/prepare stay pinned; it is harmless for `npm install -g corepack`.
tp_run_with_node_path() {
  tp_corepack_env
  _tp_node_bin=$(tp_node_bin_dir)
  if [ "$(id -u)" -eq 0 ] || tp_can_write_path "$NODE_PREFIX/bin"; then
    PATH="$_tp_node_bin:${PATH:-}" "$@"
    return $?
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    tp_error "Write access to ${NODE_PREFIX}/bin requires root privileges, but sudo is not installed."
    exit 1
  fi
  sudo env \
    COREPACK_ENABLE_DOWNLOAD_PROMPT="$COREPACK_ENABLE_DOWNLOAD_PROMPT" \
    COREPACK_DEFAULT_TO_LATEST="$COREPACK_DEFAULT_TO_LATEST" \
    COREPACK_ENABLE_AUTO_PIN="$COREPACK_ENABLE_AUTO_PIN" \
    PATH="${_tp_node_bin}:${PATH:-}" \
    "$@"
}

# Node 25+ no longer ships a corepack executable. Install the standalone npm
# package into the vendored prefix so package.json packageManager still works.
tp_ensure_corepack() {
  _ec_corepack=$(tp_corepack_bin)
  if [ -x "$_ec_corepack" ]; then
    return 0
  fi

  _ec_npm=$(tp_npm_bin)
  if [ ! -x "$_ec_npm" ]; then
    tp_error "npm not found at ${_ec_npm} (expected from the Node install)."
    exit 1
  fi

  tp_info "Installing Corepack (Node 25+ no longer ships it)…"
  tp_export_node_path
  tp_run_with_node_path "$_ec_npm" install --global --prefix "$NODE_VERSION_DIR" \
    --no-fund --no-audit corepack

  if [ ! -x "$_ec_corepack" ]; then
    tp_error "corepack install failed — expected ${_ec_corepack}"
    exit 1
  fi
}

# Optional $1 is a repo root; Corepack shims read packageManager from cwd,
# so the version check must run inside that checkout (not $HOME).
tp_pnpm_installed_version() {
  _piv_repo_root=${1:-}
  [ -x "$PNPM_BIN" ] || return 1
  tp_corepack_env
  tp_export_node_path
  if [ -n "$_piv_repo_root" ]; then
    (cd "$_piv_repo_root" && "$PNPM_BIN" --version 2>/dev/null)
    return $?
  fi
  "$PNPM_BIN" --version 2>/dev/null
}

tp_ensure_corepack_pnpm() {
  _ecp_repo_root=$1
  tp_export_node_path
  tp_corepack_env
  tp_ensure_corepack
  _ecp_corepack=$(tp_corepack_bin)

  _ecp_pnpm_version=$(tp_read_pnpm_version "$_ecp_repo_root/package.json")
  _ecp_pnpm_semver=${_ecp_pnpm_version%%+*}

  tp_info "Ensuring pnpm v${_ecp_pnpm_semver} (Corepack)…"
  tp_run_with_node_path "$_ecp_corepack" enable
  tp_run_with_node_path "$_ecp_corepack" prepare "pnpm@${_ecp_pnpm_version}" --activate

  _ecp_installed=$(tp_pnpm_installed_version "$_ecp_repo_root") || true
  if [ "$_ecp_installed" != "$_ecp_pnpm_semver" ]; then
    tp_error "pnpm install failed — expected v${_ecp_pnpm_semver}, got ${_ecp_installed:-<missing>}"
    exit 1
  fi

  tp_success "pnpm v${_ecp_pnpm_semver} ready"
}

tp_ensure_node_runtime() {
  tp_install_node_runtime
}

tp_vendored_deno_bin_dir() {
  dirname "$VENDORED_DENO_BIN"
}

# Prefer vendored Deno (vendor/deno/current) on PATH for hooks and child shells.
tp_export_deno_path() {
  if [ -x "$VENDORED_DENO_BIN" ]; then
    DENO_BIN=$VENDORED_DENO_BIN
    export DENO_BIN
    PATH="$(tp_vendored_deno_bin_dir):${PATH:-}"
    export PATH
    return 0
  fi
  if [ -n "${DENO_BIN:-}" ] && [ -x "$DENO_BIN" ]; then
    PATH="$(dirname "$DENO_BIN"):${PATH:-}"
    export PATH
    return 0
  fi
  return 1
}
