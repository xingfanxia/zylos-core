# Dashboard UI/UX Redesign — Design Plan

## Design Language: Vercel/Geist-Inspired

Adopt Vercel's Geist design system principles: dark-first, minimal, high-density data presentation, restrained color, and generous whitespace.

## 1. Typography

| Element | Current | Target |
|---------|---------|--------|
| Font family | System stack (-apple-system...) | **Geist Sans** (variable, via CDN) with Geist Mono for data |
| H1 (page title) | 1.5rem/600 | 1.25rem/500, normal case (no uppercase) |
| H2 (section titles) | 0.9rem/600 uppercase | 0.8125rem/500 normal case, letter-spacing 0 |
| Body | 0.85rem | 0.875rem/400 |
| Table data | 0.85rem | 0.8125rem Geist Mono for numbers |
| Labels/captions | 0.8rem | 0.75rem/400, muted |

Load from CDN:
```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/geist@1/dist/fonts/geist-sans/style.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/geist@1/dist/fonts/geist-mono/style.min.css">
```

## 2. Color Palette

### Backgrounds
| Token | Current | Target |
|-------|---------|--------|
| --bg-primary | #0a0a0a | `#000000` (true black, like Vercel) |
| --bg-secondary | #1a1a1a | `#0a0a0a` |
| --bg-card | #1e1e1e | `#111111` |
| --bg-hover | #252525 | `#1a1a1a` |

### Text
| Token | Current | Target |
|-------|---------|--------|
| --text-primary | #e0e0e0 | `#ededed` |
| --text-secondary | #888 | `#a1a1a1` |
| --text-muted | #555 | `#666666` |

### Borders
| Token | Current | Target |
|-------|---------|--------|
| --border | #2a2a2a | `#1f1f1f` (subtler) |
| --border-light | #333 | `#333333` |

### Accents (Vercel's restrained palette)
| Token | Current | Target | Usage |
|-------|---------|--------|-------|
| --accent | #4a9eff | `#0070f3` (Vercel blue) | Links, active states |
| --green | #4ade80 | `#00cc88` | Running, success |
| --red | #ef4444 | `#ee0000` | Errors, danger |
| --yellow | #facc15 | `#f5a623` | Warnings, suspended |
| --purple | #a78bfa | `#8a63d2` | Dedicated type badge |

## 3. Layout & Spacing

### Page structure
```
┌─────────────────────────────────────────────────────┐
│ Header: Logo/title · breadcrumb · Live indicator    │
├─────────────────────────────────────────────────────┤
│ Tab nav: Overview | Instances | Usage | Processes   │
├─────────────────────────────────────────────────────┤
│ Content area (tab-specific)                         │
└─────────────────────────────────────────────────────┘
```

- Max width: 1200px (down from 1400px — tighter, more focused)
- Page padding: 24px (48px on large screens)
- Section gap: 24px
- Card padding: 16px body, 12px header
- Border radius: 6px (down from 8px — sharper, more technical)

### Tab-based navigation (NEW)
Move from single long scroll to tabbed sections:
- **Overview** — System resources + instance status grid (combined, condensed)
- **Instances** — Instance cards with actions (expanded view)
- **Usage** — Token tracking: bar chart, calendar view, pie chart, table
- **Processes** — PM2 table

### Pending approvals
Float as a top banner (not a card section) — dismissible alert bar with count badge.

## 4. Component Redesign

### Cards
- Remove card-header background fill (flat, borderless headers)
- Headers: left-aligned label, right-aligned action/badge
- Subtle bottom border only (no full border box for some cards)
- Use `box-shadow: 0 0 0 1px var(--border)` instead of `border:` for crisper 1px borders

### Instance cards
- Compact layout: single line per instance in a table/list view (not grid cards)
- Status dot + name + type badge + status text + last activity + actions in one row
- Expandable row for details on click
- Remove colored glow on status dots (too flashy) — solid dots only

### Tables
- No hover background change (Vercel doesn't do row hover highlights on data tables)
- Header row: no uppercase, just muted color and 500 weight
- Alternating row backgrounds: none (clean, borderless rows with separator lines)
- Sticky headers for long tables

### Buttons
- Ghost buttons by default (transparent bg, subtle border)
- Primary action: filled with --accent
- Danger: text color only, no border tint until hover
- Smaller: 28px height, 0.75rem text
- No border-radius on pill buttons — use 4px radius consistently

### Badges
- Smaller, no background color — text + dot or text + count
- Monochrome with colored dot prefix

## 5. Token Usage Section Redesign

### Bar chart improvements
- Taller chart area: 200px (up from 120px)
- Thinner bars (max-width 24px) with 2px gap
- Remove per-bar value labels (cluttered) — show on hover tooltip instead
- X-axis: show every other date label to reduce clutter
- Y-axis: add subtle gridlines with token count markers
- Smooth rounded corners on stacked segments

### Calendar heatmap view (NEW)
GitHub-style contribution calendar showing daily token usage intensity:
```
         Mon  Wed  Fri
Week 1:  ░░░  ▓▓▓  ███
Week 2:  ░░░  ░░░  ▓▓▓
Week 3:  ███  ▓▓▓  ░░░
Week 4:  ▓▓▓  ███  ▓▓▓
```
- 5 intensity levels (empty, low, medium, high, extreme)
- Colors: grayscale or accent-tinted (like GitHub's green → Vercel blue gradient)
- Hover shows date + total tokens + cost
- Switchable between token count and cost mode
- Last 90 days visible (3 months of squares)

### Pie chart improvements
- Donut chart (hollow center) instead of solid pie
- Show total cost in the center
- Smaller diameter (140px)
- Legend as a clean list to the right
- Percentage bars alongside legend items (horizontal mini-bars)

### Table improvements
- Compact, monospace numbers
- Sortable columns (click header to sort)
- Sparkline mini-charts per instance (tiny inline trend line)

## 6. New Features

### Calendar view page
Full calendar with daily cost/token breakdown:
- Month grid view with day cells
- Each cell shows: total cost (large), token count (small), color intensity
- Click a day to see breakdown by instance
- Navigation: prev/next month arrows
- Summary row at bottom: month total cost + average daily cost

### Instance detail panel
Click an instance row to expand inline:
- 7-day token usage sparkline
- Last 5 messages processed
- Session uptime history
- Memory/state file paths

## 7. Implementation Plan

### Phase 1: Foundation (CSS + layout)
1. Add Geist font CDN links
2. Rewrite CSS variables (colors, spacing, typography)
3. Convert to tab-based navigation (HTML + JS routing)
4. Redesign header and page chrome

### Phase 2: Component refinement
1. Redesign instance cards as table rows
2. Redesign tables (remove hover, fix typography)
3. Redesign buttons and badges
4. Move pending approvals to top banner

### Phase 3: Token usage overhaul
1. Improve bar chart (taller, thinner bars, gridlines, tooltips)
2. Improve pie → donut chart
3. Add calendar heatmap view
4. Add sortable table columns

### Phase 4: Polish
1. Transitions and micro-animations (subtle, 150ms)
2. Responsive breakpoints audit
3. Loading skeletons instead of "Loading..." text
4. Error states with retry buttons

## 8. Reference

Vercel design principles (Geist):
- **Simplicity over decoration** — no gradients, shadows minimal, borders subtle
- **Data density** — show more information in less space
- **Monochrome first** — color only for status and action, not for decoration
- **Consistent spacing** — 4px grid (4, 8, 12, 16, 24, 32, 48)
- **Typography hierarchy** — weight and size create hierarchy, not color
