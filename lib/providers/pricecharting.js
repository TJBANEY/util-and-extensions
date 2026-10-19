/* Card Deal Scout — PriceCharting provider (paid API token)
 * GET https://www.pricecharting.com/api/products?t=<token>&q=<query>   → { status, products:[{id, product-name, console-name, loose-price, graded-price, ...}] }
 * GET https://www.pricecharting.com/api/product?t=<token>&id=<id>       → single product with all price fields (pennies)
 * Trading-card field meaning: loose-price = Ungraded, cib-price = Grade 7, new-price = Grade 8, graded-price = Grade 9,
 *                             box-only-price = Grade 9.5, manual-only-price = PSA 10 (bgs-10-price / condition-17/18 for BGS 10 / CGC 10 / SGC 10)
 * Rate limit: 1 request/second. Classic script for the service worker. */
(function (root) {
  const CDS = (root.CDS = root.CDS || {});
  CDS.providers = CDS.providers || {};

  const BASE = 'https://www.pricecharting.com/api';
  let lastCall = 0;
  const throttle = async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastCall));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
  };

  async function api(path, params, token) {
    await throttle();
    const url = new URL(BASE + path);
    url.searchParams.set('t', token);
    Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
    const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
    let body = null;
    try { body = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok || (body && body.status === 'error')) {
      const err = new Error((body && body['error-message']) || `HTTP ${res.status}`); err.status = res.status; throw err;
    }
    CDS.setProviderStatus('pricecharting', { lastOk: Date.now(), lastError: null }).catch(() => {});
    return body;
  }

  const cents = (v) => (typeof v === 'number' && v > 0 ? Math.round(v) / 100 : null);

  function toResult(prod, parsed, score, settings) {
    const ungraded = cents(prod['loose-price']);
    if (!ungraded) return null;
    const lpFactor = settings.pricechartingLpFactor ?? 0.85;
    const prices = { NM: ungraded, LP: Math.round(ungraded * lpFactor * 100) / 100 };
    const graded = {
      '7': cents(prod['cib-price']), '8': cents(prod['new-price']), '9': cents(prod['graded-price']), '9.5': cents(prod['box-only-price']), '10': cents(prod['manual-only-price']),
      bgs10: cents(prod['bgs-10-price']), cgc10: cents(prod['condition-17-price']), sgc10: cents(prod['condition-18-price'])
    };
    Object.keys(graded).forEach((k) => graded[k] == null && delete graded[k]);
    return {
      source: 'pricecharting', sourceLabel: 'PriceCharting (eBay sold)',
      matchedName: prod['product-name'], matchedSet: prod['console-name'], matchedNumber: (String(prod['product-name'] || '').match(/#\s?([A-Za-z]*\d+)/) || [])[1] || '',
      printing: /1st/i.test(prod['product-name'] || '') ? '1st Edition' : 'Ungraded', prices, graded, trend: {}, updatedAt: Date.now(), matchScore: score,
      url: `https://www.pricecharting.com/game/${encodeURIComponent(String(prod['console-name'] || '').toLowerCase().replace(/\s+/g, '-'))}/${encodeURIComponent(String(prod['product-name'] || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'))}`,
      note: `LP estimated as ${Math.round(lpFactor * 100)}% of Ungraded`
    };
  }

  CDS.providers.pricecharting = {
    id: 'pricecharting',
    name: 'PriceCharting',
    needsKey: true,
    isConfigured: (settings) => !!settings.pricechartingToken,

    async test(settings) {
      const body = await api('/products', { q: 'charizard base set' }, settings.pricechartingToken);
      const n = (body.products || []).length;
      return { ok: true, message: `Connected. Test search returned ${n} products.` };
    },

    async lookup(parsed, settings) {
      const token = settings.pricechartingToken;
      if (!token) return null;
      const name = CDS.searchQuery(parsed);
      if (!name) return null;
      const parts = ['pokemon', parsed.language === 'ja' ? 'japanese' : '', name, parsed.number ? '#' + parsed.number : '', parsed.setHint || ''];
      const q = parts.filter(Boolean).join(' ');
      let body = await api('/products', { q }, token);
      let products = body.products || [];
      if (!products.length && parsed.setHint) { body = await api('/products', { q: parts.slice(0, 4).filter(Boolean).join(' ') }, token); products = body.products || []; }
      if (!products.length) return null;
      const scored = products
        .filter((p) => /pokemon/i.test(p['console-name'] || ''))
        .map((p) => {
          const pname = String(p['product-name'] || '');
          const num = (pname.match(/#\s?([A-Za-z]*\d+)/) || [])[1] || '';
          let s = CDS.matchScore(parsed, { name: pname.replace(/#.*$/, '').replace(/\[.*?\]/g, ''), number: num, set: p['console-name'], game: p['console-name'] });
          const isJa = /japanese/i.test(p['console-name'] || '');
          if (parsed.language === 'ja' && isJa) s += 10; else if (parsed.language === 'ja' && !isJa) s -= 15; else if (parsed.language !== 'ja' && isJa) s -= 15;
          if (parsed.firstEdition && /1st/i.test(pname)) s += 8; else if (!parsed.firstEdition && /1st/i.test(pname)) s -= 8;
          return { p, s: Math.max(0, Math.min(100, s)) };
        })
        .sort((a, b) => b.s - a.s);
      const best = scored[0];
      const minScore = parsed.number ? 50 : 30;
      if (!best || best.s < minScore) return null;
      let prod = best.p;
      if (prod['loose-price'] == null) { const full = await api('/product', { id: prod.id }, token); prod = { ...prod, ...full }; }
      const res = toResult(prod, parsed, best.s, settings);
      if (res) res.candidates = scored.slice(0, 5).map((x) => ({ name: x.p['product-name'], set: x.p['console-name'], score: x.s }));
      return res;
    }
  };
})(globalThis);
