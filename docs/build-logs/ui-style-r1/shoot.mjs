// Style-critic round 1 — screenshot every page (viewport + fullPage).
import { chromium } from 'playwright';

const BASE = 'http://localhost:5199';
const OUT = '/Users/hex/projects/arrow/flight-tracking/docs/build-logs/ui-style-r1/shots';
const AIRCRAFT_ID = '7a02eb55-6f41-4f51-abe6-26e006b7bd74';
const FLIGHT_ID = '457a9e99-1750-46dd-8c58-a5d92e7793c4';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

async function shoot(name, path, { settle = 1200 } = {}) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(settle);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.screenshot({ path: `${OUT}/${name}-full.png`, fullPage: true });
  console.log('shot', name, '->', page.url());
}

// 1. login (logged out)
await shoot('01-login', '/login');

// sign in as thomas (admin+manufacturer)
await page.goto(BASE + '/login');
await page.getByLabel('Email').fill('thomas@arrowair.com');
await page.getByLabel('Password').fill('password123');
await page.getByRole('button', { name: /sign in/i }).click();
await page.waitForURL(BASE + '/', { timeout: 15000 });
console.log('logged in as thomas');

await shoot('02-fleet', '/');
await shoot('03-aircraft-new', '/aircraft/new');
await shoot('04-aircraft-detail', `/aircraft/${AIRCRAFT_ID}`, { settle: 2000 });
await shoot('05-sites', '/sites');
await shoot('06-flights', '/flights');
await shoot('07-quicklog', '/flights/new');
await shoot('08-flight-card', `/flights/${FLIGHT_ID}`, { settle: 2500 });
await shoot('09-bulk-upload', '/upload');
await shoot('10-log-status', '/logs');
await shoot('11-styleguide', '/styleguide');

// computed-style probe on the fleet page: navbar, fonts, primary color usage
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const probe = await page.evaluate(() => {
  const gs = (el, p) => (el ? getComputedStyle(el).getPropertyValue(p).trim() : null);
  const nav = document.querySelector('nav, header, [class*=navbar]');
  const h1 = document.querySelector('h1');
  const btn = document.querySelector('button, a[class*=btn], [class*=button]');
  const table = document.querySelector('table th');
  const side = document.querySelector('[class*=sidebar] a, aside a');
  return {
    navbarBg: gs(nav, 'background-color'),
    navbarHeight: nav ? nav.getBoundingClientRect().height : null,
    bodyFont: gs(document.body, 'font-family'),
    bodyColor: gs(document.body, 'color'),
    h1Font: gs(h1, 'font-family'),
    h1Size: gs(h1, 'font-size'),
    btnFont: gs(btn, 'font-family'),
    btnRadius: gs(btn, 'border-radius'),
    thBg: gs(table, 'background-color'),
    thFont: gs(table, 'font-family'),
    sidebarFont: gs(side, 'font-family'),
    rootPrimary: getComputedStyle(document.documentElement).getPropertyValue('--ifm-color-primary') || getComputedStyle(document.documentElement).getPropertyValue('--color-primary'),
  };
});
console.log('PROBE', JSON.stringify(probe, null, 2));

await browser.close();
