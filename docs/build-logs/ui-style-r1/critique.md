# UI style critic — round 1

Run: 2026-08-10 ~21:15 CDT, branch `overnight/p0`. First style-critic round
(no prior `ui-style-r*` existed). Environment: builder's Vite dev server on
:5199 + local supabase, both live (curl 200/200). Note: a smoke re-run
happened mid-critique (the "Smoke quick-log flight" row id changed under me),
so shot 08 was retaken against the current parsed flight
`9f99a9bf-68e9-4a87-92a8-503f9a59dd61`.

## Method

- `docs/build-logs/ui-style-r1/shoot.mjs` (playwright chromium, 1440×900,
  viewport + fullPage per route) — all 11 routes as thomas@arrowair.com
  (admin+manufacturer): /login, /, /aircraft/new, /aircraft/:id, /sites,
  /flights, /flights/new, /flights/:id, /upload, /logs, /styleguide.
  `reshoot08.mjs` retook the flight card. Shots in `shots/`.
- Compared against `docs/reference-screenshots/` (docs-home, docs-tables-test,
  docs-kitchen-sink) and `docs/build-logs/design-compare-r1/` styleguide shots.
- Computed-style probe on the fleet page (in shoot.mjs output):
  navbar `rgb(9, 67, 191)` = #0943BF, height 72.0px — matches the design
  round's documented navbar decision (component CSS #0943bf, not the
  RUN-CONTEXT #072a80 which is the mobile brand bar); body font
  "Neue Haas Grotesk", body color `rgb(75, 85, 99)` = #4b5563; h1 32px Neue
  Haas; buttons JetBrains Mono, border-radius 0px (square, correct).

## Per-page fidelity (0–100)

| # | Page | Score | Notes |
|---|------|-------|-------|
| 01 | /login | 92 | Centered admonition-style panel, mono ARROW wordmark, blue mono labels, hard-shadow primary button. On-system. |
| 02 | / fleet | 95 | Full shell: 72px navbar + pixel strip, sidebar w/ mono section labels + active state + blue footer chip, breadcrumbs, H1 double rule, card grid w/ bayer dither identical to docs-home cards, status pills. |
| 03 | /aircraft/new | 95 | Two-column form, blue mono labels w/ red required stars, square inputs, hard-shadow CREATE button, mono ghost CANCEL. |
| 04 | /aircraft/:id | 92 | H1 + badge, H2 blue w/ tinted rule, static cards, docs-style blue-header tables, bordered mono action buttons. Nit: Operators card — "Operator Test / SINCE AUG 10 2026 / REVOKE" row is cramped (label wraps against the mono date). |
| 05 | /sites | 93 | Docs table (blue #0843BF header band, Departure Mono allcaps headers, bordered cells) matches docs-tables-test; warning pill for NO COORDS; mono EDIT/DELETE row actions. |
| 06 | /flights | 94 | Same table language; status + GPS pills; primary/secondary button pair top-right. |
| 07 | /flights/new | 90 | Panel-style weather auto-fill block, mono labels, on-system selects/dates. Deviation: native OS "Choose File" control inside the dashed file well — the one unstyled control in the app. |
| 08 | /flights/:id | 94 | Header w/ GPS PRIVATE square pill, weather blockquote, stat strip (mono labels + large values), Battery/Modes/Events static cards w/ dither, collapsible HEALTH CHECKS, RAW/SANITIZED bordered mono buttons. Disabled ADD NOTE renders in the muted blue state. |
| 09 | /upload | 93 | Batch defaults row + dashed drop zone w/ mono DROP .BIN FILES HERE + bordered BROWSE. |
| 10 | /logs | 94 | Status-count pill row + REFRESHED mono timestamp, docs table, per-row status pills, error detail text. |
| 11 | /styleguide | 96 | Matches design-compare-r1 references (already gated PASS). |

Weighted overall: **93**.

## Issues (no blockers — every page is built on the design system)

1. **minor** — `src/pages/QuickLog.vue`: native browser "Choose File" widget
   is the only OS-default control visible anywhere; restyle the file input
   (hidden input + AppButton label) to match the mono/allcaps square button
   language. Same trick would suit BulkUpload's BROWSE… (that one is already
   styled; only QuickLog shows the native widget).
2. **minor** — `src/pages/AircraftDetail.vue`: Operators card row is cramped —
   operator name wraps against the SINCE date and REVOKE link (see
   shots/04-aircraft-detail.png). Give the row a proper grid/gap.
3. **minor** — `src/pages/FlightCard.vue`: header meta line mixes a text link
   ("Aircraft page →") next to a bordered EDIT FLIGHT button; docs pattern
   would make both mono bordered actions. Cosmetic.

## Verdict

```json
{"score": 93, "pass": true, "issues": [
  {"severity": "minor", "description": "Native OS file input on Quick log — only unstyled control in the app", "file": "src/pages/QuickLog.vue"},
  {"severity": "minor", "description": "Operators card row cramped (name/date/revoke collide)", "file": "src/pages/AircraftDetail.vue"},
  {"severity": "minor", "description": "Flight header mixes text link with bordered button for actions", "file": "src/pages/FlightCard.vue"}
], "evidence": "shoot.mjs: 11 routes shot at 1440x900 (shots/*.png); probe: navbar rgb(9,67,191)=#0943BF @72.0px, body #4b5563 Neue Haas Grotesk, h1 32px, buttons JetBrains Mono radius 0; tables match docs-tables-test (blue header, Departure Mono); cards match docs-home bayer dither"}
```
