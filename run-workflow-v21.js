export const meta = {
  name: 'flight-tracking-v21',
  description: 'Flight tracking v2.1 feedback: auth, admin, filters, param viewer — build+critic loops, tested and reviewed',
  phases: [
    { title: 'Recon', detail: 'codebase map + verify context claims' },
    { title: 'Schema+Parser', detail: 'migrations, coarse coords, start time' },
    { title: 'QuickFixes', detail: 'login, tiles, durations, upload form, dedup' },
    { title: 'Features', detail: 'admin page, filters, stats, weather' },
    { title: 'ParamViewer', detail: 'param browser + diff' },
    { title: 'Gate', detail: 'build+tests+smoke integration gate' },
    { title: 'RedTeam', detail: 'security/RLS + UX + data-correctness attack' },
    { title: 'Package', detail: 'commit, push branch, draft PR, RUN-RESULT' },
  ],
}

const REPO = '/Users/hex/projects/arrow/flight-tracking'
const CTX = `${REPO}/run/RUN-CONTEXT-V21.md`
const NOTES = `${REPO}/run/ARCH-NOTES-V21.md`
const PREAMBLE = `You are one agent in a multi-agent build run. Read ${CTX} FULLY first — it is ground truth and contains HARD RULES (branch v21-feedback only, never touch prod, never print secrets). Then read ${NOTES} if it exists. Work in ${REPO}. `

const VERDICT = {
  type: 'object', additionalProperties: false,
  properties: {
    score: { type: 'number', description: '0-10' },
    pass: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      severity: { type: 'string', enum: ['blocker','major','minor'] },
      file: { type: 'string' }, description: { type: 'string' },
    }, required: ['severity','description'] } },
    evidence: { type: 'string', description: 'actual numbers: test counts, file:line refs, measurements' },
  },
  required: ['score','pass','issues','evidence'],
}

function critics(stageName, mandates) {
  return Promise.all(mandates.map(m =>
    agent(PREAMBLE + `You are a CRITIC for stage "${stageName}" on branch v21-feedback (do NOT edit code; read + run read-only checks/tests only). Mandate: ${m.mandate} Verdict must cite real evidence (file:line, command output). Be adversarial — a false pass costs more than a false fail.`,
      { label: `critic:${stageName}:${m.key}`, phase: m.phase, schema: VERDICT })
  ))
}

async function buildLoop(stageName, phase, builderPrompt, criticMandates, maxRounds) {
  let round = 0, lastIssues = 'none yet', plateau = 0, prevOpen = Infinity
  while (round < maxRounds) {
    round += 1
    log(`${stageName}: build round ${round}`)
    await agent(PREAMBLE + builderPrompt + ` This is round ${round}. Open issues from critics last round: ${lastIssues}. Fix those first. When done: git add your files and commit on v21-feedback with message "[v21 ${stageName} r${round}] <summary>". Run the relevant tests yourself before committing.`,
      { label: `build:${stageName}:r${round}`, phase })
    const verdicts = (await critics(stageName, criticMandates.map(m => ({ ...m, phase })))).filter(Boolean)
    const open = verdicts.flatMap(v => v.issues.filter(i => i.severity !== 'minor'))
    const allPass = verdicts.length === criticMandates.length && verdicts.every(v => v.pass)
    log(`${stageName} r${round}: ${verdicts.map(v => v.score).join('/')}, open issues ${open.length}`)
    if (allPass) return { stage: stageName, rounds: round, verdicts, shipped: 'clean' }
    if (open.length >= prevOpen) { plateau += 1 } else { plateau = 0 }
    prevOpen = open.length
    if (plateau >= 2) return { stage: stageName, rounds: round, verdicts, shipped: 'plateau — complaints recorded' }
    lastIssues = JSON.stringify(open).slice(0, 4000)
  }
  return { stage: stageName, rounds: round, shipped: 'max rounds — complaints recorded', lastIssues }
}

const results = {}

// ── Phase 0: Recon ──────────────────────────────────────────────────────────
phase('Recon')
await agent(PREAMBLE + `RECON. Create branch v21-feedback off main if it does not exist (git checkout -b v21-feedback). Then write ${NOTES}: a precise map for later agents — (1) frontend structure: routes/views/components/stores/api-client files relevant to each work item A-G, with file paths; (2) actual schema from supabase/migrations: tables/columns for roles, aircraft access, flights, flight_log_summary, param_snapshots — quote the CREATE statements that matter; (3) ROOT CAUSE of bug E1 (durations not showing) with file:line; (4) how profiles/roles are provisioned on signup (A1 needs this); (5) test setup: how to run vitest, pytest, ui-smoke locally, and whether supabase CLI local dev works on this machine (try it, time-box 5 min); (6) discrepancies vs RUN-CONTEXT. Commit the notes file.`,
  { label: 'recon', phase: 'Recon' })

// ── Phase 1: Schema + Parser ────────────────────────────────────────────────
results.schema = await buildLoop('schema-parser', 'Schema+Parser',
  `BUILDER. Implement the schema+parser slice: (1) migration(s) adding flight_log_summary columns start_time_utc + coarse takeoff coords (2-decimal rounding done in PARSER, item D1) + any incident field on flights (E2) + unique-checksum handling for F1 if you judge a partial unique index safe (document either way); (2) parser changes: emit coarse takeoff lat/lon (round(2) BEFORE it leaves the parser; verify sanitize pipeline never writes precise coords to summary), keep start_time_utc flowing (db.py introspects columns — verify with a test); (3) parser pytest updated/added, green.`,
  [
    { key: 'correctness', mandate: 'Run parser pytest yourself; verify migrations are valid SQL consistent with existing migration style; verify db.py actually picks up the new columns (read the introspection code); check rounding happens parser-side with a test that would fail if precise coords leaked.' },
    { key: 'privacy', mandate: 'Adversarial privacy pass: grep the diff for any path where precise (>2dp) coordinates could reach the DB, summary JSON, series output, or client. The sanitization contract in parser/README.md must still hold. Any leak = blocker.' },
  ], 4)

// ── Phase 2: Quick fixes ────────────────────────────────────────────────────
results.quickfixes = await buildLoop('quickfixes', 'QuickFixes',
  `BUILDER. Implement work items A2, A3 (download wordmark SVGs per context, wire into login page + anywhere the text-brand appears), C1 (tile readability), E1 (durations bug — root cause in ${NOTES}), F2 (operator-scoped aircraft + site dropdowns), F3 (remove ended field; started optional, prefer start_time_utc from log summary when present), F1 client-side (sha256 checksum pre-upload, duplicate warn/skip in single AND bulk upload flows). Match existing code style; npm run build + vitest green before commit.`,
  [
    { key: 'functional', mandate: 'Run npm run build and npx vitest run yourself and report counts. Then read each changed view against its work item (A2, A3, C1, E1, F1, F2, F3) and verify the requirement is actually met, not approximately met. Check the bulk upload dedup path specifically — the easy miss.' },
    { key: 'ux-consistency', mandate: 'Review changed UI against the rest of the app: spacing, dark/light themes, wordmark variant per background, empty/loading/error states for new logic (duplicate warnings, empty dropdowns for non-operators). Screenshot with ui-smoke if runnable.' },
  ], 4)

// ── Phase 3: Features (sequential builders, shared phase) ───────────────────
results.auth = await buildLoop('github-auth', 'Features',
  `BUILDER. Work item A1: GitHub OAuth sign-in. Login button, OAuth callback handling in the SPA (supabase-js signInWithOAuth, redirect back to app, session pickup), first-login provisioning path verified against how email signups provision (see ${NOTES}; add migration/trigger only if genuinely missing), README docs for the GoTrue server env. You cannot e2e-test OAuth locally without the provider secret — unit-test what is testable, document the manual test plan for Hex.`,
  [ { key: 'auth-review', mandate: 'Review the OAuth flow for: open-redirect in the callback, session fixation, missing provisioning for first GitHub login (user with no profile row must not brick the app — trace the actual code path), and README accuracy of the documented GoTrue env vars.' } ], 3)

results.admin = await buildLoop('admin-page', 'Features',
  `BUILDER. Work item B1: admin page (users, roles, aircraft access grants). RLS-gated server-side AND route-gated client-side. Use the real roles/access schema from ${NOTES}. Include vitest coverage for the store/api layer. npm build + vitest green.`,
  [
    { key: 'security', mandate: 'Adversarial: could a non-admin session read the user list or mutate roles via the underlying tables/RPCs if they call supabase-js directly (ignore the UI)? Read the RLS policies in migrations and answer with the actual policy text. Client-only gating = blocker.' },
    { key: 'functional', mandate: 'Build+vitest yourself, then walk each admin capability (list users, change role, grant/revoke aircraft) through the code path and confirm it round-trips.' },
  ], 4)

results.filters = await buildLoop('filters-stats', 'Features',
  `BUILDER. Work items C2, C3, E2, D1-app-side: fleet filters (type, manufactured-by-me, operated-by-me, active/retired), flights filters (aircraft type, specific aircraft, site, manufacturer, incident, date range, +cheap extras), incident editing on flight detail (uses schema from Phase 1), total-Quiver-hours stat (pick home per context, note choice in commit), weather autofill preferring log coarse coords with site fallback. Filters must compose (AND) and reflect in URL query params so engineers can share filtered views. npm build + vitest green.`,
  [
    { key: 'data-correctness', mandate: 'Verify filter predicates against schema (joins for manufacturer/operator correct? active/retired semantics real column?), total-hours math (which duration field, unit conversion s→h, rounds how, includes only Quiver airframes how?), and weather coord preference order. Cite the query code.' },
    { key: 'functional', mandate: 'Build+vitest, then verify URL-param round-trip of filters and that empty-result states render. Confirm incident edit persists via the API layer.' },
  ], 4)

// ── Phase 4: Param viewer/diff ──────────────────────────────────────────────
results.params = await buildLoop('param-viewer', 'ParamViewer',
  `BUILDER. Work item G: param viewer + diff. Per-flight-log param browser (search, virtualized or paginated for 1000+ params), two-log diff (changed/added/removed with old→new values), default hide-filters for COMPASS_* and STAT_* plus user-defined prefix hides (toggleable, persisted in localStorage). Verify param_snapshots real shape first (${NOTES}). Entry points: from flight detail (view params; pick second flight to diff). Design for engineers: monospace values, copy param name, filter counts visible so hidden ≠ silently missing. vitest for the diff logic (pure function — test changed/added/removed/hidden cases). npm build green.`,
  [
    { key: 'functional', mandate: 'Build+vitest yourself. Feed the diff function synthetic fixtures (param added, removed, changed, hidden-by-prefix, numeric precision edge e.g. 0.1+0.2) and report actual outputs. Verify search+hide compose and hidden counts display.' },
    { key: 'scale-ux', mandate: 'Trace what happens with a realistic 1000+ param set: is the list virtualized/paginated (cite the mechanism), does search stay client-side responsive, does the diff view stay readable? Check loading/error/empty states and entry-point discoverability from flight detail.' },
  ], 6)

// ── Phase 5: Integration gate ───────────────────────────────────────────────
phase('Gate')
let gate = null
for (let attempt = 1; attempt <= 2; attempt++) {
  gate = await agent(PREAMBLE + `INTEGRATION GATE (attempt ${attempt}). On v21-feedback run: npm ci (if needed), npm run build, npx vitest run, parser pytest, and run/ui-smoke.mjs if runnable. Report exact pass/fail counts and every failure verbatim.`,
    { label: `gate:attempt${attempt}`, phase: 'Gate', schema: VERDICT })
  if (gate && gate.pass) break
  if (attempt === 1) {
    await agent(PREAMBLE + `GATE FIX ROUND. The integration gate failed with: ${JSON.stringify(gate && gate.issues).slice(0, 4000)}. Fix ONLY these failures on v21-feedback, run the failing commands yourself until green, commit "[v21 gate-fix] <summary>".`,
      { label: 'gate:fix', phase: 'Gate' })
  }
}
results.gate = gate

// ── Phase 6: Red team + remediation ────────────────────────────────────────
phase('RedTeam')
const redteam = (await Promise.all([
  agent(PREAMBLE + `RED TEAM — security. Attack the full v21-feedback diff vs main (git diff main...v21-feedback): RLS bypasses, privilege escalation via admin endpoints, OAuth callback abuse, coordinate privacy leaks, injection in filter query building. Evidence required (policy text, file:line, PoC reasoning).`,
    { label: 'redteam:security', phase: 'RedTeam', schema: VERDICT }),
  agent(PREAMBLE + `RED TEAM — product. Walk every work item A1-G3 in ${CTX} against the final diff as a skeptical Thomas: is each actually delivered as asked? List every gap, partial, or silent reinterpretation. Evidence: file:line per item.`,
    { label: 'redteam:product', phase: 'RedTeam', schema: VERDICT }),
])).filter(Boolean)
const rtBlockers = redteam.flatMap(v => v.issues.filter(i => i.severity === 'blocker'))
if (rtBlockers.length > 0) {
  await agent(PREAMBLE + `RED TEAM REMEDIATION. Fix these blockers on v21-feedback: ${JSON.stringify(rtBlockers).slice(0, 5000)}. Tests green, commit "[v21 redteam-fix] <summary>".`,
    { label: 'redteam:fix', phase: 'RedTeam' })
  results.redteamRecheck = (await Promise.all(rtBlockers.slice(0, 4).map((b, i) =>
    agent(PREAMBLE + `Verify this red-team blocker is now actually fixed on v21-feedback (evidence or it did not happen): ${JSON.stringify(b)}`,
      { label: `redteam:verify${i}`, phase: 'RedTeam', schema: VERDICT })
  ))).filter(Boolean)
}
results.redteam = redteam

// ── Phase 7: Package ────────────────────────────────────────────────────────
phase('Package')
const pkg = await agent(PREAMBLE + `PACKAGER. On v21-feedback: (1) ensure working tree clean and all commits present; (2) write ${REPO}/run/RUN-RESULT-V21.md — per-phase results, critic scores, red-team findings + dispositions, risk register, work-item status table A1-G3, decisions Thomas must make; commit it; (3) push branch: git push -u origin v21-feedback; (4) create DRAFT PR: gh pr create --draft --base main --head v21-feedback --title "v2.1: feedback round 1 — auth, admin, filters, param viewer" --body-file <(work-item status summary — write a temp file); (5) return the PR URL and a 6-line Discord-ready summary. Do NOT merge, do NOT touch main.`,
  { label: 'package', phase: 'Package' })
results.package = pkg

return results
