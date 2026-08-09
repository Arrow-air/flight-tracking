# RUN-CONTEXT — Ground truth for the overnight P0 run

Every agent MUST read this file first. Rules: **never invent facts — label
assumptions as ASSUMPTION**; do not push to any git remote; do not run `git
commit` (only the final packager commits); stay inside
`/Users/hex/projects/arrow/flight-tracking` except the read-only reference
paths below; record actual numbers in every verdict.

## The product (full spec: docs/V2-PLAN.md — read it)

Flight Tracking v2 for Arrow: the system of record for open-stack aircraft.
This run builds **all of P0** (V2-PLAN "P0 — core", items 1–7) plus the Arrow
docs design system. Exit criterion is P0-complete, not time.

## Hard directives from Thomas (quoted, dated 2026-08-09)

- Styling: "I'd like the frontend to match the style of the Arrow docs
  whenever practical … Not just the colors, ideally we match the ui/ux in
  general."
- GPS privacy: "private by default … Admins can view … people will want the
  ability to download a large dataset of .bin logs too, so we should actually
  strip the data from the logs too." (Strip = remove location messages from
  the `.bin` file itself, not UI hiding.)
- Roles: "admin (… see all data), manufacturer (… the only people allowed to
  add in new aircraft), and operators (who have write access to aircraft they
  control and can upload flight/maintenance data)". GitHub auth as an option.
- Manufacturers at launch: Thomas + Julius.
- Bulk upload: "at the end of a day … dump the whole day's worth of logs in
  without having to write up info for each flight."
- Flatten legs → flights: yes. Parser: pymavlink. Import: Quiver-devkit data
  only.

## Repo + environment facts

- App repo (working dir): `/Users/hex/projects/arrow/flight-tracking` —
  Vue 3 + Vite + TS SPA scaffold (`src/`), `supabase/migrations/` (Supabase
  CLI project), branch for this run: `overnight/p0` (already checked out).
- Node 24 at `/opt/homebrew/bin/node`; `npm run typecheck` / `build` exist.
- Supabase CLI at `/opt/homebrew/bin/supabase` — use `supabase start` /
  `supabase db reset` for the local stack (Postgres + GoTrue + PostgREST).
- Docker via **colima** (no Docker Desktop): daemon already started
  (`colima start`, server 29.5.2 confirmed 2026-08-09). If it's down:
  `colima start`, never `open -ga Docker`.
- Python 3 at `/opt/homebrew/bin/python3`. Parser gets its OWN venv at
  `parser/.venv` with pymavlink pinned (do not reuse other venvs).
- **Reference (READ-ONLY):** Arrow docs site source
  `/Users/hex/projects/arrow/website` (Docusaurus; theme in
  `src/css/custom.css`, fonts in `static/fonts/`). Build it locally for
  screenshot reference. NEVER edit anything in it.
- **Reference (READ-ONLY):** v1 app `/Users/hex/projects/arrow/project-flight-tracking`
  (legacy schema for the import mapping; TS parser code as reference only).

## Test fixtures (real DataFlash logs — ground truth)

- `fixtures/nas-logs/` — 101 real Quiver flight logs from Javelina ops
  (~1.2 GB, local copy from NAS).
- `/Users/hex/projects/project-quiver/flight-test/PT1/assets/001/logs/*.BIN`
  and `.../002/logs/*.BIN` — ~8 PT1 flight-test logs.
- `/Users/hex/projects/arrow/project-flight-tracking/supabase/functions/mavlink-parser/test12.bin`
- SITL: `/Users/hex/projects/quiver-dock/sim/sitl_wd/logs/00000001.BIN`
- Per-round parser gates run on PT1 + test12 + 10 sampled NAS logs; the FULL
  101-log corpus must pass once before the parser phase exits.

## Design tokens (from website repo `src/css/custom.css`)

Docs primary `#0843BF`; primary-light `rgba(8,67,191,0.08)`; borders
`#D0D9F3` / `#b1c0ec` / `#e5e7eb`; brand dark `#060528`; navbar `#072a80`;
text `#1f2937` / `#4b5563` / `#6b7280`. Fonts: Neue Haas Grotesk (text),
JetBrains Mono / Departure Mono / IBM Plex Mono (code/accents) — woff2 files
in website repo `static/fonts/`, copy into this repo's `public/fonts/`.
Layout language: fixed top navbar (72px, `#072a80`), left sidebar nav, card
grids, bordered tables, breadcrumbs, generous whitespace rhythm.

## Schema (implement exactly; full commentary in V2-PLAN "Data model sketch")

user_profiles, aircraft_operators, sites, aircraft_types, aircraft,
components, component_events, airframe_events, issues, attachments_catalog,
flight_payloads, flights (flattened, `gps_private`), flight_tags,
flight_notes, flight_logs (`sanitized_path`, checksum UNIQUE, status),
flight_log_summary, flight_log_series, param_snapshots, media, exports,
audit_log (append-only, trigger-fed).

Roles: admin / manufacturer / operator. RLS invariants the gate must prove:
1. Only manufacturers (and admins) can INSERT aircraft.
2. Operators write flights/maintenance ONLY for aircraft they're assigned to
   via `aircraft_operators`; reads are fleet-visible for authenticated users.
3. GPS privacy: non-owner, non-admin access to a `gps_private` flight's raw
   log/series/track coordinates is DENIED; sanitized artifacts are what they
   get. Admins and the owner see raw.
4. Every failed write surfaces an error (no silent RLS swallowing — v1 pain
   point #1): the API layer must distinguish 0-rows-affected from success.
5. audit_log receives INSERT/UPDATE/DELETE entries for the core tables and
   rejects UPDATE/DELETE on itself.
Seed: Thomas (admin+manufacturer), Julius (manufacturer), one operator test
user; aircraft_types Quiver, Caribou (18S hex), Spearhead (fixed-wing),
Kestrel; 2 seed sites.

## Parser (Python + pymavlink, `parser/`)

Queue watcher on `flight_logs.status='uploaded'` (LISTEN/NOTIFY or poll) →
download from storage → emit: flight_log_summary (duration, distance, max
alt/speed, battery: voltage sag / mAh / per-cell via aircraft_type.cells,
modes timeline, arm/disarm events, errors, health score), downsampled
flight_log_series, param_snapshots, and a **sanitized `.bin` copy** with ALL
location-bearing messages removed (GPS/GPS2/POS/ORGN/HOME + position fields
in any fused messages present) written to storage + `sanitized_path`.
Health-score thresholds: port from Hex's ArduPilot flight-card work — vibe
warn >30 m/s², clip events, EKF variance warn >0.5, compass innovation,
motor-output spread imbalance, RC RSSI dropouts. Sanitized copy MUST re-parse
cleanly with pymavlink and yield the same duration/battery summary ±1%.

## UI (P0 surface, on the design system)

Fleet list; aircraft detail (registry fields + component/event history);
sites CRUD; one-screen quick-log (aircraft/pilot/site/times/notes/tags +
Open-Meteo weather auto-fill from log timestamp + site coords — keyless API);
bulk-dump intake (drop N `.BIN`s → N flight stubs from log timestamps, batch
defaults, editable later); upload status per log (uploaded/parsing/parsed/
error); flight card page; auth screens (email live; GitHub OAuth button wired
behind config flag — no secret exists yet); role-aware UI (hide aircraft-create
from non-manufacturers, etc.).

## Import (`scripts/import/`)

v1 (project-flight-tracking hosted Supabase) → v2 schema. Quiver-devkit data
only — skip everything else including the unowned "JIS M-40" aircraft.
Aircraft creation attributed to Thomas (Julius for his own devkit); operator
assignments from v1 ownership. Legacy creds are NOT available tonight:
build + test against a synthetic fixture dump (`scripts/import/fixtures/`)
shaped like the v1 schema (v1 repo has the schema). Real run is a follow-up.

## Verdict discipline

Critic/gate verdicts are JSON: `{score: 0-100, pass: bool, issues:
[{severity: 'blocker'|'major'|'minor', description, file}], evidence:
'<the actual numbers/commands run>'}`. A pass without evidence is invalid.
