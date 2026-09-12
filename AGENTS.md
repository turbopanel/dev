# AGENTS.md

## What this repo is

The **dev** repository ([TurboPanel/dev](https://github.com/TurboPanel/dev)) is the **TurboPanel Development Environment** — contributor tooling only, not production or self-hosted install. It is a minimal terminal UI built on [Ink](https://github.com/vadimdemedes/ink) 7, run on **Node** via **Vite (`vite-node`)**. Watch mode uses a custom Vite dev runner (`scripts/hot-reload.tsx`) that keeps the Ink process mounted and reloads changed `src/` modules. Contributors run it inside a **Vagrant** guest with six sibling checkouts mounted from the host (`dev`, `turbopaneld`, `turbopanel`, `ui`, `website`, `.github`).

**License:** AGPL-3.0-only. Trademarks are not granted by the software license ([`TRADEMARKS.md`](./TRADEMARKS.md)). Third-party components keep their own licenses ([`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)). Published story: `../website` `/open-source` and `docs/getting-started/licensing.mdx`. Contributions require the [CLA](https://github.com/TurboPanel/.github/blob/trunk/CLA.md). **Maturity:** **Private alpha**. README is product-facing; AGENTS.md is maintainer-facing.

**This repo runs on Node, not Deno.** In dev the console bootstraps
orchestration and runs the **daemon from the dev user's home checkout**
(`~/turbopaneld`, resolved via `TURBOPANEL_DEV_ROOT` / `TURBOPANEL_DAEMON_REPO`) via Deno (`deno run main.ts`) — host Deno is
preferred, else the vendored runtime at
`/opt/turbopanel/vendor/deno/current/deno`. It never runs a
compiled daemon binary. Production installs (driven by `run.sh` + Ansible, **not**
this console) run **`turbopaneld.service`** on the FHS tree
(`/etc/turbopanel`, `/var/lib/turbopanel`, `/var/log/turbopanel`,
`/run/turbopanel`): native **`/opt/turbopanel/bin/turbopaneld`** when that binary
executes, otherwise **`turbopaneld.js`** via vendored Deno — the supported path
on hosts where the native binary cannot load (e.g. some Raspberry Pi kernels with
16 KiB pages; see the daemon repo's `AGENTS.md` → "Filesystem layout & path
model"). Deno is still installed for the **instance** stack (and mailer) via the
`deno-runtime` Ansible role during dev converge.

**Target host:** Debian 13 (Trixie) inside the Vagrant guest. **Linux
contributors** use **Vagrant + libvirt** with the `debian/trixie64` box; **macOS
contributors** use **Vagrant + UTM** with guest box **`utm/bookworm`** (Debian
12) until a Trixie UTM box is available.

Canonical docs: https://turbopanel.io/docs/getting-started/development

**Vagrant:** root [`Vagrantfile`](./Vagrantfile). Plain `vagrant up`
auto-selects **libvirt** on Linux (`vagrant-libvirt`, Debian 13
`debian/trixie64`) and **UTM** on macOS (`vagrant_utm`, Debian 12
`utm/bookworm`); `VAGRANT_DEFAULT_PROVIDER` still permits an explicit
override. Linux shares use bidirectional VirtioFS with explicit **memfd**
shared-memory backing; do not leave only `access mode=shared`, because libvirt
then file-backs all guest RAM under `/var/lib/libvirt/qemu/ram` and guest
memory churn causes severe host disk writeback/I/O pressure.
UTM uses VirtFS. Synced folders map host siblings
`../{turbopaneld,turbopanel,ui,website}` and this repo (`.`) to guest
`$HOME/{dev,turbopaneld,turbopanel,ui,website}` so default
`TURBOPANEL_DEV_ROOT=$HOME` matches bare metal — confirmed against the daemon's
Ansible roles (`daemon-launch`, `instance-launch`, etc.): source always
resolves to `<dev_root>/<repo>` when `turbopanel_dev_user` is set, and
`/opt/turbopanel` in dev holds **only** vendored runtimes, the production
binary, and the built static UI — never source checkouts. `../.github`
(community health files) mounts to `$HOME/.github` when present on the host;
otherwise the `github-repo` Ansible role clones it inside the guest via HTTPS.
FHS trees stay **guest-local**. Ports `80` / `443` (hosting Caddy) / `8443` / `8880` / `8081` / `8088` / `19820` forward
to the host on `0.0.0.0` (LAN-reachable, not localhost-only). Drizzle Studio
`4983`, Mailpit `8025`, Redis Insight `5540`, and the DuckDB UI `4213` are loopback-only
on both sides of the forward (`127.0.0.1` host and guest): those APIs are
unauthenticated. The hosted HTTPS Studio UI must use `?host=localhost` rather
than a private hostname such as `studio.lan`. All forwards target **guest
loopback** so they still work when the libvirt DHCP address changes.

The current entrypoint is a minimal launcher only (full multi-screen console was removed during a rewrite).

## Filesystem layout

```
~/dev/                    # turbopanel/dev checkout (Vagrant mounts host sibling here)
├── Vagrantfile           # libvirt/UTM guest: mounts + port forwards + light provision
├── console               # ensure Node, pnpm install, launch the TUI via vite-node
├── orchestration/        # Ansible dev overlay + development Caddyfile
│   ├── Caddyfile         # co-located control-plane proxy (Expo, :8880, wrangler)
│   └── expo-loading.html # Expo cold-start page served by the development Caddyfile
├── package.json          # Node project (pnpm, pinned via packageManager); ink + react + vite
├── src/tui.tsx           # Ink entrypoint
├── scripts/guest/        # Vagrant SSH MOTD (T-mark banner + ~/dev/console)
└── …

~/turbopaneld/                 # TURBOPANEL_DAEMON_REPO (default: $TURBOPANEL_DEV_ROOT/turbopaneld)
~/turbopanel/               # TURBOPANEL_INSTANCE_REPO
~/ui/                     # TURBOPANEL_UI_REPO
~/website/                # TURBOPANEL_WEBSITE_REPO
~/.github/                # turbopanel_github_dir (github-repo Ansible role; not a TURBOPANEL_*_REPO var)

/opt/turbopanel/vendor/
├── node/current/bin/node   # pinned Node (installed by ./console + node-runtime role)
├── node/current/bin/pnpm   # pnpm shim (Corepack)
├── deno/current/deno       # pinned Deno (deno-runtime role / console bootstrap)
├── caddy/current/caddy     # …
└── …                       # uv/python/ansible (orchestration bootstrap)

/etc/turbopanel/          # config (dev-user-owned): daemon.env, instance/, rabbitmq/, …
/var/lib/turbopanel/      # persistent state (dev-user-owned)
/var/log/turbopanel/      # service logs (dev-user-owned)
/run/turbopanel/          # runtime sockets (dev-user-owned)
/opt/turbopanel/share/ui/ # static UI export (production build mode)
~/.local/console/         # console converge logs (consoleLogDir())
```

Node is a pinned `nodejs.org` tarball vendored under `/opt/turbopanel/vendor/node/<version>/` with a `current` symlink (same layout as deno/caddy). pnpm is provisioned via Corepack and pinned by the `packageManager` field in `package.json`. **Node 25+ no longer ships Corepack**, so `./console` (and the daemon `node-runtime` role) install it with the vendored `npm install -g corepack` into that prefix, then Corepack still activates the hashed pnpm pin. Deno is **host-provided in development** (preferred) or bootstrap-installed to `/opt/turbopanel/vendor/deno/current/deno` when host Deno is absent; the dev console always runs the daemon and orchestration **from the source checkout** via Deno. Production daemon installs use native `/opt/turbopanel/bin/turbopaneld` or, when that binary cannot execute on the host, `turbopaneld.js` via vendored Deno — driven by `run.sh` + Ansible, never by this console.

## Fresh-clone → working dev

1. Clone (or fork) the six sibling repos under one parent directory on the host (`dev`, `turbopaneld`, `turbopanel`, `ui`, `website`, `.github`).
2. From the host `dev` checkout: `vagrant up` then `vagrant ssh`.
3. Inside the guest: `dev/console` → prereqs, pinned Node, `pnpm install`, TUI launch (exports `TURBOPANEL_MODE=development`, `TURBOPANEL_DEV_ROOT`, `TURBOPANEL_<DIR>_REPO`).
4. **Bootstrap / converge** → the console uses `resolveDevEnvStartupPlan` (`src/lib/dev-env-readiness.ts`) on launch: **auto-bootstraps** (daemon install → systemd unit) when prerequisites are missing; after bootstrap finishes it opens the **optional services** picker then converges (`if-needed`). When the host is already installed, launch sits **idle** — no auto-converge (use Developer → **Converge / re-converge**). The converge picker defaults to UI + website + Mailpit + Drizzle Studio on (Redis Insight and the Stripe CLI forwarder off); idle for 5s continues with the current selection. The Stripe CLI service (`turbopanel-stripe-listen`, daemon role `stripe-listen`, Workers runtime only — wrangler reads secrets from `.dev.vars`) forwards sandbox events to `/webhook/stripe`; it needs a test-mode `TURBOPANEL_STRIPE_SECRET_KEY` written by hand into `/etc/turbopanel/stripe-listen/stripe.env` (never generated or committed) and exits with a pointer to that file otherwise. On the Workers runtime, Developer → **Save tier catalogue** writes the billing tiers a superadmin bound to payment-provider products (Admin → Tiers) to the gitignored `local/tiers.json`, and the dev overlay role `dev-tier-catalogue` restores them on converge when the database holds no **priced** tier row (the unpriced `SX` row a deno-mode instance creates for its licence grant does not count, and a label already present is skipped); the instance and daemon repos know nothing of it (see `local/README.md`). Drizzle Studio and Mailpit stay listed on the Services screen in gray when not enabled — select the row and press **E**, or use Developer → **Optional services…**. That menu also starts/stops optional units anytime without a full converge. Daemon bootstrap (`installDaemon` in `src/lib/platform-install.ts`) **uses an existing usable checkout** when `~/turbopaneld` already has `main.ts` or `orchestration/ansible.cfg` (Vagrant VirtFS mounts and pre-cloned siblings — no guest-side clone/pull; Git may also refuse mounted trees via `safe.directory`); it only **clones** when that path is missing. Bootstrap then writes `/etc/turbopanel/daemon.env`, runs the `dev/orchestration` overlay (runtimes into `/opt/turbopanel/vendor`, systemd units + Docker (postgres/redis/rabbitmq/mailpit) as the dev user, mutable data under FHS trees dev-user-owned; no `tp` / `tpctrl` / `tpcache` accounts created).
5. On the **host**, open `https://localhost:8443` (or `http://localhost:8880`); edit source in the host sibling checkouts (mounted into the guest). Prefer a LAN hostname when attaching remote test machines.

## Entry points

| Script | Purpose |
|--------|---------|
| `vagrant up` / `vagrant ssh` | **Canonical:** boot guest from `dev/`, then SSH in and run `dev/console`. |
| `./console` | Ensure pinned Node (sudo on first run), `pnpm install`, launch `src/tui.tsx` via `vite-node` (run **inside the guest**; from `$HOME` that is `dev/console`). |
| `./console --watch` | Same, but use `scripts/hot-reload.tsx` for live reload on `src/` changes. |
| `pnpm dev` | Run `src/tui.tsx` directly via `vite-node` (requires Node on PATH). |
| `pnpm dev:watch` | Run `scripts/hot-reload.tsx`, which keeps Ink mounted and rerenders on `src/` changes. |
| `./scripts/sync.sh` | Push `turbopanel/src/lib/db/schema.ts` → live Postgres (drizzle-kit push; Deno dev convenience). |
| `./scripts/introspect.sh` | Pull live Postgres → `turbopanel/src/lib/db/schema.ts` (drizzle-kit introspect). |

**Typical flow:**

```bash
# siblings: …/turbopanel/{dev,turbopaneld,turbopanel,ui,website,.github}
cd …/turbopanel/dev
vagrant up
vagrant ssh
# inside guest:
dev/console
```

## Responsibilities

- **`Vagrantfile`** — host-aware libvirt/UTM provider config, bidirectional VirtioFS/VirtFS mounts of the five workspace repos plus optional `.github`, SSH agent forwarding, port forwards `80`/`443` (hosting Caddy) / `8443`/`8880`/`8081`/`8088`/`19820` (LAN `0.0.0.0`) plus loopback-only `4983`/`8025`/`5540`/`4213`, all with `guest_ip: 127.0.0.1`, and idempotent shell
provision split as `system-upgrade` → `turbopanel_reboot_if_needed` → `guest-setup` → `sshd-port-forward-keepalives` (`run: always`) → `guest-motd` (`run: always`) → `turbopanel_ensure_libvirt_port_forwards` (`run: always`). Upgrades run `apt-get update` + `upgrade` + `autoremove` + `curl` and set the `vagrant` login password; when Debian leaves `/var/run/reboot-required` or the running kernel differs from the newest `/boot/vmlinuz-*`, the reboot provisioner prints that SSH will drop for about a minute, reboots via the guest reboot capability (Vagrant waits for SSH), **remounts VirtioFS synced folders** (mid-provision reboot otherwise leaves empty `~/dev` mount-point dirs — Vagrant only mounts shares on `up`/`reload`), then `guest-setup` finishes (passwordless sudo, `/etc/profile.d/turbopanel-vagrant.sh`, pnpm's `~/.config/pnpm/config.yaml` pointing `storeDir` at guest-local `/var/lib/pnpm/store`, per-repo `node_modules` **bind mounts** from `/var/lib/turbopanel-dev/node_modules/<repo>/node_modules` (systemd `turbopanel-virtfs-node-modules.service` at boot), 8 GiB `/swapfile`). **Libvirt port forwards are SSH `-L` tunnels** (not QEMU `hostfwd`); guest reboot / sshd restart / OpenSSH 9.8+ `UnusedConnectionTimeout` drop idle one-shot vagrant-libvirt `ssh -N` sessions. `sshd-port-forward-keepalives` writes `/etc/ssh/sshd_config.d/turbopanel-vagrant.conf` (`UnusedConnectionTimeout 0` when the guest sshd supports it; `PrintMotd no` so PAM owns the banner). `guest-motd` replaces Debian's default login MOTD with the official T-mark banner from `scripts/guest/motd.sh` (`/etc/motd.d/10-turbopanel`, empty `/etc/motd`, stock `update-motd.d` fragments chmod `-x`) — safe while `./console` is up. `turbopanel_ensure_libvirt_port_forwards` then replaces those one-shot tunnels with a restarting `ssh_forward_supervisor.sh` per port (health = host TCP listen plus our supervisor pid, not leftover libvirt ssh; host **80**/**443** wrap the supervisor in `sudo -n` when `net.ipv4.ip_unprivileged_port_start` still blocks the bind). Heal without a full reload: `vagrant provision --provision-with sshd-port-forward-keepalives,guest-motd,turbopanel_ensure_libvirt_port_forwards` (do not run a full `vagrant provision` while `./console` is up — that re-runs guest-setup). Linux defaults to libvirt + `debian/trixie64`; macOS defaults to UTM + `utm/bookworm`. Does not clone platform repos or run `./console`. Why bind-mount `node_modules`: on ARM64, FUSE-backed filesystems (9p/virtiofs, which is how UTM VirtFS is implemented) don't invalidate the instruction cache for pages faulted in from mmap'd executable files, so native Node addons (esbuild, `@rolldown/binding-*`, lightningcss, ...) crash with `SIGSEGV`/`SIGILL` when `node_modules` lives directly on the VirtFS mount — the pnpm store already being local isn't enough, since `packageImportMethod: copy` still writes the actual files into `node_modules` on the mount. A **symlink** is not enough: Next.js Turbopack rejects `node_modules` that points outside the project (`Symlink [project]/node_modules is invalid, it points out of the filesystem root`), and Node ESM/CJS realpath walks miss packages unless the physical path ends in a directory named `node_modules` (flat `<repo>/drizzle-orm` makes `drizzle-kit` fail with "Please install latest version of drizzle-orm"; Tamagui fails with `Cannot find module 'typescript'`). The provisioner runs for every mounted repo with a `package.json` (`dev`, `turbopanel`, `ui`, `website`; `turbopaneld` has none) and is idempotent across `vagrant provision` re-runs. On boot, its helper waits for all four Vagrant shares to expose `package.json` before binding—the shares are mounted over SSH after userspace starts, so an immediate check can otherwise exit successfully without mounting anything—and dbstudio/UI/website/instance units are ordered after it. Ansible `instance-repo` / `ui-repo` / `website-repo` must probe a nested package (`drizzle-kit`, `expo`, `next`) before skipping `pnpm install` — the mount point exists while the guest tree is still empty. A provisioner layout change wipes a flat tree; the next `pnpm install` (console for `dev`, converge for the others) refills it from the guest pnpm store. Do not `vagrant provision` while `./console` is running if that would rebuild the `dev` tree.
- **`console`** — runs the prerequisite check, ensures pinned **Node** (`/opt/turbopanel/vendor/node/current/bin/node`, runs this repo) is installed, installs Corepack via vendored npm when Node did not ship it (25+), enables Corepack/pnpm, runs `pnpm install`, and launches the Ink TUI via `vite-node`. Add `--watch` to use `scripts/hot-reload.tsx`, which keeps the Ink process alive and rerenders when imported `src/` modules change. When stdin/stdout/stderr are not TTYs, reattaches stdio to `/dev/tty` when `tp_is_interactive()` succeeds. Does **not** install Deno via `./console` itself (Deno bootstrap is via `ensureBootstrapDeno` during daemon install).
- **`src/tui.tsx`** — minimal Ink app: full-height shell with a one-row `MenuBar`, a bordered `MainPanel`, and a one-row `StatusBar`. `← →` switches areas; Ctrl-C exits. Uses `alternateScreen`. No stack orchestration or platform install yet — rebuild features in `src/` incrementally.

## Node app

Moved to [`src/AGENTS.md`](./src/AGENTS.md) — Ink TUI entry points, hot-reload
model, and the `src/lib/` helper contracts (paths, developer client,
daemon-exec, dev-env readiness, cell trace, test runner, daemon rebuild).

## Testing

**Run tests inside the Vagrant guest, never on the host.** Host VirtFS
checkouts do not have a usable Node/pnpm/Deno tree (`node_modules` is
bind-mounted inside the guest from `/var/lib/turbopanel-dev/…`). Agents
must SSH into the VM. From the host `dev` checkout (where the
`Vagrantfile` lives):

```bash
# CI-parity for every sibling (static gates + test:coverage LCOV, minus Sonar upload).
# From the host this re-execs via vagrant ssh; same path inside the guest.
./scripts/ci-verify.sh
./scripts/ci-verify.sh ui website
./scripts/ci-verify.sh --coverage-only

# one-shot (prefix vendored Node + Deno)
vagrant ssh -c 'export PATH="/opt/turbopanel/vendor/node/current/bin:/opt/turbopanel/vendor/deno/current:$PATH"; cd ~/dev && pnpm test'
vagrant ssh -c 'export PATH="/opt/turbopanel/vendor/node/current/bin:/opt/turbopanel/vendor/deno/current:$PATH"; cd ~/turbopaneld && deno task test'
vagrant ssh -c 'export PATH="/opt/turbopanel/vendor/node/current/bin:/opt/turbopanel/vendor/deno/current:$PATH"; cd ~/turbopanel && pnpm test:do'
# DuckDB compile/packaging gate — run on BOTH guest architectures (x64 + arm64)
vagrant ssh -c 'export PATH="/opt/turbopanel/vendor/node/current/bin:/opt/turbopanel/vendor/deno/current:$PATH"; cd ~/turbopanel && deno task duckdb:smoke'
vagrant ssh -c 'export PATH="/opt/turbopanel/vendor/node/current/bin:/opt/turbopanel/vendor/deno/current:$PATH"; cd ~/ui && pnpm test'
vagrant ssh -c 'export PATH="/opt/turbopanel/vendor/node/current/bin:/opt/turbopanel/vendor/deno/current:$PATH"; cd ~/website && pnpm typecheck'
```

Interactive: `vagrant ssh`, then `cd ~/dev` (or `~/turbopaneld` /
`~/turbopanel` / `~/ui` / `~/website`) and the same commands. The TUI
also runs suites in-guest: Developer → **Run tests…**, or on Services
select instance / daemon / caddy / ui / website and press **T**.

Do not run `pnpm test` / `deno task test` against the host sibling trees.

Guest commands:

| Command | Purpose |
| ------- | ------- |
| `pnpm test` | Vitest once (`vitest run`) |
| `pnpm test:watch` | Vitest watch mode |
| `pnpm test:coverage` | Vitest + LCOV (`coverage/lcov.info`) |
| `pnpm verify:ci` | GitHub Actions `verify.yml` minus Sonar upload (notices + typecheck + LCOV) |
| `./scripts/ci-verify.sh` | Same job for every sibling checkout (guest; re-execs via `vagrant ssh` from the host) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm notices:generate` | Write `THIRD_PARTY_NOTICES.md` from the resolved pnpm graph |
| `pnpm notices:check` | Fail when notices are stale vs the lockfile, or a production dependency has an unreviewed license class |

**Vitest convention:** place suites at `src/**/*.test.ts` / `src/**/*.test.tsx`. Use the `node` environment (Ink TUI, not a browser). Import `describe` / `it` / `expect` from `vitest` — do not use `node:test` + `node:assert/strict`. Assert shapes with `new TypeError()` per `typescript:S7786`.

**Shared test helpers:** this repo has no local shared test-helper module. Daemon test authors must use the shared doubles in `../turbopaneld/src/testing/` instead of hand-rolled ones (see that repo’s Testing section).

**Pre-commit** (`.githooks/pre-commit`): runs `scripts/scan-secrets.sh` only
(never skippable). Typecheck/tests are **temporarily disabled** in the hook
until the toolchain can run inside the Vagrant guest (host VirtFS checkouts
often lack a usable Node/pnpm tree). CI `verify.yml` still gates PRs.
`./console` idempotently sets `core.hooksPath=.githooks` via
`tp_ensure_git_hooks_path` in `scripts/lib/git-github-ssh.sh`.

**Gate matrix** (one policy with the daemon repo):

| Stage | dev | daemon | Rationale |
| ----- | --- | ------ | --------- |
| pre-commit | scan-secrets only (tests deferred) | scan-secrets + `deno fmt` (lint/tests deferred) | secret scan always; daemon fmt via host Deno or `vagrant ssh`; suites in CI / guest |
| PR → `trunk` | `verify.yml` | `verify.yml` | blocks merge |
| push `trunk` | `verify.yml` | `verify.yml`; `publish` job `needs: verify` | nothing compiles from failing code |
| promote → canary/rc/release | n/a | **artifact integrity only** (S3 sha256/size + CDN fetch) | no new code enters after publish |

### SonarQube (CI-based analysis)

- Analysis runs in GitHub Actions (`.github/workflows/verify.yml`) with
  `SONAR_TOKEN` and `sonar-project.properties`
  (`sonar.projectKey=turbopanel_dev`, `sonar.organization=turbopanel`). The job
  runs typecheck + **`pnpm test:coverage`** (Vitest v8 LCOV at
  `coverage/lcov.info`), then scans with
  `sonar.javascript.lcov.reportPaths=coverage/lcov.info`. The scan waits on the
  quality gate (`sonar.qualitygate.wait=true`); if the gate fails, the workflow
  stops.
- Vitest coverage `include` is `src/lib/**/*.ts` and `src/hooks/**/*.ts`
  (`vitest.config.ts`). `sonar.coverage.exclusions` keeps Ink chrome
  (`src/components/**`, `**/*.tsx`), entrypoints, and spawn/integration helpers
  out of the coverage denominator so untested TUI surfaces do not fail Sonar-way
  **Coverage on New Code ≥ 80%**.
- **`sonar.sources` / `sonar.tests` / `sonar.test.inclusions`** must stay set in
  `sonar-project.properties` (and mirrored in vestigial
  `.sonarcloud.properties`). Tests are co-located (`**/*.test.ts` under `src`).
- **Automatic Analysis must stay off** for `turbopanel_dev` (SonarCloud →
  project **Administration → Analysis Method**). CI and Automatic Analysis
  cannot run together — Automatic Analysis enabled makes the CI scanner fail.

**Coverage:** SonarCloud’s Sonar-way quality gate (CI scan in `.github/workflows/verify.yml` with `sonar.qualitygate.wait=true`) requires **≥ 80% coverage on new code**. CI uploads Vitest LCOV from `pnpm test:coverage` (`coverage/lcov.info`); `SONAR_TOKEN` is required on same-repo PRs and trunk pushes. After switching from Automatic Analysis, reset **New Code** (Administration → New Code) so the baseline is not months of uncovered history. Sibling repos (`turbopanel`, `ui`, `website`) use the same CI-based Sonar + LCOV pattern in their own `verify.yml` workflows.

## Ansible dev overlay

The **Ansible dev overlay** lives in `<dev checkout>/orchestration/` and overrides the daemon's production roles with dev-user parameters (the daemon still executes Ansible). Set `TURBOPANEL_MODE=development` during dev converge.

The **`dev-shell-path`** role (dev-only) always installs `/etc/profile.d/turbopanel-dev-deno.sh` (bash/login `sh`). When **zsh is installed** (`/usr/bin/zsh`), it also installs `/etc/zsh/zshenv.d/turbopanel-dev-deno` plus a guarded block in `/etc/zsh/zshenv` so **zsh invocations for the dest user** (including Oh My Zsh interactive shells — Debian does not source `/etc/zsh/zshrc.d`) prepend **`/opt/turbopanel/vendor/deno/current`** to `PATH`. Drop-ins are `root:<dev user>` mode `0640` (directory `0750`) so the dest login shell can source them without world-readable bits (`ansible:S2612`); Debian `/etc/profile` skips unreadable `profile.d` files. The role does not chmod Debian's `/etc/zsh/zshenv` conffile. Minimal Debian/Vagrant images ship bash only — zsh tasks are skipped rather than failing on a missing `/etc/zsh/zshenv` (do not create it on zsh-less hosts). That directory is the `deno-runtime` `current` symlink — version bumps only require updating the pin in the daemon role and `DENO_VERSION` in `scripts/lib/paths.sh` / `src/lib/paths.ts`, then re-converging. If a host later gains zsh, re-converge to wire the drop-ins.

### Development Caddyfile

Co-located hosts load **`orchestration/Caddyfile`** (not `~/turbopanel/Caddyfile`) when `turbopanel_dev_user` is set — wired by the daemon `instance-launch` role via `turbopanel_caddyfile`. That file owns:

- HTTPS `:8443` plus plaintext `:8880` (always on; no serve-time flag)
- Expo reverse_proxy when `TURBOPANEL_UI_MODE=dev` (with `expo-loading.html` for cold-start 502s; `flush_interval -1` so Fast Refresh `/hot` is unbuffered). Host edits on VirtioFS/9p need Metro poll watch in the UI repo (`scripts/metro-virtfs-poll-watch.cjs`) — inotify does not cross the share.
- Optional wrangler upstream when `TURBOPANEL_INSTANCE_RUNTIME=workers`
- `/downloads/daemon/*` (always — overlay catalog + artifacts; not gated on `TURBOPANEL_UI_MODE`) and the install script at **`/run.sh`** from the daemon checkout (`dist/` after Developer → **Rebuild daemon and upgrade connected servers** / `deno task release:dev`)

- Stripping `CF-Connecting-IP` / `True-Client-IP` / `X-Forwarded-For` from non-loopback peers, so only a connector on this host can present them

The instance repo's `Caddyfile` stays production-only (HTTPS + Deno socket + static UI). See **`../turbopanel/AGENTS.md`** (Caddy) and **`../turbopaneld/AGENTS.md`** (plaintext HTTP client gate).

**Server addresses in development.** Vagrant forwards `8443` / `8880` **over SSH**, so a daemon anywhere on the LAN reaches Caddy from `127.0.0.1` — the header-stripping matcher above never fires for it, and the peer address on the wire is `127.0.0.1` for every server. That is why the instance falls back to the interface addresses the daemon reports rather than trusting the wire (`src/lib/peer-address.ts` → `resolveServerAddress`, documented in **`../turbopanel/AGENTS.md`** → Caddy → Server addresses). A Cloudflare Tunnel pointed at this guest still resolves correctly: `cloudflared` is a loopback peer, so its `CF-Connecting-IP` is believed. Mixing LAN servers, tunnelled servers, and the co-located guest daemon in one fleet is the case this is built for.

## Shell libraries

- **`scripts/lib/privileges.sh`** — POSIX sudo re-exec helpers (`tp_ensure_privileges`), logging helpers, `tp_is_interactive()` (stdin TTY or readable/writable `/dev/tty`).
- **`scripts/lib/paths.sh`** — `/opt/turbopanel` path constants; pinned `NODE_VERSION` + vendored `NODE_BIN`/`PNPM_BIN` under `vendor/node/current/bin/`; pinned `DENO_VERSION` + `VENDORED_DENO_BIN` (`vendor/deno/current/deno`).
- **`scripts/lib/packages.sh`** — apt prerequisite checks: `tp_require_host_commands` (curl/tar/sha256sum).
- **`scripts/lib/runtime.sh`** — pinned **Node** install from the `nodejs.org` tarball into `/opt/turbopanel/vendor/node/<version>/` plus Corepack/pnpm (`tp_ensure_node_runtime` / `tp_ensure_corepack_pnpm`; Corepack is `npm install -g` on Node 25+); `tp_export_deno_path` prepends vendored Deno for hooks/child shells.
- **`scripts/lib/dev-identity.sh`** — resolve dev user from process UID (`tp_resolve_dev_identity`).
- **`scripts/lib/dev-prerequisites.sh`** — curl/sudo/dev-user checks for `./console`. When sudo still requires a password, optionally prompts to install `/etc/sudoers.d/turbopanel-dev-nopasswd` (full `NOPASSWD` for the dev user on local dev hosts). Set `TURBOPANEL_DEV_SKIP_NOPASSWD_SUDO=1` to skip the prompt.
- **`scripts/lib/git-github-ssh.sh`** — git identity prompts, SSH key generation, GitHub verification (used by `./console` when needed).

## Key conventions

### TypeScript style (SonarQube)

- Prefer **`String#replaceAll()`** over **`String#replace()` with a global regex** when replacing every occurrence of a substring (`typescript:S7781`).
- Use **`String.raw`** for string literals that contain backslashes so escapes stay readable and correct (`typescript:S7780`). Example: POSIX shell single-quote escaping is `String.raw`'\''` plus `replaceAll("'", …)`, not `"\'\\''"` with `replace(/'/g, …)`.
- Import **`shellQuote`** from `src/lib/shell-quote.ts` for shell argument quoting — do not copy inline `shellQuote` helpers.
- Prefer **optional chaining** (`obj?.prop`) over `!obj || obj.prop` (`typescript:S6582`).
- Use **`new TypeError()`** (not `new Error()`) when asserting types/shapes in tests (`typescript:S7786`).
- Avoid **nested ternaries** — use `if`/`switch` or small helpers (`typescript:S3358`).
- Extract helpers when **cognitive complexity** exceeds 15 (`typescript:S3776`).
- Sort strings with **`.sort((a, b) => a.localeCompare(b))`** (`typescript:S2871`).
- Do not leave **`TODO`** in code — use `Future:` in a normal comment (`typescript:S1135`).
- Use **`RegExp.exec()`** instead of `String.match()` when extracting a single match (`typescript:S6594`).

### Ansible style (SonarQube)

- Prefer **`mode: "0640"`** / **`0750"`** over world-readable **`0644"`** / **`0755"`** for scripts and systemd units; set explicit **`owner`** / **`group`** (`ansible:S2612`).

- Default git branch is **`trunk`** everywhere.
- Shell scripts are **POSIX `sh`** — no bashisms. Sonar `shelldre:S7688` (`[[` vs `[`) and `shelldre:S7682` (explicit `return`) are ignored in `sonar-project.properties` / `.sonarcloud.properties` for that reason.
- Git clones use **SSH** (`git@github.com:TurboPanel/...`), not HTTPS.
- **`console` owns the Node runtime** (for this repo) and starting the TUI. It does **not** install Deno or other platform runtimes.
- Contributors clone the six sibling repos on the host; Vagrant mounts them into the guest under `$HOME`.
- Developer identity (`TURBOPANEL_DEV_USER`, `TURBOPANEL_DEV_UID`, `TURBOPANEL_DEV_GID`) is resolved from the **process UID** via `getent passwd` (`tp_resolve_dev_identity()` in `scripts/lib/dev-identity.sh`). **`USER` / `LOGNAME` are never trusted.** Unresolved identities and `root` are rejected; the only root exception is a validated `SUDO_USER` passwd entry when the console runs under `sudo`.
- Node is pinned in `scripts/lib/paths.sh` (`NODE_VERSION` **`26.7.0`**), downloaded from `nodejs.org`, vendored to `/opt/turbopanel/vendor/node/<version>/` with a `current` symlink. pnpm is pinned solely by `packageManager` in `package.json` and provisioned via Corepack. Node 25+ dropped the bundled `corepack` binary, so `tp_ensure_corepack` installs the standalone package with vendored npm into that prefix before `corepack enable` / `prepare`. `tp_corepack_env` sets `COREPACK_DEFAULT_TO_LATEST=0` and `COREPACK_ENABLE_AUTO_PIN=0` so `pnpm --version` after `corepack prepare --activate` stays on that pin (Corepack otherwise reports the newest npm release when `./console` is launched from `$HOME`, which produced `expected vX, got Y` on every bump). The version check runs from the checkout so Corepack reads that `package.json`.
- **`TURBOPANEL_MODE=development`** during dev converge. Source repos default under `$HOME` via `TURBOPANEL_DEV_ROOT` and per-repo `TURBOPANEL_<DIR>_REPO` overrides.
- Daemon bootstrap, systemd units, and Docker containers run as the **current dev user** — no `tp` / `tpctrl` / `tpcache` service accounts are created in dev.
- Purge/reset stops and removes the daemon systemd unit **`turbopaneld.service`**, dev FHS state under `/etc/turbopanel`, `/var/lib/turbopanel`, `/var/log/turbopanel`, `/run/turbopanel`, and runtimes under `/opt/turbopanel/vendor`.
- Do not commit secrets or environment-specific config.

## What agents must NOT do

- Do not reintroduce `deno.json`/`deno.lock` to this repo or use Deno to run the console — this repo is Node/pnpm/Vite.
- Do not add Deno installation or upgrade logic to `./console` or `scripts/lib/runtime.sh` — development Deno is resolved from host PATH when present and otherwise auto-vendored by the orchestration path (`ensureBootstrapDeno` / `ensureOrchestrationDenoBin`); production Deno remains platform-managed. Keep `./console` and `scripts/lib/runtime.sh` Node-only.
- Do not reintroduce a host-side clone/bootstrap installer or a Workers Static Assets host for contributor setup — use Vagrant + pre-cloned sibling repos; docs live at turbopanel.io.
- Do not add platform repo cloning to shell scripts — that belongs in the TUI when rebuilt.
- Do not hardcode developer UID/GID — always read from `tp_resolve_dev_identity()` / `tp_require_dev_identity()` in shell scripts.
- Do not reintroduce `pull.sh`.
- Platform repos live under **`$HOME`** (via `TURBOPANEL_DEV_ROOT` / `TURBOPANEL_<DIR>_REPO`) — do not clone into `/opt/turbopanel/platform`.
- Do not bump the pinned Node version without updating `scripts/lib/paths.sh` and docs. Bump pnpm by updating `packageManager` in `package.json` only (keep the hashed Corepack pin), then run `pnpm install` so each sibling `pnpm-lock.yaml` records the `packageManagerDependencies` catalog — `--frozen-lockfile` (CI and Cloudflare) fails without it. Each pnpm checkout needs `pnpm-workspace.yaml` `allowBuilds` for packages whose postinstalls must run (`esbuild` / `workerd` for wrangler; this repo at least `esbuild`). pnpm 12 `strictDepBuilds` otherwise fails the install with `ERR_PNPM_IGNORED_BUILDS`. CI `pnpm/action-setup` must stay at **v6.1.0+** — v4 cannot install pnpm 12's native binary.
- Do not commit directly to `trunk` — use a feature branch and open a PR.
- Do not run unit tests, typecheck, or lint on the **host** checkout — use `vagrant ssh` (or the TUI Run tests / Services **T**). Host VirtFS trees lack a usable Node/pnpm/Deno `node_modules`.
- Do not update `AGENTS.md` to describe deleted multi-screen features as if they still exist — document the minimal `src/tui.tsx` flow until those features are reintroduced.
