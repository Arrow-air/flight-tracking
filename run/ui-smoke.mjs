/**
 * UI round-1 builder smoke test (not the critic's gate — a builder sanity pass).
 * Prereqs: dev server on :5199, supabase stack up + seeded, parser watcher
 * running (see docs/build-logs/ui-r1.md for the exact commands).
 *
 * Covers: login per role, manufacturer aircraft create, operator denied w/
 * visible error, operator assignment, site CRUD, quick-log with real PT1 .BIN
 * upload → wait for parse → flight card summary, bulk-drop 3 NAS logs → 3
 * stubs, GPS privacy (non-owner sees sanitized only, no raw button).
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Pre-clean prior smoke data so checksum dedupe (correct app behavior!)
// doesn't block re-uploading the same fixture files across runs.
execSync(
  `docker exec supabase_db_flight-tracking psql -U postgres -d postgres -c "` +
    `delete from public.flight_logs where object_path like '%.BIN';` +
    `delete from public.flights where title like 'Smoke%' or title like 'Bulk dump%';"`,
  { stdio: 'inherit' },
);

const BASE = 'http://localhost:5199';
const SHOTS = new URL('../docs/build-logs/ui-r1-shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const PT1_BIN = '/Users/hex/projects/project-quiver/flight-test/PT1/assets/001/logs/00000075.BIN';
const NAS = [
  '/Users/hex/projects/arrow/flight-tracking/fixtures/nas-logs/00000074.BIN',
  '/Users/hex/projects/arrow/flight-tracking/fixtures/nas-logs/00000039.BIN',
  '/Users/hex/projects/arrow/flight-tracking/fixtures/nas-logs/00000021.BIN',
];

const results = [];
const t0 = Date.now();
const ok = (s, x = '') => {
  results.push(`PASS [${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}${x ? ` — ${x}` : ''}`);
  console.log(results.at(-1));
};
const fail = (s, e) => {
  results.push(`FAIL [${((Date.now() - t0) / 1000).toFixed(0)}s] ${s} — ${e}`);
  console.log(results.at(-1));
};

const browser = await chromium.launch();
const serial = `SMOKE-${Date.now().toString(36).toUpperCase()}`;
const siteName = `Smoke Field ${Date.now().toString(36)}`;
let flightUrl = null;

async function login(page, email, password) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });
}

// ---- 1. manufacturer path -------------------------------------------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await login(page, 'thomas@arrowair.com', 'password123');
    await page.waitForSelector('text=Fleet');
    await page.screenshot({ path: `${SHOTS}01-fleet-thomas.png`, fullPage: true });
    ok('thomas login + fleet renders');

    await page.goto(`${BASE}/aircraft/new`);
    await page.getByLabel('Serial').fill(serial);
    await page.getByLabel('Name', { exact: true }).fill('Smoke Test Quiver');
    await page.getByRole('button', { name: 'Create aircraft' }).click();
    await page.waitForURL(/\/aircraft\/[0-9a-f-]+$/, { timeout: 15000 });
    await page.waitForSelector('text=Registry');
    ok('manufacturer created aircraft', serial);

    await page.getByLabel('Assign operator').selectOption({ label: 'Operator Test' });
    await page.getByRole('button', { name: 'Assign', exact: true }).click();
    await page.waitForSelector('text=Operator assigned.');
    ok('operator assigned to aircraft');

    await page.locator('[data-test="add-component-event"]').click();
    await page.getByLabel('New component kind').fill('motor');
    await page.getByLabel('Position').fill('front-left');
    await page.getByRole('button', { name: 'Log event', exact: true }).click();
    await page.waitForSelector('text=Component event logged.');
    await page.screenshot({ path: `${SHOTS}02-aircraft-detail.png`, fullPage: true });
    ok('component install event logged');

    await page.locator('[data-test="add-airframe-event"]').click();
    await page.getByLabel('Title').fill('Smoke maintenance entry');
    await page.getByRole('button', { name: 'Log event', exact: true }).click();
    await page.waitForSelector('text=Airframe event logged.');
    ok('airframe maintenance event logged');

    await page.goto(`${BASE}/sites`);
    await page.locator('[data-test="new-site"]').click();
    await page.getByLabel('Name').fill(siteName);
    // Post-redteam RLS: private sites are invisible to non-owners, so the
    // operator path below needs this site to be public.
    await page.getByLabel('Visibility').selectOption('public');
    await page.getByLabel('Latitude').fill('27.5');
    await page.getByLabel('Longitude').fill('-98.1');
    await page.getByRole('button', { name: 'Create site' }).click();
    await page.waitForSelector('text=Site created.');
    await page.screenshot({ path: `${SHOTS}03-sites.png`, fullPage: true });
    ok('site with coordinates created', siteName);
  } catch (e) {
    fail('manufacturer path', e.message?.split('\n')[0]);
    await page.screenshot({ path: `${SHOTS}ERR-manufacturer.png`, fullPage: true });
  }
  await ctx.close();
}

// ---- 2. operator path -----------------------------------------------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await login(page, 'operator@example.com', 'password123');
    const btnCount = await page.locator('[data-test="new-aircraft"]').count();
    if (btnCount === 0) ok('new-aircraft button hidden from operator');
    else fail('new-aircraft button hidden from operator', `count=${btnCount}`);

    await page.goto(`${BASE}/aircraft/new`);
    await page.waitForSelector('text=Your role cannot create aircraft');
    await page.getByLabel('Serial').fill(`${serial}-OP`);
    await page.getByRole('button', { name: 'Create aircraft' }).click();
    await page.waitForSelector('[data-test="create-error"]', { timeout: 15000 });
    const errText = await page.locator('[data-test="create-error"]').innerText();
    await page.screenshot({ path: `${SHOTS}04-operator-denied.png`, fullPage: true });
    ok('operator aircraft INSERT denied with visible error', errText.replace(/\n/g, ' ').slice(0, 90));

    // quick-log with real PT1 log attached (gps stays private = default)
    await page.goto(`${BASE}/flights/new`);
    // pick the option containing our serial (type label varies)
    const opt = page.getByLabel('Aircraft').locator('option', { hasText: serial });
    await opt.waitFor({ state: 'attached', timeout: 15000 });
    await page.getByLabel('Aircraft').selectOption(await opt.getAttribute('value'));
    await page.getByLabel('Site').selectOption({ label: siteName });
    await page.getByLabel('Title').fill('Smoke quick-log flight');
    await page.locator('#ql-log').setInputFiles(PT1_BIN);
    await page.waitForSelector('.ql-file__note', { timeout: 20000 });
    const note = await page.locator('.ql-file__note').innerText();
    ok('log timestamp extracted', note.slice(0, 90));
    try {
      await page.waitForSelector('[data-test="weather-result"]', { timeout: 15000 });
      ok('weather auto-filled', (await page.locator('[data-test="weather-result"]').innerText()).split('\n')[0].slice(0, 90));
    } catch {
      fail('weather auto-filled', (await page.locator('.ql-weather__error').allTextContents()).join(' '));
    }
    await page.screenshot({ path: `${SHOTS}05-quicklog.png`, fullPage: true });
    await page.getByRole('button', { name: 'Save flight' }).click();
    await page.waitForURL(/\/flights\/[0-9a-f-]+$/, { timeout: 60000 });
    flightUrl = page.url();
    ok('operator quick-logged flight with PT1 .BIN upload');

    // wait for the parser
    await page.waitForSelector('[data-test="log-summary"]', { timeout: 180000 });
    const health = await page.locator('[data-test="health-score"]').innerText();
    const battery = await page.locator('[data-test="battery"]').innerText();
    const modes = (await page.locator('[data-test="modes"]').innerText()).split('\n').slice(0, 4).join(' ');
    await page.screenshot({ path: `${SHOTS}06-flight-card-parsed.png`, fullPage: true });
    ok('flight card parsed: duration/battery/modes/health render',
      `health="${health.replace(/\n/g, ' ')}" battery starts "${battery.split('\n').slice(1, 4).join(' ')}" modes "${modes}"`);

    // bulk-drop 3 NAS logs
    await page.goto(`${BASE}/upload`);
    const bulkOpt = page.getByLabel('Aircraft').locator('option', { hasText: serial });
    await bulkOpt.waitFor({ state: 'attached', timeout: 15000 });
    await page.getByLabel('Aircraft').selectOption(await bulkOpt.getAttribute('value'));
    await page.locator('.dropzone__pick input').setInputFiles(NAS);
    await page.locator('[data-test="start-bulk"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll('td .badge, td [class*="badge"]').length >= 0 &&
        Array.from(document.querySelectorAll('tbody tr')).filter((r) => /done/.test(r.textContent)).length === 3,
      { timeout: 300000 },
    );
    await page.screenshot({ path: `${SHOTS}07-bulk-upload.png`, fullPage: true });
    ok('bulk-drop: 3 NAS logs → 3 flight stubs created');

    // stubs visible on flights list
    await page.goto(`${BASE}/flights`);
    await page.waitForSelector('text=Bulk dump · 00000074.BIN');
    ok('bulk stubs appear in flights list');
  } catch (e) {
    fail('operator path', e.message?.split('\n')[0]);
    await page.screenshot({ path: `${SHOTS}ERR-operator.png`, fullPage: true });
  }
  await ctx.close();
}

// ---- 3. GPS privacy: non-owner (julius) ----------------------------------
if (flightUrl) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await login(page, 'julius@example.com', 'password123');
    await page.goto(flightUrl);
    await page.waitForSelector('text=Flight logs');
    await page.waitForSelector('.fc-log');
    const rawBtn = await page.getByRole('button', { name: 'Raw .bin' }).count();
    if (rawBtn === 0) ok('non-owner sees NO raw download for gps_private flight');
    else fail('non-owner sees NO raw download', `count=${rawBtn}`);
    // sanitized available once parsed
    const sanBtn = await page.getByRole('button', { name: 'Sanitized .bin' }).count();
    if (sanBtn > 0) ok('non-owner gets sanitized artifact button');
    else fail('non-owner gets sanitized artifact button', 'not present');
    await page.screenshot({ path: `${SHOTS}08-julius-privacy.png`, fullPage: true });
  } catch (e) {
    fail('gps privacy path', e.message?.split('\n')[0]);
    await page.screenshot({ path: `${SHOTS}ERR-privacy.png`, fullPage: true });
  }
  await ctx.close();
}

await browser.close();
console.log('\n==== SUMMARY ====');
for (const r of results) console.log(r);
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
