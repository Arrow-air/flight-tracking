<!-- ===================================================================== -->
<!-- HOST PROCESS RECORD (written by the headless host after workflow exit) -->
<!-- ===================================================================== -->

# Host record — workflow `wf_034e42ae-bd3` (task `wa45eqzso`)

Completed 2026-08-10. Duration ~2h41m (9,658,576 ms). Agents: 28 spawned,
27 done, 1 errored (`redteam:drift` — API connection lost mid-response; the
red-team drift check did not return, but the primary red-team attack agent did).
Subagent tokens: 1,766,784. Tool uses: 917.

**Workflow return value (verbatim):**

```json
{
  "design":  { "exit": "pass", "rounds": 1 },
  "schema":  { "exit": "pass", "rounds": 1 },
  "parser":  { "exit": "pass", "rounds": 2 },
  "ui":      { "exit": "pass", "rounds": 1 },
  "import":  { "exit": "pass", "rounds": 1 },
  "redTeam": [ { "pass": false, "score": 62, "issues": 4 } ],
  "packaged": true
}
```

**Phase-by-phase, as returned by the gates:**

| Phase | Rounds | Gate exit | Notes |
|---|---|---|---|
| Preflight | 1 | pass | 8/8 environment + reference-build checks green |
| Design System | 1 | pass | docs design-system port, screenshot critics passed |
| Schema + RLS | 1 | pass | M0 migrations + RLS matrix hard gate passed |
| Parser | 2 | pass | round 1 failed on battery-plausibility (score 76); round 2 windowed battery stats and passed; 30/30 gate + full 101-log corpus, 0 sanitization leaks |
| UI | 1 | pass | P0 screens; build + functional + style gates passed |
| Import | 1 | pass | v1 import dry-run gate passed |
| Red Team | 1 | **FAIL (score 62)** | 25 attacks; 3 findings still OPEN — see below |
| Package | — | done | `packaged: true`; 6 commits on `overnight/p0`, **not pushed** |

**Headline caveat — the red-team gate did not pass and its findings are
unremediated.** The workflow packaged anyway (packaging is unconditional). Three
security findings landed against the live stack and remain OPEN in the branch:

- **[BLOCKER] Private site coordinates leak to any authenticated user** —
  `sites` SELECT policy is `using(true)`, never checks `visibility`. Because
  flights are fleet-visible with `site_id`, a non-owner can resolve the takeoff
  location of a `gps_private` flight — a GPS-privacy side channel.
  (`supabase/migrations/20260810210300_rls.sql`)
- **[MAJOR] Arbitrary writes to the `media` bucket** — INSERT storage policy
  checks only `bucket_id='media'`, no path/owner constraint. An operator can PUT
  objects into any victim's path. (`supabase/migrations/20260810210500_storage.sql`)
- **[MAJOR] Forged evidence attachments** — `media` INSERT checks only
  `uploaded_by=self`, not write access to the referenced owner row; an operator
  can fabricate crash photos / reports on aircraft they don't control.
  (`supabase/migrations/20260810210300_rls.sql`)
- [minor] RLS-denied UPDATE/DELETE returns HTTP 200 `[]` rather than an error
  (v1 pain point #1); enforcement rests on the client treating 0 rows as failure.

The `redteam:drift` agent errored (connection lost) and did not return a verdict,
so drift was not independently scored this run. Full attack evidence is in the
workflow journal (agent `a4765552834712324`).

---

<!-- Everything below is the packager agent's own RUN-RESULT (committed on the branch). -->

# RUN-RESULT — Overnight P0 build, branch `overnight/p0`

Run window: 2026-08-09 (planning commits) → 2026-08-10/11 overnight (build).
Packaged: 2026-08-10 late evening. **Nothing pushed** — all work is local
commits on `overnight/p0`. Facts below are copied from the phase build logs in
`docs/build-logs/` (every number was measured, not estimated); anything
uncertain is labeled ASSUMPTION there.

---

## Per-phase outcomes

| Phase | Rounds | Final score (gate marker) | Verdict |
|---|---|---|---|
| Preflight | 1 | 8/8 checks PASS | PASS (`docs/build-logs/preflight.md`) |
| Design system | 1 | 175 (`design.PASSED`) | PASS round 1 |
| Schema + RLS | 1 | 97 (`schema.PASSED`) | PASS round 1 |
| Parser | 2 | 93 (`parser.PASSED`) | PASS round 2 |
| UI | 1 | 188 total; style critic 93 | PASS round 1 |
| Import | 1 | 92 (`import.PASSED`) | PASS round 1 |
| Red team | 1 pass | 25 attacks, 5 findings | Register written — **3 findings still OPEN, see below** |

### Gate evidence (the actual numbers)

- **Design** (`design-system-r1.md`): full docs design system — 10 woff2 fonts,
  `src/styles/tokens|base|index.css`, 8 `src/components/ui/` components,
  `/styleguide` route. typecheck + build clean (105 modules). Side-by-side
  hover-state parity with the real docs cards verified in
  `docs/build-logs/design-compare-r1/`.
- **Schema** (`schema-r1.md`): 7 migrations, 22 tables, `app.*` helper schema,
  audit triggers on 18 tables, 3 storage buckets. Smoke test
  `supabase/tests/schema_smoke.sql`: **21/21 PASS, 0 FAIL** on a fresh
  `supabase db reset` — covers all 5 RUN-CONTEXT RLS invariants (manufacturer-only
  aircraft INSERT, operator scoping, gps_private series denial 0-rows for
  non-owner, errors-not-silence on writes, audit_log append-only even as
  postgres).
- **Parser** (`parser-r1.md`, `parser-r2.md`): round-1 gate 30/30 logs
  (18 PT1 + test12 + SITL + 10 NAS) with sanitize verify on every log; round 2
  fixed the battery post-landing power-off transient (3 fixtures: per-cell
  1.95/1.61/1.89 V → 3.75/3.85/3.75 V windowed to armed span) → gate re-run
  **30/30**. **Full NAS corpus: 101/101, n_fail 0** (1923.3 s;
  `parser/tests/results/corpus-r1.json`, verdict marker committed at
  `parser/tests/results/gate-r2-verdict.json`). Live-stack integration: real
  PT1 upload → parsed, cells=14 from aircraft_type join, sanitized copy
  59,301 msgs / 0 location msgs.
- **UI** (`ui-r1.md`, `ui-style-r1/critique.md`): functional smoke
  (`run/ui-smoke.mjs`) **16/16 steps green** incl. real .BIN upload → parse →
  flight card (duration 02:52, health 65), Open-Meteo auto-fill from a real
  log timestamp (2025-03-05, 24.8 °C / RH 18%), bulk 3 NAS logs → 3 stubs,
  operator RLS denial with visible error, non-owner sees sanitized-only
  download. Style critic: **93/100 weighted over 11 routes**, zero blockers,
  3 cosmetic minors (native file input on QuickLog, cramped Operators row,
  mixed link/button in flight header). Computed-style probe: navbar #0943BF
  @72 px, Neue Haas body, JetBrains Mono buttons, radius 0.
- **Import** (`import-r1.md`, `import-critic-r1.md`): from the REAL v1 backup
  (13 aircraft / 193 legs / 199 storage objects verified in `v1source`):
  kept **11 aircraft, 191 flights, 192 flight_logs, 94 notes, 16 maintenance
  events, 9 sites, 11 operator assignments**; JIS M-40 and Stork VTOL skipped
  with explicit skip-report entries (`scripts/import/out/skip-report.md`).
  Storage staging 192/192 with sha256 verified vs v1 checksums; critic's
  **independent** spot-check 12/12 (+3 source re-hashes). Idempotency: run 2
  and 3 inserted all zeros, still exactly 192 objects, 0 dupes.

---

## Red-team summary (`docs/RISK-REGISTER.md`) — READ BEFORE ANY DEPLOY

25 attacks (forged JWTs for anon/operator/admin) across RLS, embeds, RPC,
storage, audit, roles. 20 defended, including: series/embed GPS gates, raw-log
signed-URL denial, role self-promotion block, audit immutability, app-schema
non-exposure, sanitized artifact verified coordinate-free across 437,656
messages. Findings:

| ID | Sev | Status | What |
|---|---|---|---|
| F1 | **BLOCKER** | **OPEN** | Private **site coordinates leak** to any authenticated user (`sites` SELECT `using (true)` ignores `visibility`); a `gps_private` flight's takeoff location resolves via its `site_id`. Fix in `20260810210300_rls.sql`. |
| F2 | MAJOR | **OPEN** | Any authenticated user can PUT arbitrary objects anywhere in the `media` bucket (policy checks bucket only). Fix in `20260810210500_storage.sql`. |
| F3 | MAJOR | **OPEN** | `media` rows attachable to records the user can't write (forged evidence). Fix in `20260810210300_rls.sql`. |
| F4 | minor | Mitigated client-side | RLS-denied UPDATE returns `200 []` — invariant 4 rests on `src/lib/db.ts` strict helpers (0 rows ⇒ throw), which all pages use. Consider a repo-wide lint/test. |
| F5 | info | Noted | GitHub flag is UI-only (real gate = GoTrue provider config); no secret in repo, only the public client ID. |

**No remediation round ran after the red-team pass** — F1–F3 are unfixed in
the committed migrations. They are local-stack only right now, but F1 must be
fixed before anything ships.

---

## P0 coverage map (V2-PLAN "P0 — core", items 1–7)

| # | Item | Status |
|---|---|---|
| 1 | Auth + roles | **Done.** Email auth live; GitHub OAuth wired behind `VITE_GITHUB_AUTH_ENABLED` with env placeholders (secret external, prod callback — not E2E-testable locally by design). admin/manufacturer/operator enforced by RLS (21/21) and mirrored in the UI (create-aircraft hidden from operators, verified in smoke). |
| 2 | GPS privacy | **Done with one open hole.** Private by default (per-user default + per-flight flag); sanitized `.bin` actually stripped (0 location msgs, coords zeroed in fused msgs) and re-parses within 1%; raw denied to non-owner/non-admin at REST + storage. **Open: F1 site-coordinate side channel (blocker).** |
| 3 | Aircraft registry | **Done except photo.** Fleet list + detail, type-aware (4 seeded types w/ cells), component install/remove events, airframe events, operator assignment. Photo upload not wired (schema has `photo_path`; media bucket exists). |
| 4 | Flights flattened, quick-log + bulk dump | **Done.** One-screen quick-log with Open-Meteo auto-fill (keyless, verified against a 2025 log) + tags + gps default; bulk dump: N `.BIN`s → N stubs timed from the logs' GPS clocks, batch defaults, `session_id`, editable later. |
| 5 | Upload + parse pipeline | **Done.** Checksum dedupe (UNIQUE + `DuplicateLogError`), row-first/PUT-second contract, LISTEN/NOTIFY watcher, per-log status UI w/ realtime + poll fallback, visible errors (2 genuinely-empty v1 files sit in `status='error'` correctly). Upload/NOTIFY race found and fixed in `src/lib/logs.ts`. |
| 6 | Flight card | **Done.** Duration/distance/max alt/speed, battery (sag, mAh, per-cell via aircraft_type cells, armed-window fix), modes timeline, arm/disarm events, errors, health score+grade w/ per-check table. Wind estimate not computed (column NULL); series plots are P1. |
| 7 | v1 import | **Done.** Idempotent, skip-reported, checksum-verified (numbers above). ASSUMPTION flagged for Thomas: "Quiver-devkit only" read as the whole `^Quiver` family (keeps your PT3/v3 history, 191 flights); strict devkit-type-only reading is a one-line change in `scripts/import/01-import.mjs` (`KEEP_TYPE_RE`). |

Parser backlog at shutdown: **58 parsed / 132 uploaded (queued) / 2 error
(empty source files) of 192 staged logs** — the watcher chews the rest
whenever it runs; not gated (per RUN-CONTEXT).

---

## External-dependency TODOs (need Thomas / prod access)

1. **GitHub OAuth secret** — set on the prod GoTrue box (from Hex's
   `.secrets/`, never the repo): `GOTRUE_EXTERNAL_GITHUB_ENABLED=true`,
   `GOTRUE_EXTERNAL_GITHUB_CLIENT_ID=Ov23liqSDMPkyBhht5hG`,
   `GOTRUE_EXTERNAL_GITHUB_SECRET=<secret>`,
   `GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI=https://supabase.arrowair.com/auth/v1/callback`;
   then `VITE_GITHUB_AUTH_ENABLED=true` in the prod build env. See
   `.env.example`.
2. **Legacy v1 creds** — untouched by this run (import ran from the backup
   only, per RUN-CONTEXT). v1 hosted project stays system-of-record until
   cutover; re-run the import at cutover (idempotent).
3. **Julius's seed email** — `supabase/seed.sql` uses the deliberate
   placeholder `julius@example.com`; his real address is julius@arrowair.com.
   One-line seed fix + reset (left untouched so committed state = gated state).
4. **Red-team fixes F1/F2/F3** (above) — schema/policy edits + re-run
   `schema_smoke.sql` + re-verify with the RISK-REGISTER attack commands.
5. **Schema addendum for the parser** — `flight_log_summary` lacks columns for
   `armed_duration_s`, `start_time_utc`, `vehicle`, `message_counts` (parser
   currently drops them on DB write; one ALTER and `db.py` picks them up
   automatically).
6. **Host disk** — was at ~94% during the run (a full-disk event crashed the
   colima VM mid-import-gate; remediated). Each `db reset` + restage strands a
   ~7 GB orphan generation in the supabase storage docker volume — wipe
   `supabase_storage_flight-tracking/_data` if space gets tight again.

---

## Morning review path

Everything was stopped cleanly (watcher SIGTERM'd, in-flight row requeued,
`supabase stop` with backup, `v1source` container stopped, vite killed). DB
data (imported v1 + parse results) survives `supabase start`. **Do NOT run
`supabase db reset`** unless you want to re-import (idempotent but restages
4.6 GB and costs disk).

```sh
cd /Users/hex/projects/arrow/flight-tracking
git checkout overnight/p0
colima start                      # if the docker daemon is down (never Docker Desktop)
supabase start                    # local stack; data restored from backup
npm install                       # only if node_modules is stale
npm run dev -- --port 5199        # app at http://localhost:5199

# Parser watcher (drains the remaining 132-log backlog; run in a 2nd terminal):
cd parser
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_SERVICE_ROLE_KEY="$(supabase status -o json | jq -r .SERVICE_ROLE_KEY)" \
.venv/bin/python watcher.py       # venv is local-only; if missing: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Log in as `thomas@arrowair.com` / `password123` (seed; operator test:
`operator@example.com`). Look at, in order:

- `http://localhost:5199/styleguide` — the design system end-to-end.
- `/` fleet (real imported aircraft incl. your PT3s; Julius Devkit attributed
  to Julius), `/flights` (191 imported + smoke), `/logs` (live parse statuses
  ticking as the watcher drains), any parsed flight card (battery/modes/health),
  `/flights/new` quick-log (weather auto-fill needs a site with coords),
  `/upload` bulk dump.
- The devkit-filter question (P0 item 7 above) — one decision needed from you.

### Best comparison screenshots (repo paths)

- Styleguide vs real docs cards (incl. hover dither):
  `docs/build-logs/design-compare-r1/styleguide-full.png` and
  `styleguide-card-hover.png` vs `ref-cards-title-desc-hover.png`
- Fleet page vs docs landing: `docs/build-logs/ui-style-r1/shots/02-fleet-full.png`
  vs `docs/reference-screenshots/docs-home.png`
- Tables: `docs/build-logs/ui-style-r1/shots/05-sites.png`
  vs `docs/reference-screenshots/docs-tables-test.png`
- Flight card with parsed real log:
  `docs/build-logs/ui-r1-shots/06-flight-card-parsed.png`
- GPS privacy as a non-owner sees it:
  `docs/build-logs/ui-r1-shots/08-julius-privacy.png`
- All 11 routes: `docs/build-logs/ui-style-r1/shots/`
