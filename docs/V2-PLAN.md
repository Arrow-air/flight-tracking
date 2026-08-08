# Flight Tracking v2 — Planning Doc

**Status:** DRAFT — feature planning, pre-dev. Started 2026-08-08 (Thomas + Hex).
**Pending input:** Vector part 2 of 2 (part 1 folded in below, 2026-08-08).

## Vision

The system of record for every Arrow flight: log a flight in seconds, drop the DataFlash
log on it, and get back an aircraft-aware picture — flight card, health, params, maps —
that engineers, pilots, and the community can actually use. v1 proved the shape
(aircraft → flight legs → logs → analysis); v2 makes it fast, complete, and ours
(Openship + self-hosted Supabase).

## What v1 has (feature inventory)

From `project-flight-tracking` (legacy repo, stays as reference + data source):

- **Auth:** Supabase GoTrue — signup/login/forgot/reset, user profiles.
- **Aircraft:** CRUD, cards, serial numbers, type, owner; `aircraft_hardware` table.
- **Maintenance logs:** typed log entries (date/title/notes) per aircraft.
- **Flight legs:** pilot + aircraft + location/altitude/temp/title/description; tags.
- **Flight notes:** typed notes per leg.
- **Flight logs:** DataFlash upload to storage bucket (`flight_leg_logs`: filename,
  size, checksum, path), listed per leg.
- **Log analysis (Deno edge fn `mavlink-parser`):** params diff between logs,
  flight-time analysis. That's it — no plots, no health, no GPS/map.

### v1 pain points (why rebuild)

- Clunky UX overall (Thomas). Multi-modal CRUD flows; entering a flight takes too long.
- Analysis is thin: two endpoints, no visual output, no flight summary.
- Edge-function parser is a dead end — Deno CPU/memory limits on big `.bin` logs;
  self-hosted Supabase app doesn't even ship edge functions.
- RLS policies are own-rows-only in places (e.g. flight notes SELECT) — wrong model for
  a team/fleet tool where everyone should see the fleet's flights.
- Hosted on Vercel + hosted Supabase — moving to Arrow infra regardless.

### Who actually uses v1 (Vector, 2026-08-08)

Small but real user base:

- **Erick** — heaviest user; devkit pilot. Registers aircraft, uploads logs, files
  maintenance entries (e.g. Jul 23 motor-arm adjustment).
- **Thomas** — Texas ops / Javelina flights.
- **Zeynep** — closest thing to a maintainer; built the flight-report-generator
  integration with Vector (March), reviews everyone's DataFlash logs.
- **Julius** — notable NON-user. Caribou logs get shared as raw `.bin` over Discord
  CDN links, which expire/rot (Vector has had to re-fetch via message-history tricks).
- **Gray / Kellan** — fly in Texas; Kellan held platform credentials early on.

Thomas's verdict on the call: "if we keep using this app (we should), it needs some
updates."

### Community-reported pain points (Vector, part 1)

1. **Intermittent add-aircraft failure** (Jul 15) — Erick logged in fine, save
   silently did nothing, then worked days later during a call. Suspected permissions;
   never root-caused. → v2: no silent failures — every write surfaces success/error,
   and RLS denials must be visible, not swallowed.
2. **The "JIS M-40" mystery** — an aircraft in the shared DB nobody on the team
   added, with a scary log entry ("props visibly seen slowing... stopping mid-air at
   70m"). Still unowned. A data-governance hole: no ownership/attribution model on
   records. → v2: every record carries `created_by` + timestamps; audit-friendly.
3. **Upload fragility** — the March report-integration work needed fixes (macbinary
   handling) just to get logs in. → v2 pipeline must be robust to real-world file
   weirdness.
4. **Adoption gap** — "register aircraft before flying" sat on action registers for
   weeks; real flight data lives scattered across Discord threads, the GitHub wiki,
   and the tracker. → v2's job is to be lower-friction than a Discord post
   (quick-log, drag-drop upload), or the scatter continues. Julius's Discord-CDN
   habit is the concrete target: P2's API-token upload (or a Discord-bot ingest via
   Vector) would capture Caribou logs before the links rot.

## v2 architecture (decided)

- **Frontend:** Vue 3 + Vite + TS SPA (scaffold live at flights.arrowair.com).
- **Backend:** self-hosted Supabase at supabase.arrowair.com (Postgres 17, GoTrue,
  PostgREST, Realtime, Storage).
- **Parser:** standalone container service on Openship (Arrow Prod box, lots of
  headroom) — replaces the Deno edge fn. Async job model: upload → queue → parse →
  write results back to Postgres → Realtime notifies the UI.
- **CD:** push to `main` → Openship auto-deploy.
- **Legacy data:** old hosted Supabase stays system-of-record until new schema is
  stable; one-time import at the end. (Backup of old DB still TODO — needs creds.)

## Proposed feature set

### P0 — core (can't ship without)

1. **Auth + roles.** GoTrue email auth; roles `admin` / `member` (maybe `viewer`).
   Fleet-visible RLS: any authenticated member sees all aircraft/flights; writes
   restricted to author/admin. Fixes v1's own-rows-only weirdness.
2. **Aircraft registry.** Fleet list + aircraft detail page: serial, type, name,
   status (active/maintenance/retired), photo. Cumulative stats (total flights, hours)
   derived from flight data. Hardware/config: revisions over time (what motor/ESC/FC
   was on it when), not just a flat table.
3. **Flights & legs.** Keep the flight-leg model but make entry *fast*: one-screen
   quick-log (aircraft, pilot, site, times, notes), tags, weather auto-fill from
   log timestamp + site (Open-Meteo historical — same trick as Hex's flight cards).
   Sites/locations as first-class entities (ranch, test field...) instead of free text.
4. **Log upload + parse pipeline.** Drag-drop `.bin` (multi-file), checksum dedupe,
   background parse, status visible in UI. Parsed once, results stored — nothing
   re-parses on every view like an edge fn would.
5. **Flight card (auto-summary per log).** Duration, distances, max alt/speed,
   battery (voltage sag, mAh, per-cell), modes timeline, arm/disarm events, errors.
   Port the health-score approach from Hex's ArduPilot analysis work (vibe, EKF
   variance, compass σ, motor balance, RC RSSI thresholds — see `memory/2026-02-13.md`
   in Hex's workspace for the thresholds that worked).
6. **Data import from v1.** Script + mapping doc; run once at cutover.

### P1 — the reasons people will actually like it

7. **Map view.** GPS track per flight on a map (MapLibre + OSM/satellite tiles);
   altitude-colored path; home point. Fleet map of sites.
8. **Plots.** Time-series viewer for key channels (alt, speed, battery, vibe, RCOU)
   from stored parse output — pre-downsampled series in Postgres (or parquet in
   storage) so the UI never touches the raw `.bin`.
9. **Params.** Keep v1's param diff (it was the good part) — diff any two logs, diff
   against an aircraft's "blessed" param set, flag drift.
10. **Maintenance v2.** Squawks (issue → resolved workflow) distinct from performed
    maintenance; component hours tracked from flight time; simple due-by reminders
    (e.g. "inspect after N hours").
11. **Fleet dashboard.** Home page = fleet at a glance: recent flights, hours this
    month, aircraft status, open squawks.

### P2 — later / nice-to-have

- Public read-only pages (share a flight / fleet stats with community) — Vector's
  input will tell us if this matters.
- Realtime "live" ops board (who's flying now) — probably premature.
- ULog/PX4 support (Quiver is ArduPilot; only if needed).
- Pilot logbook export (per-pilot hours, CSV/PDF).
- API tokens for programmatic upload (auto-upload from ground station / Hex).

## Data model sketch (v2)

```
user_profiles (id, name, role)
sites (id, name, lat/lon, elevation, notes)
aircraft (id, serial UNIQUE, name, type, status, notes, photo)
aircraft_config_revisions (aircraft_id, effective_from, hardware jsonb, notes)
maintenance_logs (aircraft_id, author, type, date, title, notes, hours_at)
squawks (aircraft_id, reporter, opened_at, severity, status, resolved_by/at)
flights (id, aircraft_id, pilot_id, site_id, started_at, ended_at, title, notes)
  -- "flight" = v1 "leg"; drop the extra nesting unless multi-leg sessions prove needed
flight_tags (flight_id, tag_id)
flight_notes (flight_id, author, type, body)
flight_logs (flight_id, object_path, checksum UNIQUE, size, status: uploaded|parsing|parsed|error)
flight_log_summary (log_id, duration, distance, max_alt, batt stats, health jsonb, modes jsonb)
flight_log_series (log_id, channel, t[], v[])  -- downsampled; or parquet in storage
param_snapshots (log_id, params jsonb)
```

Open modeling question: keep flight→legs two-level (v1) or flatten to flights with a
`session_id` grouping? Leaning flatten — v1's nesting is part of the clunk.

## Parser service (replaces edge fn)

- Container on Openship, same box as Supabase. Node or Python (pymavlink is the
  mature option; Hex already has working DataFlash extraction + health scoring code
  patterns from the Carbon Cub work).
- Contract: watches `flight_logs` rows with `status=uploaded` (pg LISTEN/NOTIFY or
  poll), pulls from storage, writes summary/series/params rows, flips status.
- Reuse v1's TS `dataflash/` extraction code if it's solid, else pymavlink.

## Milestones

- **M0 — Schema + auth.** Migrations for the model above, roles, RLS, seed. Fleet
  list renders.
- **M1 — Core CRUD.** Aircraft, sites, flights quick-log, notes, tags. Usable as a
  manual logbook.
- **M2 — Log pipeline.** Upload → parser service → flight card. The headline feature.
- **M3 — Maps + plots + params.** Analysis UI.
- **M4 — Maintenance + dashboard.**
- **M5 — Import + cutover.** Legacy import, redirect old app, archive.

## Open questions (for Thomas / Vector)

1. ~~Who are the v2 users beyond Thomas + Arrow engineers?~~ **Answered (Vector):**
   community devkit pilots are real users today (Erick), plus Zeynep in a
   maintainer/reviewer role — so member auth for non-Arrow-staff is P0, and a
   reviewer-friendly view of *other people's* logs matters (fleet-visible RLS
   confirmed as the right call).
2. Flatten legs → flights? (Hex says yes.)
3. Parser language: reuse v1 TS dataflash code vs pymavlink port. Need a look at how
   complete `dataflash/` actually is.
4. ~~Is maintenance tracking real usage or aspirational?~~ **Answered (Vector):**
   real — Erick files maintenance entries. Keep maintenance v2 at P1.
5. Anything from v1 data worth NOT importing (test junk)? The unowned "JIS M-40"
   aircraft + its log entry need an ownership decision at import time.
6. How do we capture Julius/Caribou logs? He won't use the web UI — Discord-CDN
   links rot. Options: Vector-driven bot ingest, API-token upload. (Awaiting
   Vector part 2 before deciding.)
