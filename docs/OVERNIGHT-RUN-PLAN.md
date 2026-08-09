# Overnight Agent Run — Plan (v2 kickoff: ALL of P0 + design system)

**Status:** PROPOSED v2, 2026-08-09 — revised per Thomas: the run must get
through **everything in P0** (was: design system + M0 + M1 only). Needs his
go + the scheduling call. Pattern: proven detached-host + watchdog setup from
the quiver-dock runs (2026-08-04: 55 agents / 8.5 h / zero completed work lost).

## P0 coverage map (the guarantee)

| P0 item | Covered by |
|---|---|
| 1. Auth + roles (GitHub OAuth + admin/manufacturer/operator) | Phase 2 (RLS/roles) + Phase 4 (UI). GitHub OAuth fully wired; needs Thomas's OAuth-app secret to go live (external dep, below) |
| 2. GPS/location privacy (sanitized `.bin` copies) | Phase 3 hard gate — verified on real logs |
| 3. Aircraft registry (type-aware, components/events) | Phase 2 (schema) + Phase 4 (UI) |
| 4. Flights: quick-log + bulk dump + weather auto-fill | Phase 4 (Open-Meteo is keyless — fully buildable) |
| 5. Log upload + parse pipeline | Phase 3 + Phase 4 upload UI |
| 6. Flight card (summary + health score) | Phase 3 (compute) + Phase 4 (render) |
| 7. Data import from v1 | Phase 5 — script built + dry-run tested; REAL run needs legacy creds (external dep) |

**Exit criterion for the run is P0-complete, not time-elapsed.** Generous round
caps; plateau counter only ships-with-complaints on style fidelity, never on
the P0 hard gates (schema, parser, typecheck/build) — those loop until green.

## Test fixtures (already on disk — real ground truth)

- **Real Quiver flight-test logs:** `~/projects/project-quiver/flight-test/PT1/assets/001-002/logs/*.BIN` (~8 logs)
- v1's parser fixture: `project-flight-tracking/supabase/functions/mavlink-parser/test12.bin`
- SITL log: `~/projects/quiver-dock/sim/sitl_wd/logs/00000001.BIN`
- pymavlink already installed and proven (Feb 13 flight-card work, built for
  Julius's original extract-data ask — closing the loop).

## Phases

### Phase 1 — Arrow docs design system port

Agents study the `website` repo (Docusaurus theme CSS, components, layout) and
build `src/styles/` tokens + base Vue components (navbar, sidebar, cards,
tables, buttons, forms, breadcrumbs) replicating the docs **UI/UX in general**
(Thomas, 2026-08-09) — layout, spacing, hover behavior, not just colors.
**Critics:** build the website repo locally as reference; screenshot-compare
tracker vs docs pages, numeric fidelity scores, concrete deviation lists.

### Phase 2 — M0: schema + roles + RLS (HARD GATE)

Full migration set from V2-PLAN (incl. `aircraft_operators`, `gps_private`,
`sanitized_path`, audit_log triggers), roles, seed (Thomas + Julius as
manufacturers; all four aircraft types). **Gate:** migrations apply to fresh
Postgres in Docker + RLS test matrix passes per role — manufacturer-only
aircraft creation, operator write scoping, fleet reads, GPS-privacy
visibility, no silent-failure writes. Critic approvals record actual counts.

### Phase 3 — Parser service (HARD GATE — this is P0's heart)

Python + pymavlink container (the M2 pipeline, pulled into the run):
`flight_logs` queue watcher → parse → `flight_log_summary` (duration,
distances, alt/speed, battery incl. per-cell via aircraft_type cells, modes
timeline, arm/disarm, errors, health score per the Carbon Cub thresholds) +
downsampled series + param snapshot + **sanitized `.bin` copy**.
**Gate, on the real PT1 Quiver logs:** (a) all fixtures parse; (b) summary
values sanity-checked against pymavlink-independent spot checks; (c) sanitized
copy re-parsed and asserted to contain zero GPS/POS/ORGN/home-location
messages while still parsing clean with summaries intact; (d) bulk batch of
all fixtures at once processes without loss. Loops until green.

### Phase 4 — P0 UI on the design system

Fleet list, aircraft detail (registry + component/event history), sites,
one-screen quick-log with Open-Meteo weather auto-fill, **bulk-dump intake**
(drop N `.BIN`s → N flight stubs auto-created from log timestamps), upload
status, flight card render, auth screens (email + GitHub button), role-aware
UI. **Gates/critics:** typecheck + build (hard); functional critic drives the
dev server end-to-end — upload a real PT1 log through the UI, watch it parse,
see the flight card (the M2 headline demo, automated); style critic
re-screenshots vs docs reference.

### Phase 5 — v1 import (P0 item 7, to the creds boundary)

Import script + mapping doc (v1 schema → v2), **Quiver-devkit data only**
(decided 2026-08-09), manufacturer attribution Thomas/Julius, operator
assignments. Tested by dry-run against a fixture copy of the v1 schema with
synthetic rows. The REAL import needs legacy hosted-Supabase creds — external
dependency; if Thomas drops creds before launch, the run executes it against
a fresh dump (never the live DB) and stages results for morning review.

### Phase 6 — Red team + package

Fresh red-team agent attacks the package: RLS bypass, GPS leakage into API
responses/series/exports for non-owners, role escalation, schema-vs-plan
drift, style drift. Findings → `docs/RISK-REGISTER.md`. Packager commits to
branch **`overnight/p0`** (NO push — Thomas reviews first), writes
`RUN-RESULT.md` + morning summary with screenshots.

## External dependencies (the only P0 asterisks)

1. **GitHub OAuth app** — Thomas creates it on the Arrow-air org (2-min task;
   callback URL will be in RUN-RESULT.md); until then GitHub login is wired
   but dark, email auth fully live. Not a blocker for the run.
2. ~~Legacy Supabase creds~~ **RECEIVED 2026-08-09.** Full v1 backup taken
   same day (`backups/`: public + auth/storage dumps, all 199 storage
   objects ≈ 4.6 GB). Import phase runs against the restored dump — the run
   never touches the live project. Post-migration: rotate the v1 DB password
   (it transited Discord).

## Ground-truth pack (written before launch)

`docs/RUN-CONTEXT.md`: distilled V2-PLAN (schema, roles, privacy rules,
styling directive quoted + dated), fixture paths, website-repo paths, scaffold
inventory, hard rules: never invent facts / label assumptions; no push; P0
list is the exit checklist; parser gate values must be recorded in the result.

## Mechanics (proven playbook)

- Detached host: `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 nohup caffeinate -i
  claude -p --dangerously-skip-permissions --model claude-fable-5 '<host
  prompt>'` — never in a chat session.
- Limit-aware watchdog (dock-rev2 variant): relaunch host with
  `resumeFromRunId`; exit on `RUN-RESULT.md`.
- `run-workflow.js` in this repo; journal checkpoints; HEARTBEAT.md ACTIVE
  section for overnight monitoring.

## Scheduling constraint (needs Thomas's call)

Quiver-dock rev2 still running (13:15 CDT, watchdog relaunch #28, fighting
5-h session limits). Options:
1. **Queue (recommended):** auto-launch when dock rev2 writes RUN-RESULT.md.
2. **Priority swap:** pause dock rev2 (resumes from cache), flight-tracking
   gets the night.
Run order proposal: dock rev2 → flight-tracking P0 → dispenser r13.
