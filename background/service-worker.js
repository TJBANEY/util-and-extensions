/* Card Deal Scout — background service worker (MV3)
 * Owns: price lookups (providers + cache + queue), notifications, saved-search patrol, action badge, site enablement. */
importScripts(
  '../lib/storage.js',
  '../lib/card-parser.js',
  '../lib/condition-sniffer.js',
  '../lib/deal-scorer.js',
  '../lib/providers/justtcg.js',
  '../lib/providers/pricecharting.js',
  '../lib/providers/manual.js',
  '../lib/providers/index.js'
);

const CONTENT_JS = [
  'lib/storage.js', 'lib/card-parser.js', 'lib/condition-sniffer.js', 'lib/deal-scorer.js',
  'content/adapters/mercari.js', 'content/adapters/ebay.js', 'content/adapters/generic.js', 'content/adapters/index.js', 'content/content.js'
];
const CONTENT_CSS = ['content/overlay.css'];

// ---------------------------------------------------------------------------
// Lookup queue: small concurrency so a 48-card page doesn't hammer the API.
// ---------------------------------------------------------------------------
const queue = [];
let active = 0;
const CONCURRENCY = 3;
function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < CONCURRENCY && queue.length) {
    const { task, resolve, reject } = queue.shift();
    active++;
    Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; pump(); });
  }
}

async function lookupOne(parsed, settings, force) {
  try {
    return await CDS.priceLookup(parsed, settings, { force });
  } catch (e) {
    return { key: CDS.lookupKey(parsed), status: 'error', error: e.message || String(e), primary: null, others: [], prices: null };
  }
}

// ---------------------------------------------------------------------------
// Notifications (watch hits + optional steals), de-duplicated per listing/day
// ---------------------------------------------------------------------------
async function notifyOnce(id, title, message, url) {
  const sent = (await new Promise((r) => chrome.storage.local.get('alertsSent', (x) => r(x.alertsSent || {}))));
  const now = Date.now();
  if (sent[id] && now - sent[id] < 24 * 3600e3) return false;
  sent[id] = now;
  Object.keys(sent).forEach((k) => { if (now - sent[k] > 3 * 86400e3) delete sent[k]; });
  chrome.storage.local.set({ alertsSent: sent });
  chrome.notifications.create(`cds:${id}:${encodeURIComponent(url || '')}`, {
    type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, priority: 2
  });
  return true;
}
chrome.notifications.onClicked.addListener((nid) => {
  const m = nid.match(/^cds:[^:]+:(.*)$/);
  if (m && m[1]) chrome.tabs.create({ url: decodeURIComponent(m[1]) });
  chrome.notifications.clear(nid);
});

// ---------------------------------------------------------------------------
// Saved-search patrol: opens each saved search in a background tab, lets the
// content script scan it, collects the report, closes the tab.
// ---------------------------------------------------------------------------
const patrolWaiters = new Map(); // tabId → resolve
async function runPatrol() {
  const settings = await CDS.getSettings();
  if (!settings.patrolEnabled) return;
  const searches = (await CDS.getSavedSearches()).filter((s) => s.enabled !== false && s.url);
  for (const s of searches) {
    let tab;
    try {
      tab = await chrome.tabs.create({ url: s.url, active: false });
      const report = await new Promise((resolve) => {
        patrolWaiters.set(tab.id, resolve);
        setTimeout(() => { if (patrolWaiters.has(tab.id)) { patrolWaiters.delete(tab.id); resolve(null); } }, 45000);
      });
      if (report) {
        const hits = report.deals.filter((d) => d.watchHit || (settings.notifyOnSteal && d.tier === 'steal'));
        for (const d of hits.slice(0, 5)) {
          await notifyOnce(d.key, d.watchHit ? `Watchlist hit: ${d.name}` : `Steal spotted: ${d.name}`, `${CDS.fmtMoney(d.asking)} vs market ${CDS.fmtMoney(d.basisPrice)} (${CDS.fmtPct(d.pctDiff)}) — ${s.label || 'saved search'}`, d.url);
        }
      }
    } catch (e) { /* tab may have been closed by the user */ }
    finally { if (tab) chrome.tabs.remove(tab.id).catch(() => {}); }
    await new Promise((r) => setTimeout(r, 4000)); // polite spacing between searches
  }
  chrome.storage.local.set({ lastPatrol: Date.now() });
}
async function schedulePatrol() {
  const settings = await CDS.getSettings();
  await chrome.alarms.clear('cds-patrol');
  if (settings.patrolEnabled) chrome.alarms.create('cds-patrol', { periodInMinutes: Math.max(10, Number(settings.patrolIntervalMin) || 30) });
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'cds-patrol') runPatrol(); });
chrome.runtime.onInstalled.addListener(() => { schedulePatrol(); reRegisterSites(); });
chrome.runtime.onStartup.addListener(() => { schedulePatrol(); reRegisterSites(); });

// ---------------------------------------------------------------------------
// "Enable on this site": persist a dynamic content-script registration.
// ---------------------------------------------------------------------------
async function registerSite(origin) {
  const id = 'cds-' + origin.replace(/[^a-z0-9]/gi, '_');
  const matches = [origin.replace(/\/$/, '') + '/*'];
  try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); } catch (e) { /* not registered yet */ }
  await chrome.scripting.registerContentScripts([{ id, matches, js: CONTENT_JS, css: CONTENT_CSS, runAt: 'document_idle', persistAcrossSessions: true }]);
  const sites = (await new Promise((r) => chrome.storage.sync.get('enabledSites', (x) => r(x.enabledSites || []))));
  if (!sites.includes(origin)) { sites.push(origin); chrome.storage.sync.set({ enabledSites: sites }); }
}
async function unregisterSite(origin) {
  const id = 'cds-' + origin.replace(/[^a-z0-9]/gi, '_');
  try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); } catch (e) { /* ignore */ }
  const sites = (await new Promise((r) => chrome.storage.sync.get('enabledSites', (x) => r(x.enabledSites || []))));
  chrome.storage.sync.set({ enabledSites: sites.filter((s) => s !== origin) });
}
async function reRegisterSites() {
  const sites = (await new Promise((r) => chrome.storage.sync.get('enabledSites', (x) => r(x.enabledSites || []))));
  for (const origin of sites) {
    const ok = await chrome.permissions.contains({ origins: [origin.replace(/\/$/, '') + '/*'] }).catch(() => false);
    if (ok) registerSite(origin).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Action badge: number of STEAL/OFFER deals on the active tab
// ---------------------------------------------------------------------------
const tabCounts = new Map();
function paintBadge(tabId) {
  const c = tabCounts.get(tabId);
  if (!c) { chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}); return; }
  const text = c.steal ? String(c.steal) : c.offer ? String(c.offer) : '';
  chrome.action.setBadgeBackgroundColor({ tabId, color: c.steal ? '#16a34a' : '#0f766e' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}
chrome.tabs.onRemoved.addListener((id) => tabCounts.delete(id));

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  (async () => {
    switch (msg && msg.type) {
      case 'cds:getSettings': return CDS.getSettings();
      case 'cds:setSettings': { const s = await CDS.setSettings(msg.patch || {}); await schedulePatrol(); return s; }
      case 'cds:lookup': {
        const settings = await CDS.getSettings();
        return enqueue(() => lookupOne(msg.parsed, settings, msg.force));
      }
      case 'cds:lookupBatch': {
        const settings = await CDS.getSettings();
        const items = msg.items || [];
        const results = await Promise.all(items.map((it) => enqueue(() => lookupOne(it.parsed, settings, msg.force))));
        const out = {};
        items.forEach((it, i) => { out[it.key] = results[i]; });
        return out;
      }
      case 'cds:scanReport': {
        if (tabId != null) {
          tabCounts.set(tabId, { steal: msg.counts?.steal || 0, offer: msg.counts?.offer || 0 });
          paintBadge(tabId);
          if (patrolWaiters.has(tabId)) { const r = patrolWaiters.get(tabId); patrolWaiters.delete(tabId); r(msg); }
          chrome.storage.session?.set({ ['report:' + tabId]: { ts: Date.now(), deals: msg.deals, site: msg.site, pageType: msg.pageType } }).catch?.(() => {});
        }
        return { ok: true };
      }
      case 'cds:watchHit': {
        const settings = await CDS.getSettings();
        if (!settings.notifyOnWatchHit) return { ok: false };
        const d = msg.deal;
        const sent = await notifyOnce(d.key, `Watchlist hit: ${d.name}`, `${CDS.fmtMoney(d.asking)} on ${d.site}${d.basisPrice ? ` vs market ${CDS.fmtMoney(d.basisPrice)} (${CDS.fmtPct(d.pctDiff)})` : ''}`, d.url);
        return { ok: sent };
      }
      case 'cds:testProvider': {
        const settings = await CDS.getSettings();
        const p = CDS.providers[msg.provider];
        if (!p) return { ok: false, message: 'Unknown provider' };
        try { return await p.test(settings); } catch (e) { await CDS.setProviderStatus(msg.provider, { lastError: e.message, lastErrorAt: Date.now() }); return { ok: false, message: e.message || String(e) }; }
      }
      case 'cds:listGames': {
        const settings = await CDS.getSettings();
        try { return { ok: true, games: await CDS.providers.justtcg.listGames(settings.justtcgApiKey) }; } catch (e) { return { ok: false, message: e.message }; }
      }
      case 'cds:clearCache': { await CDS.cacheClear(); return { ok: true }; }
      case 'cds:registerSite': { await registerSite(msg.origin); return { ok: true }; }
      case 'cds:unregisterSite': { await unregisterSite(msg.origin); return { ok: true }; }
      case 'cds:patrolNow': { runPatrol(); return { ok: true }; }
      case 'cds:openOptions': { chrome.runtime.openOptionsPage(); return { ok: true }; }
      case 'cds:openTabs': { for (const url of (msg.urls || []).slice(0, 15)) chrome.tabs.create({ url, active: false }); return { ok: true }; }
      case 'cds:markSeen': { await CDS.markSeen(msg.key); return { ok: true }; }
      case 'cds:getHistory': { return { history: await CDS.getPriceHistory(msg.key) }; }
      case 'cds:getStatus': { return { providers: await CDS.getProviderStatus(), lastPatrol: (await new Promise((r) => chrome.storage.local.get('lastPatrol', (x) => r(x.lastPatrol)))) }; }
      default: return { error: 'unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ error: e && e.message ? e.message : String(e) }));
  return true; // async
});
