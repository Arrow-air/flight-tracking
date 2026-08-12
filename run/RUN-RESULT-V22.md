# RUN-RESULT-V22 — v2.2 feedback round 2

Per-phase results. Each phase appends its own section; the packager merges
the work-item status table into the PR body.

---

## P3 — deletion permissions (builder round 1)

### What shipped

- **Migration `supabase/migrations/20260812150000_v22_deletions.sql`**
  - Verified existing RLS first (RUN-CONTEXT said "there may be none" — there
    ARE): `flights` DELETE was already operator-or-admin
    (`app.can_write_aircraft_data`, exactly the canWrite semantics asked for)
    and `aircraft` DELETE was already admin-only. Both left untouched.
  - `flight_logs.flight_id` FK: RESTRICT → **CASCADE**. This was the real
    blocker: without it a flight delete required deleting flight_logs rows
    first, and the uploader-scoped "delete own logs" policy would block
    operators who didn't upload the log. Flight delete is now one statement;
    summaries/series/param_snapshots (cascade from flight_logs) and
    notes/tags/payloads (cascade from flights) clean up DB-side.
    `airframe_events.flight_id` stays SET NULL — aircraft history survives.
  - Storage: raw-bucket DELETE policy widened from uploader-or-admin to
    uploader-or-**flight-writer**-or-admin; sanitized bucket (which had NO
    authenticated delete policy — objects would ALWAYS orphan) got the same
    flight-writer-or-admin delete policy. Read policies untouched
    (gps-privacy INVARIANT 3 unaffected).
- **`src/lib/deletion.ts`** — `deleteFlight()` (storage objects first, then
  the row; see ordering trap below), `deleteAircraft()` +
  `countAircraftFlights()` (safe-default block). 15 unit tests in
  `src/lib/deletion.test.ts` including the storage-before-row ordering.
- **UI** — new `src/components/ui/ConfirmDialog.vue` (danger styling,
  optional type-to-confirm). FlightCard: "Delete flight" (canWrite-gated) +
  confirm dialog listing what cascades; success notice hands over to /flights
  via a one-shot `?notice=` param. AircraftDetail: admin-only "Danger zone"
  with "Delete aircraft" — blocked with a clear message while flights exist
  (live count, not the page's 50-row list); otherwise **type-the-serial**
  confirm (aircraft delete cascades operator grants, component events,
  airframe events, issues).

### Aircraft-with-flights: SAFE DEFAULT chosen = BLOCK

`flights.aircraft_id → aircraft` stays ON DELETE RESTRICT (DB blocks it even
via raw API), `deleteAircraft()` pre-checks the count, and the UI tells the
admin to delete or reassign flights first. Flight history is never cascaded
away by an aircraft delete.

### Storage-orphan approach (decision for Thomas)

Chosen approach: **client deletes storage objects BEFORE the DB rows; leftovers
orphan knowingly; a service-role sweep reconciles.**

- Ordering trap: both storage delete policies resolve permission THROUGH the
  `flight_logs` row (`object_path`/`sanitized_path` match). Once the row is
  gone (FK cascade included), no client can ever delete the object — hence
  objects first, row second (enforced + unit-tested in deletion.ts).
- Anything not removed (network error, RLS miss) is reported: console list +
  UI notice ("N object(s) could not be confirmed removed").
- **Known over-report (verified on local stack):** the Storage API's
  removed-list is RETURNING-filtered by SELECT policies, so a NON-owner
  operator deleting a `gps_private` flight's raw object succeeds but can't
  see the confirmation (raw read stays owner/admin-only). deletion.ts
  deliberately over-reports that case as "unconfirmed".
- **Admin sweep mechanism** (for Hex, post-merge, service-role): list each
  bucket and delete objects with no matching live `flight_logs` row —
  raw: `object_path`, sanitized: `sanitized_path`. One-shot SQL shape
  (service context): `select name from storage.objects o where bucket_id =
  'flight-logs' and not exists (select 1 from public.flight_logs fl where
  fl.object_path = o.name)` (mirror for sanitized), then delete via the
  Storage API (direct SQL DML on storage.objects is blocked by a guard
  trigger — discovered while testing).

### Evidence

- `npm run build`, `npm run typecheck`, `npx vitest run` (119 tests, 8 files),
  parser pytest (35) — all green.
- Migration applied to the LOCAL stack (`supabase migration up`; prod
  untouched — files only, Hex applies post-merge).
- psql RLS matrix-style spot-checks (impersonated seed users, rolled back):
  operator delete of unassigned flight denied (0 rows); operator aircraft
  delete denied; operator delete of assigned flight (log uploaded by someone
  else) succeeds and cascades logs+summary; admin delete of aircraft WITH
  flights blocked by FK restrict; admin flight-then-aircraft delete succeeds.
- Storage API end-to-end as real seed users (supabase-js against local kong):
  operator (non-uploader) removes raw + sanitized objects, deletes the
  flight, FK cascade clean, zero objects left in either bucket; operator
  aircraft delete returns 0 rows. Plus the gps_private=true/false pair
  proving the RETURNING-filter behavior above.
- ui-smoke NOT run this phase (needs dev server + parser watcher; no P3
  coverage in it anyway) — left for the packager/critic gate.

### Risks / notes for the critic

- Flight delete UI is one-click-confirm (no type-to-confirm) by design —
  RUN-CONTEXT reserves type-to-confirm for the aircraft cascade. Say the word
  if flights should get it too.
- The FK CASCADE means an authorized flights DELETE via raw API also removes
  log rows the deleter didn't upload — intended (that's what "operator can
  delete a flight" means), and summaries were already admin-write-only so no
  privilege gained.
- Orphan handling accepts eventual consistency: worst case (client crashes
  between storage remove and row delete) leaves DB rows pointing at deleted
  objects — the flight simply still exists with missing artifacts, and
  re-deleting finishes the job. No data-loss path found.
