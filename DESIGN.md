# RainBot interface contract

RainBot shows its owner the bot's actual condition and the next available action. Commands are references to copy into Discord; they are never represented as controls that have already run.

The browser dashboard and Electron renderer share `src/dashboard/public`. All five views use this contract and the same CSS tokens. Keep the RainBot name, rain mark, hash navigation, and light/dark preference.

## Tokens

| CSS role | Light | Dark |
| --- | --- | --- |
| `--canvas` | `#f7f9fc` | `#13191f` |
| `--surface` | `#ffffff` | `#1b232c` |
| `--surface-dim` | `#f0f3f8` | `#252f3a` |
| `--text` | `#202934` | `#e0e7ef` |
| `--muted` | `#677380` | `#a0acb9` |
| `--line` | `#e6ebf0` | `#2c3743` |
| `--control-border` | `#7a8796` | `#7e8fa1` |
| `--primary` / `--focus` | `#285ba0` | `#a1c6fc` |
| `--primary-hover` | `#194a8c` | `#bad7ff` |
| `--primary-ink` | `#ffffff` | `#18304e` |
| `--selected` | `#e7f0ff` | `#293f5d` |
| `--green` / `--green-bg` | `#377557` / `#e9f4ed` | `#a3d7b9` / `#2b4133` |
| `--warning` / `--warning-bg` | `#80600b` / `#fff2d8` | `#efce85` / `#4c4029` |
| `--danger` / `--danger-hover` | `#a34440` / `#8a3532` | `#9d403b` / `#b14b44` |
| `--error` / `--error-bg` | `#9a3b32` / `#fbeae7` | `#f3b3aa` / `#492b2a` |

Blue identifies actions and selection; status colors require corresponding state text. Divider tokens separate related content; control borders identify editable/control boundaries. Do not use decorative category tints.

## Type, spacing, and shape

- Arial/Helvetica is retained for readable offline UI. Use 28px page headings, 18px section headings, 15px body text, and 13px secondary text. Navigation may use 12px on narrow screens; editable mobile inputs use 16px. Do not shrink essential content to fit.
- Consolas / Courier New is reserved for command syntax and identifiers. Metrics use tabular numbers.
- Space related content using 4/8/12/16/24/32px intervals. Desktop columns may use 48px separation. Content determines height.
- Controls use 6px corners; meaningful grouped surfaces use 8px. State badges use 4px. Ordinary rows have no outer frame. Elevation is reserved for dialogs and toasts.

## Structure

Overview starts with readiness and the applicable owner action. Use aligned service rows, explicit Discord copy shortcuts, and compact scene shortcuts. Ambience starts with current sessions, followed by scene rows. Commands uses a searchable/filterable semantic list. System health uses metric entries and definition lists. Settings uses meaningful form sections, existing advanced disclosures, and sticky Save/Discard controls.

Keep navigation accessible through desktop rail, collapsed rail, and mobile bottom navigation. Mobile uses Home and Health as compact labels while retaining the full accessible destination names. Use one page title and one local connection indicator. No marketing hero, decorative account menu, repeated eyebrow/subtitle, ornamental scene art, or invented metric history.

## Interaction and accessibility

- View changes and keyboard actions are immediate. Pointer press feedback may scale a primary-sized button to .98 over 120ms using `cubic-bezier(0.23, 1, 0.32, 1)`; reduced motion removes it.
- No blanket `transition: all`, hover lift, decorative loop, or animation dependency. Hover styling is gated to hover-capable fine pointers.
- Preserve visible focus, labels, skip navigation, active-route/filter semantics, native dialogs, focus restoration, and live feedback. Inputs and disclosure controls have explicit focus-visible coverage.
- Primary touch controls are at least 44px. At 320px, wrap content, preserve labels and command options, and avoid page-level horizontal scrolling. Bottom navigation, save bars, toasts, and safe-area padding must not obstruct content.
- Preserve secret handling, paid-test labels, consent/privacy information, overrides, restart warnings, recovery, and all disabled/busy/error states. Styling never changes authorization or initiates operations.

Change this contract when adding a genuinely new role; do not introduce one-off colors, fonts, or per-page design systems.
