# Overnight Agent Run — Plan (v2 kickoff: design system + M0 + M1)

**Status:** PROPOSED 2026-08-09 — needs Thomas's scope sign-off + a scheduling
call before launch. Pattern: the proven detached-host + watchdog setup from the
quiver-dock runs (2026-08-04: 55 agents / 8.5 h / zero completed work lost).

## Scope (what the run builds)

One night is realistically **design system + M0 + M1** — the foundation layers
where adversarial build/critic loops shine. NOT in scope: M2 parser (needs
pymavlink env + real `.bin` logs to verify against — better as its own follow-up
run), maps/plots, import.

### Phase 1 — Arrow docs design system port

- Agents study the `website` repo (Docusaurus theme: `src/css/custom.css`,
  swizzled components, layout) and build the tracker's design foundation in the
  scaffold: `src/styles/` tokens + base Vue components (top navbar, left
  sidebar, cards, tables, buttons, forms, breadcrumbs) that replicate the docs
  **UI/UX in general** (Thomas, 2026-08-09) — layout, spacing rhythm, hover
  behavior, not just colors.
- **Critics (screenshot-based):** build the real website repo locally as the
  reference; critics compare screenshots of tracker components vs docs pages
  side by side, score fidelity numerically, list concrete deviations. Loop
  until pass or plateau.

### Phase 2 — M0: schema + roles + RLS (hard gate)

- Full migration set from V2-PLAN's data model (all tables incl.
  `aircraft_operators`, `gps_private` fields, `sanitized_path`, audit_log
  triggers), roles admin/manufacturer/operator, seed data (Thomas + Julius as
  manufacturers; aircraft types Quiver/Caribou/Spearhead/Kestrel).
- **Hard gate, kicks back on failure:** migrations apply cleanly to a fresh
  Postgres (Docker, supabase-compatible image) + an **RLS test matrix** run via
  psql as each role: manufacturer-only aircraft creation, operator writes only
  to controlled aircraft, fleet-visible reads, GPS-privacy visibility rules,
  no silent-failure writes (v1 pain point #1). Every critic approval records
  the actual test counts.

### Phase 3 — M1: core CRUD UI

- Fleet list, aircraft detail (registry + component/event history shell),
  sites, one-screen quick-log flight form, bulk-dump upload UI (file intake +
  flight-stub creation; parser integration stubbed), notes/tags — all on the
  Phase 1 design system, wired to the local M0 database.
- **Critics:** (a) `npm run typecheck` + `build` must pass — hard gate;
  (b) functional critic drives the dev server against seeded data (CRUD
  round-trips, role-based UI behavior); (c) style critic re-screenshots every
  page vs the docs reference. Build/critic loop, generous cap (~8 rounds),
  plateau counter 2.

### Phase 4 — Red team + package

- Fresh red-team agent attacks the whole package: RLS bypass attempts, GPS
  leakage into API responses for non-owners, auth-role escalation, style
  drift, schema-vs-plan mismatches. Findings → `docs/RISK-REGISTER.md`, not
  under the rug.
- Packager commits everything to branch **`overnight/m0-m1`** (NO push — Thomas
  reviews in the morning, then we push), writes `RUN-RESULT.md` + a morning
  summary with screenshots.

## Ground-truth pack (written before launch)

`docs/RUN-CONTEXT.md`: distilled V2-PLAN (schema, roles, privacy rules, styling
directive quoted + dated), pointers to the `website` repo paths, scaffold
inventory, hard rules ("never invent facts; label assumptions", "no push",
"parser out of scope"). Every agent prompt requires reading it first.

## Mechanics (per the proven playbook)

- Detached host: `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 nohup caffeinate -i
  claude -p --dangerously-skip-permissions --model claude-fable-5 '<host
  prompt>'` — never in a chat session.
- Watchdog (limit-aware variant from dock rev2): relaunch with
  `resumeFromRunId` on host death, exit on `RUN-RESULT.md`.
- Workflow script: `run-workflow.js` in this repo; journal checkpoints mean a
  crash only loses in-flight agents.
- HEARTBEAT.md gets an ACTIVE section for overnight monitoring.

## Scheduling constraint (needs a call)

The quiver-dock rev2 run is **still running** as of 13:15 CDT 2026-08-09 and
has been fighting 5-hour session limits (watchdog relaunch #28). Two runs
sharing the lane would starve each other. Options:

1. **Queue (recommended):** launch tonight's run automatically once dock rev2
   writes its RUN-RESULT.md — the watchdog can wait on that marker before
   starting. If dock finishes this afternoon, flight-tracking gets the full
   night.
2. **Priority swap:** pause dock rev2 (it resumes cleanly from cache later)
   and give flight-tracking the night.

Also queued behind dock rev2 already: the dispenser r13 close-out run — that
one is short; proposed order: dock rev2 → flight-tracking overnight → r13.
