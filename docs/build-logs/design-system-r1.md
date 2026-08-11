# Design system — round 1 build log

Run: 2026-08-10 ~19:31–19:45 CDT, branch `overnight/p0`. First round of this
launch: `docs/build-logs/` contained only `preflight.md` and `src/` had no
styles/ui components — built from scratch (nothing to repair).

## Source material studied (read-only)

- `website/src/css/custom.css` (4251 lines): docs tokens (`:root` at ~719),
  sidebar (~762–1400), typography/headings (~1575–1860), code (~2022),
  tables (~2111), admonitions (~2195), breadcrumbs (~3290), cards (~3917),
  pills (~4214), dark-mode block (~3375).
- `website/src/theme/Navbar/DocsNavbar.module.css`: the actual 72px navbar
  is `#0943bf` (NOT `#072a80` — that's the mobile slide-in brand bar;
  RUN-CONTEXT says navbar `#072a80`, the component CSS + screenshot say
  `#0943bf`; went with the component CSS, `#072a80` kept as
  `--navbar-deep`).
- `docs/reference-screenshots/*.png` from preflight, plus live comparison
  screenshots of the built docs site (served `website/build` on :3999).

## What was built

### `public/fonts/` (10 woff2, copied from website/static/fonts)
DepartureMono-Regular; JetBrainsMono Regular/Italic/Medium/SemiBold/Bold;
NHaasGroteskTXPro 55Rg/56It/65Md/75Bd.

### `src/styles/`
- `tokens.css` — @font-face for the three families + all docs tokens as CSS
  vars: primary `#0843BF` scale, neutrals, card colors (`#b1c0ec` border,
  `#f1f3f8` bg, hover `#ECF0FA`/`#6D8ED9`), navbar, status colors (from
  admonitions + pills), font stacks, hard-shadow tokens, focus ring, and
  the pixel-slash strips as inlined data URIs.
- `base.css` — element defaults ported from `.theme-doc-markdown`: full
  H1–H6 hierarchy (H1 double-rule, H2 blue w/ tinted rule, H4–H6 mono
  allcaps), links w/ faint→solid underline, code/pre/kbd/blockquote/hr,
  `.page-header`, `.mono-label`, `.card-grid --cols-2/3/4`, `.app-shell`
  layout (navbar + sidebar + content, 1600px page / 860px content widths),
  `.panel` (admonition frame w/ titlebar + "– ×" controls), `.thin-scroll`.
  NOTE: body rule is `html body` to outrank the scaffold `Home.vue`'s
  unscoped `body { background:#0d1117 }` (that placeholder is off-limits
  this round; UI phase should delete its global style block).
- `index.css` — entrypoint importing both. Loaded globally via one import
  line in `src/router.ts` (the route file I had to touch anyway; move to
  `main.ts` if anyone prefers).

### `src/components/ui/` (8 components + 1 asset)
- `AppNavbar.vue` — 72px `#0943bf` sticky bar, pixel-slash bottom strip,
  inlined white Arrow wordmark SVG + mono divider label, `#actions` slot
  with `.navbar-action` bordered-button styling (hover/focus/active).
- `AppSidebar.vue` — sticky bordered column: mono allcaps top-level labels
  w/ 6-dot grid icon, nested links w/ page icon, blue active state + right
  accent border, hover bg + border, scroll fade, blue footer chip, pixel
  strip. Active state auto-derived from route or `active` flag.
- `AppCard.vue` + `card-bayer-gradient.svg` (copied next to it, bundled by
  Vite) — faithful port incl. bayer dither `::before` (rest:
  saturate(0)/0.15, hover: full blue), hover lift −4px + shadow + border
  shift, arrow pulse keyframe. Dark title for static cards, blue for link
  cards (verified against docs). `title`/`meta` slots.
- `AppTable.vue` — docs table style (blue `#0843BF` header, Departure Mono
  allcaps, `#0636A0` rules, bordered cells). Data-driven (`columns`/`rows`
  + `cell-<key>` scoped slots + `@row-click` w/ hover tint) or free-form
  default slot; empty-state row.
- `AppButton.vue` — primary/secondary/ghost/danger, sm/md, mono allcaps,
  square corners, hard offset shadow that presses in on `:active`
  (translate(2px,2px)); renders button/router-link/a; disabled + focus ring.
- `AppInput.vue` — `as` = input/textarea/select/checkbox; mono allcaps blue
  labels (docs H5), square bordered controls, hover border, blue focus
  ring, error + hint states, `mono` value option, custom angular select
  caret, accent-color checkbox.
- `AppBreadcrumbs.vue` — Departure Mono allcaps trail, muted links, active
  chip on `#eef0f3`.
- `AppBadge.vue` — docs pills (success/danger/warning/info/neutral/primary)
  plus `square` mono variant and `status` shorthand mapping flight-log
  pipeline states (uploaded→info, parsing→warning, parsed→success,
  error→danger); optional dot.

### `/styleguide` route
`src/pages/Styleguide.vue` + lazy route in `src/router.ts`. Full app shell
(navbar w/ actions, 3-section sidebar) with realistic compositions: fleet
card grid w/ status badges, static cards, clickable flights table + empty
state, button rows, quick-log form in a titled panel (selects, error field,
GPS-private checkbox), badge sets, breadcrumbs, typography specimen, panel.

## Evidence

- `npm run typecheck` exit 0; `npm run build` ✓ (105 modules; styleguide
  chunk 21.7 kB JS / 16.5 kB CSS; fonts + bayer svg emitted to dist).
- Playwright (chromium, 1440×900) against `vite preview`:
  - shell/cards/table/forms/badges/typography all render in the docs
    style; fonts visibly loaded (Neue Haas headings, Departure Mono
    labels, JetBrains mono cells).
  - card hover: lift + blue dither — compared side-by-side with the real
    docs `cards-test` page ("Governance" card hover behaves identically).
  - row-click emits (`FLT-0193` echoed), row hover tint works, focus ring
    on inputs works.
- Gotcha found: scaffold `src/lib/supabase.ts` throws at import without
  `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY` → blank page. For
  screenshots I built with dummy env vars. UI phase must handle this
  (don't throw at module scope, or provide `.env.local`).

## What remains / notes for later rounds

- Home.vue placeholder still has its dark unscoped body style — remove it
  when the real UI lands (my `html body` override wins meanwhile).
- Dark mode tokens exist in the docs; not ported (out of P0 scope).
- Mobile: sidebar simply hides <996px; a slide-in drawer (docs
  navbar-sidebar) is not built.
- IBM Plex Mono (docs sidebar label font) is not bundled — stack falls back
  to Departure Mono/JetBrains; looks correct in screenshots. ASSUMPTION:
  acceptable vs. adding a Google Fonts dependency.
- No AppTabs (docs subnav tab bar) — port from `DocsNavbar.module.css`
  `.subNav*` if a page needs tabs.
- Styleguide sidebar/nav links point at `/styleguide` anchors; wire real
  routes when pages exist.
