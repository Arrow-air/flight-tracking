export const meta = {
  name: 'flight-tracking-v22',
  description: 'Flight tracking v2.2 feedback round 2: duration fix, deletes, profile, weather guard — build+critic, tested and reviewed',
  phases: [
    { title: 'Recon', detail: 'verify claims, map deltas since v21' },
    { title: 'Parser', detail: 'armed-duration fix + coords guard' },
    { title: 'AppFeatures', detail: 'deletes, profile, manufacturer, hover, bulk title, weather error' },
    { title: 'Gate', detail: 'build+tests+smoke' },
    { title: 'RedTeam', detail: 'security + skeptical-Thomas product pass' },
    { title: 'Package', detail: 'push branch, draft PR, RUN-RESULT' },
  ],
}

const REPO = '/Users/hex/projects/arrow/flight-tracking'
const CTX = `${REPO}/run/RUN-CONTEXT-V22.md`
const NOTES = `${REPO}/run/ARCH-NOTES-V22.md`
const PREAMBLE = `You are one agent in a multi-agent build run. Read ${CTX} FULLY first — ground truth + HARD RULES (branch v22-feedback only, never touch prod, never print secrets). Also read ${REPO}/run/ARCH-NOTES-V21.md for the codebase map. Read ${NOTES} if it exists. Work in ${REPO}. `

const VERDICT = {
  type: 'object', additionalProperties: false,
  properties: {
    score: { type: 'number' }, pass: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      severity: { type: 'string', enum: ['blocker','major','minor'] },
      file: { type: 'string' }, description: { type: 'string' },
    }, required: ['severity','description'] } },
    evidence: { type: 'string' },
  },
  required: ['score','pass','issues','evidence'],
}

async function buildLoop(stageName, phase, builderPrompt, criticMandates, maxRounds) {
  let round = 0, lastIssues = 'none yet', plateau = 0, prevOpen = Infinity
  while (round < maxRounds) {
    round += 1
    log(`${stageName}: build round ${round}`)
    await agent(PREAMBLE + builderPrompt + ` This is round ${round}. Open critic issues: ${lastIssues}. Fix those first. Run relevant tests before committing. Commit on v22-feedback: "[v22 ${stageName} r${round}] <summary>".`,
      { label: `build:${stageName}:r${round}`, phase })
    const verdicts = (await Promise.all(criticMandates.map(m =>
      agent(PREAMBLE + `CRITIC for stage "${stageName}" (read + run read-only checks/tests; NEVER edit code). Mandate: ${m.mandate} Cite real evidence. Adversarial — false pass costs more than false fail.`,
        { label: `critic:${stageName}:${m.key}:r${round}`, phase, schema: VERDICT })
    ))).filter(Boolean)
    const open = verdicts.flatMap(v => v.issues.filter(i => i.severity !== 'minor'))
    const allPass = verdicts.length === criticMandates.length && verdicts.every(v => v.pass)
    log(`${stageName} r${round}: scores ${verdicts.map(v => v.score).join('/')}, open ${open.length}`)
    if (allPass) return { stage: stageName, rounds: round, shipped: 'clean' }
    if (open.length >= prevOpen) plateau += 1; else plateau = 0
    prevOpen = open.length
    if (plateau >= 2) return { stage: stageName, rounds: round, shipped: 'plateau — complaints recorded', open }
    lastIssues = JSON.stringify(open).slice(0, 4000)
  }
  return { stage: stageName, rounds: round, shipped: 'max rounds', lastIssues }
}

const results = {}

phase('Recon')
await agent(PREAMBLE + `RECON. git checkout -b v22-feedback off latest main (git pull first). Write ${NOTES}: (1) deltas since ARCH-NOTES-V21 (v21 merged — what moved); (2) for P1: locate the duration computation and the battery armed-window code in parser/arrow_parser/summary.py — file:line, and confirm whether a local copy of log 387be26687b7_00000027.BIN exists under backups/ (check paths; do NOT download from prod); (3) for P2: the first-fix scan code and what validity info the GPS messages carry; (4) for P3: existing RLS delete policies (quote them or state none), FK ON DELETE behavior for flights→flight_logs→summaries/notes, storage delete policy reality; (5) for P5: the manufactured-by field the v21 fleet filter uses; (6) for P6: the exact AppCard hover CSS rule harming contrast; (7) for P7: how single upload sets flight titles. Commit.`,
  { label: 'recon', phase: 'Recon' })

phase('Parser')
results.parser = await buildLoop('parser-fixes', 'Parser',
  `BUILDER. P1 + P2 from ${CTX}: duration_s = summed armed spans (reuse the battery stats-window arm/disarm detection; record window kind like battery.stats_window), new log_duration_s field + migration column; first-fix validity guard (null coords for (0,0)/no-lock). pytest cases per context (multi-arm-cycle, no-arm fallback, stripped-GPS log → null coords). If the real .BIN for bd0ee3e6 exists locally per ${NOTES}, add an integration test asserting its duration lands ~570s not 3745s and takeoff coords near (30.04,-103.49).`,
  [
    { key: 'correctness', mandate: 'Run parser pytest yourself. Verify armed-span logic against a multi-arm fixture BY HAND (compute expected sum independently from the fixture events). Verify migration + db.py column pickup. Verify the fallback path is labeled, not silent.' },
    { key: 'regression', mandate: 'Check nothing else consumed duration_s assuming log-duration semantics (grep frontend + parser + tests); check battery stats window unchanged; check sanitize/verify pipeline still green; run the full parser pytest and report counts.' },
  ], 4)

phase('AppFeatures')
results.deletes = await buildLoop('deletes', 'AppFeatures',
  `BUILDER. P3: deletion permissions (operator deletes flight, admin deletes aircraft; safe-default block for aircraft-with-flights per context; RLS migrations; confirm dialogs; child-row cleanup; storage-orphan approach documented in code comments + RUN-RESULT note). Follow the P3 spec in ${CTX} closely.`,
  [
    { key: 'security', mandate: 'Adversarial RLS: can an operator delete an aircraft, another operator’s unrelated flight, or orphan rows they should not, calling supabase-js directly? Quote the new policy SQL. Client-only gating = blocker.' },
    { key: 'functional', mandate: 'Build+vitest; trace flight delete end-to-end incl. child rows and confirm the aircraft-with-flights block behaves; confirm dialogs wired.' },
  ], 4)

results.appMisc = await buildLoop('app-misc', 'AppFeatures',
  `BUILDER. P4 (profile page w/ copyable user id), P5 (manufacturer display + admin-only edit, human-readable name), P6 (fix hover contrast on fleet tiles — the at-rest fix from v21 must stay), P7 (bulk upload shared title), P2-app-side (weather fetch: hard error message when no usable coords; never fetch (0,0)). npm build + vitest green.`,
  [
    { key: 'functional', mandate: 'Build+vitest; verify each of P4/P5/P6/P7/P2-app against its spec — read the diff per item. For P6 specifically: find the hover rule and confirm computed contrast is actually fixed (not just moved).' },
    { key: 'ux-consistency', mandate: 'Profile page + manufacturer edit + bulk title field must match app styling/i18n conventions; weather error message must be actionable; hover state keeps a visible affordance. Screenshot via ui-smoke if runnable.' },
  ], 4)

phase('Gate')
let gate = null
for (let attempt = 1; attempt <= 2; attempt++) {
  gate = await agent(PREAMBLE + `INTEGRATION GATE (attempt ${attempt}). On v22-feedback: npm run build, npx vitest run, parser pytest, run/ui-smoke.mjs if runnable. Exact counts + every failure verbatim.`,
    { label: `gate:attempt${attempt}`, phase: 'Gate', schema: VERDICT })
  if (gate && gate.pass) break
  if (attempt === 1) await agent(PREAMBLE + `GATE FIX. Failures: ${JSON.stringify(gate && gate.issues).slice(0, 4000)}. Fix only these, re-run until green, commit "[v22 gate-fix]".`,
    { label: 'gate:fix', phase: 'Gate' })
}
results.gate = gate

phase('RedTeam')
const redteam = (await Promise.all([
  agent(PREAMBLE + `RED TEAM — security. Attack git diff main...v22-feedback: RLS deletes (escalation, cross-tenant), storage orphan handling, weather-fetch input validation, profile page info exposure. Evidence required.`,
    { label: 'redteam:security', phase: 'RedTeam', schema: VERDICT }),
  agent(PREAMBLE + `RED TEAM — product. Skeptical-Thomas pass: every item P1-P7 in ${CTX} — delivered as asked? Duration semantics REALLY armed-time now (check the math path end to end incl. fleet total hours)? Gaps/partials/reinterpretations with file:line.`,
    { label: 'redteam:product', phase: 'RedTeam', schema: VERDICT }),
])).filter(Boolean)
const rtBlockers = redteam.flatMap(v => v.issues.filter(i => i.severity === 'blocker'))
if (rtBlockers.length > 0) {
  await agent(PREAMBLE + `REMEDIATION. Fix blockers on v22-feedback: ${JSON.stringify(rtBlockers).slice(0, 5000)}. Tests green, commit "[v22 redteam-fix]".`,
    { label: 'redteam:fix', phase: 'RedTeam' })
  results.recheck = (await Promise.all(rtBlockers.slice(0, 4).map((b, i) =>
    agent(PREAMBLE + `Verify blocker actually fixed (evidence): ${JSON.stringify(b)}`,
      { label: `redteam:verify${i}`, phase: 'RedTeam', schema: VERDICT })))).filter(Boolean)
}
results.redteam = redteam

phase('Package')
results.package = await agent(PREAMBLE + `PACKAGER. Write ${REPO}/run/RUN-RESULT-V22.md (per-phase results, critic evidence incl. P1 before/after duration numbers, risk register, work-item table P1-P7, decisions for Thomas incl. the storage-orphan approach and reparse requirement); commit; push -u origin v22-feedback; gh pr create --draft --base main --head v22-feedback --title "v2.2: feedback round 2 — durations, deletes, profile, weather guard" with work-item summary body. Return PR URL + 6-line Discord summary. Do NOT merge.`,
  { label: 'package', phase: 'Package' })

return results
