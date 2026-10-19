/* Card Deal Scout — Manual price sheet provider.
 * Rows come from the options page (CSV paste/import): name, number, set, language, nm, lp, note
 * Always available; no API key. Great for Card Ladder / Terapeak numbers you track yourself. */
(function (root) {
  const CDS = (root.CDS = root.CDS || {});
  CDS.providers = CDS.providers || {};

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9&' ]/g, ' ').replace(/\s+/g, ' ').trim();

  CDS.parseManualCsv = function (text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const split = (l) => {
      const out = []; let cur = ''; let q = false;
      for (const ch of l) {
        if (ch === '"') { q = !q; continue; }
        if ((ch === ',' || ch === '\t') && !q) { out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
      }
      out.push(cur.trim());
      return out;
    };
    let header = split(lines[0]).map((h) => h.toLowerCase());
    let start = 1;
    const known = ['name', 'number', 'set', 'language', 'nm', 'lp'];
    if (!header.some((h) => known.includes(h))) { header = ['name', 'number', 'set', 'language', 'nm', 'lp', 'note']; start = 0; }
    const rows = [];
    for (let i = start; i < lines.length; i++) {
      const cols = split(lines[i]);
      const row = {};
      header.forEach((h, idx) => { row[h] = cols[idx] ?? ''; });
      const nm = parseFloat(String(row.nm || row.price || row.market || '').replace(/[^0-9.]/g, ''));
      const lp = parseFloat(String(row.lp || '').replace(/[^0-9.]/g, ''));
      if (!row.name) continue;
      rows.push({
        name: row.name, number: String(row.number || row['#'] || '').replace(/^#/, ''), setCode: row.set || row.setcode || '', language: (row.language || row.lang || 'any').toLowerCase().slice(0, 3).replace('jap', 'ja').replace('eng', 'en'),
        nm: isNaN(nm) ? null : nm, lp: isNaN(lp) ? (isNaN(nm) ? null : Math.round(nm * 0.85 * 100) / 100) : lp, note: row.note || ''
      });
    }
    return rows;
  };

  CDS.providers.manual = {
    id: 'manual',
    name: 'Manual price sheet',
    needsKey: false,
    isConfigured: (settings) => settings.manualEnabled !== false,
    async test() { const rows = await CDS.getManualSheet(); return { ok: true, message: `${rows.length} rows in your sheet.` }; },

    async lookup(parsed, settings) {
      if (settings.manualEnabled === false) return null;
      const rows = await CDS.getManualSheet();
      if (!rows.length) return null;
      const pn = norm(parsed.name);
      if (!pn) return null;
      let best = null, bestScore = 0;
      for (const r of rows) {
        const rn = norm(r.name);
        if (!rn) continue;
        let s = 0;
        if (rn === pn) s += 60; else if (pn.includes(rn) || rn.includes(pn)) s += 40; else continue;
        if (r.number && parsed.number) { if (String(r.number).replace(/^0+/, '').toUpperCase() === String(parsed.number).replace(/^0+/, '').toUpperCase()) s += 35; else s -= 40; }
        if (r.setCode && (parsed.setCode || parsed.setHint)) { if (norm(r.setCode) === norm(parsed.setCode) || norm(parsed.setHint || '').includes(norm(r.setCode))) s += 10; else s -= 10; }
        if (r.language && r.language !== 'any') { if (r.language === parsed.language) s += 5; else s -= 15; }
        if (s > bestScore) { best = r; bestScore = s; }
      }
      if (!best || bestScore < 40) return null;
      const prices = {};
      if (best.nm != null) prices.NM = best.nm;
      if (best.lp != null) prices.LP = best.lp;
      if (!Object.keys(prices).length) return null;
      return {
        source: 'manual', sourceLabel: 'Your price sheet', matchedName: best.name, matchedSet: best.setCode || '', matchedNumber: best.number || '',
        printing: '', prices, trend: {}, updatedAt: Date.now(), matchScore: Math.min(100, bestScore), url: '', note: best.note || ''
      };
    }
  };
})(globalThis);
