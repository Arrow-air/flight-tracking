# RISK-REGISTER

Structured, append-only security findings for the Flight Tracking v2 P0 run.
Each entry: ID, date, author, severity, status, evidence (actual commands/results).

---

## Red-team pass R1 — privacy & access (2026-08-10, agent: red-team)

**Target:** running local stack (PostgREST `http://127.0.0.1:54321`, Postgres
`supabase_db_flight-tracking`), migrations `20260810210100..210600`, real
imported data (11 aircraft, 191 flights all `gps_private=true`, 192 logs, 23
parsed w/ sanitized copies, 11 sites, 11 operator assignments).

**Method:** minted HS256 JWTs with the local GoTrue secret for three principals —
`anon`, seed **operator** `33333333-…` (authenticated, assigned to **zero**
aircraft = pure non-owner/non-admin attacker), and admin `11111111-…` (to plant
bait). 25 distinct attacks across RLS bypass, embedded-resource leakage, RPC
surface, GPS/coordinate leakage, role escalation, storage, evidence integrity,
audit immutability, and the GitHub auth flag. Attacks that were DEFENDED are
listed for coverage; findings below are the ones that landed.

### Attack log (defended unless flagged)

| # | Attack | Result |
|---|--------|--------|
| A1 | anon SELECT `flights` | DEFENDED — 401, no table grant to anon |
| A2 | operator SELECT `flight_log_series` of a private flight | DEFENDED — `[]` (GPS gate) |
| A3 | pull private series via embedded resource `flights?select=…,flight_logs(flight_log_series(*))` | DEFENDED — embedded `flight_log_series: []` (RLS applies to embeds) |
| A4 | operator INSERT `aircraft` (manufacturer-only invariant 1) | DEFENDED — 403 RLS |
| A5 | role escalation: PATCH own `user_profiles.roles=['admin']` | DEFENDED — 400 `only admins can change roles` (guard trigger) |
| A6 | operator self-assign into `aircraft_operators` | DEFENDED — 403 RLS |
| A7 | operator INSERT `flights` for unassigned aircraft (invariant 2) | DEFENDED — 403 RLS |
| A8 | operator PATCH another user's flight `gps_private=false` to unlock GPS | DEFENDED (write) — 200 `[]`, 0 rows; **see F4 (silent 200)** |
| A9 | operator SELECT `audit_log` | DEFENDED — `[]` (admin-only) |
| A10 | operator INSERT forged `audit_log` row | DEFENDED — 403 RLS |
| A11 | operator DELETE `audit_log` | DEFENDED — 403 (revoked + immutability trigger) |
| A12 | RPC probe `POST /rest/v1/rpc/is_admin` (app-schema exposure) | DEFENDED — 404, `app` schema not exposed |
| A13 | forge `uploaded_by` on `flight_logs` INSERT | DEFENDED — 403 RLS |
| A14 | **site-visibility coordinate leak** — non-owner reads a `visibility='private'` site's lat/lon | **VULN → F1** |
| A15 | PostgREST schema switch `Accept-Profile: storage` to reach `storage.objects` | DEFENDED — 406, only `public, graphql_public` exposed |
| A16 | scan fleet-visible `flight_log_summary` jsonb for coordinates | DEFENDED — no lat/lon/home/origin keys |
| A17 | operator mint SIGNED URL for a raw private `.bin` (`/storage/v1/object/sign/flight-logs/…`) | DEFENDED — 404 (RLS-masked) |
| A18 | operator LIST raw `flight-logs` bucket | DEFENDED — `[]` |
| A19 | operator fetch RAW private object over HTTP | DEFENDED — 400/`NoSuchKey` (RLS-masked) |
| A20 | **arbitrary media-bucket write** — operator PUTs object at a victim's media path | **VULN → F2** |
| A21 | raw-log upload to a victim path with no matching `flight_logs` row | DEFENDED — 403 `AccessDenied` (ordering policy) |
| A22 | **forge evidence** — operator INSERTs `media` row for an aircraft they don't control | **VULN → F3** |
| A23 | operator INSERT `flight_notes` on a flight they can't write | DEFENDED — 403 RLS |
| A24 | operator PATCH `aircraft` registry they don't operate | DEFENDED (write) — 200 `[]`, 0 rows; see F4 |
| A25 | sanitized `.bin` GPS residue — parse a fleet-readable sanitized copy for coordinates | DEFENDED — see "Sanitization verified" |
| — | GitHub OAuth secret committed? / flag wiring | No secret in repo (only public client ID); flag is UI-only — see F5 |

### Sanitization verified (invariant 3, the artifact side)

Operator (non-owner) fetched the fleet-readable sanitized copy of a private
flight's log and it was checked with pymavlink:
- `GET /storage/v1/object/flight-logs-sanitized/792b1e25-…/d2073a8251a8_00000100.bin`
  → HTTP 200, 21,278,784 bytes (raw was 21,553,152 — GPS msgs removed).
- `GPS/GPS2/GPA/POS/ORGN/HOME` messages: **absent**.
- Residual position-bearing fused msgs `AHR2` (3168), `EAHR`, `CMD` are present
  but **all Lat/Lng/Lon fields zeroed** — comprehensive scan across all 437,656
  messages: `nonzero coord by type: {}`. Sanitizer strips coordinate fields, not
  just whole GPS messages. Raw fetch by same non-owner: DENIED. Invariant 3 holds
  for logs/series/summary; the leak is the **site** side channel (F1).

---

## Findings

### F1 — [BLOCKER] Private site coordinates leak to any authenticated user (GPS-privacy side channel)

- **File:** `supabase/migrations/20260810210300_rls.sql` L40-42 (`"sites fleet-visible" … using (true)`); enabled by `flights` L192-193 exposing `site_id` fleet-wide.
- **What:** the `sites` SELECT policy is `using (true)` and never consults the
  `sites.visibility` column (`site_visibility` enum, default `'private'`). Every
  authenticated user can read every site's exact `lat`/`lon`. Because `flights`
  is fleet-visible and returns `site_id`, a non-owner can take any
  `gps_private=true` flight, read its `site_id`, and resolve the takeoff/landing
  location — defeating the GPS-privacy intent via a side channel. V2-PLAN item 2
  explicitly requires "site links carry the same visibility rule"; they do not.
  The `visibility` column is dead/unenforced everywhere.
- **Evidence (live):** admin planted `INSERT sites {name:'SECRET-BASE',
  lat:31.1234, lon:-100.5678, visibility:'private'}` → operator
  `GET /rest/v1/sites?select=name,lat,lon,visibility&id=eq.<id>` returned
  `200 [{"name":"SECRET-BASE","lat":31.1234,"lon":-100.5678,"visibility":"private"}]`.
  (bait deleted after test.)
- **Fix:** gate site SELECT (or at least `lat`/`lon`) on
  `visibility='public' OR created_by=auth.uid() OR app.is_admin()`; consider a
  fleet-visible view exposing name/notes without coordinates for the "link" case.

### F2 — [MAJOR] Any authenticated user can write arbitrary objects anywhere in the `media` bucket

- **File:** `supabase/migrations/20260810210500_storage.sql` L87-89 (`"media upload" … with check (bucket_id = 'media')`).
- **What:** the media INSERT policy checks only `bucket_id='media'` — no path,
  owner, or size constraint. Any authenticated principal can PUT objects at any
  media path (e.g. under another user's UUID prefix). Media is also
  fleet-readable (L83-85), so this is unrestricted storage write + read for the
  whole tenant: storage pollution, planted files, and (with F3) fabricated
  evidence. A "system of record" with chain-of-custody goals (study §3.5) should
  not accept anonymous-within-tenant blob writes.
- **Evidence (live):** operator
  `POST /storage/v1/object/media/11111111-…/evil.txt` (victim's prefix) →
  `200 {"Key":"media/11111111-…/evil.txt", …}`. (object deleted after test.)
- **Fix:** constrain the media upload path to the uploader (e.g. first path
  segment = `auth.uid()`), or require a matching `media` row / owner-write check.

### F3 — [MAJOR] Forged evidence attachments — `media` rows can be attached to records the user cannot write

- **File:** `supabase/migrations/20260810210300_rls.sql` L374-375 (`"attach media" … with check (uploaded_by = auth.uid())`).
- **What:** the `media` INSERT policy only verifies `uploaded_by=auth.uid()`; it
  never checks that the caller may write the referenced `(owner_table, owner_id)`.
  An operator can attach media (crash photos, pilot reports, docs) to any
  aircraft / issue / airframe_event / flight they don't control. Combined with
  F2's arbitrary upload, an attacker fabricates evidence on other people's
  records — directly undermining crash-record integrity (V2-PLAN P1 issue/failure
  minimums) and provenance.
- **Evidence (live):** operator
  `POST /rest/v1/media {owner_table:'aircraft', owner_id:'<aircraft they don't
  operate>', object_path:'media/forged.txt', kind:'report'}` →
  `201 [{… uploaded_by:'33333333-…'}]`. (row deleted after test.)
- **Fix:** in the WITH CHECK, require write access to the owner record, e.g.
  branch per `owner_table` on `app.can_write_aircraft_data(owner_id)` /
  `app.can_write_flight(owner_id)` / author checks — mirror how flight-scoped
  tables already gate writes.

### F4 — [MINOR] RLS-denied UPDATE/DELETE returns HTTP 200 `[]` (invariant 4 — silent swallow) is delegated entirely to the client

- **File:** `supabase/migrations/20260810210300_rls.sql` (all UPDATE policies) — behavior, not a policy bug.
- **What:** an operator's PATCH of a flight's `gps_private` (A8) or another
  aircraft's `serial` (A24) returns `200 []` / 0 rows, no error — exactly v1
  pain point #1. RLS correctly denies the write, so this is not a privacy breach,
  but invariant 4 ("no silent RLS swallowing") then rests 100% on the API layer
  treating 0 rows as failure. Recommend a repo-wide check that every mutating
  client call uses `return=representation` and raises on empty result; add a test.
- **Evidence:** `PATCH /flights?id=eq.<not-owned> {gps_private:false}` → `200 []`;
  `PATCH /aircraft?id=eq.<not-owned> {serial:'TAMPERED'}` → `200 []` (no change).

### F5 — [INFO] GitHub OAuth flag is UI-only; symmetric JWT secret is the real trust anchor

- **What (github flag):** `githubEnabled` (`src/lib/auth.ts` L15-16) only controls
  button rendering (`Login.vue` L128). `signInWithGitHub()` remains exported and
  callable from the console when the flag is off; the *actual* gate is GoTrue's
  server-side provider config (unset locally → the call fails). Acceptable per
  RUN-CONTEXT ("assert flag/button wiring only"), noted so no one mistakes the
  flag for a security control. **No secret leak:** repo contains only the public
  client ID `Ov23liqSDMPkyBhht5hG`; `GOTRUE_EXTERNAL_GITHUB_SECRET` is a
  placeholder in `.env.example`. Good.
- **What (JWT):** this pass forged valid admin/operator JWTs from the local
  GoTrue secret — inherent to symmetric HS256 and expected locally. Prod risk
  only if `JWT_SECRET` / `SERVICE_ROLE_KEY` ever leak; keep them out of the repo
  and rotate on the self-hosted box. Not a stack bug.
</content>
</invoke>

---

## Remediation round (2026-08-10 evening, by hand — Hex + Thomas)

The P0 run pipeline had no post-red-team remediation stage, so F1–F3 were
fixed as a follow-up migration `supabase/migrations/20260810232000_redteam_fixes.sql`
and verified against the seeded local DB by reproducing each attack.

| ID | Was | Fix | Verification (seeded DB, RLS as `authenticated`) |
|----|-----|-----|--------------------------------------------------|
| **F1** BLOCKER | `sites` SELECT `using(true)` | SELECT now `visibility='public' OR created_by=auth.uid() OR is_admin()` | Non-owner (Julius) sees **0** sites and **0** private coords; owner sees **11**; **191** fleet flights resolve to **0** sites for Julius (side channel closed). Owner/admin unaffected. |
| **F2** MAJOR | `media` bucket INSERT checked bucket only | Row-first: object PUT requires a matching `public.media` row owned by the uploader (same contract as `flight-logs`) | Storage policy `media upload row-first` in place; mirrors the flight-logs bucket path already verified in the run. |
| **F3** MAJOR | `media` INSERT checked only `uploaded_by` | INSERT now also requires `app.can_attach_media(owner_table, owner_id)` — write access to the owning record | Julius attaching forged media to an aircraft he can't write → **blocked by RLS** (`new row violates row-level security policy`). |

F1 status → **CLOSED**. F2/F3 → **CLOSED**. Local-stack; not yet deployed.
