/* Card Deal Scout — shared settings + storage helpers.
 * Classic script: attaches to globalThis.CDS so the same file works in the
 * service worker (importScripts), content scripts, popup and options page. */
(function (root) {
  const CDS = (root.CDS = root.CDS || {});

  CDS.VERSION = '0.1.0';

  CDS.DEFAULTS = {
    // --- pricing sources -------------------------------------------------
    providerOrder: ['justtcg', 'pricecharting', 'manual'],
    blendMode: 'first', // 'first' = stop at first provider with a hit; 'all' = query every enabled provider and blend
    justtcgApiKey: '',
    justtcgGameEn: 'pokemon',
    justtcgGameJa: '', // auto-detected from /v1/games when a key is saved; falls back to name filtering
    pricechartingToken: '',
    pricechartingLpFactor: 0.85, // PriceCharting only has "Ungraded": LP ≈ 85% of it
    manualEnabled: true,
    cacheTtlHours: 6,

    // --- comparison basis --------------------------------------------------
    comparisonBasis: 'mid', // 'nm' | 'lp' | 'mid'  (used when the listing's condition can't be sniffed)
    useSniffedCondition: true, // compare against the price tier matching the listing's stated condition
    thresholds: { steal: 0.72, offer: 0.92, fair: 1.15 }, // asking/market ratios
    minPriceForBadge: 2, // ignore sub-$2 listings (bulk junk)

    // --- offer & flip calculator -------------------------------------------
    offerTargetRatio: 0.8, // aim to pay 80% of market
    offerMaxDiscount: 0.25, // Mercari won't let buyers offer more than ~25% below asking
    fees: {
      mercari: { pct: 0.10, processingPct: 0.029, processingFixed: 0.50 },
      ebay: { pct: 0.1325, processingPct: 0, processingFixed: 0.30 }
    },
    resalePlatform: 'ebay',
    shippingCost: 1.5, // PWE w/ tracking-less; bump for bubble mailer
    suppliesCost: 0.35, // sleeve + toploader + team bag

    // --- badge display -----------------------------------------------------
    showUnknownBadge: true, // show a small "?" badge when the card can't be matched
    showTrend: true,
    badgePosition: 'top-left',
    dimSeen: true,

    // --- sites --------------------------------------------------------------
    sites: { mercari: true, ebay: true, generic: true },

    // --- watchlist + alerts -----------------------------------------------------
    notifyOnWatchHit: true,
    notifyOnSteal: false,
    patrolEnabled: false,
    patrolIntervalMin: 30,

    // --- misc ---------------------------------------------------------------
    debug: false
  };

  const deepMerge = (base, patch) => {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (!patch || typeof patch !== 'object') return out;
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = deepMerge(base[k], v);
      } else if (v !== undefined) {
        out[k] = v;
      }
    }
    return out;
  };
  CDS.deepMerge = deepMerge;

  const hasChrome = typeof chrome !== 'undefined' && chrome.storage;

  const area = (name) => (hasChrome ? chrome.storage[name] : null);

  const get = (areaName, key) =>
    new Promise((resolve) => {
      const a = area(areaName);
      if (!a) return resolve(undefined);
      a.get(key, (res) => resolve(res ? res[key] : undefined));
    });
  const set = (areaName, key, value) =>
    new Promise((resolve) => {
      const a = area(areaName);
      if (!a) return resolve();
      a.set({ [key]: value }, () => resolve());
    });

  CDS.getSettings = async function () {
    const stored = (await get('sync', 'settings')) || {};
    return deepMerge(CDS.DEFAULTS, stored);
  };
  CDS.setSettings = async function (patch) {
    const current = (await get('sync', 'settings')) || {};
    const next = deepMerge(current, patch);
    await set('sync', 'settings', next);
    return deepMerge(CDS.DEFAULTS, next);
  };
  CDS.replaceSettings = async function (full) {
    await set('sync', 'settings', full);
    return deepMerge(CDS.DEFAULTS, full);
  };

  // Watchlist: [{id, name, number, setCode, language, maxPrice, maxRatio, note, createdAt}]
  CDS.getWatchlist = async () => (await get('sync', 'watchlist')) || [];
  CDS.setWatchlist = (list) => set('sync', 'watchlist', list);

  // Saved searches for background patrol: [{id, label, url, enabled}]
  CDS.getSavedSearches = async () => (await get('sync', 'savedSearches')) || [];
  CDS.setSavedSearches = (list) => set('sync', 'savedSearches', list);

  // Manual price sheet rows: [{name, number, setCode, language, nm, lp, note}]
  CDS.getManualSheet = async () => (await get('local', 'manualSheet')) || [];
  CDS.setManualSheet = (rows) => set('local', 'manualSheet', rows);

  // Seen listings {key: ts}
  CDS.getSeen = async () => (await get('local', 'seen')) || {};
  CDS.markSeen = async (key) => {
    const seen = await CDS.getSeen();
    seen[key] = Date.now();
    // prune > 60 days or > 5000 entries
    const cutoff = Date.now() - 60 * 864e5;
    const entries = Object.entries(seen).filter(([, ts]) => ts > cutoff).sort((a, b) => b[1] - a[1]).slice(0, 5000);
    await set('local', 'seen', Object.fromEntries(entries));
  };

  // Price cache {lookupKey: {ts, result}}
  CDS.cacheGet = async (key, ttlHours) => {
    const cache = (await get('local', 'priceCache')) || {};
    const hit = cache[key];
    if (!hit) return undefined;
    if (Date.now() - hit.ts > (ttlHours || 6) * 3600e3) return undefined;
    return hit.result;
  };
  CDS.cacheSet = async (key, result) => {
    const cache = (await get('local', 'priceCache')) || {};
    cache[key] = { ts: Date.now(), result };
    const keys = Object.keys(cache);
    if (keys.length > 4000) {
      keys.sort((a, b) => cache[a].ts - cache[b].ts).slice(0, keys.length - 4000).forEach((k) => delete cache[k]);
    }
    await set('local', 'priceCache', cache);
  };
  CDS.cacheClear = () => set('local', 'priceCache', {});

  // Provider usage/status {justtcg:{remaining, limit, lastOk, lastError}}
  CDS.getProviderStatus = async () => (await get('local', 'providerStatus')) || {};
  CDS.setProviderStatus = async (id, patch) => {
    const st = await CDS.getProviderStatus();
    st[id] = { ...(st[id] || {}), ...patch };
    await set('local', 'providerStatus', st);
  };

  // Price history for trend tracking {lookupKey: [{t, nm, lp}]}
  CDS.recordPricePoint = async (key, prices) => {
    const hist = (await get('local', 'priceHistory')) || {};
    const arr = hist[key] || [];
    const last = arr[arr.length - 1];
    const today = new Date().toISOString().slice(0, 10);
    if (!last || last.d !== today) arr.push({ d: today, nm: prices.NM ?? null, lp: prices.LP ?? null });
    else arr[arr.length - 1] = { d: today, nm: prices.NM ?? null, lp: prices.LP ?? null };
    hist[key] = arr.slice(-90);
    const keys = Object.keys(hist);
    if (keys.length > 2000) keys.slice(0, keys.length - 2000).forEach((k) => delete hist[k]);
    await set('local', 'priceHistory', hist);
  };
  CDS.getPriceHistory = async (key) => ((await get('local', 'priceHistory')) || {})[key] || [];

  CDS.uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  CDS.fmtMoney = (n, opts = {}) => {
    if (n == null || isNaN(n)) return '—';
    const abs = Math.abs(n);
    const s = abs >= 1000 ? abs.toLocaleString('en-US', { maximumFractionDigits: 0 }) : abs.toFixed(abs < 20 && !opts.whole ? 2 : 0);
    return (n < 0 ? '-$' : '$') + s;
  };
  CDS.fmtPct = (r) => (r == null || isNaN(r) ? '—' : (r > 0 ? '+' : r < 0 ? '−' : '') + Math.round(Math.abs(r) * 100) + '%');
})(globalThis);
