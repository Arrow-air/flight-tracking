# Flight Tracking v2 — Planning Doc

**Status:** SCOPE LOCKED (2026-08-09) — both of Thomas's review rounds folded in.
All open questions (Q1–Q12) answered. Next step: sequence M0 and start dev.
**Vector input:** COMPLETE (2026-08-08) — parts 1 + 2 and the full May 15 strategy
study (Vector's critique doc) all folded in. Study source:
`flight-tracker-strategy-may2026-vector-critique.md` (kept in Hex's workspace
`downloads/`; worth committing to this repo's `docs/` if we want it versioned).

## Vision

The system of record for every Arrow flight: log a flight in seconds, drop the DataFlash
log on it, and get back an aircraft-aware picture — flight card, health, params, maps —
that engineers, pilots, and the community can actually use. v1 proved the shape
(aircraft → flight legs → logs → analysis); v2 makes it fast, complete, and ours
(Openship + self-hosted Supabase).

Two more pillars (Thomas, 2026-08-09):

1. **A crowdsourced flight-data store.** The accumulated logs are a dataset, not
   just records — the community should be able to bulk-download flight data (with
   filters: aircraft type, attachment/payload, etc.) and use it to improve
   parameters and flight mechanics (PID tuning, control improvements). This pulls
   the public data layer up from "nice-to-have" to a core product goal.
2. **Product lifecycle tracking.** Manufacturing entries, maintenance logs,
   equipment failures — the tracker should answer questions like *"how long can a
   Quiver motor run before it is at risk of failure?"* with real fleet data. This
   confirms the May study's airframe-event-history frame ("Yes" — Thomas) and adds
   a concrete acceptance question for the component/event data model: component
   hours-at-failure must be aggregatable across the fleet.

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
   habit is the concrete target: the P1 API-token upload (or a P2 Discord-bot
   ingest via Vector) would capture Caribou logs before the links rot.

### Feature asks from Arrow meetings (Vector, part 2)

All previously agreed or requested in Arrow meetings — v2 inherits these as commitments,
not new ideas:

1. **Payload/attachment config per flight + attachment database** (Zeynep, Feb 27).
   Payload mass changes how logs are interpreted; ties to the granular-spreader work.
   → P1: attachments as first-class entities, per-flight payload config feeding the
   flight card (mass-aware performance expectations).
2. **Wind-data correlation** — explicit Mar 2 decision, never built. → weather
   auto-fill is P0; wind-vs-log correlation joins the P1 analysis views.
3. **Formal issue/failure log** (Erick + Thomas, May 7): problem / status / fix /
   fixable-or-not. The Gray battery incident (precharge overheating hypothesis) has
   no home today. Crash-record minimums already agreed: photos + pilot's report +
   DataFlash log. → folded into Maintenance v2 (P1): squawks become a full
   issue/failure workflow with evidence attachments and crash records.
4. **$ARROW rewards for log uploads** (Erick, Apr 28) — never designed. Rewards
   mechanics are P2/later, but the prerequisite is P0: verifiable per-upload
   attribution (`created_by` + checksums + timestamps) from day one.
5. **Remote-ID fields** — exist in v1, empty pending Part 107. Keep in the v2 schema;
   no UI investment until there's a regulatory driver.
6. **QuiverHub boundary** — "decide what data lives where: tracker vs Alex's RPi/REST
   side" was a Feb/Mar action item, never resolved. Settled below (see "Boundary:
   tracker vs QuiverHub") so v2 doesn't inherit the ambiguity.
7. **Multi-aircraft-type support** — Caribou (hex, 18S, SORA 2.5 evidence needs),
   Spearhead (fixed-wing), Kestrel. v1 is Quiver-shaped. → P0: aircraft `type` drives
   battery config (cell count), airframe class (multi/fixed-wing), and per-type
   parser thresholds; nothing hardcoded to Quiver.

### Strategic frame (Thomas + Vector, May 15 study — full text received)

The study reframes the tracker as **Arrow's data infrastructure**, not a SaaS toy, and
it's blunt about the wedge:

> Flight logs + parts lifecycle + maintenance history + manufacturer quality feedback
> for open-stack aircraft — **not** generic log analytics (AirData owns that space;
> 400k+ pilots, 60M+ flights).

The tracker is an **airframe event history system** where a flight log is just one
event type alongside maintenance, assembly, part replacement, incidents, inspections,
field actions, and ownership transfer.

**First strategic milestone (study §1):** one real Quiver airframe born into a
manufacturing workflow, accumulating trustworthy flight + maintenance +
component-replacement history, producing an **exportable airframe history report**.
Everything downstream (AIP-009 QA, insurance/regulatory evidence, resale provenance)
hangs off that if it works. This is the strategic acceptance test for v2 — the
data-model choices below are shaped to pass it.

Key sequencing guidance we adopt:

- **Trust before crypto (§3.5):** no attestation layer in v2. The order is
  (1) append-only audit history in the DB, (2) exports with hash + signature,
  (3) external anchoring *only if someone requires it*. v2 builds (1) and the
  schema for (2).
- **Insurance/regulatory as design constraints, not deliverables (§3.6):** capture
  events cleanly, preserve audit history, don't structure data in ways that break
  chain-of-custody — but build zero insurer/regulator UI.
- **Two paths (§3.4):** Path A = AIP-009 integration (primary case); Path B =
  standalone open-stack lifecycle tool. v2's core (aircraft/component/event
  primitives) must be useful under Path B alone, so the app doesn't die if AIP-009
  slips.
- **Phasing (§3.8):** study Phase 1 "lifecycle primitives" ≈ our v2 scope. Phase 2
  (manufacturer ops: QR/serial workflow, onboarding, scorecards) and Phase 3
  (external trust surfaces) are explicitly out of v2 — the schema just mustn't
  preclude them.
- **Adoption risk #1 is data-entry burden (§10 R2):** lifecycle records only have
  value if complete. This independently confirms the quick-log/low-friction bet as
  the most strategically important UX decision in v2, not just a comfort feature.

**Caveats carried from the study:** market numbers are directional self-labeled
estimates (§3.1), and the doc predates AIP-010 and the treasury sale, so funding
context has shifted. Funding tiers / pricing (§8–9) are Arrow-governance material,
not v2 build scope — noted here only so we don't re-derive them.

### Boundary: tracker vs QuiverHub (SIGNED OFF — Thomas, 2026-08-09)

Thomas's addition: QuiverHub may end up being *one of many* tools people use to
interact with their aircraft. The tracker should make it easy for any such tool to
push logs/flight data in — which makes the API-token upload path a committed
feature (promoted to P1 below), not a nice-to-have.

- **Tracker owns:** the permanent record — airframes, components, flights, logs,
  analysis results, maintenance/incidents, evidence exports. Anything you'd need
  months later for SORA, warranty, or provenance.
- **QuiverHub (Alex's RPi/REST side) owns:** live/operational data — telemetry in
  flight, on-aircraft state, field-side capture. It is a *source*, not a store:
  anything durable it produces (logs, flight events) pushes to the tracker via the
  P2 API-token upload path.
- Rule of thumb: QuiverHub is the nervous system, tracker is the memory.

## v2 architecture (decided)

- **Frontend:** Vue 3 + Vite + TS SPA (scaffold live at flights.arrowair.com).
  **Styling (Thomas, 2026-08-09): match the Arrow docs whenever practical.** The
  docs theme lives in the `website` repo (`src/css/custom.css`) — port its tokens
  into the SPA's base stylesheet rather than eyeballing it: docs primary `#0843BF`
  (borders `#D0D9F3`/`#b1c0ec`, light bg `rgba(8,67,191,0.08)`), brand dark
  `#060528`, navbar `#072a80`, neutrals `#1f2937`/`#4b5563`/`#6b7280`; fonts Neue
  Haas Grotesk (text) + JetBrains Mono / Departure Mono (code/accents). "Whenever
  practical" = data-dense views (plots, tables, maps) get functional treatment,
  but chrome, typography, colors, and nav feel read as Arrow docs.
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

1. **Auth + roles (DECIDED — Thomas, 2026-08-09).** GoTrue email auth + **GitHub
   OAuth** (natural fit for the open-stack community; GoTrue supports it natively).
   Three roles:
   - **admin** — sees all data (e.g. flight test engineer reviewing the whole fleet).
   - **manufacturer** — the *only* role that can create new aircraft records. This
     bakes in the provenance story: an airframe is born in a manufacturing workflow,
     not self-registered. Devkit implication: Arrow creates the aircraft record at
     build/ship time and assigns the buyer as operator.
   - **operator** — write access to aircraft they control (via an
     `aircraft_operators` assignment), can upload flight/maintenance data for those
     aircraft.
   Fleet-visible reads for authenticated users stays (fixes v1's own-rows-only
   weirdness), with the GPS-privacy carve-out below.
2. **GPS/location privacy (DECIDED — Thomas, 2026-08-09).** **Private by
   default**; admins can view raw GPS (flight-test review needs it). Uploader's
   GPS stays visible to them; **everyone else — including bulk dataset
   downloads — gets the sanitized `.bin` with location messages actually stripped
   from the log**, not just hidden in the UI. Parser writes the sanitized copy
   (GPS/POS/GPA/ORGN messages removed) at parse time — stripping on the fly
   per-download is fragile; pre-generating the artifact is cheap and cacheable.
   Derived data (map tracks, home points, site links) carries the same visibility
   rule. Distance/speed/altitude summaries survive sanitization (relative values,
   no coordinates). Per-user default + per-flight override in schema.
3. **Aircraft registry.** Fleet list + aircraft detail page: serial, type, name,
   status (active/maintenance/retired), photo. Cumulative stats (total flights, hours)
   derived from flight data. Type-aware from day one (Quiver, Caribou hex/18S,
   Spearhead fixed-wing, Kestrel): type drives battery config and parser thresholds.
   Hardware as component install/remove events over time (see May study), not a flat
   table — build info (who/when/which components) is the seed of provenance.
4. **Flights (flattened — DECIDED).** Legs → flights, one level; `session_id`
   grouping if multi-leg days ever need it. Two entry modes, both first-class:
   - **Quick-log** — one-screen entry (aircraft, pilot, site, times, notes), tags,
     weather auto-fill from log timestamp + site (Open-Meteo historical — same
     trick as Hex's flight cards). Sites/locations as first-class entities.
   - **Bulk dump (NEW — Thomas, 2026-08-09)** — end of an ag-ops day, drop the whole
     day's `.bin` files at once; each becomes a flight with aircraft/pilot/site
     defaulted from the batch and times/duration/stats auto-derived by the parser.
     No per-flight write-up required; details can be added later. Detailed entry
     stays for active flight-test work on prototypes. This is the low-friction bet
     (study §10 R2) made concrete: the daily-ops path must be near-zero typing.
5. **Log upload + parse pipeline.** Drag-drop `.bin` (multi-file), checksum dedupe,
   background parse, status visible in UI. Parsed once, results stored — nothing
   re-parses on every view like an edge fn would. Produces the sanitized log copy
   (see GPS privacy) alongside summary/series/params.
6. **Flight card (auto-summary per log).** Duration, distances, max alt/speed,
   battery (voltage sag, mAh, per-cell), modes timeline, arm/disarm events, errors.
   Port the health-score approach from Hex's ArduPilot analysis work (vibe, EKF
   variance, compass σ, motor balance, RC RSSI thresholds — see `memory/2026-02-13.md`
   in Hex's workspace for the thresholds that worked).
7. **Data import from v1.** Script + mapping doc; run once at cutover.

### P1 — the reasons people will actually like it

8. **Map view.** GPS track per flight on a map (MapLibre + OSM/satellite tiles);
   altitude-colored path; home point. Fleet map of sites.
9. **Plots.** Time-series viewer for key channels (alt, speed, battery, vibe, RCOU)
   from stored parse output — pre-downsampled series in Postgres (or parquet in
   storage) so the UI never touches the raw `.bin`.
10. **Params.** Keep v1's param diff (it was the good part) — diff any two logs, diff
   against an aircraft's "blessed" param set, flag drift. Thomas: "a big one" —
   and comparison must work **across users/fleet**: diff your params against
   someone else's flight of the same aircraft type, not just your own history.
   Params carry no GPS, so cross-user comparison is privacy-clean by default.
11. **Maintenance v2 + issue/failure log.** Squawks grow into the formal
    issue/failure log agreed May 7: problem / status / fix / fixable-or-not, with
    evidence attachments. Crash records enforce the agreed minimums (photos +
    pilot's report + DataFlash log). Distinct from performed maintenance; component
    hours tracked from flight time; simple due-by reminders ("inspect after N hours").
12. **Payload/attachment config.** Attachment database (spreader, camera, etc. with
    mass + notes); per-flight payload selection; flight card and analysis become
    mass-aware.
13. **Wind correlation.** Wind (from site weather at log timestamps) overlaid on
    flight analysis — the Mar 2 commitment, finally built. Privacy-compatible by
    design: the wind lookup happens server-side at parse time using the private
    GPS; only the resulting wind values (speed/direction/gusts) are stored on the
    summary, so shared/sanitized views get wind without coordinates. Long game
    (Thomas): the drone should eventually estimate wind onboard with no external
    data — the tracker's wind-vs-log corpus is the **ground-truth dataset** for
    building that. Another reason the crowdsourced store matters.
14. **Fleet dashboard.** Home page = fleet at a glance: recent flights, hours this
    month, aircraft status, open squawks/issues. Plus **per-type aggregates**
    (Thomas): total flight hours across all Quiver drones, per-type fleet counts —
    cheap rollups over flights × aircraft_types.
15. **Airframe history report.** One-click export per aircraft: identity + component
    history + flights + maintenance + incidents + total hours, as JSON/PDF with a
    generated timestamp and content hash. This is the study's proof artifact
    ("first strategic milestone") — pulled forward from the generic P2 evidence
    exports because it's cheap once the event tables exist and it's what makes the
    strategic case testable.
16. **Public read-only pages + bulk data export (PROMOTED from P2 — Thomas:
    "pretty important").** Public fleet/flight pages, and bulk download of flight
    logs **with filters** (aircraft type, attachment/payload, date range) so the
    community can use the whole dataset to improve performance — PID changes,
    parameter tuning. Serves *sanitized* logs only (GPS stripped) unless the
    uploader opted their location public. This is the crowdsourced-data-store
    pillar shipping as a feature.
17. **API-token upload (PROMOTED from P2).** Committed per the QuiverHub sign-off
    and Julius/Caribou answer: programmatic push so logs auto-upload from the
    aircraft/ground-station side (QuiverHub or any other tool). Same pipeline,
    same attribution (token → user), same privacy rules.

### P2 — later / nice-to-have

- **Fleet reliability analytics** — the "how long can a Quiver motor run before
  it's at risk of failure?" question, answered with real data: aggregate
  component hours-at-removal/failure across the fleet (component_events × flights
  × issues), per part_no/batch. The data model supports it from M0; the analytics
  UI is P2 because it needs fleet-scale data to be meaningful. Feeds AIP-009
  manufacturer scoring later.
- Realtime "live" ops board (who's flying now) — probably premature; and live data
  is QuiverHub's side of the boundary anyway.
- ULog/PX4 support (Quiver is ArduPilot; only if needed).
- Pilot logbook export (per-pilot hours, CSV/PDF).
- Vector Discord-bot ingest riding the P1 API path — fallback for Caribou logs if
  Julius doesn't adopt the new web UI (Thomas expects he will).
- **$ARROW rewards for uploads** — mechanics TBD, but P0's attribution model
  (created_by + checksum + timestamps) is designed to support it.
- **Evidence exports beyond the airframe history report** — structured SORA/Part 108
  packets, warranty claims (AIP-009), resale provenance, *signed* (not just hashed)
  exports. Data model supports these from M0; the P1 history report is the template
  they extend.
- **AIP-009 data-interface spec** (study 90-day M6) — how manufacturers create/update
  records: required fields at manufacture, registration flow, post-sale submission.
  A doc, not code; belongs to Arrow governance timing, tracked here so it's not lost.
- Remote-ID fields: in schema, no UI until Part 107 forces it.

## Data model sketch (v2)

```
user_profiles (id, name, role: admin|manufacturer|operator, gps_default_private bool)
  -- GitHub OAuth or email via GoTrue; role decided 2026-08-09
aircraft_operators (aircraft_id, user_id, granted_by, granted_at)
  -- "operators have write access to aircraft they control" — this is the control
  -- edge; RLS write policies check it. Manufacturer assigns at ship time.
sites (id, name, lat/lon, elevation, notes, visibility: public|private)
aircraft_types (id, name, class: multirotor|fixed_wing, cells, parser_profile jsonb)
  -- Quiver, Caribou (hex/18S), Spearhead, Kestrel; drives thresholds + battery math
aircraft (id, serial UNIQUE, name, type_id, status, notes, photo, design_rev,
          built_by, built_at, remote_id fields)
  -- total hours/cycles derived from flights, not stored
components (id, kind, part_no, serial, batch_no, vendor, design_rev, mfg_date, notes)
  -- study §5 minimums; hours-while-installed derived from component_events × flights
component_events (aircraft_id, component_id, event: installed|removed, position,
                  at, by, reason, notes)
  -- study's "Assembly" entity as an event stream; position matters ("front-left
  -- motor for 37.2h"), reason captures why it came off
airframe_events (aircraft_id, kind: maintenance|incident|field_action, author, date,
                 title, body, hours_at, flight_id NULL, signoff_by NULL)
  -- unified event stream; maintenance_logs from v1 import land here. If field
  -- actions get real (AIP-009 Phase 2: issuer, due date, compliance status per
  -- affected batch) they graduate to their own table — kind enum keeps the door open
issues (aircraft_id, reporter, opened_at, severity, status, problem, fix,
        fixable: yes|no|unknown, resolved_by/at)
  -- May 7 issue/failure log; "squawk" = issue with severity=low
attachments_catalog (id, name, kind, mass_g, notes)  -- spreader, camera, ...
flight_payloads (flight_id, attachment_id, qty)
flights (id, aircraft_id, pilot_id, site_id, started_at, ended_at, title, notes,
         created_by, session_id NULL, gps_private bool)
  -- "flight" = v1 "leg" — flatten DECIDED 2026-08-09; session_id groups a bulk-dump
  -- day if ever needed. gps_private defaults from user_profiles, overridable per flight
flight_tags (flight_id, tag_id)
flight_notes (flight_id, author, type, body)
flight_logs (flight_id, object_path, sanitized_path NULL, checksum UNIQUE, size,
             uploaded_by, uploaded_at, status: uploaded|parsing|parsed|error)
  -- attribution here is the $ARROW-rewards + governance foundation;
  -- sanitized_path = GPS-stripped copy written at parse time, served to non-owners
flight_log_summary (log_id, duration, distance, max_alt, batt stats, health jsonb,
                    modes jsonb, wind jsonb)
flight_log_series (log_id, channel, t[], v[])  -- downsampled; or parquet in storage
param_snapshots (log_id, params jsonb)
media (owner_table, owner_id, object_path, kind: photo|report|doc)
  -- crash-record evidence: photos + pilot report attach to issues/airframe_events
exports (id, report_type, aircraft_id, generated_by, generated_at, content_hash,
         object_path, visibility: private|shared, included_range jsonb)
  -- study's Export entity: the airframe history report lands here, hash-stamped
audit_log (id, table_name, row_id, action, actor, at, diff jsonb)  -- append-only
  -- study §3.5 step 1: trigger-fed, no UI in v2; the trust foundation everything
  -- later (signed exports, attestation) builds on
```

## Parser service (replaces edge fn)

- **Python + pymavlink (DECIDED — Thomas leans this way, 2026-08-09; Hex agrees).**
  It's the mature DataFlash library, Hex already has working extraction + health
  scoring patterns from the Carbon Cub work, and GPS-stripping a `.bin` for the
  sanitized copy is far safer with a library that actually understands the message
  framing. v1's TS `dataflash/` code becomes reference only. If a spike turns up a
  blocker we revisit, but plan on pymavlink.
- Container on Openship, same box as Supabase.
- Contract: watches `flight_logs` rows with `status=uploaded` (pg LISTEN/NOTIFY or
  poll), pulls from storage, writes summary/series/params rows + the sanitized log
  copy, flips status. Bulk-dump batches are just N rows hitting the same queue.

## Milestones

- **M0 — Schema + auth.** Migrations for the model above, roles, RLS, seed. Fleet
  list renders.
- **M1 — Core CRUD.** Aircraft, sites, flights quick-log, notes, tags. Usable as a
  manual logbook.
- **M2 — Log pipeline.** Upload (incl. bulk dump) → parser service → flight card +
  sanitized copy. The headline feature.
- **M3 — Maps + plots + params.** Analysis UI, GPS-privacy rules enforced in every
  view, cross-user param comparison.
- **M4 — Maintenance + dashboard + airframe history report.** The report closes the
  loop on the study's first strategic milestone: a real airframe with real history
  producing an exportable record. Dashboard includes per-type aggregates.
- **M5 — Import + cutover.** Legacy import (Quiver-devkit data only — Thomas,
  2026-08-09; everything else including "JIS M-40" is skipped), redirect old app,
  archive.
- **M6 — Public data layer.** Public read-only pages, filtered bulk export,
  API-token upload. After cutover so the public dataset launches with the imported
  history in it.

The study's 90-day roadmap (§6) maps cleanly onto these: study-M1 canonical data
model = our M0, study-M2 identity workflow = our M1, study-M3 log attachment = our
M2, study-M4 events = our M4, study-M5 history report = our M4. Study-M6 (AIP-009
interface draft) is the P2 doc item. Component-hours accrual (study-M3 acceptance:
"installed components receive accumulated hours from that flight") is derived at
query time from component_events × flights — no extra pipeline work.

## Open questions (for Thomas / Vector)

1. ~~Who are the v2 users beyond Thomas + Arrow engineers?~~ **Answered (Vector):**
   community devkit pilots are real users today (Erick), plus Zeynep in a
   maintainer/reviewer role — so member auth for non-Arrow-staff is P0, and a
   reviewer-friendly view of *other people's* logs matters (fleet-visible RLS
   confirmed as the right call).
2. ~~Flatten legs → flights?~~ **Answered (Thomas, 2026-08-09): yes.** Flattened.
3. ~~Parser language?~~ **Answered (Thomas, 2026-08-09): pymavlink** ("probably
   better, not certain") — decided above; a spike can falsify it cheaply.
4. ~~Is maintenance tracking real usage or aspirational?~~ **Answered (Vector):**
   real — Erick files maintenance entries. Keep maintenance v2 at P1.
5. ~~Anything from v1 not worth importing?~~ **Answered (Thomas, 2026-08-09):**
   anything not from a Quiver devkit is skipped — which resolves "JIS M-40" too
   (not devkit-attributable, not imported; the mystery record dies with v1).
6. ~~How do we capture Julius/Caribou logs?~~ **Answered (Thomas, 2026-08-09):**
   expectation is he'll use the new web UI; the API-token path (now P1) covers
   auto-upload from the aircraft. Vector Discord-bot ingest stays as a P2 fallback.
7. ~~QuiverHub boundary~~ **SIGNED OFF (Thomas, 2026-08-09)** — tracker = memory,
   QuiverHub = one of many tools that push to it.
8. ~~Payload/attachment DB scope?~~ **Answered (Thomas, 2026-08-09): mass + name
   is probably ok.** Schema keeps a `notes` field; no structured spreader config
   in v2.
9. ~~Issue/failure log P0 or P1?~~ **Answered (Thomas, 2026-08-09): stays P1**
   (ships with Maintenance v2).
10. ~~Commit Vector's May 15 study into this repo?~~ **Answered (Thomas,
    2026-08-09): no.** Stays out of the repo; source copy lives in Hex's
    workspace `downloads/`.
11. ~~GPS privacy defaults + mechanics?~~ **Answered (Thomas, 2026-08-09):
    private by default; admins can view raw GPS.** And explicitly: bulk `.bin`
    dataset downloads must serve logs with location data *actually stripped from
    the file* — the sanitized-copy pipeline is the committed approach, not
    UI-level hiding. Folded into P0 item 2.
12. ~~Who holds `manufacturer` at launch?~~ **Answered (Thomas, 2026-08-09):
    Thomas + Julius.** Thomas manufactured every devkit except the one Julius
    has (Julius built his own). M5 import: aircraft creation attributed to
    Thomas (or Julius for his Caribou/devkit), operators assigned per current
    ownership (Erick et al.).

**All questions answered — scope is locked.**
