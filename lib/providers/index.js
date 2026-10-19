/* Card Deal Scout — provider orchestrator (runs in the service worker).
 * Resolves a parsed card → { primary, others[], prices (blended), ... } with caching and per-provider error tracking. */
(function (root) {
  const CDS = (root.CDS = root.CDS || {});

  const inflight = new Map(); // lookupKey → Promise (dedupes concurrent requests for the same card)

  function blend(results, mode) {
    if (!results.length) return null;
    if (mode !== 'all' || results.length === 1) return results[0].prices;
    const tiers = ['NM', 'LP', 'MP', 'HP', 'DMG'];
    const out = {};
    for (const t of tiers) {
      const vals = results.map((r) => r.prices[t]).filter((v) => typeof v === 'number' && v > 0);
      if (vals.length) out[t] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
    }
    return out;
  }

  /**
   * @param {object} parsed  output of CDS.parseCardTitle
   * @param {object} settings
   * @param {{force?:boolean}} [opts]
   */
  CDS.priceLookup = async function (parsed, settings, opts = {}) {
    const key = CDS.lookupKey(parsed);
    if (!parsed.name) return { key, status: 'unparsed', primary: null, others: [], prices: null };
    if (!opts.force) {
      const cached = await CDS.cacheGet(key, settings.cacheTtlHours);
      if (cached) return { ...cached, cached: true };
    }
    if (inflight.has(key)) return inflight.get(key);

    const run = (async () => {
      const order = (settings.providerOrder || CDS.DEFAULTS.providerOrder).filter((id) => CDS.providers[id]);
      const configured = order.filter((id) => CDS.providers[id].isConfigured(settings));
      if (!configured.length) return { key, status: 'nosource', primary: null, others: [], prices: null };
      const results = []; const errors = [];
      for (const id of configured) {
        try {
          const r = await CDS.providers[id].lookup(parsed, settings);
          if (r) { results.push(r); if (settings.blendMode !== 'all') break; }
        } catch (e) {
          errors.push({ provider: id, message: e.message || String(e), status: e.status });
          CDS.setProviderStatus(id, { lastError: e.message || String(e), lastErrorAt: Date.now() }).catch(() => {});
          if (e.status === 401 || e.status === 403) continue; // bad key: try next provider
          if (e.status === 429) continue; // quota: try next provider
        }
      }
      const out = {
        key, status: results.length ? 'ok' : 'nomatch',
        primary: results[0] || null, others: results.slice(1), prices: blend(results, settings.blendMode), errors, ts: Date.now()
      };
      if (results.length) {
        await CDS.cacheSet(key, out);
        CDS.recordPricePoint(key, out.prices).catch(() => {});
      } else if (!errors.length) {
        // cache misses briefly too, so a page of 48 unmatched vintage titles doesn't burn quota on every scroll
        await CDS.cacheSet(key, { ...out, status: 'nomatch' });
      }
      return out;
    })();
    inflight.set(key, run);
    try { return await run; } finally { inflight.delete(key); }
  };
})(globalThis);
