// End-to-end: load the unpacked extension in Chromium, serve Mercari/eBay/generic fixtures under mapped
// hostnames, seed a manual price sheet, and screenshot badges, popover, detail panel, popup and options.
// Run: NODE_PATH=$(npm root -g) node test/e2e.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');

const SRC = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'screens');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8787;

// test copy of the extension with the generic fixture host pre-authorised (in real life: popup → "Enable on this site")
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-ext-'));
for (const d of ['background', 'lib', 'lib/providers', 'content', 'content/adapters', 'popup', 'options', 'icons']) fs.mkdirSync(path.join(EXT, d), { recursive: true });
const copy = (rel) => fs.copyFileSync(path.join(SRC, rel), path.join(EXT, rel));
const walk = (dir) => fs.readdirSync(path.join(SRC, dir)).forEach((f) => { const rel = path.join(dir, f); if (fs.statSync(path.join(SRC, rel)).isDirectory()) { if (!['test', 'node_modules', '.git'].includes(f)) { fs.mkdirSync(path.join(EXT, rel), { recursive: true }); walk(rel); } } else copy(rel); });
walk('.');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
manifest.content_scripts[0].matches.push('*://shop.example/*');
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const host = req.headers.host || '';
  let file = null;
  if (/ebay/.test(host)) file = 'ebay-search.html';
  else if (/shop\.example/.test(host)) file = 'generic-shop.html';
  else if (u.pathname.startsWith('/search')) file = 'mercari-search.html';
  else if (/^\/us\/item\//.test(u.pathname)) file = 'mercari-item.html';
  if (!file || u.pathname === '/favicon.ico') { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(FIX, file)));
});

const SHEET = [
  ['Mega Floette ex', '115', 'ninja spinner', 'ja', 18, 15], ["Rocket's Suicune", '96', 'VS', 'ja', 320, 270], ["Bruno's Steelix", '84', 'VS', 'ja', 380, 320],
  ["Blaine's Typhlosion", '', 'VS', 'ja', 120, 100], ["Rocket's Raikou", '94', 'VS', 'ja', 300, 255], ['Charizard ex', '199', 'sv2a', 'ja', 140, 118],
  ['Umbreon VMAX', '215', 'Evolving Skies', 'en', 1250, 1050], ['Iono', '350', 's12a', 'ja', 160, 135], ["Rocket's Entei", '93', 'VS', 'ja', 350, 300], ['Pikachu ex', '238', 'Surging Sparks', 'en', 120, 100]
].map(([name, number, setCode, language, nm, lp]) => ({ name, number, setCode, language, nm, lp, note: 'fixture' }));

const table = async (page, cellSel, titleSel) => page.$$eval(cellSel, (cells, titleSel) => cells.map((c) => ({ title: (c.querySelector(titleSel) || c).textContent.trim().slice(0, 46), badge: c.querySelector('.cds-badge') ? c.querySelector('.cds-badge').className.replace('cds-badge ', '') + ' | ' + c.querySelector('.cds-badge').innerText.replace(/\n/g, ' ') : '(none)' })), titleSel);

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--host-resolver-rules=MAP www.mercari.com 127.0.0.1, MAP www.ebay.com 127.0.0.1, MAP shop.example 127.0.0.1', '--no-sandbox'],
    viewport: { width: 1200, height: 900 }
  });
  const errors = [];
  context.on('page', (p) => { p.on('pageerror', (e) => errors.push(p.url().slice(0, 40) + ' pageerror: ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(p.url().slice(0, 40) + ' console.error: ' + m.text()); }); });
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    console.log('extension id', extId);

    const opts = await context.newPage();
    await opts.goto(`chrome-extension://${extId}/options/options.html`);
    await opts.evaluate(async (rows) => { await CDS.setManualSheet(rows); await CDS.setSettings({ providerOrder: ['manual', 'justtcg', 'pricecharting'], debug: false }); await CDS.setWatchlist([{ id: 'w1', name: 'Iono', number: '350', language: 'ja', maxPrice: 200, createdAt: Date.now() }]); }, SHEET);
    await opts.reload(); await opts.waitForTimeout(300);
    await opts.screenshot({ path: path.join(OUT, 'options.png'), fullPage: true });

    // --- Mercari list
    const page = await context.newPage();
    await page.goto(`http://www.mercari.com:${PORT}/search/?keyword=pokemon+japanese+vs`);
    await page.waitForSelector('.cds-badge', { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector('.cds-tier-loading'), null, { timeout: 15000 });
    await page.waitForTimeout(500);
    console.log('\nMERCARI LIST'); console.table(await table(page, '[data-testid="ItemContainer"]', '[data-testid="ItemName"]'));
    await page.screenshot({ path: path.join(OUT, 'list.png'), fullPage: true });
    const steal = await page.$('.cds-tier-steal');
    if (steal) { await steal.hover(); await page.waitForSelector('#cds-pop.cds-open'); await page.waitForTimeout(200); await page.screenshot({ path: path.join(OUT, 'popover.png') }); }
    const slab = await page.$('.cds-tier-slab');
    if (slab) { await slab.hover(); await page.waitForTimeout(250); console.log('slab popover:\n' + (await page.$eval('#cds-pop', (p) => p.innerText)).split('\n').slice(0, 12).join(' | ')); }

    // --- popup (stub tabs.query so the popup targets the fixture tab)
    const popup = await context.newPage();
    await popup.addInitScript((u) => { const orig = chrome.tabs.query.bind(chrome.tabs); chrome.tabs.query = (q) => orig({ url: u + '*' }); }, `http://www.mercari.com:${PORT}/`);
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await popup.waitForSelector('#main:not(.hidden)', { timeout: 8000 });
    await popup.waitForTimeout(500);
    await popup.screenshot({ path: path.join(OUT, 'popup.png') });
    console.log('\nPOPUP:\n' + (await popup.evaluate(() => document.body.innerText)).replace(/\n{2,}/g, '\n').slice(0, 900));
    await popup.close();

    // --- Mercari detail
    await page.goto(`http://www.mercari.com:${PORT}/us/item/m1002/`);
    await page.waitForSelector('.cds-panel', { timeout: 15000 });
    await page.waitForFunction(() => { const p = document.querySelector('.cds-panel'); return p && !/Looking up/.test(p.textContent); }, null, { timeout: 15000 });
    await page.waitForTimeout(400);
    console.log('\nDETAIL PANEL:\n' + (await page.$eval('.cds-panel', (p) => p.innerText)).replace(/\n/g, ' | ').slice(0, 700));
    await page.screenshot({ path: path.join(OUT, 'detail.png'), fullPage: true });

    // --- eBay list
    await page.goto(`http://www.ebay.com:${PORT}/sch/i.html?_nkw=pokemon+japanese+vs`);
    await page.waitForSelector('.cds-badge', { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector('.cds-tier-loading'), null, { timeout: 15000 });
    await page.waitForTimeout(400);
    console.log('\nEBAY LIST'); console.table(await table(page, 'li.s-item', '.s-item__title'));
    await page.screenshot({ path: path.join(OUT, 'ebay.png'), fullPage: true });

    // --- generic shop
    await page.goto(`http://shop.example:${PORT}/products`);
    await page.waitForSelector('.cds-badge', { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector('.cds-tier-loading'), null, { timeout: 15000 });
    await page.waitForTimeout(400);
    console.log('\nGENERIC SHOP'); console.table(await table(page, '.product-card', 'h3'));
    await page.screenshot({ path: path.join(OUT, 'generic.png'), fullPage: true });

    if (errors.length) { console.log('\nERRORS:'); errors.slice(0, 30).forEach((l) => console.log('  ' + l)); } else console.log('\nno page errors');
  } finally {
    await context.close();
    server.close();
    fs.rmSync(EXT, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
