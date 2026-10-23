# RainBot Windows App — Implementation Plan

Status: **Approved on 24 October 2026 — implemented and locally verified; unsigned installer built.**

Prepared: **24 October 2026**.

Scope: a dedicated Windows application for the existing combined Discord bot.

## 1. Recommended approach

Build **RainBot Desktop with Electron**, reusing the existing Material Design-inspired interface and bot services. Users install an `.exe`, open RainBot from the Start menu, configure their bot, and use Start/Stop in its own window. Normal use requires no terminal, browser dashboard, source checkout, or separately installed Node.js.

The interface remains HTML/CSS inside Electron. It is a desktop application with a Windows window, taskbar entry, installer, and tray controls; it does not use WinUI widgets. A WinUI rewrite would replace much of the working interface and introduce a separate .NET integration layer. Electron is the practical choice for preserving this project's existing functionality, with a larger installation and memory footprint as its main tradeoff.

The desktop app becomes the primary interface. Keep the existing command-line and local browser dashboard available for development and recovery; do not start the HTTP dashboard as part of normal desktop operation.

## 2. First-release scope

- Windows 11 x64, installed for the current Windows user.
- Existing Overview, Ambience, Commands, System Health, and Settings views.
- Start/Stop, live operation progress, connection status, and pending-restart feedback.
- Personal Discord bot token, application/server IDs, permissions, AI provider/model, and existing ambience settings.
- Existing ChatGPT connection and explicit OpenAI API-key modes, with no automatic provider fallback.
- Native setup actions for command registration and connecting/disconnecting ChatGPT, so setup does not depend on a terminal.
- System tray, single app instance, and reconnection to a bot already managed by this installation.
- Optional, explicit import of the existing project's settings and data.
- A Windows installer containing the runtime and required bot assets.

Each installation uses its owner's Discord application and AI credentials. This does not introduce hosted accounts, individual Discord-member API keys, other AI vendors, or multiple bot profiles in one app. The Windows computer must remain running and connected for its bot to stay online.

Defer automatic updates, launch at sign-in, Windows services, Microsoft Store/MSIX distribution, Windows ARM64, and Linux/macOS packaging. Do not add automatic startup or background AI requests.

## 3. Architecture

```text
RainBot Desktop
  Electron main process — window, tray, dialogs, validated bridge
    ↕ fixed, validated messages
  Bundled Node controller — settings, status, lifecycle, setup operations
    ↕ existing authenticated runtime control
  Discord bot frontend — independently managed background process
    ↕ existing worker IPC
  AI worker

Sandboxed renderer ↔ narrow preload bridge ↔ Electron main process
```

Keep settings encryption, filesystem operations, process inspection, and network setup work in the Node controller. The Electron main process handles the desktop shell and relays validated requests. Blocking DPAPI/process inspection must not freeze the window.

Extract reusable application operations from the current HTTP handlers. The existing dashboard uses an HTTP adapter; the desktop controller uses an IPC adapter. Share validation, secret redaction, operation locking, and lifecycle rules rather than copying a second implementation.

Introduce a small renderer transport module. The current views call named operations through this module instead of calling `fetch('/api/...')` directly. In desktop mode it uses the preload bridge; browser mode retains its authenticated HTTP transport. Hide browser-only workspace connection controls in desktop mode.

## 4. Packaged runtime and paths

The current supervisor launches `process.execPath` with `--import tsx` and source entry points. The worker also starts from TypeScript source. These assumptions must change for a standalone installer: Electron's executable cannot be treated as the existing Node executable.

Create an explicit application-path configuration containing:

| Path/value | Desktop purpose |
| --- | --- |
| `resourceRoot` | Installed, read-only application files and audio assets |
| `stateRoot` | `%LOCALAPPDATA%\RainBot`, writable by the current user |
| `runtimeExecutable` | Bundled, pinned Windows x64 Node.js executable |
| Compiled entry points | Controller, Discord frontend, and AI worker JavaScript |
| Installation identity | Stable local identity associated with this state directory |

Compile backend TypeScript to JavaScript in a release staging directory, preserving the existing ESM/module layout and copied JavaScript dependencies. End users do not need `tsx`, npm, or development tools. Use a separate desktop package for Electron/Forge tooling to avoid changing the backend's Node engine assumptions.

Bundle a verified official Node 24 release compatible with the project's `>=24.19.0 <25` requirement. Pin exact runtime/tool versions during implementation and record distribution hashes/licenses. Launch the controller and bot with explicit executable and entry-point paths, fixed arguments, `shell: false`, and hidden console windows. Preserve advanced worker IPC serialization for binary images.

Stage backend production dependencies against the bundled Node ABI, including `sharp` and its Windows binaries. Keep the Node runtime, backend/native dependencies, PCM assets, and inspection scripts outside Electron's ASAR archive. Do not load backend native modules into Electron's different runtime.

Audit all source-derived paths: settings, vault, personality, databases, locks, health files, logs, audio assets, worker entry points, and PowerShell helpers. Retain source-checkout defaults for CLI use. In desktop mode, mutable files go under `stateRoot`; bundled assets remain under `resourceRoot`. Never write settings or databases into the installation directory.

Preserve CLI configuration precedence. Start the packaged controller with a minimal, allowlisted OS environment and explicit desktop paths, so unrelated development credentials or Node injection options are not accidentally inherited. Desktop settings are its configuration source by default.

## 5. Desktop interaction

Preserve the current Material-inspired visual language, professional labels, light/dark themes, keyboard access, and uncluttered layout. Use a standard Windows title bar initially, with an application icon and sensible minimum size. No remote fonts or UI assets are required at runtime.

- **Open:** show Overview and read current status; never start the bot automatically.
- **Start/Stop:** reuse the existing serialized lifecycle operation and show its actual result. Disable conflicting actions while an operation is running.
- **Settings:** keep password inputs blank after saving; show only whether a credential exists. Saving settings does not restart the bot.
- **Tray:** provide Open RainBot, Start bot, Stop bot, Quit app (keep bot running), and Stop bot and quit. Enable actions according to current status.
- **Window close:** hide to the tray, with one brief first-use notice explaining where RainBot remains available.
- **Second launch:** focus the existing window using Electron's single-instance mechanism; do not launch another controller or bot.
- **Stop and quit failure:** retain the app and show the error if verified shutdown cannot complete. Never silently force-kill a process.

Quitting only the app leaves the independently managed bot running. Reopening reconnects through the authenticated control channel. Windows shutdown/sign-out is not a guarantee of uninterrupted bot operation; this release is not a service.

## 6. Setup and credentials

Reuse `SettingsStore`, existing validation, atomic revisions, and Windows CurrentUser DPAPI. The renderer receives redacted settings and presence flags, never stored secret values. Newly entered secrets travel only through the bounded local save operation, are not logged, and are cleared after completion/navigation. Renderer access does not provide isolation from other malicious software running as the same Windows user.

The setup flow provides:

1. Enter and save the owner's Discord settings and AI connection choice.
2. Run explicit connection checks using the existing non-inference checks.
3. Register this bot's commands with a clearly labeled **Register commands** action. Preserve unrelated commands and report partial failure accurately; do not register automatically on open or save.
4. Start the bot when configuration is ready.

Adapt the existing ChatGPT authorization logic into a bounded controller operation with progress, cancellation, and timeout. Open its supported sign-in page in the user's browser after they select Connect; retain the existing callback and credential protections. Require the bot/auth lock to be available before changing that connection. Do not embed a third-party sign-in page or expose authorization URLs/tokens in general-purpose logs. Validate account/provider compatibility during implementation; packaging does not create new subscription entitlements.

Keep connection checks separate from the explicit AI response test. Any response test retains its usage/cost notice and runs only when selected. No automatic inference, paid fallback, or ambiguous request retries are introduced.

## 7. IPC and window security

Use a sandboxed renderer with `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true`. Expose individual preload methods for status, settings, lifecycle operations, and setup; never expose raw IPC, filesystem access, shell execution, arbitrary URLs, or generic command invocation. Validate the requesting top-level frame, message schema, size, and permitted operation in the main process and controller. These choices follow [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

Load only bundled interface files through a restricted application protocol, with an exact resource allowlist and strict Content Security Policy. Reject traversal, popups, unexpected navigation, remote scripts, and unneeded permission requests. External browser links must come from explicit supported actions and validated destinations. Desktop administrative transport does not open a localhost management port; retain all existing session/origin/CSRF protections when the browser dashboard is launched separately.

Use a small CommonJS preload (`preload.cjs`); sandboxed preload scripts cannot use ESM imports, as documented in [Electron's ESM guide](https://www.electronjs.org/docs/latest/tutorial/esm#sandboxed-preload-scripts-cant-use-esm-imports). The Electron main process may use ESM independently.

## 8. Lifecycle ownership and upgrades

Extend existing process checks to accept the explicitly configured packaged runtime and compiled frontend/worker entry points. Verify executable, entry point, state directory/instance identity, process creation identity, locks, and worker parentage. Preserve authenticated control messages, cross-controller operation locks, duplicate-start rejection, cooperative shutdown, and PID-reuse protections.

Derive desktop control-channel identity from the stable state location/instance rather than the versioned installation path. Include protocol/build identity in runtime descriptors so a new app can identify an older running bot and require a controlled restart. Do not weaken ownership checks just because a process is named `node.exe`.

The first release uses manual updates. Stop and verify both bot processes before replacing/removing their runtime files. Handle installer lifecycle launches before ordinary app startup; they must not spawn another bot. Validate versioned install/update/uninstall behavior in the packaging phase, including a running background bot. Preserve user data on uninstall by default and explain any required shutdown rather than deleting active state or force-killing unrelated processes.

## 9. Import and rollback

New installations start with empty configuration. Existing project data is imported only through an explicit **Import existing installation** action and a selected source folder.

1. Validate the selected source and preview the items to import without printing secrets.
2. Require the source frontend, worker, and authorization operations to be stopped and verified. Reject ambiguous ownership; do not remove locks merely to proceed.
3. Stage settings, personality, conversation history, and sleep state in a new destination. Use SQLite backup facilities and run integrity checks. Keep the source unchanged.
4. Import recognized legacy settings through validation and DPAPI-backed secret storage. Copy the protected ChatGPT grant with its required host binding only when same-account/machine compatibility is verified; otherwise ask the owner to reconnect.
5. Publish the staged profile only after validation succeeds. Do not overwrite an existing desktop profile. Create fresh runtime identity/control state; never import old PIDs, locks, operation files, or stale health snapshots as ownership evidence.

Document rollback to the source installation. OAuth refresh may rotate credentials after migration: rollback must preserve the latest valid protected grant/binding, with both installations stopped. Never run the imported and original profiles simultaneously against the same bot merely because their state directories differ.

## 10. Expected file changes

Names below are proposed implementation locations, not files created by this plan.

| Area | Expected files |
| --- | --- |
| Windows shell/build | `desktop/package.json`, `desktop/main.mjs`, `desktop/preload.cjs`, `desktop/forge.config.mjs`, icon resources |
| Backend release | `tsconfig.build.json`, a focused release-staging script, packaged runtime manifest |
| Shared paths/services | `src/app-paths.ts`, extracted dashboard application operations, `src/desktop/controller.ts` |
| UI transport | `src/dashboard/public/transport.js`, targeted changes to `app.js` and existing markup/styles |
| Packaged runtime support | `src/dashboard/supervisor.ts`, `src/integration/runtime-control.ts`, `src/integration/ai-client.ts`, relevant path consumers |
| Terminal-free setup | reusable operations from `src/auth-cli.ts`, `src/auth.ts`, and `src/register.ts` |
| Migration and checks | focused desktop/controller/path/migration tests and installer smoke-test instructions |
| User documentation | desktop setup/update/recovery instructions in `README.md`; checkpoint in `PROJECT_STATE.md` |

Avoid rewriting bot dispatch, AI providers, voice behavior, or database formats unless a demonstrated packaging requirement needs a targeted change.

## 11. Delivery phases and acceptance

1. **Runtime/path foundation:** compile and run the existing backend from a staged release with an isolated writable profile. Verify native image processing, SQLite, assets, worker IPC, and ownership checks using the bundled Node executable.
2. **Desktop shell and shared operations:** add the window, secure bridge/controller, renderer transport, single-instance handling, and tray. Confirm browser dashboard behavior remains intact.
3. **Setup and import:** add explicit registration/auth operations and staged migration, with cancellation/error handling and protected credentials.
4. **Installer and verification:** package on Windows with Electron Forge's Squirrel.Windows maker. It produces a Setup executable and related release artifacts; use its installer-event handling requirements from the [official Forge documentation](https://www.electronforge.io/config/makers/squirrel.windows).

Completion requires:

- Install and launch under a normal Windows user on a clean Windows 11 x64 machine without Node.js, npm, a repository, or a terminal.
- No localhost dashboard listener in desktop mode, no exposed raw bridge, and no packaged credentials, private histories, logs, backups, or owner-specific personality data. Build from an allowlisted staging directory, including a generic personality template and required license notices.
- Configure, save, reopen, and remove synthetic protected secrets; verify redaction, failure recovery, and revision handling.
- Start/stop a disposable frontend and worker, reconnect after app restart, reject duplicate instances and foreign/reused PIDs, and handle failed/timed-out shutdown without force.
- Verify tray/quit behavior, setup operation cancellation, migration integrity/rollback, and update/uninstall with a running bot.
- Rendered review at common Windows display scaling levels; keyboard navigation, window resizing, dark/light themes, and settings feedback work.
- Existing type checks and regression tests pass, with focused new tests for paths, transport/security, packaged lifecycle, and migration. The previous 145-test baseline is historical evidence, not verification of a desktop build.
- Actual Discord registration, sign-in, real AI usage, and voice listening are separate owner-approved pilot actions; synthetic tests cannot establish those outcomes.

Configure signing for the executable and installer before public distribution, using owner-provided signing infrastructure. Keep signing secrets outside the repository. An unsigned internal build may be used for testing, but release readiness must report signing status and any Windows trust prompts accurately. See [Electron's code-signing documentation](https://www.electronjs.org/docs/latest/tutorial/code-signing).

## 12. Approval boundary

The original request authorized this planning document only. The owner subsequently approved implementation with “proceed” on 24 October 2026. The desktop application has been implemented; current verification and release limits are recorded in `PROJECT_STATE.md` and `WINDOWS_APP.md`. Production credential migration, real command registration, sign-in and live bot/inference actions were not performed during development.
