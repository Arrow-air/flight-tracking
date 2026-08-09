export const meta = {
  name: 'flight-tracking-p0',
  description: 'Build Flight Tracking v2: full P0 (schema+RLS, parser, UI, import) on the Arrow docs design system',
  phases: [
    { title: 'Preflight', detail: 'environment + reference build checks' },
    { title: 'Design System', detail: 'Arrow docs UI/UX port, screenshot critics' },
    { title: 'Schema', detail: 'M0 migrations + RLS matrix hard gate' },
    { title: 'Parser', detail: 'pymavlink service, real-log hard gate' },
    { title: 'UI', detail: 'P0 screens, build+functional+style gates' },
    { title: 'Import', detail: 'v1 import script, dry-run gate' },
    { title: 'Red Team', detail: 'privacy/RLS/drift attack pass' },
    { title: 'Package', detail: 'branch commit + RUN-RESULT' },
  ],
}

const REPO = '/Users/hex/projects/arrow/flight-tracking'
const CTX = `${REPO}/docs/RUN-CONTEXT.md`
const PLAN = `${REPO}/docs/V2-PLAN.md`
const PREAMBLE = `You are one agent in an overnight build run. FIRST read ${CTX} (hard rules + facts) and skim ${PLAN}. Never invent facts; label assumptions. Do NOT git commit or push — write files only. Work only inside ${REPO} (reference paths in RUN-CONTEXT are read-only).`

const VERDICT = {
  type: 'object',
  required: ['score', 'pass', 'issues', 'evidence'],
  properties: {
    score: { type: 'number' },
    pass: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'description'],
        properties: {
          severity: { enum: ['blocker', 'major', 'minor'] },
          description: { type: 'string' },
          file: { type: 'string' },
        },
      },
    },
    evidence: { type: 'string' },
  },
}

const SUMMARY = {
  type: 'object',
  required: ['done', 'notes'],
  properties: { done: { type: 'boolean' }, notes: { type: 'string' } },
}

function issueList(verdicts) {
  return verdicts
    .filter(Boolean)
    .flatMap(v => v.issues.filter(i => i.severity !== 'minor'))
    .map(i => `- [${i.severity}] ${i.description}${i.file ? ` (${i.file})` : ''}`)
    .join('\n')
}

// Generic build/critic loop. critics: [{label, prompt}] run in parallel each
// round. Exits when all critics pass, or on plateau (2 rounds without total
// score improvement) if allowPlateau, or at cap.
async function buildLoop({ name, phase, builderPrompt, critics, cap, allowPlateau }) {
  let round = 0
  let issues = ''
  let best = -1
  let flat = 0
  let lastVerdicts = []
  while (round < cap) {
    round++
    await agent(
      `${PREAMBLE}\n\nROLE: builder for ${name}, round ${round}.\n${builderPrompt}\n${issues ? `Open issues from the previous round's critics — fix ALL blockers and majors:\n${issues}` : 'First round: build from scratch per the spec.'}\nWrite a round log to ${REPO}/docs/build-logs/${phase.toLowerCase().replace(/ /g, '-')}-r${round}.md (what you did, what remains).`,
      { label: `${name}:build:r${round}`, phase, schema: SUMMARY },
    )
    lastVerdicts = (await parallel(
      critics.map(c => () =>
        agent(
          `${PREAMBLE}\n\nROLE: critic (${c.label}) for ${name}, round ${round}. ${c.prompt}\nVerdict discipline: pass=false if ANY blocker exists. Evidence must contain the actual commands run and numbers observed.`,
          { label: `${name}:${c.label}:r${round}`, phase, schema: VERDICT },
        ),
      ),
    )).filter(Boolean)
    const total = lastVerdicts.reduce((s, v) => s + v.score, 0)
    const allPass = lastVerdicts.length === critics.length && lastVerdicts.every(v => v.pass)
    log(`${name} r${round}: total ${total}, pass ${allPass}`)
    if (allPass) return { rounds: round, verdicts: lastVerdicts, exit: 'pass' }
    if (total <= best) {
      flat++
      if (allowPlateau && flat >= 2) return { rounds: round, verdicts: lastVerdicts, exit: 'plateau' }
    } else {
      best = total
      flat = 0
    }
    issues = issueList(lastVerdicts)
  }
  return { rounds: round, verdicts: lastVerdicts, exit: 'cap' }
}

// ---------- Phase 0: Preflight ----------
phase('Preflight')
const pre = await agent(
  `${PREAMBLE}\n\nROLE: preflight. Verify and FIX where possible: (1) docker daemon responds (open -ga Docker and wait if needed); (2) \`supabase start\` works in ${REPO} (stop it after); (3) npm install state: \`npm ci || npm install\`, then \`npm run typecheck\` and \`npm run build\` pass on the untouched scaffold; (4) install @playwright/test as devDependency + \`npx playwright install chromium\`; (5) build the READ-ONLY reference docs site: cd /Users/hex/projects/arrow/website && npm install && npm run build, then verify you can serve + screenshot a page of it with playwright; save reference screenshots of 4 representative docs pages to ${REPO}/docs/reference-screenshots/; (6) create ${REPO}/parser/.venv with python3 -m venv, pip install pymavlink, and confirm it parses one PT1 fixture; (7) confirm fixtures/nas-logs has ~101 .BIN files; (8) git branch is overnight/p0. Write results to ${REPO}/docs/build-logs/preflight.md.`,
  { label: 'preflight', phase: 'Preflight', schema: VERDICT },
)
if (!pre || !pre.pass) {
  return { aborted: 'preflight failed', detail: pre ? pre.issues : 'preflight agent died' }
}

// ---------- Phases 1-3 in parallel pipelines (disjoint dirs) ----------
const designP = buildLoop({
  name: 'design',
  phase: 'Design System',
  cap: 6,
  allowPlateau: true,
  builderPrompt: `Port the Arrow docs design system into the scaffold per RUN-CONTEXT "Design tokens": src/styles/ (tokens.css + base.css), fonts copied to public/fonts/, and base Vue components in src/components/ui/ — AppNavbar, AppSidebar, AppCard, AppTable, AppButton, AppInput/Form controls, AppBreadcrumbs, AppBadge — replicating the docs site's layout, spacing, and interaction feel (hover/active/focus), not just colors. Build a /styleguide route rendering every component in realistic compositions. Only touch src/styles, src/components/ui, public/fonts, the styleguide page + its route.`,
  critics: [
    {
      label: 'fidelity',
      prompt: `Serve the tracker (npm run dev or preview) and screenshot the /styleguide route with playwright; compare side-by-side against ${REPO}/docs/reference-screenshots/ (the real docs site). Score visual fidelity 0-100 across: palette, typography (family/size/weight rhythm), navbar/sidebar layout, card+table+button treatment, spacing, hover behavior. Save comparison screenshots to docs/build-logs/design-compare-r<N>/. Pass requires ≥85 and no blocker-level deviation.`,
    },
    {
      label: 'code-quality',
      prompt: `Review the design-system code: tokens actually used (no hardcoded colors bypassing them), components are reusable Vue 3 SFCs with props (not copy-paste), typecheck passes, no edits outside the allowed paths (git status). Score 0-100; blockers for typecheck failures or out-of-scope edits.`,
    },
  ],
})

const schemaP = buildLoop({
  name: 'schema',
  phase: 'Schema',
  cap: 8,
  allowPlateau: false, // HARD GATE
  builderPrompt: `Write the full migration set in supabase/migrations/ implementing RUN-CONTEXT "Schema" exactly (all 22 tables, role model, RLS policies, audit triggers, seed data in a seed migration or supabase/seed.sql). Only touch supabase/.`,
  critics: [
    {
      label: 'gate',
      prompt: `You own ${REPO}/tests/rls/ (create/maintain it; builder must not touch it). Run \`supabase db reset\` for a fresh local DB, then execute an RLS test matrix via psql covering EVERY invariant in RUN-CONTEXT "Schema" (manufacturer-only aircraft INSERT, operator write scoping via aircraft_operators, fleet-visible reads, gps_private visibility on logs/series, audit_log immutability + coverage, silent-write detection). Each invariant = at least one positive and one negative test executed as the appropriate role (SET LOCAL role / request.jwt.claims). Evidence: total tests run / passed / failed. Pass ONLY on 100% with all invariants covered.`,
    },
  ],
})

const parserP = buildLoop({
  name: 'parser',
  phase: 'Parser',
  cap: 8,
  allowPlateau: false, // HARD GATE
  builderPrompt: `Build the parser service in parser/ per RUN-CONTEXT "Parser": Python + pymavlink (use parser/.venv), queue watcher on flight_logs.status='uploaded' against the local Supabase stack, CLI entrypoint (parser/run.py <file.bin>) for offline testing, outputs summary/series/params rows + the sanitized .bin copy (all location-bearing messages stripped). Include Dockerfile for the eventual Openship deploy (build it, don't deploy). Health-score thresholds per RUN-CONTEXT. Only touch parser/.`,
  critics: [
    {
      label: 'gate',
      prompt: `You own ${REPO}/parser/tests/ (builder must not touch it). Run the parser CLI against: all PT1 fixture logs, test12.bin, the SITL log, and 10 NAS logs sampled by taking every 10th file of fixtures/nas-logs sorted by name. Assert per RUN-CONTEXT: all parse without error; summaries populated and sane (duration >0 within log span, battery voltage plausible for the type); sanitized copies re-parse cleanly, contain ZERO location-bearing messages (enumerate message types present and list which location types were found before/after), and match raw duration/battery summary ±1%. If all pass AND this is your first fully-green round, ALSO run the complete 101-log NAS corpus (bulk batch) and report throughput + failures — full-corpus green is required for pass=true. Evidence: per-fixture table of results.`,
    },
  ],
})

const [design, schema, parser] = await parallel([() => designP, () => schemaP, () => parserP])

const gateFailures = []
if (!schema || schema.exit !== 'pass') gateFailures.push(`schema gate: ${schema ? schema.exit : 'died'}`)
if (!parser || parser.exit !== 'pass') gateFailures.push(`parser gate: ${parser ? parser.exit : 'died'}`)
if (gateFailures.length) {
  // One dedicated rescue round each, then re-gate once; if still red, abort honestly.
  log(`hard-gate failure(s): ${gateFailures.join('; ')} — one rescue round`)
  const rescues = await parallel(
    gateFailures.map(f => () =>
      agent(
        `${PREAMBLE}\n\nROLE: rescue engineer. A hard gate failed: ${f}. Read the relevant build-logs and test outputs in docs/build-logs/ and tests/, diagnose the root cause, fix it, then re-run the gate's own test harness yourself and report honestly.`,
        { label: `rescue:${f.split(' ')[0]}`, phase: f.startsWith('schema') ? 'Schema' : 'Parser', schema: VERDICT },
      ),
    ),
  )
  if (rescues.filter(Boolean).some(r => !r.pass)) {
    return { aborted: 'hard gate failed after rescue round', gateFailures, rescues }
  }
}

// ---------- Phase 4: UI (needs design + schema + parser) ----------
const ui = await buildLoop({
  name: 'ui',
  phase: 'UI',
  cap: 8,
  allowPlateau: false, // typecheck/build/functional must go green; style may complain
  builderPrompt: `Build the P0 UI per RUN-CONTEXT "UI" on the design system (src/components/ui) against the local Supabase stack + parser: fleet list, aircraft detail with component/event history, sites, quick-log with Open-Meteo autofill, bulk-dump intake, upload status, flight card, auth screens (email live, GitHub behind config flag), role-aware UI. Touch src/ (not src/components/ui internals unless a component needs a prop added — note it in the round log).`,
  critics: [
    {
      label: 'func-gate',
      prompt: `Hard functional gate. (1) npm run typecheck && npm run build — both must pass. (2) With supabase running + seeded and the parser watcher up, drive the app with playwright as each seeded role: login; manufacturer creates an aircraft (operator must FAIL to, with a visible error — no silent failure); operator quick-logs a flight; upload a real PT1 .BIN through the UI; wait for parse; assert the flight card renders duration/battery/modes/health; bulk-drop 3 NAS logs and assert 3 flight stubs appear; verify a non-owner account cannot access the raw log of a gps_private flight but gets the sanitized artifact. Evidence: pass/fail per step with timings. Pass = every step green.`,
    },
    {
      label: 'style',
      prompt: `Screenshot every page with playwright and compare against docs/reference-screenshots/ + the design system styleguide. Score fidelity 0-100; blockers only for pages that ignore the design system entirely. Save to docs/build-logs/ui-style-r<N>/.`,
    },
  ],
})

// ---------- Phase 5: Import ----------
const importR = await buildLoop({
  name: 'import',
  phase: 'Import',
  cap: 4,
  allowPlateau: false,
  builderPrompt: `Build scripts/import/ per RUN-CONTEXT "Import" — REAL v1 data is in backups/ (dumps + 199 storage objects). Restore the dumps into a local Docker Postgres container (v1source) — NEVER touch the live hosted project. Deliver: mapping doc (v1 schema → v2), import script (v1source → local v2 DB + storage staging from backups/v1-storage-flight_logs/ with status='uploaded'), devkit-only filter with explicit skip-report (JIS M-40 must appear in it), manufacturer attribution (Thomas; Julius for his own devkit), operator assignments from v1 ownership, idempotency. Only touch scripts/import/.`,
  critics: [
    {
      label: 'gate',
      prompt: `Run the import against the restored REAL v1 dump into a fresh local v2 DB (supabase db reset first). Assert: devkit aircraft/flights/maintenance land with correct attribution + operator assignments; non-devkit rows and JIS M-40 are skipped and listed in the skip-report; staged log files match source checksums (spot-check ≥10); re-running produces zero duplicates. Evidence: row counts in/out/skipped per table, checksum results.`,
    },
  ],
})

// ---------- Phase 6: Red team ----------
phase('Red Team')
const red = await parallel([
  () =>
    agent(
      `${PREAMBLE}\n\nROLE: red team — privacy & access. Attack the running stack: RLS bypass attempts via PostgREST (forged filters, embedded resources, RPC), GPS coordinate leakage into ANY response reachable by a non-owner/non-admin (summaries, series, exports, storage URLs, sanitized bins), role escalation, auth-flag bypass on the GitHub button. Try at least 12 distinct attacks. Write findings to docs/RISK-REGISTER.md (append, structured).`,
      { label: 'redteam:privacy', phase: 'Red Team', schema: VERDICT },
    ),
  () =>
    agent(
      `${PREAMBLE}\n\nROLE: red team — spec drift. Diff the built system against docs/V2-PLAN.md P0 items 1-7 and RUN-CONTEXT: missing fields, schema deviations, styling directive violations, TODO/stub code paths presented as done. Append findings to docs/RISK-REGISTER.md.`,
      { label: 'redteam:drift', phase: 'Red Team', schema: VERDICT },
    ),
])

// ---------- Phase 7: Package ----------
phase('Package')
const pkg = await agent(
  `${PREAMBLE.replace('Do NOT git commit or push — write files only.', '')}\n\nROLE: packager. You are the ONLY agent allowed to commit. (1) Ensure supabase stack + parser stopped cleanly. (2) git status review: everything intended, nothing stray (fixtures/ and parser/.venv must be gitignored — fix .gitignore if needed). (3) Commit ALL work to branch overnight/p0 in logical commits (design system / schema+tests / parser / UI / import / docs). DO NOT PUSH. (4) Write ${REPO}/RUN-RESULT.md: per-phase outcomes with rounds + final scores + gate evidence numbers, red-team summary, the P0 coverage map with per-item status, external-dep TODOs (GitHub OAuth secret, legacy creds), and a "morning review path" (commands for Thomas: checkout branch, supabase start, npm run dev, parser watcher, styleguide + screenshots to look at). Include paths to the best comparison screenshots.`,
  { label: 'package', phase: 'Package', schema: SUMMARY },
)

return {
  design: design && { exit: design.exit, rounds: design.rounds },
  schema: schema && { exit: schema.exit, rounds: schema.rounds },
  parser: parser && { exit: parser.exit, rounds: parser.rounds },
  ui: ui && { exit: ui.exit, rounds: ui.rounds },
  import: importR && { exit: importR.exit, rounds: importR.rounds },
  redTeam: red.filter(Boolean).map(v => ({ pass: v.pass, score: v.score, issues: v.issues.length })),
  packaged: pkg && pkg.done,
}
