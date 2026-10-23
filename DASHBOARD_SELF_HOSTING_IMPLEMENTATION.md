# Dashboard controls and self-hosting settings — implementation plan

Date: 23 October 2026 (MYT, UTC+08:00).

**Status: approved by the owner; implemented on 24 October 2026.** See `PROJECT_STATE.md` for verification and operational limitations. The sections below retain the approved design; operational instructions are maintained in `README.md`.

## 1. Intended outcome and scope

Add Start and Stop controls to the existing RainBot dashboard and a Settings section through which a self-hosting owner can configure their own Discord application and AI credentials.

Proposed first release: **one installation, one owner, one Discord application, and one configured AI server**. Each person hosts their own copy with their own Discord token, API key, settings, and databases. Members of that server use the owner's configured provider within the existing access rules.

This is not a shared hosted service with accounts or a separate API key for every Discord member. That interpretation would require a separate design for tenant isolation, credential routing, access, and billing. Multiple installations on one machine must use separate project/data directories, bot identities, and dashboard ports.

Target Windows first, matching the project's current credential protection and process tools. Linux/Docker support is a later, explicit portability task; this release must not claim to support them.

Proposed API-key provider: **OpenAI**, alongside the existing ChatGPT connection. Other vendors and custom endpoints need dedicated adapters and compatibility checks and are outside the first release. Keep the current provider and model unchanged until the owner explicitly selects another mode.

## 2. Confirmed starting point

- `src/dashboard/server.ts` currently serves a loopback-only, read-only dashboard and sanitized health data. It rejects mutations.
- The four current views are Overview, Ambience, Commands, and System Health. Actions copy commands into Discord; there are no browser-based bot controls.
- `src/main.ts` owns Discord and voice. `AIClient` supervises a separate AI worker; the dashboard is an independent process.
- Startup uses exclusive runtime locks. `data/runtime-status.json` is a snapshot, not sufficient proof of process ownership for Stop.
- `scripts/stop-combined.ps1` verifies directories, entry points, and parentage but force-stops processes. Do not call it as the normal dashboard Stop implementation.
- `src/config.ts` accepts `chatgpt` and `stub` providers. The worker currently initializes the subscription connection and its model catalog directly.
- `workerEnvironment` intentionally excludes API keys and Discord credentials. API support requires deliberate credential delivery; adding a field alone will not work.
- `src/vault.ts` provides Windows CurrentUser DPAPI encryption. Existing subscription credentials and ownership locks must remain intact.
- Latest completed baseline: TypeScript check and **118/118 tests passed**. Browser review covered live data, navigation, search/filtering, copy feedback, refresh, themes, keyboard skip navigation, and mobile overflow.

## 3. Dashboard experience

### Bot controls

Place the bot control beside Refresh status in the header, with the same Material Design styling. It remains available from every view.

| Verified state | Control | Feedback |
| --- | --- | --- |
| Stopped; configuration valid | Start bot | Starting… |
| Stopped; setup incomplete | Complete setup | Opens Settings and identifies missing fields |
| Starting | Disabled Starting… | Awaiting Discord connection |
| Running | Stop bot | Stopping… |
| Stopping | Disabled Stopping… | Waiting for shutdown |
| Ownership cannot be verified | Controls disabled | Cannot verify bot ownership |
| Launch/shutdown failed | Appropriate retry after recheck | Concise, sanitized error |

Distinguish process state from Discord and AI readiness. An alive process with unavailable AI is still Running; it must not offer Start and create a duplicate. Treat a crashed process as stopped only after verified exit, even when an older health file says connected.

Start and Stop are explicit actions. Saving settings never starts, stops, restarts, registers commands, or sends a paid request. No automatic force-stop or repeated restart loop. Show a brief Stop explanation that voice disconnects and active AI requests may be interrupted; preserve saved sleep sessions for restoration on the next start.

### Settings

Add **Settings** to the existing navigation. Use clear grouped fields, short labels, accessible validation, and progressive disclosure for advanced options. Include Save changes, Discard, and an unsaved-changes indicator.

| Group | Fields and actions |
| --- | --- |
| Discord | Bot token, application ID, server ID, owner ID; Test Discord connection |
| AI connection | Provider: Existing ChatGPT connection / OpenAI API key; model; supported reasoning setting; API-key replace/remove; Test connection |
| Access | Owner only / Allowed server members; allowed channel IDs; allowed role IDs; sleep controller role IDs |
| Ambience | Default volume for rain and birdsong, initially the existing 20%; retain the current shared-volume behavior |

Changing the Discord token configures an existing bot identity; a display-name field must not imply that it creates or renames a Discord account. Personality editing and individual member credentials are deferred.

When a secret exists, show **Configured** and Replace / Remove actions. Never return an existing secret to the browser or prefill it with masked characters. Empty secret input means unchanged; removal must be explicit. Clear newly entered secrets from browser memory after save and when leaving the form. Never put them in browser storage, URLs, analytics, or frontend bundles.

All saved runtime settings apply on the next Start. If already running, show **Saved · Restart required** with the changed fields. The owner can explicitly Stop, then Start. Do not silently alter active requests or ongoing voice playback.

### First-time setup

1. The new host runs `npm run dashboard` under their own Windows account.
2. The local launcher authorizes an owner browser session; the dashboard opens Settings when required setup is missing.
3. The owner supplies their own Discord application/token and server/owner IDs, chooses access restrictions, and selects an AI provider.
4. They can save and test the connection without starting the bot. API validation must distinguish authentication/catalog access from successful inference.
5. Command registration remains an explicit setup step using `npm run register`, updated to read the same settings. Its existing non-destructive command-upsert behavior is preserved.
6. The owner clicks Start bot. Show process and Discord readiness independently from AI readiness.

Document required Discord installation permissions and Message Content intent for selected-message reading. Never copy this owner's private runtime folder, credentials, conversations, or `.env` into a distributable self-hosting package.

## 4. Safe process lifecycle

Introduce a `BotSupervisor` in the dashboard backend. It serializes lifecycle operations across requests and holds an exclusive supervisor lock so two dashboard processes cannot race to start the same installation.

### Start

1. Resolve and validate the effective configuration and required assets before spawning anything.
2. Inspect the existing frontend lock, worker lock, live control identity, and OS process metadata. Existing or ambiguous ownership blocks duplicate startup. A stale status snapshot alone never allows Start.
3. Launch the fixed project entry point with the current Node executable, fixed argument arrays, explicit project working directory, `shell: false`, and `windowsHide: true`. Never accept a command, executable, path, PID, or shell arguments from the browser.
4. Preserve the bot's own exclusive startup lock as the final authority. Store a protected supervisor record containing the installation identity, process creation identity, and configuration revision.
5. Wait for a bounded startup handshake. A spawned PID does not mean Discord is ready. Report credential/permission failures without credentials, raw provider bodies, or conversation content.
6. Persist management metadata so restarting the dashboard can reconnect to a surviving bot without launching another one. Closing the dashboard must not stop the bot.

### Stop

Add a small authenticated local control channel in `src/main.ts`, using a Windows named pipe scoped to this installation. This gives a graceful Stop path for bots started from the dashboard or from an updated `npm start` entry point. Windows process termination through Node's signal API must not be treated as graceful shutdown.

- Use a per-installation random control secret stored with DPAPI. Authenticate requests and responses and include an instance nonce, PID, process creation time, and canonical project identity. Pipe names alone are not authorization.
- Before Stop, verify the control identity against OS executable, project directory/entry point, frontend lock ownership, and worker parentage when a worker is present. Revalidate immediately before acting; never trust a PID supplied by the browser or a status file alone.
- The control channel accepts only status/identity and shutdown, not arbitrary commands or settings. Bound payload sizes and timeouts; restrict local pipe permissions where supported in addition to authentication.
- On shutdown, stop accepting new requests, reject/cancel queued AI work, stop worker supervision, and close voice, Discord, databases, and owned locks in a defined order. Reuse/refine the existing idempotent cleanup path.
- Acknowledge that shutdown was accepted, then wait for verified frontend and worker exit before displaying Stopped or enabling Start. Preserve session database state; Stop must not invoke `/sleep leave`, disable restoration, clear history, or remove credentials.
- If shutdown times out, display a clear failure and keep Start blocked while either owned process remains alive. Force-stop remains an explicit operator recovery procedure; it is not part of this UI release.
- A pre-update or unidentifiable process without the control channel remains visible as **Externally managed**. Do not terminate or adopt it blindly. Explain that it must first be stopped using its existing terminal/verified operational procedure.

Do not silently delete stale locks. A dedicated recovery path may remove only a matching exited-owner lock after exact ownership checks; ambiguous or inaccessible process inspection must fail closed and direct the owner to existing recovery instructions.

## 5. Settings storage and configuration

Add a versioned, validated local settings store:

```text
data/dashboard/settings.json       Non-secret settings and revision
data/dashboard/secrets.dpapi       Encrypted credential map
data/dashboard/control.dpapi       Local lifecycle control secret
data/dashboard/supervisor.json     Management identity; no credentials
data/dashboard/supervisor.lock     Exclusive supervisor ownership
```

Settings and secrets must be committed as one coherent revision. Use versioned credential references and atomic replacement so a crash cannot combine a new token with old Discord application settings. Keep the last valid revision available for recovery, including protected credentials, and never create plaintext secret backups.

Create a shared configuration bootstrap used by dashboard validation, normal startup, worker initialization, and command registration. Proposed precedence: explicit inherited deployment environment > saved dashboard settings > legacy `.env` > defaults. Parse legacy `.env` separately from inherited environment so precedence is real; the current `--env-file` startup flags merge those sources and need coordinated changes. Show externally overridden fields as managed outside the dashboard, rather than allowing saves that have no effect.

Retain existing `.env` installations without automatic migration or rewriting their files. The dashboard initially reads a redacted effective configuration; owner edits opt into managed storage. An explicit secret removal must not accidentally reactivate a lower-precedence legacy key—track removal/override state or require resolving that legacy source.

Keep the existing `data/ai/chatgpt.dpapi` subscription grant separate and unchanged. Do not reuse its schema for API keys. Use CurrentUser DPAPI and restrictive local file permissions; hosts re-enter credentials when moving to another Windows account or machine.

The running bot reports its active configuration revision. Compare it with the saved revision to show Restart required accurately. Reject concurrent stale settings saves using the expected revision, and serialize saves with lifecycle operations so Start always uses one complete configuration snapshot.

## 6. API-key inference

Add an explicit `openai` provider mode and provider factory behind the existing `Provider` interface. Preserve `chatgpt` and the test-only `stub` path. Do not turn a failed subscription request into an API-key request, or vice versa.

Use OpenAI's server-side bearer authentication and Responses API for the new adapter. OpenAI's [API authentication documentation](https://developers.openai.com/api/reference/overview#authentication) requires protecting API keys and keeping them out of client-side code; the [text generation guide](https://developers.openai.com/api/docs/guides/text) documents Responses-based generation. Revalidate request details during implementation rather than assuming the subscription adapter's catalog and responses are identical to the API-key contract.

- Send inference from the worker. Keep Discord tokens out of that worker and API credentials out of public status, Discord replies, and arbitrary inherited environment. Prefer loading the selected protected credential server-side from the configured installation store; allow an explicit deployment environment key through a narrowly selected provider-only path when used.
- Use the fixed official endpoint initially; do not expose an unrestricted base-URL field that could redirect credentials to another service.
- Require an explicit API-mode model selection. Preserve the existing subscription model independently. Never assume account/model availability, feature support, reasoning options, or API access from a ChatGPT login.
- Select only supported options for the chosen provider/model. Implement and verify text, images, completion/error handling, cancellation, output bounds, and exact nickname tool validation before advertising feature parity.
- Preserve current history scoping, delivery acknowledgment, duplicate suppression, cooldowns, and nickname permission checks. Provider selection never grants new Discord permissions.
- Make web search explicit in API mode and off by default for a new API profile; enable only after capability and request behavior are verified. Preserve the existing subscription mode's behavior.
- Handle invalid/revoked keys, rate limits, unavailable models, and quota failures with sanitized messages. Do not automatically retry ambiguous requests that could duplicate a paid generation or action.
- Test connection validates authentication and lists accessible models where permitted; do not promise that it proves inference capability. An optional **Test AI response** must clearly state that it can use API credit and run only on an explicit owner click. Saving and page loading never perform paid inference.

## 7. Backend routes and local authorization

Retain loopback binding, explicit static-file allowlisting, security headers, and sanitized health responses. Once settings and lifecycle mutations exist, require a locally authorized owner session for all administrative reads and writes.

Bootstrap a browser session with a short-lived, single-use random token supplied by the local launcher. Exchange it for an HttpOnly, SameSite=Strict session cookie, remove the token from browser navigation immediately, and never write it to logs. A plain localhost page visit from an unrelated site must not authorize administration. This protects browser access; it does not isolate the application from malicious software running as the same Windows user.

Require exact Host and same-origin checks plus a session-bound CSRF token on mutations, bounded JSON bodies, explicit methods, strict schemas, rate limits, and sanitized errors. Reject requests before any mutation when authorization is missing. Do not rely on CORS alone. Keep secrets out of request/response logging and return only configured/not-configured metadata.

| Route | Purpose |
| --- | --- |
| `GET /api/status` | Existing sanitized service metrics plus supervisor state and pending-restart metadata |
| `POST /api/session` | Consume the local one-time authorization token |
| `POST /api/bot/start` | Start the fixed configured installation; return an operation ID |
| `POST /api/bot/stop` | Gracefully stop the verified installation; return an operation ID |
| `GET /api/operations/:id` | Read this session's bounded lifecycle operation status |
| `GET /api/settings` | Redacted effective settings, secret-presence flags, and revision |
| `PUT /api/settings` | Validate and save settings with expected revision |
| `POST /api/settings/test-discord` | Validate owner-supplied Discord configuration without starting or registering |
| `POST /api/settings/test-ai` | Authentication/catalog validation without generation |
| `POST /api/settings/test-ai-response` | Explicit, bounded inference check with potential API usage |

Reject repeated/conflicting lifecycle operations safely and return the current operation/state. A canceled browser request must not cause a second launch when the owner retries. Registration stays CLI-based in this release; do not add an automatic Discord command-registration side effect to Save or Start.

## 8. Expected file changes after approval

| Files | Responsibility |
| --- | --- |
| `src/dashboard/server.ts` | Authorized routes, validation, operation status, sanitized responses |
| New `src/dashboard/supervisor.ts` and local session module | Lifecycle serialization, process verification, browser owner sessions |
| New shared settings/schema/bootstrap modules | Effective configuration, revisioned persistence, secret references |
| New `src/integration/runtime-control.ts` | Authenticated local identity/shutdown channel |
| `src/dashboard/public/index.html`, `app.js`, `styles.css` | Start/Stop, settings forms, validation, transition/restart feedback |
| `src/main.ts`, `src/config.ts`, `src/sleep/config.js` | Shared bootstrap and coordinated lifecycle/configuration |
| `src/provider.ts` and a new API provider module | Provider factory and isolated API-key adapter |
| `src/integration/ai-worker.ts`, `protocol.ts` | Provider selection and tightly scoped credential/configuration loading |
| `src/integration/health.ts`, `ai-client.ts` | Active revision and shutdown coordination where required |
| `src/register.ts`, relevant auth/operational entry points, `package.json` | Consistent settings bootstrap; preserve existing workflows |
| `tests/dashboard.test.ts` and focused new tests | Authorization, process lifecycle, settings, provider regressions |
| `.env.example`, `README.md`, `PROJECT_STATE.md` | Sanitized setup, compatibility, recovery, and completion records |

Prefer existing Node facilities and the current DPAPI helper. Add dependencies only when an identified correctness or platform requirement warrants them. Avoid unrelated UI or bot refactoring.

## 9. Implementation sequence

1. Establish shared configuration contracts, settings revisions, secret storage, and local admin authorization; prove legacy startup still works.
2. Add authenticated runtime identity/graceful shutdown and the supervisor; verify with disposable child processes before connecting real bot controls.
3. Add the API-key adapter and provider tests using fixtures, retaining the current ChatGPT path.
4. Add Start/Stop and Settings to the dashboard, including setup, validation, busy, failure, and restart-required states.
5. Update self-hosting setup, command registration, and recovery instructions; verify a clean installation with synthetic credentials and isolated data.
6. Run focused checks, the complete regression suite, and desktop/mobile browser review. A real bot restart, Discord mutation, command registration, or paid AI check remains an explicit operator action; do not perform them merely to demonstrate the UI.

## 10. Acceptance checks

- Double-click Start and simultaneous requests produce one bot; existing manual instances and foreign locks block a duplicate.
- Startup failure, worker unavailability, stale health, PID reuse, dashboard restart, and concurrent dashboard instances report correct ownership/state.
- Stop uses cooperative shutdown, verifies both owned processes have exited, and preserves history, saved sessions, credentials, and foreign/auth locks.
- An unverified process or expired control identity is never killed; timeout never silently escalates to force termination.
- Dashboard shutdown leaves the bot running and a reopened dashboard can verify/reconnect to it.
- Legacy `.env` and the existing subscription grant work without migration. Saved/active revisions and external overrides produce truthful restart/field states.
- Partial saves, invalid credentials, secret replacement/removal, concurrent saves, and corrupted files cannot produce mixed configuration or plaintext secret files.
- Missing sessions, CSRF tokens, bad origins/hosts, unknown settings, oversized input, and browser-supplied commands/PIDs are rejected without side effects.
- Keys/tokens never appear in status, settings reads, errors, logs, browser persistence, or worker environments unrelated to the selected provider.
- API provider fixtures cover images, supported settings/tools, exact nickname actions, stream failures, cancellation, output caps, and no hidden fallback or unexpected retries.
- Settings and lifecycle controls work by keyboard and on mobile, with readable errors, meaningful names, disabled busy controls, and both themes.
- Run `npm run check`, focused new tests, then the full `npm test` suite. Record actual results; the current 118-test baseline does not verify these proposed features.

## 11. Approval boundary

The original planning-only phase was followed by the owner's approval to implement this first-release scope. Verification uses isolated data and disposable processes. Approval to implement does not imply permission to spend API credit, restart the live bot, or mutate a live Discord server merely as a test. Live operation remains an explicit owner action through the controls or terminal.
