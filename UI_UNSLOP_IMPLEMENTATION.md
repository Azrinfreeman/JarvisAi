# RainBot UI cleanup implementation plan

Status: Implemented and verified after approval to proceed.

Date: 2026-10-29

Skills: `avoid-ai-design`, `emil-design-eng`, `ui-unslop`

Profile: Dashboard, with surgical changes to shared application controls.

## Objective and scope

Make RainBot communicate whether the bot is available, what is happening in voice, and which action the owner can take next. Structure the interface around those tasks rather than a promotional landing page.

Cover all five existing views: Overview, Ambience, Commands, System health, and Settings. The browser dashboard and Electron application reuse `src/dashboard/public`, so they must receive the same visual system. Preserve RainBot's name, rain mark, existing blue identity, light/dark themes, routes, and capabilities.

The initial phase delivered this plan only. The subsequent instruction to proceed authorized the UI implementation described here. Existing uncommitted work, including voice-summary and settings changes, was preserved. Installer rebuilding, commits, and deployment were outside this implementation.

## Evidence and baseline

Reviewed the shared HTML, CSS, rendering functions, transport bridge, desktop window configuration, relevant tests, and existing project documentation. There is no existing `DESIGN.md`; the current CSS variables and RainBot identity are the available design-system evidence.

The `avoid-ai-design` scanner inspected four public frontend files and reported **5 findings: P0 0, P1 3, P2 2**. Its results require interpretation:

- `K2`: repeated rounded surface treatment; relevant, although radii are not literally identical and shadows are not applied to every panel.
- `K3`: backdrop blur on the decorative hero note; relevant.
- `K7`: the HTML-only missing-focus warning is partly a false positive. `styles.css` already defines focus-visible styles for buttons, anchors, and inputs. Explicit select and disclosure focus treatment still needs review.
- `SD4d`: middle-dot strings occur in copy and state metadata. Remove ornamental strings, but retain punctuation when it helps distinguish actual information. The document title separator alone is not a defect.

T3 browser snapshots failed twice with `Preview automation snapshot timed out after 15000ms.` An isolated headless render of the existing frontend was used instead. Baseline inspection covered Overview, Ambience, Commands, System health, and locked Settings at 1280 CSS pixels, plus Overview at 320 CSS pixels. Entry animation was frozen for stable inspection after the initial capture. Settings form structure was reviewed in source; authenticated settings were not visually verified.

The isolated render had no application backend or desktop bridge. `/api/status` and `/api/session` requests failed as expected. Offline labels and the fetch-error toast in these captures do not establish the state of the actual bot. Dark mode, live sessions, authorized settings, and operation states remain implementation-stage verification items.

## Hierarchy and content model

- Primary: process/control state, Discord and AI readiness, and the applicable Connect / Complete setup / Start / Stop action.
- Secondary: current voice sessions, command lookup/copy, and editing configuration.
- Tertiary: resource metrics, timestamps, installation details, and advanced restrictions.
- Overview is operational evidence plus next actions; Ambience and Commands are collections; System health is diagnostic comparison; Settings is a transaction with explicit save/discard behavior.

The current repeated treatment is a rounded panel containing small muted text, a colored icon tile, and sometimes another rounded element. It gives metrics, commands, scenes, and form sections similar weight despite their different jobs.

## Audit and intended changes

Locations refer to current files under `src/dashboard/public`. CSS is compressed into long lines, so selectors are more useful than line numbers. “Rendered” means the isolated baseline described above; “inferred” identifies findings requiring a later live check.

| Priority / evidence | Location / catalog ID | Before | After | Why |
| --- | --- | --- | --- | --- |
| P1, source + rendered | `index.html`, `.hero`; `L9`, `CP1` | Large landscape hero, “Your companion, in sync,” and an Explore CTA precede operational information. | Remove the hero and lead with readiness and the available owner action. | A returning owner needs status and control before product promotion. |
| P1, source + rendered | `.stat-card`, `.panel`, `.scene-card`; `K2` | Similar large rounded enclosures make unrelated information equally prominent. | Use service rows, command rows, grouped form sections, and selective enclosure. | Representation should follow the information and interaction. |
| P1, source + rendered | `.tile-icon`, `.blue`, `.lavender`, `.mint`; `K6`, `C4` | Blue, lavender, and mint tiles decorate status, commands, and actions. | Remove decorative tile backgrounds; reserve blue for interaction and semantic colors for actual state. | These tints do not consistently encode a meaningful category or state. |
| P1, source + rendered | `.floating-note`, `.landscape`; `K3` | Glass note, orbit lines, hills, clouds, and sound bars occupy the hero. | Remove with the hero. | They supply neither operational evidence nor a working audio control. |
| P1, source + rendered | `.eyebrow`, `.workspace-label`, hero tag, repeated descriptions; `T5`, `SD4`, `CP1` | Uppercase labels and aspirational subtitles repeat page context. | Use one page heading; retain descriptions only where they explain a constraint or action. | Navigation and hierarchy already identify the view. |
| P1, source + rendered | Sidebar profile, top avatar/date, footer slogan; `L6`, `CP1` | Repeated RainBot initials, a nonfunctional profile chevron, calendar date, and slogan resemble generic app chrome. | Keep the rain mark, navigation, theme action, and one local connection indicator; remove unsupported identity/menu cues and slogan. | There is no account menu behind the profile treatment, and the date does not support a task. |
| P1, source-certain contrast calculation | `.workspace-label`, `footer`; `C9` | `#8792a0` on white is approximately 3.16:1; `#8b96a3` on `#f7f9fc` is approximately 2.85:1 for small text. | Remove redundant text; use the existing muted token or a verified stronger token for retained text. | Necessary small text must remain readable. Existing `#677380` is approximately 4.84:1 on white and 4.59:1 on the canvas. |
| P1, source-certain; visual state check pending | Global focus rules; `K7` | Focus styles cover buttons, links, and inputs, but omit explicit select/summary coverage. | Extend shared focus-visible rules to selects and summaries; verify native dialogs, filters, and range controls. | Keyboard visibility must survive the cleanup. This is not a claim that all focus styles are absent. |
| P2, source + rendered | `.mini-scenes`, `.scene-grid`, `.scene-art`; `K11`, `S1` | Large repeated illustrations and nested scene tiles make a simple command collection tall. | Compact labeled scene rows with existing descriptions and explicit Copy command actions. | Names, descriptions, and command syntax distinguish scenes better than repeated hills. |
| P2, source + rendered | `.command-row`; `K6`, `S1` | A useful list is stretched by icon tiles and generous repeated row padding. | Keep the list, emphasize command syntax, align copy actions, and use readable compact spacing. | Improve scanning without rebuilding working search/filter behavior. |
| P2, source-certain | `.page`, `.mini-scene:hover`; `M2` | Every hash view fades/rises; scene buttons lift on hover. | Instant view changes; quiet color/border feedback for frequent actions. | Repeated navigation should respond immediately, including keyboard navigation. |
| P2, source-certain | `.button` interaction rules; `K7` | Buttons have hover styling but no shared deliberate press treatment. | Add subtle pointer-only press feedback where useful, with a visible static keyboard active state. | Confirm a press without adding motion to keyboard actions. |
| P2, inferred from source | Settings panels and save bar | Every section uses the same panel frame; helper copy and setup controls compete with fields. | Use meaningful form groups, local action placement, and preserved advanced disclosures. | Make the primary configuration path easier to scan while keeping instructions and state intact. |

No P0 issue was reported by the scanner. This is not a centered SaaS hero or an untouched shadcn application; do not manufacture those findings. The problem is the promotional composition and repeated decorative system within a real dashboard.

## Proposed design contract

Direction: **Show the owner the bot's actual condition and the next available action, with commands and configuration arranged for direct use.**

Carry the current RainBot colors forward instead of changing the brand to make the page appear redesigned. The six core roles are:

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| Canvas | `#f7f9fc` | `#13191f` | Application background |
| Surface | `#ffffff` | `#1b232c` | Inputs and groups that need separation |
| Text | `#202934` | `#e0e7ef` | Primary content |
| Muted text | `#677380` | `#a0acb9` | Necessary secondary content |
| Divider | `#e6ebf0` | `#2c3743` | Nonessential section separation |
| Action | `#285ba0` | `#a1c6fc` | Links, selected navigation, primary actions |

Keep existing success/warning/error meanings as semantic exceptions, with text labels as well as color. Existing primary-hover and selected-background values remain related action states. Divider colors are not sufficient as the sole boundary of every control: establish and verify a stronger control-border/focus token in both themes where needed. Check every foreground/background pairing, including dark primary buttons and destructive actions.

Typography: retain the existing Arial/Helvetica body stack to avoid an unrelated font migration. Its role is a readable, offline application interface, not a display-brand gesture. Establish hierarchy through 28px page titles, 18px section headings, 15px body/control text, and 13px necessary secondary text. Use Consolas with a monospace fallback only for command syntax and identifiers; use tabular numerals for metrics. Do not retain the current 8–11px mobile labels. Aim for 16px editable input text on narrow screens.

Spacing: shared 4/8/12/16/24/32px scale. Use approximately 12–16px within related rows and 24–32px between task groups. Let content wrap; avoid fixed heights for text sections.

Shape and elevation: approximately 6px control corners and 8px meaningful grouped surfaces. Status dots can remain circular. Use whitespace or a divider for ordinary rows; reserve elevation for dialogs and toasts. Do not mechanically put a border, shadow, and rounded rectangle around every group.

Layout: retain the existing navigation model and hash routes, simplify the shell, and lead each page with its real content. The recognizable detail is an aligned readiness presentation for Discord, AI, and voice using real state labels; no new ornamental signature is necessary.

Default review: this retains the established rain/blue identity, avoids a cream/terracotta or black/neon replacement, uses no display-serif garnish, decorative numbering, gradient headline, or monospace chrome. A smaller alternative would remove the hero and tints while keeping the existing card structure; a larger alternative would replace the navigation shell. Recommend the content restructuring below while keeping familiar navigation.

After approval, record this contract in one root `DESIGN.md` and apply it across every view and theme. Do not generate separate palettes or component styles per page.

## Page implementation

### Shared shell

- Keep the rain mark, five navigation destinations, theme toggle, and current route indication.
- Remove the repeated eyebrow, decorative profile/avatar treatment, date, redundant breadcrumb context, and footer slogan. Preserve or safely update any JavaScript references to removed elements in the same pass.
- Retain one page heading and the existing global management controls. Keep Refresh secondary; present Connect / Complete setup / Start / Stop according to the existing state machine.
- Keep management notices, restart requirements, recovery actions, and operation feedback conspicuous. Simplification must not make a destructive stop look like a start action.
- Keep accessible navigation names when the rail collapses. Retain mobile bottom navigation, with safe-area-aware padding and sufficient clearance for content, toasts, dialogs, and the Settings save bar.

### Overview

1. Delete the promotional hero and its illustration styles.
2. Place process/control feedback and Discord/AI/voice readiness at the top. Keep process management distinct from actual Discord and AI readiness.
3. Replace oversized status cards with aligned service rows. Consolidate duplicate state text; update `renderStatus()` and `badge()` calls together if a duplicate node is removed, leaving no dangling selector.
4. Keep command shortcuts as explicit copy actions: Copy ask command, Copy rain command, and Copy status command. Copying must not imply execution in Discord.
5. Reduce the duplicated illustrated soundscape preview to compact scene shortcuts plus the Ambience link. Do not add a second polling source or duplicate live-session rendering here.

### Ambience

1. Place the existing current-session section before the scene collection, so actual playback information is visible first.
2. Replace the nine illustrated cards with compact rows for all seven rain styles, birdsong, and silent presence. Retain real descriptions and all current command strings; shorten only promotional filler.
3. Keep an explicit Copy command action per item. Do not add a play button, preview sound, direct Discord control, or fake selected scene.
4. Use existing mode/style/voice/audio fields in session rows. Keep anonymized session numbering when actual channel identity is unavailable; do not invent names or imply channel selection.

### Commands

1. Preserve search, category filters, empty results, the `/` shortcut, and clipboard fallback.
2. Keep a semantic list of rows: readable command syntax, action name/necessary explanation, and an aligned copy action. Remove decorative category tiles.
3. Wrap long syntax at narrow widths without removing options or creating page-level horizontal scrolling.
4. Preserve permission, consent, withdrawal, and voice-capture explanations. The layout must not make a copied command look like a completed operation.

### System health

1. Keep a concise service summary and the existing stale/disconnected guidance.
2. Replace the three oversized metric cards with aligned metric entries, retaining units and interval/percentile context.
3. Reuse the existing definition-list structure for service details; avoid repeating the same value in several decorative containers.
4. Render unavailable metrics as unavailable, not zero. Keep snapshot timestamps and ten-second refresh behavior. Do not add charts without historical data.

### Settings

1. Preserve every current field, `name`, validation constraint, provider condition, environment override, secret action, and save/discard state.
2. Organize existing Discord, AI connection, Voice summaries, Access, and Ambience groups using headings and spacing rather than identical heavy frames. Use two field columns where they fit and one column at narrow widths.
3. Keep provider-dependent controls and existing advanced disclosures. Do not add a new tab system or hide essential consent/privacy information under Advanced.
4. Keep local transcription setup/progress/cancel beside its provider controls. Keep account, import, registration, and installation actions inside their existing desktop-only context.
5. Keep useful helper text: credential handling, paid-test costs, local/cloud privacy, consent modes, restart requirements, format constraints, external overrides, and recovery guidance. Remove only redundant motivational or restated copy.
6. Preserve sticky Save/Discard behavior and unsaved-change protection. Ensure the bar does not obscure the final fields, focus targets, mobile navigation, or error feedback.

## Interaction and accessibility rules

- Frequent view changes and keyboard-triggered actions are immediate. No page entrance choreography or staggered data rows.
- Pointer button press feedback, where useful, may use `scale(0.98)` over 100–140ms with `cubic-bezier(0.23, 1, 0.32, 1)`. Keyboard active feedback stays static. Avoid scaling small icon targets if it reduces clarity.
- Use explicit transition properties; do not introduce `transition: all`, bounce, decorative blur, or an animation dependency. Gate hover motion to `(hover: hover) and (pointer: fine)`.
- Retain reduced-motion support and remove transform movement when requested. Status refresh must not animate entire sections or steal focus.
- Keep visible focus, skip navigation, `aria-current`, filter `aria-pressed`, labeled controls, status/alert semantics, Escape dismissal, and dialog focus restoration. Give dialogs accessible names where needed.
- Target 44px primary touch actions and at least 24px other pointer targets with adequate spacing. Retained text must meet 4.5:1 for normal text; meaningful control boundaries and focus cues need adequate non-text contrast.

## Files and implementation order

1. Add `DESIGN.md` with the approved shared contract.
2. Edit `src/dashboard/public/index.html` for shell cleanup, content order, semantic groups, and preserved form/control hooks.
3. Edit `src/dashboard/public/app.js` only for affected markup templates, presentation strings, removed hooks, and required accessibility behavior. Keep routes, command data, status interpretation, event delegation, and existing operations intact.
4. Consolidate `src/dashboard/public/styles.css` around shared tokens, readable type, responsive layouts, and complete interaction states. Remove obsolete hero/art/card rules after their markup is gone; avoid layering another override section onto dead CSS.
5. Keep `transport.js`, server routes, IPC/preload contracts, settings schema, and bot/provider/audio logic unchanged unless a concrete regression makes a narrowly scoped fix necessary.

No new framework, package, icon library, remote font, generated image, or build pipeline is needed. Installer rebuilding is a separate delivery step if requested; source edits alone do not update an installed desktop application.

## Verification after implementation

The original verification checklist follows; executed results and remaining delivery limits are recorded below.

1. Run `node --check src/dashboard/public/app.js` and `npm run check`.
2. Run the existing focused regression set: `node --import tsx --test tests/dashboard.test.ts tests/dashboard-admin.test.ts tests/desktop.test.ts tests/voice-settings.test.ts`. These protect contracts; they do not prove visual quality. Broaden only for failures or changes that reach other systems.
3. Re-run `node C:/Users/Melon/.agents/skills/avoid-ai-design/scripts/detect.mjs src/dashboard/public`. Require no P0 findings and review every residual finding against its actual context. Document valid false positives instead of adding ignore comments solely to silence the scanner.
4. Compare all five views before/after at 1280px and 320px. Check the existing breakpoint boundaries at 650/651, 920/921, 1150/1151, and 1499/1500px where their rules remain; include the Electron 760px minimum width and default 1280×850 window. Cover both themes and 200% browser zoom.
5. Exercise, with disposable data and mocked operations, locked/authorized Settings, clean/dirty/saving/saved/error, externally managed/starting/running/stopping/blocked states, stale/disconnected status, empty/populated sessions, search/no-results, clipboard success/fallback, dialog cancellation, provider switches, secret Replace/Remove/Keep, local setup progress/cancel, and desktop-only installation controls.
6. Check keyboard-only navigation, visible focus, dialog names and focus restoration, immediate keyboard transitions, reduced motion, contrast, long commands/identifiers, content reflow, sticky bars, and absence of page-level horizontal overflow.
7. Perform an isolated Electron smoke check for the shared UI and desktop-only states using the existing repository workflow and a disposable profile. Do not use production credentials or operate the real bot to verify styling.

Acceptance gates: the first glance reveals readiness and the next action; each content type has an appropriate representation; remaining containers/icons/tints encode meaning; no unsupported first- or second-order template remains; controls retain their behavior; essential content is readable and reachable at every checked width. Any failed gate reopens the implementation before completion is reported.

## Implementation and verification results

- Removed the promotional hero, decorative landscape/scene art, repeated icon tiles, account/date chrome, and redundant subtitles. Readiness rows now lead Overview; current sessions lead Ambience; command syntax leads searchable command rows; diagnostics use aligned metrics; Settings uses spaced form groups.
- Retained the existing blue identity, rain mark, five routes, light/dark preference, command copying, and necessary credential, consent, privacy, restart, and recovery guidance. Shared tokens and interaction rules are recorded in `DESIGN.md`.
- Fixed the `/` shortcut to reveal Commands before focusing Search and to respect selects, editable content, and open dialogs. Clearing authorization also clears destructive Stop styling. Named dialogs, explicit focus coverage, pointer-only press feedback, readable narrow-screen navigation, and mobile save-bar clearance accompany the layout changes.
- `node --check src/dashboard/public/app.js`, `npm run check`, and the 31 focused dashboard/admin/desktop/voice-settings tests passed. Whitespace validation passed for the UI and desktop smoke changes.
- The saved isolated Electron UI run passed **268 checks**, with no renderer errors. It covers all five views in both themes at 320, 650, 651, 760, 920, 921, 1150, 1151, 1280, 1499, and 1500 CSS pixels, plus 200% zoom and reduced motion. Screenshots at 320px and 1280px were reviewed on resumption; the successful run postdates the current frontend edits.
- Interaction checks cover search/filter/no-results, clipboard success/fallback, trusted keyboard focus, dialog Escape/cancellation/focus restoration, locked/authorized Settings, provider changes, save/discard/error and credential clearing, local setup progress/cancel, management states, stale metrics, and empty/populated sessions. See `output/ui-unslop/qa-result.json` and `output/ui-unslop/screenshots/` for local evidence.
- `npm run desktop:smoke` passed using an isolated synthetic profile, including the actual window/preload/controller, settings save/reload/redaction, incomplete-startup rejection, 960px layout, both themes, and tray reopening. No production credentials or live bot operations were used.
- The final design scan reports **P0 0, P1 1, P2 0**. Its sole `K7` warning is an HTML-only false positive: `index.html` links `styles.css`, whose shared `:focus-visible` rule covers buttons, links, inputs, selects, and disclosure summaries. The rendered keyboard-focus check passed. No ignore comment was added to hide the finding.

The operational hierarchy and content-specific rows replace the repeated decorative card system. Remaining enclosure identifies the readiness group, controls, management feedback, dialogs, or save transaction; blue marks actions/selection and semantic colors accompany state labels. The reviewed views share one design system without decorative replacement themes.

Verification used synthetic data; live Discord/provider behavior is not claimed.

On the subsequent request to build the installer, `npm run desktop:prepare` and `npm run desktop:make` completed on 2026-10-29. The Windows x64 installer is `desktop/out/make/squirrel.windows/x64/RainBotSetup.exe`. All 231 regression tests, desktop UI/runtime smoke checks, and the final package smoke check passed. Both packaged UI copies match the four current frontend source files. The installer remains unsigned; clean-machine installation/update/uninstall trials were not performed.
