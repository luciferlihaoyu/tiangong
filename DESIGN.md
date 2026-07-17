# 天宫 TIANGONG / Design System

This document codifies the design system already in use across the Tiangong admin UI. It exists so future work matches the visual contract established by the existing pages, rather than drifting into something generic.

The system is dark-first, dense, and operationally serious. It draws on Chinese sci-fi visual language (vermillion red, gilt gold, dark space black) layered onto a terminal-grade data console. Pages are panels, not cards. Type is mostly mono. Color carries meaning, never decoration.

## 0. Provenance

This file is extracted from the live source, not invented. It was read against:

- `src/index.css` (theme variables and primitive component classes)
- `src/sections/Navigation.tsx` (app shell, sidebar, top bar, theme toggle)
- `src/pages/OpsPanel.tsx`, `GuardPanel.tsx`, `UsagePanel.tsx`, `PricingPanel.tsx`, `SessionPanel.tsx` (route page shells, panel composition, tables, forms, modals)

No external design references, imagegen, or browser QA informed this doc. New visual decisions should land here before they land in code.

## 1. Brand and Visual Direction

### Voice

The product is a multi-agent operations console. It reads like a mission control room, not a marketing page. The reader is an operator watching live signals, not a buyer scrolling a landing page.

Two principles:

1. Information density over whitespace. Operators scan, they don't read prose. A page that breathes too much wastes their time.
2. Color carries meaning. Red means active, alert, or destructive. Gold means budget, cost, value. Cyan means data flow, tokens, throughput. Green means success or online. Everything else is muted grey.

### Aesthetic anchors

- Dark space backgrounds with a faint grid texture (`.bg-grid`)
- Vermillion red (`--accent-red`) as the primary action and brand color, drawn from Chinese imperial seal tradition
- Gilt gold (`--accent-gold`) for currency, budget, and section headings
- Glass panels with subtle inner highlight and a sharp drop shadow
- Decorative corner brackets (`.sci-border`) on important panels, suggesting framed targeting reticles

### What this UI is not

- Not a flat utility. There is depth (shadows, glows, glass blur), just not decoration for its own sake.
- Not bright. Dark mode is the default. Light mode is opt-in via the theme toggle.
- Not warm. The palette is cool, with red and gold as warm accents against cold steel-blue text.
- Not playful. No illustrations, no marketing hero, no empty encouragement copy.

## 2. Design Tokens

All tokens are CSS custom properties on `:root` in `src/index.css`. Dark mode is the default (`:root`); light mode activates under `[data-theme="light"]`. Components reference tokens via `var(--name)`. Do not introduce new colors outside this set without updating this doc.

### Color tokens (dark, default)

| Token              | Value                        | Use                                      |
| ------------------ | ---------------------------- | ---------------------------------------- |
| `--bg-primary`     | `#050508`                    | Page background, app shell               |
| `--bg-secondary`   | `#0a0a10`                    | Secondary surfaces, sidebar, modal body  |
| `--bg-card`        | `rgba(180, 200, 255, 0.025)` | Glass panel fill                         |
| `--bg-card-hover`  | `rgba(180, 200, 255, 0.04)`  | Glass panel hover                        |
| `--bg-terminal`    | `rgba(0, 0, 0, 0.45)`        | Terminal / deep inset surfaces           |
| `--border-default` | `rgba(180, 200, 255, 0.06)`  | Default 1px border                       |
| `--border-hover`   | `rgba(180, 200, 255, 0.15)`  | Hover border                             |
| `--text-primary`   | `#e6e9f0`                    | Body text, headings                      |
| `--text-secondary` | `rgba(180, 195, 230, 0.75)`  | Captions, supporting text                |
| `--text-muted`     | `rgba(140, 160, 210, 0.45)`  | Labels, de-emphasized meta               |
| `--accent-red`     | `#c23a30`                    | Primary brand, active nav, destructive   |
| `--accent-red-bright` | `#d44236`                 | Brighter red on hover / focus            |
| `--accent-gold`    | `#c9a84c`                    | Cost, budget, currency, section labels   |
| `--accent-gold-bright` | `#dbc164`                | Hover variant                            |
| `--accent-cyan`    | `#4a9eff`                    | Data flow, tokens, throughput, info      |
| `--accent-glow-red`  | `rgba(194, 58, 48, 0.15)`  | Active nav background glow               |
| `--accent-glow-gold` | `rgba(201, 168, 76, 0.1)`  | Gold-tinted surface glow                 |
| `--success`        | `#4caf7d`                    | Online, succeeded, healthy               |
| `--warning`        | `#c9a84c`                    | Approaching threshold                    |

### Color tokens (light, `[data-theme="light"]`)

Same names, different values. Light mode is a silver-white palette with the same red, gold, and cyan accents at deeper saturation.

| Token            | Light value                  |
| ---------------- | ---------------------------- |
| `--bg-primary`   | `#eceef3`                    |
| `--bg-secondary` | `#e2e5ec`                    |
| `--bg-card`      | `rgba(255, 255, 255, 0.65)`  |
| `--accent-red`   | `#b83028`                    |
| `--accent-gold`  | `#a68a38`                    |
| `--accent-cyan`  | `#2176d4`                    |
| `--success`      | `#3a9b66`                    |

Body has a `transition: background-color 0.5s ease, color 0.5s ease` so theme swaps fade rather than flash.

### Status color semantics

These are not tokens but mappings used across pages. Keep them consistent.

| Meaning            | Token              | Notes                          |
| ------------------ | ------------------ | ------------------------------ |
| Online / success   | `var(--success)`   | Agent online, healthy metric   |
| Active / running   | `var(--accent-cyan)` | Tokens, throughput, in-flight |
| Idle / queued      | `var(--text-muted)` | Waiting state                 |
| Pending / warm     | `var(--accent-gold)` | In queue, awaiting approval   |
| Alert / danger     | `var(--danger)`    | Failed, expired, broken (see §8) |
| Brand / destructive | `var(--accent-red)` | Active nav, delete buttons   |

### Typography

Two font stacks. Both are tokenized.

- `--font-sans`: `'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif`. Used for Chinese labels, headings, body copy.
- `--font-mono`: `'JetBrains Mono', 'SF Mono', monospace`. Used for IDs, timestamps, numerics, table cells, version strings, badges, section labels.

Pattern rules observed across pages:

- Page title: `text-2xl font-black tracking-wider`, color `--text-primary`. Example: `OPS 作战室`.
- Page subtitle: `text-[10px] font-mono mt-1`, color `--text-muted`. Example: `多 Agent 运行状态 · 任务流 · 模型调用 · 成本监控`.
- Section label inside a panel: `text-[10px] font-mono uppercase tracking-wider`, color `--text-muted`. Example: `任务流 · TASK FLOW`.
- Tabular data, IDs, times, costs: `text-xs font-mono`.
- Helper text under fields: `text-[10px] font-mono`, color `--text-muted`.
- Stat values inside cards: `text-lg font-bold font-mono`, color matches the semantic.

`h1` through `h6` set `word-break: keep-all` so Chinese runs don't fragment mid-character.

### Spacing and sizing

The codebase uses Tailwind utilities plus raw inline values. Common observed scales:

- Card padding: `p-3` (12px) or `p-4` (16px)
- Section gap: `mb-4` (16px), `mb-6` (24px)
- Stat grid gap: `gap-2` (8px)
- Table cell padding: `py-2 px-3`
- Modal padding: `p-6` (24px) outer, `space-y-3` between fields
- Inline icon to label: `gap-1.5` or `gap-2.5`

### Radius

- `--radius: 0.5rem` (8px). Applied by default to glass panels, terminal panels, and theme toggle.
- Specific elements use smaller radius: logo block is `rounded-sm`, progress fills are `rounded-full` for pill shape, status dots are full circle.
- Modals and primary buttons use the default radius; only deviate when the element is intentionally square.

### Shadow and elevation

Three elevation tiers, all defined inside `.glass-panel`:

1. Resting: `0 4px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(180,200,255,0.04)`
2. Hover: `0 8px 40px rgba(0,0,0,0.3), inset 0 1px 0 rgba(180,200,255,0.08), 0 0 30px rgba(194,58,48,0.03)` (red glow on hover)
3. Modal: page-specific, e.g. `boxShadow: '0 0 80px rgba(0,0,0,0.5), 0 0 20px rgba(74,158,255,0.08)'` on the NewSessionDialog

Light mode softens each tier to lighter shadows and a white inset highlight.

## 3. Layout System

### App shell (owned by `AppLayout` in `Navigation.tsx`)

- Outer wrapper: `min-h-screen` with `backgroundColor: var(--bg-primary)`.
- TopBar: fixed, full width, height `TOPBAR_HEIGHT = 48px`, z-50, dark glass with bottom border. Holds logo, version, theme toggle, user chip, settings, logout.
- Sidebar: fixed left, width `SIDEBAR_WIDTH = 220px`, z-40. Top edge aligns to `TOPBAR_HEIGHT`. Holds grouped nav (four groups: 监控 / 管理 / 系统 / 工具) plus a WebSocket status footer.
- Main content: `marginLeft: SIDEBAR_WIDTH` on desktop, `marginLeft: 0` on mobile, `paddingTop: TOPBAR_HEIGHT`, `minHeight: '100vh'`. Owns its own scroll. The route pages never reposition these values.
- Mobile (< md): sidebar slides in from left via `-translate-x-full` / `translate-x-0` over 300ms ease, with a `bg-black/60` overlay covering everything below the top bar.

### Route page shell

Every route page follows the same outer skeleton (the existing pages deviate only in width):

```
<div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
  <div className="mx-auto px-4 sm:px-6 pt-24 pb-16">
    ... page content ...
  </div>
</div>
```

Width is the one variable. Two widths are used in the existing code:

- `max-w-6xl`: dense admin tools (`GuardPanel`, `PricingPanel`). 1152px max.
- `max-w-7xl`: data-heavy dashboards (`OpsPanel`, `UsagePanel`). 1280px max.

Pick by content density, not preference. If a page mixes tables and stats, default to `max-w-7xl`. If it's mostly forms, lists, or narrow settings, default to `max-w-6xl`.

`SessionPanel` is the intentional exception: it has its own 300px left list plus flex-1 message panel. It does not use the standard route shell because the layout is two-pane conversation.

### Scroll and layout ownership

- App shell owns outer scroll. Sidebar has its own `overflow-y-auto custom-scrollbar`.
- Route pages own inner scroll inside panels (`max-h-80 overflow-y-auto custom-scrollbar` for lists, `overflow-x-auto custom-scrollbar` for wide tables).
- Never scroll the outer shell from inside a panel.

## 4. Components and Patterns

### Glass panel (`.glass-panel`)

The base surface. Use for any contained block of related content (a section, a card group, a modal body).

```
<div className="glass-panel p-4 sci-border">...</div>
```

Common variants:

- `p-3 sci-border` for stat cards
- `p-4 sci-border` for section panels
- `p-6 sci-border` for modals

### Section label (`.section-label`)

The mono uppercase tag inside panels. For inline labels (without the dedicated class), use:

```
<div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
  任务流 · TASK FLOW
</div>
```

Bilingual: Chinese first, then `·`, then UPPERCASE English. The English part uses the same mono font.

### Corner brackets (`.sci-border`)

`::before` adds a 20x20 top-left L bracket; `::after` adds a bottom-right mirror. Both are `2px solid var(--accent-red)` at 50% opacity. Apply to important panels, modal bodies, and stat cards. Skip for inline list rows.

### Stat card

Pattern used in `OpsPanel` and `UsagePanel`:

```
<div className="glass-panel p-3 sci-border flex items-center gap-2">
  <div className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0"
       style={{ background: 'rgba(255,255,255,0.03)' }}>
    <span style={{ color }}>{icon}</span>
  </div>
  <div className="min-w-0">
    <div className="text-lg font-bold font-mono" style={{ color }}>{value}</div>
    <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{label}</div>
    {sub && <div className="text-[9px] font-mono" style={{ color: 'var(--text-secondary)' }}>{sub}</div>}
  </div>
</div>
```

Icon goes left, value is the largest piece of text, label sits under the value in muted mono. Optional `sub` line in `--text-secondary`.

### Lists and rows

For list items inside a panel (tasks, model calls, sessions), the pattern is:

```
<div className="flex items-center justify-between gap-2 py-2 px-3 rounded text-xs"
     style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.03)' }}>
  <div className="flex items-center gap-3 min-w-0">...primary content...</div>
  <div className="flex items-center gap-3 flex-shrink-0">...meta + actions...</div>
</div>
```

Space-between with truncate on the left, no-wrap meta on the right. Borders are nearly invisible at 3% white.

### Tables

Used in `UsagePanel` and `PricingPanel`. Pattern:

- Outer wrap: `<div className="overflow-x-auto custom-scrollbar">`.
- `<table className="w-full text-xs font-mono">`.
- Header row: `borderBottom: '1px solid var(--border-default)'`, header cells: `text-left py-2 px-3`, color `--text-muted`, `fontWeight: 400`.
- Body rows: hover `bg-[rgba(180,200,255,0.02)]`, border-bottom `1px solid rgba(255,255,255,0.03)`.
- Each cell: `py-2 px-3`; numeric cells get a semantic color (`--accent-cyan` for tokens, `--accent-gold` for cost, `--success` for cache hits).

Column truncation is via `truncate max-w-XX` on long text fields (model names, agent names).

### Forms

Inputs are raw inline-styled elements, not Tailwind component classes:

```
<input
  className="px-3 py-2 rounded text-xs outline-none"
  style={{
    background: 'rgba(0,0,0,0.2)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-primary)',
  }}
/>
```

Labels sit above inputs as `text-[10px] font-mono` in `--text-muted`. Inputs inside modals get `w-full`; inline filters use natural width.

Primary action buttons in forms are filled with `var(--accent-cyan)` or `var(--accent-gold)` and dark text. Destructive confirm buttons are `var(--accent-red)` with white text. Cancel buttons are outline only.

### Modals

Pattern from `PricingPanel` and `SessionPanel`:

```
<div className="fixed inset-0 z-[100] flex items-center justify-center p-4"
     style={{ background: 'rgba(0,0,0,0.6)' }}>
  <div className="glass-panel p-6 sci-border w-full max-w-md">...</div>
</div>
```

Backdrop is solid black at 60%. Container is a glass panel with corner brackets and a large dark shadow plus optional cyan glow (`boxShadow: '0 0 80px rgba(0,0,0,0.5), 0 0 20px rgba(74,158,255,0.08)'`). Session dialog uses its own centered-top position with backdrop blur.

### Tabs

From `UsagePanel`:

```
<button
  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono whitespace-nowrap transition-colors"
  style={{
    background: active ? 'rgba(180,200,255,0.06)' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
    border: active ? '1px solid var(--border-hover)' : '1px solid transparent',
  }}
>
```

No underline tabs. Selected state is a subtle fill plus a 1px hover-color border. Wrap container uses `overflow-x-auto custom-scrollbar` for narrow viewports.

### Toggle switches

Used for currency and display mode in `UsagePanel`:

- Track: `w-8 h-4 rounded-full`, background swaps between `rgba(255,255,255,0.1)` (off) and `var(--accent-red)` (on).
- Knob: `w-3 h-3 rounded-full` in `--text-primary`, slides via `left: 3px` / `left: 19px` over 200ms.
- Labels on both sides in mono 10px.

### Type tags (session panel)

Color-coded pill tags (`协作`, `交接`, `会议`, `审查`, `临时`). Each tag is a `text-[10px] px-1.5 py-0.5 rounded font-mono` element with a tinted background and a matching accent color:

- collaboration: cyan tint
- handoff: gold tint
- meeting: green tint
- review: red tint
- adhoc: muted tint

Status indicators on session list items follow the same recipe with semantic colors.

### Bar and line charts

All charts are inline CSS, no chart library. Two patterns:

1. Bar chart: flex row of vertical divs, height computed inline as `(value/max) * chartHeight`, `background: linear-gradient(180deg, color, color + alpha)`, `opacity: 0.7`. Hover tooltip is an absolutely positioned div that fades in on `group-hover`.
2. Line chart: inline `<svg viewBox preserveAspectRatio="none">` with a `<polyline>` for the line and `<circle>` points.

Hover-tooltip text uses mono at 8-9px in the chart's accent color.

### Icons

Icons come from `lucide-react`. Common sizes:

- Sidebar nav: `size={15}`
- Inline label icons: `size={10}` to `size={12}`
- Card / stat icons: `size={14}` to `size={16}`
- Empty state icons: `size={32}` to `size={64}`, opacity 0.1 to 0.3

Icon color follows the surrounding semantic (status icons take the row color, neutral icons take `--text-muted`).

Two inline SVG icons are defined locally in `Navigation.tsx`: `SunIcon` and `MoonIcon` for the theme toggle, at 14x14. These are the only exceptions to the lucide-react rule, and only because lucide's sun/moon don't match the design.

## 5. Content and Voice

### Bilingual labels

Chinese leads, English follows. The pattern is `<chinese> · <UPPERCASE ENGLISH>`:

- Section labels: `任务流 · TASK FLOW`
- Page subtitles: `多 Agent 运行状态 · 任务流 · 模型调用 · 成本监控`
- Status footers: `OPS 作战室`, sidebar group headers: `监控`, `管理`, `系统`, `工具`

English parts go in the mono font at 10-12px with `uppercase` and `tracking-wider`. Chinese goes in the sans font. Never translate one without the other.

### Numeric formatting

- Tokens: short form (`1.2M`, `45.3K`, raw on toggle). Always mono.
- Cost: `$X.XX` or `Xc` under one dollar, `¥X.XX` for CNY. Exchange rate constant `7.2` lives in `UsagePanel.tsx`.
- Times: `MM-DD HH:mm` for short form, `YYYY-MM-DD HH:mm` for full form. Always mono.
- IDs: prefixed with `#` for traces, kept short via `.slice(0, 8)` for display, full value in `title` attribute.

### Empty and loading states

- Loading: `text-xs` in `--text-muted`, e.g. `加载中...`, `加载消息...`.
- Empty data: small mono line in `--text-muted` (`暂无模型数据`) plus a faded lucide icon at 32-40px, `opacity: 0.2-0.3`.
- Error states: shown via `toast.error(...)` from sonner. Inline error text follows the loading pattern.

### Buttons and CTAs

- Refresh: outline button, `text-xs px-3 py-1.5 rounded font-mono`, color `--text-muted`, border `--border-default`, leading `RefreshCw` icon.
- Primary create: filled in `--accent-red` or `--accent-cyan`, white or black text.
- Destructive row actions: ghost button with hover background `rgba(255,50,50,0.1)` and color `--accent-red-bright`. No confirmation modal for row-level delete except where data loss is permanent (PricingPanel uses `confirm()` for delete).
- Cancel: outline only, color `--text-muted`.

## 6. Motion and Interaction

The codebase uses small, targeted motion. Three flavors, all GPU-friendly.

### Transitions

- Theme swap: 500ms ease on `background-color` and `color` of body.
- Sidebar slide on mobile: 300ms ease-in-out transform.
- Glass panel hover: 400ms ease on shadow and border.
- Toggle knobs: 200ms ease on `left`.
- Progress fill width: 1s ease.
- Custom utility on interactive controls: `transition-colors`.

### Hover affordances

Hover must change something visible. Acceptable patterns:

- Glass panels: shadow deepens, border moves to `--border-hover`, faint red glow appears.
- List rows: background lightens to `rgba(180,200,255,0.02)`.
- Buttons: background tint shifts to a 5% alpha of the accent.
- Bar chart bars: tooltip appears with `opacity: 0 → 100` on `group-hover`.

Hover does not move layout. Never animate `margin`, `padding`, or `height` on hover.

### Live feedback

- WebSocket events set a small badge in the page header (OpsPanel shows live event type in cyan). New events also throttle-trigger a refetch (5s minimum between refetches).
- Connection status dot in the sidebar footer uses `box-shadow: 0 0 6px var(--success)` to give the dot a faint glow when online.
- Progress bars update with a 1s width transition rather than snapping.

### Ring animation

`.ring-container` spins at 30s linear infinite via `animation: ringSpin`. Pause on hover. Used only for the hero brand ring, not inside data panels. Never auto-spin inside admin content.

### Reduced motion

`prefers-reduced-motion` is not currently honored. Keep animations subtle (rotation, fade, slide) so they remain acceptable when reduced. Do not add motion that conveys critical state (use color and label changes, not movement, for success/failure).

## 7. Accessibility Constraints

The current UI meets basic contrast for body text but has known gaps. These constraints apply going forward.

### Color contrast

- Body text `--text-primary` (`#e6e9f0`) on `--bg-primary` (`#050508`) exceeds WCAG AA for normal text.
- `--text-secondary` on the same background is borderline. Do not use it for anything smaller than 12px or for the only way to read important information.
- `--text-muted` on dark background does not meet AA. Reserve it for labels, captions, and decorative meta. Never use it as the sole carrier of meaning.

### Keyboard and focus

- All interactive elements are real `<button>`, `<input>`, `<select>`, `<a>`. No `<div onClick>`.
- Focus rings are not custom-styled yet. Browser defaults are the current state. When adding custom focus styles, use a 2px outline in `--accent-cyan` or `--accent-red` with 2px offset.
- Tab order follows DOM order. Sidebar nav is keyboard reachable. Modal close is keyboard reachable via the X button; no Escape-to-close handler exists yet.

### Iconography and labels

- All icons are decorative; no `aria-label` is required on icon-only buttons today, but icon-only buttons should carry a `title` attribute (existing pattern in `Navigation.tsx`).
- Action buttons in rows have a `title` attribute describing the action.
- Forms have visible labels above each input. No placeholder-as-label.

### Live regions

- WebSocket-driven updates (session list refresh, message arrival) do not currently announce to assistive tech. New live regions should use `aria-live="polite"` and limit announcements to meaningful changes (new session, new message), not refetches.

### Motion safety

- No motion conveys critical state. A user with reduced-motion preferences will still see all information via color and text.
- The 30s hero ring spin is non-essential and pauses on hover.

### Known gaps

- No `prefers-reduced-motion` opt-out is wired. Future work should disable the ring spin and ease all transitions to 0ms when set.
- No skip-to-content link in the app shell.
- Form validation errors are not announced. Currently shown only via `toast.error`.
- Modal focus trapping is not implemented.

## 8. Accepted Debt

These are real issues in the existing code. Documented here so future work knows what to avoid and what to fix.

1. `var(--danger)` is used in six page files but is not defined in `src/index.css`. Affected files: `OpsPanel.tsx`, `GuardPanel.tsx`, `FusionPanel.tsx`, `GitHubPanel.tsx`, `EventStream.tsx`, `DagPanel.tsx`. In the current dark theme this resolves to an invalid value and falls back to the inherited text color, so `danger` states render in the wrong tone. New work must not introduce more `--danger` references. Fix candidate: add `--danger: #e8504a` (a brighter red than `--accent-red-bright`) to `:root` in `index.css` and migrate these references. Until that lands, treat `--danger` references as a known bug, not a feature.

2. This file (`DESIGN.md`) did not exist before this commit. The design system was implicit. Any inconsistency between what a page does and what this doc says is, until proven otherwise, an undocumented convention that needs codifying, not a doc bug.

3. `prefers-reduced-motion` is not honored. The ring spin and transitions run for everyone.

4. The body has `overflow-x: hidden` to mask horizontal overflow from misbehaving children, not because the layouts are correct. Audit scroll ownership before adding new panels that might overflow.

5. No shared form, button, or input component exists. The form-input recipe in §4 is repeated by copy in every page. Until a shared component is extracted, treat the recipe as the contract and copy it verbatim.

6. Raw inline `var(--*)` strings appear in dozens of places rather than going through utility classes. New components may use Tailwind utilities for layout (`flex`, `gap-2`, `p-3`) but should still pull colors and the radius from CSS variables, never hard-code hex values.

7. Light mode is implemented in CSS but is not exercised by the existing pages beyond the theme toggle hook. Treat light mode as a defined contract but unverified behavior; do not assume it renders correctly without checking in a browser.

8. Charts are hand-rolled CSS / inline SVG. There is no chart abstraction. If a future page needs a chart, copy the existing pattern rather than introducing a new chart library.

## Conventions for Future Work

- New route page: pick `max-w-6xl` or `max-w-7xl` based on content density (§3), use the standard shell, mark every panel with `glass-panel` and most with `sci-border`.
- New status color: add it as a token in `index.css`, map it in §2, then use it. Do not introduce semantic colors via raw hex in component code.
- New interactive element: real HTML element first (`<button>`, `<input>`), inline style for the visual layer, focus ring to follow §7.
- New modal: copy the modal pattern from §4. Use `.glass-panel` + `.sci-border` for the body. Backdrop at 60% black. z-index 100.
- When in doubt, follow the closest existing page. The system is established by example; this doc just records the example.