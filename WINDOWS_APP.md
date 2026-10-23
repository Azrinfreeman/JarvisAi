# RainBot for Windows

## Install and configure

The Windows x64 installer is `desktop/out/make/squirrel.windows/x64/RainBotSetup.exe`. Open it, then launch **RainBot** from the Start menu. The app includes its own Node runtime; normal use requires no browser dashboard, terminal, npm, or source checkout.

This development installer is **unsigned**. Public distribution still needs owner-provided code signing. No certificate or signing service was purchased or configured.

Open **Settings** and either:

- Choose **Import existing installation** before saving any desktop settings. Stop the original bot and its worker first, select the combined project folder, review the import, and confirm. Keep the original installation stopped afterward.
- Enter your own Discord bot token, application ID, server ID, owner ID, and AI provider settings, then save. For ChatGPT, stop the bot and use **Connect ChatGPT**; account eligibility is still required. For API mode, enter your own OpenAI API key and model.

Use **Test saved connection** to check saved credentials. These checks do not generate an AI response. The separately labeled AI response test can consume API credit. Use **Register commands** explicitly to install/update the bot's six commands in the configured server; unrelated commands are preserved. Then choose **Start bot** from Overview.

Use only one installation for a given Discord bot application. Starting a fresh profile with the same token does not transfer control of an older source installation. Stop the original first; do not run both copies together.

## Window and tray

- Start/Stop controls manage the verified Discord frontend and AI worker together. Connection readiness is shown separately.
- Saving settings applies them on the next start and never restarts the bot automatically.
- Closing the window hides RainBot to the system tray. Double-click its tray icon to reopen it.
- **Quit app (keep bot running)** closes the UI while the bot continues. Reopening reconnects to that installation's authenticated control channel.
- **Stop bot and quit** waits for verified cooperative shutdown. An unsuccessful shutdown leaves the app available and reports the failure; no process is force-stopped.
- No launch-at-sign-in, automatic bot startup, Windows service, automatic updater, or hosted server is installed. The PC must remain awake and online.

## Local files and protection

Desktop state lives under `%LOCALAPPDATA%\RainBot`:

| Location | Contents |
| --- | --- |
| `data/dashboard` | Validated settings, DPAPI-protected secrets/control credential, operation ownership |
| `data/ai` | Protected ChatGPT connection/host binding and conversation database |
| `data/sleep` | Saved voice sessions |
| `data/frontend` | Frontend ownership locks and nickname event database |
| `data/bot.stdout.log`, `data/bot.stderr.log` | Local runtime diagnostics |
| `PERSONALITY.md` | Optional owner personality, read on subsequent requests |
| `desktop-profile` | Electron window profile, local theme and browser cache |

Installed application files and audio assets are separate and read-only during normal operation. The installer is built from an allowlisted staging directory and excludes the source project's `.env`, protected grants, settings, databases, logs, backups, and personal `PERSONALITY.md`.

DPAPI credentials require the Windows account/machine that protected them. History databases are ordinary local files. The UI is sandboxed, but the app and bot run as the same Windows user; this is not protection against malicious software already running under that account.

## Import, update and recovery

Import supports the combined source project's default data locations. Custom `AI_DATA_DIR` or sleep database locations require a deliberate manual migration. The import checks source ownership locks, temporarily acquires bot/auth locks to prevent concurrent use, backs up SQLite databases consistently, checks database integrity, verifies DPAPI compatibility, and publishes settings last. It preserves source data and never imports old PIDs, runtime descriptors, control keys, or bot locks. An existing desktop profile is not overwritten.

If the import fails normally, its newly published files are rolled back. A hard interruption can leave `data/import.pending`; startup and settings edits are blocked until recovery. Stop/quit both installations, verify no owned bot or auth process remains, preserve a copy of the destination, and review the marker's relative file list against the selected source before removing only that incomplete import's destination files. Do not delete the source, unrelated desktop files, or arbitrary paths supplied by an edited marker. Remove the marker only after verified recovery, then retry into an empty destination. Empty folders left after a failed attempt may also need removal after that verification.

Before a manual update or uninstall, use **Stop bot and quit**, verify completion, then run the installer/uninstaller. A newer app will reject ownership of a bot running from another installed version; reopen the older version to stop it first. Updates are manual. User data is outside the installation and is preserved by default on uninstall.

For rollback, stop both installations before restoring or starting the source project. OAuth refresh may rotate credentials: preserve the latest valid `chatgpt.dpapi` and matching `host-id` under the original Windows account. Do not restore a stale credential backup over a refreshed grant or launch the original and imported copies simultaneously. See the existing README for verified lock recovery; a stale status snapshot alone does not prove a process has exited.

## Develop and build

Use Windows x64 and the project's supported Node version for development:

```text
npm ci --ignore-scripts
npm --prefix desktop ci
npm run desktop:prepare
npm run desktop
```

`desktop:prepare` compiles backend JavaScript, stages only production dependencies/assets, and downloads a pinned official Node 24.22.0 executable with SHA-256 verification. It also stages the Node license and runtime manifest. Electron 45.0.0 and Forge 8.0.1 are pinned in the desktop lockfile. The backend's native dependencies run under bundled Node, independently of Electron's V8/ABI. Electron/controller IPC uses JSON for runtime compatibility; frontend/worker binary IPC retains advanced serialization under the same Node runtime.

After preparing resources:

```text
npm run check
npm test
npm run desktop:smoke
node scripts/desktop-runtime-smoke.mjs
npm run desktop:make
node scripts/desktop-package-smoke.mjs
```

Re-run preparation after source/UI/dependency changes before packaging. The focused smoke tests use fresh profiles under `output`, synthetic credentials, and disposable lifecycle fixtures; they never use the owner's saved credentials or contact Discord/AI services. Packaged startup verification temporarily launches and terminates only its own idle, unconfigured GUI test process and verifies its controller exits. Test captures/results are under `output/desktop-smoke`, `output/desktop-runtime`, and `output/desktop-package`.

Forge emits the installer, `.nupkg`, and `RELEASES` metadata. Its lifecycle handler exits before normal UI/controller startup during installer events. The build selects its vendor x64 7-Zip files explicitly because npm may block that dependency's install script; it does not change global npm permissions.

For a signed release, supply `RAINBOT_SIGN_CERT` and `RAINBOT_SIGN_PASSWORD` through protected build infrastructure. Do not save signing secrets in this repository. Validate the resulting installer signature and Windows trust experience before distributing it.

## Verification limits

Local checks passed: the 151-test regression run, eight subsequent supervisor checks, type/syntax checks, real Electron settings/theme/tray checks, compiled fixture startup/reconnection/cooperative shutdown, and final packaged-executable/dependency/single-instance checks. Production dependency audits reported zero vulnerabilities. The final installer was built successfully and its signature status is NotSigned.

Local development/runtime/package checks do not substitute for installation, update and uninstall trials on a clean Windows 11 VM. The local package check removes system Node from the child's PATH; it does not prove the host has no other development tools. Live Discord registration, real ChatGPT sign-in, provider/model entitlement checks, paid inference, and human voice listening are separate pilot actions and are not triggered by these smoke tests.
