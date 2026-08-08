# Flight Tracking v2 — Planning Doc

**Status:** DRAFT — feature planning, pre-dev. Started 2026-08-08 (Thomas + Hex).
**Pending input:** Vector (community/ops perspective) — pinged 2026-08-08, fold in on reply.

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
- _Placeholder: Vector's community-reported pain points._

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

1. Who are the v2 users beyond Thomas + Arrow engineers? Community pilots with
   devkits? Changes auth/visibility design (P2 public pages).
2. Flatten legs → flights? (Hex says yes.)
3. Parser language: reuse v1 TS dataflash code vs pymavlink port. Need a look at how
   complete `dataflash/` actually is.
4. Is maintenance tracking real usage or aspirational in v1? (Vector may know.)
5. Anything from v1 data worth NOT importing (test junk)?
