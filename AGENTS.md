# Repository Guidelines

## Project Structure & Module Organization
The root package is the Bun-based CLI and local server. Main code lives in `src/`: `entrypoints/` for startup paths, `screens/` and `components/` for the Ink TUI, `commands/` for slash commands, `services/` for API/MCP/OAuth logic, and `tools/` for agent tool implementations. `bin/claude-haha` is the executable entrypoint. The desktop app is isolated in `desktop/` with React UI code in `desktop/src/` and Tauri glue in `desktop/src-tauri/`. Documentation is in `docs/` and builds with VitePress. Treat root screenshots and `docs/images/` as reference assets, not source code.

## Build, Test, and Development Commands
Install root dependencies with `bun install`, then install desktop dependencies in `desktop/` if you are touching the app UI.

- `./bin/claude-haha` or `bun run start`: run the CLI locally.
- `SERVER_PORT=3456 bun run src/server/index.ts`: start the local API/WebSocket server used by `desktop/`.
- `bun run docs:dev` / `bun run docs:build`: preview or build the VitePress docs.
- `cd desktop && bun run dev`: run the desktop frontend in Vite.
- `cd desktop && bun run build`: type-check and produce a production web build.
- `cd desktop && bun run test`: run Vitest suites.
- `cd desktop && bun run lint`: run TypeScript no-emit checks.

## Desktop Development & Local Testing

### Sidecar binary

The Tauri desktop app spawns a compiled sidecar binary as its backend server. This binary is produced by `desktop/scripts/build-sidecars.ts`, which uses `Bun.build({ compile: true })` to bundle `desktop/sidecars/claude-sidecar.ts` + Bun runtime into a standalone executable. The entrypoint `claude-sidecar.ts` is a merged launcher that selects mode by its first CLI argument:

- `claude-sidecar server --app-root <path> --host 127.0.0.1 --port <port>` — HTTP + WebSocket API server
- `claude-sidecar cli --app-root <path> ...` — full CLI / TUI
- `claude-sidecar adapters --app-root <path> [--feishu] [--telegram]` — IM adapters

The binary outputs to `desktop/src-tauri/binaries/claude-sidecar-<target-triple>` and is declared in `tauri.conf.json` under `bundle.externalBin`. Build it manually with:

```bash
cd desktop && bun run build:sidecars
```

Adapters dependencies (`@larksuiteoapi/node-sdk`, `grammy`) are marked as external (not bundled into the binary) and must be findable from the binary's node_modules search path. Install them and symlink:

```bash
cd adapters && bun install
cd ../desktop
ln -sf ../../adapters/node_modules/@larksuiteoapi node_modules/@larksuiteoapi
ln -sf ../../adapters/node_modules/grammy node_modules/grammy
```

### Web UI mode (fast iteration, no Tauri toolchain)

Best for UI and server-side development. Runs the server and Vite frontend separately, accessed in a browser with hot reload.

```bash
# Terminal 1: start the API server
SERVER_PORT=3456 bun run src/server/index.ts

# Terminal 2: start the Vite frontend
cd desktop && bun run dev --host 127.0.0.1 --port 2024
```

Open `http://127.0.0.1:2024` in a browser. Use this for most UI, API, and logic changes.

### Remote Access (LAN — serve to other devices)

The desktop app can expose a remote access server on the LAN so phones/tablets/other computers can access it via a browser. The remote server binds to a configurable IP:port, serves the built frontend, proxies API/WebSocket to the local server, and enforces JWT login.

**Two ways to start:**

| Method | Command | Best for |
|--------|---------|----------|
| **Production** (built files) | `SERVER_PORT=3456 bun run src/server/index.ts --remote-enabled --remote-port 8080` | Full integration test, serves `desktop/dist/` |
| **Dev with hot reload** | `SERVER_PORT=3456 bun run src/server/index.ts` + `cd desktop && bun run dev:remote` | UI iteration, no rebuild needed |

**Important:** When using the production method, the remote server serves static files from `desktop/dist/`. After any frontend change, you MUST rebuild:

```bash
cd desktop && bun run build
```

The `dev:remote` method uses Vite's dev server (hot reload, no build step). LAN devices access `http://<host-ip>:1420`.

**CLI flags for remote access:**

| Flag | Description |
|------|-------------|
| `--remote-enabled` | Force-enable remote server (override config file) |
| `--remote-host <ip>` | Bind address (default from config, typically `0.0.0.0`) |
| `--remote-port <port>` | Listening port (default from config, typically `8080`) |

**Settings UI path:** Settings → Remote Access tab. Configure bind address, port, and access password. Changes take effect immediately (server auto-restarts).

### Tauri native mode (full desktop app)

Required when testing native features: built-in terminal (PTY), sidecar lifecycle, tray, auto-updater, or the final DMG shape. Has heavier prerequisites (Rust toolchain, Tauri CLI).

```bash
cd desktop && bun install            # frontend deps (one time)
cd ../adapters && bun install        # adapter deps (one time, see symlink step above)

cd ../desktop
bun run tauri dev                    # builds sidecar + starts Vite + opens native window
```

First run downloads Rust/Tauri tooling automatically (~minutes). Subsequent runs take ~10–20 seconds (rebuilds sidecar then launches). To skip sidecar rebuild pass extra Tauri args: `bun run tauri dev -- --no-build`.

## Desktop Release Workflow

Two ways to produce distributable desktop installers (DMG/EXE/MSI):

### Local build (single platform, for testing)

**macOS Apple Silicon → DMG & .app:**
```bash
cd desktop
bun install                                          # install frontend deps
./scripts/build-macos-arm64.sh                       # outputs to desktop/build-artifacts/macos-arm64/
```
Prerequisites: macOS arm64 host, `bun`, `cargo`/`rustc`, `codesign`, `hdiutil`.
Env vars: `SKIP_INSTALL=1` to skip `bun install`, `SIGN_BUILD=1` to enable signing, `OPEN_OUTPUT=1` to open Finder.

**Windows x64 → NSIS installer:**
```powershell
cd desktop
.\scripts\build-windows-x64.ps1                      # outputs to desktop/build-artifacts/windows-x64/
```
Prerequisites: Windows host, `bun`, Rust MSVC toolchain.

### CI build (all platforms, for release)

Push a version tag and GitHub Actions builds all 5 platforms automatically:
```bash
mkdir -p release-notes
echo "## Changes

- your notes here
" > release-notes/v0.1.8.md

bun run scripts/release.ts patch    # bumps version, updates Cargo.lock, creates commit + tag
git push origin main --tags         # triggers .github/workflows/release-desktop.yml
```

The workflow builds macOS ARM64/x64 DMG, Windows x64 NSIS, and Linux x64/ARM64 deb.
The tag name, app version in `tauri.conf.json`, and `release-notes/vX.Y.Z.md` filename must all match, or the build fails fast.

## Docs Workflow Notes
- The docs workflow is `.github/workflows/deploy-docs.yml` and uses `npm ci`, not Bun. When root `package.json` dependencies change, keep `package-lock.json` in the same commit or the docs build will fail.
- The docs workflow currently runs on Node 22; avoid reintroducing older Node assumptions there without checking dependency engine requirements.

## Coding Style & Naming Conventions
Use TypeScript with 2-space indentation, ESM imports, and no semicolons to match the existing code. Prefer `PascalCase` for React components, `camelCase` for functions, hooks, and stores, and descriptive file names like `teamWatcher.ts` or `AgentTranscript.tsx`. Keep shared UI in `desktop/src/components/`, API clients in `desktop/src/api/`, and avoid adding new dependencies unless the existing utilities cannot cover the change.

## Testing Guidelines
Desktop tests use Vitest with Testing Library in a `jsdom` environment. Name tests `*.test.ts` or `*.test.tsx`; colocate focused tests near the file or place broader coverage in `desktop/src/__tests__/`. No coverage gate is configured, so add regression tests for any behavior you change and run the relevant suites before opening a PR.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit prefixes such as `feat:`, `fix:`, and `docs:`. Keep subjects imperative and scoped to one change. PRs should explain the user-visible impact, list verification steps, link related issues, and include screenshots for desktop or docs UI changes. Keep diffs reviewable and call out any follow-up work or known gaps.
