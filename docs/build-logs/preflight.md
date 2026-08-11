# Preflight — build log

Run: 2026-08-10 ~19:25–19:30 CDT. Branch: `overnight/p0` (confirmed). Fresh
preflight — `docs/build-logs/` did not exist before this run, no prior rounds
to repair.

## Results (all PASS)

1. **Docker daemon** — PASS. Colima already running (macOS VZ, aarch64),
   `docker version` server **29.5.2**. No action needed. NOTE: RUN-CONTEXT
   overrides the task's `open -ga Docker` instruction — docker here is colima,
   never Docker Desktop; if down use `colima start`.
2. **supabase start** — PASS. First start pulled `supabase/postgres:17.6.1.158`
   image; stack came up with API `http://127.0.0.1:54321`, DB
   `postgresql://postgres:postgres@127.0.0.1:54322/postgres`, Studio `:54323`.
   Verified live: `GET /auth/v1/health` → **200**, `GET /rest/v1/` with anon
   key → **200**. Then `supabase stop` → "Stopped supabase local development
   setup." (with backup; 0 containers left running). Warnings seen (benign):
   `supabase/migrations/README.md` skipped (name pattern), no
   `supabase/seed.sql` yet.
3. **npm install + scaffold typecheck/build** — PASS. `npm ci` exit 0
   (allow-scripts warnings for esbuild/fsevents postinstall — did not affect
   anything). `npm run typecheck` (vue-tsc --noEmit) exit 0. `npm run build`
   → 73 modules, `dist/assets/index-nvKfviHa.js` 309.73 kB, built in 884ms.
4. **Playwright** — PASS. `@playwright/test@^1.62.1` added to devDependencies
   (`package.json`/`package-lock.json` modified — left uncommitted per rules).
   `npx playwright install chromium` → chromium-1234 +
   chromium_headless_shell-1234 in `~/Library/Caches/ms-playwright/`.
   Verified `chromium.launch()` succeeds ("chromium launches OK").
5. **Reference docs site** — PASS. `/Users/hex/projects/arrow/website`:
   `npm install` + `npm run build` → `[SUCCESS] Generated static files in
   "build"` (some pre-existing broken-link warnings in the site itself, e.g.
   `/docs/lists-test` → `/docs/overview`; not our problem, repo is read-only
   and untouched). Served `build/` via `npx serve -l 3999` and captured
   **5** reference screenshots (1440x900, chromium) to
   `docs/reference-screenshots/`:
   - `docs-home.png` — `/docs/` docs landing: navbar, tab bar, sidebar, card grid
   - `docs-kitchen-sink.png` — `/docs/kitchen-sink/` typography/components showcase
   - `quiver-index.png` — `/quiver/` project page: sidebar + TOC + content
   - `docs-cards-test.png` — `/docs/cards-test/` card components
   - `docs-tables-test.png` — `/docs/tables-test/` bordered tables
   All visually verified as fully rendered pages (an earlier
   `/docs/overview/` capture was a directory listing — deleted, route
   replaced with real built routes). Gotcha for later phases: `npx serve ... | head`
   kills the server via SIGPIPE; run serve without piping.
6. **Parser venv** — PASS. `parser/.venv` created with
   `/opt/homebrew/bin/python3 -m venv`; **pymavlink 2.4.49** installed.
   Fixture parse: PT1 `assets/001/logs/00000075.BIN` → **112,811 messages**,
   TimeUS duration **172.2 s**.
7. **Fixtures** — PASS. `fixtures/nas-logs/*.BIN` count = **101** (matches
   RUN-CONTEXT "~101"). Actual size **1.8 GB** by `du -sh` (RUN-CONTEXT says
   ~1.2 GB — recording the measured number; ASSUMPTION: doc estimate was
   approximate, files are the real NAS copy).
8. **Git branch** — PASS. `git branch --show-current` = `overnight/p0`.
   Working-tree changes left uncommitted (no commits per hard rules):
   `package.json`, `package-lock.json` (playwright dep),
   `docs/reference-screenshots/` (new), `supabase/.branches/` (supabase CLI
   artifact), `docs/build-logs/` (this log), `parser/.venv` (should be
   gitignored by whoever writes `parser/` — check `.gitignore` in that phase).

## Environment facts confirmed for later phases

- Node 24 / npm work; typecheck+build clean on untouched scaffold.
- Supabase local stack keys are the standard demo keys (see
  `supabase start` output; anon + service_role JWTs, JWT secret
  `super-secret-jwt-token-with-at-least-32-characters-long`).
- Website design tokens match RUN-CONTEXT (navbar `#072a80` blue confirmed
  visually in screenshots; card grids, mono accents, left sidebar).
