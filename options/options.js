/* Card Deal Scout — options page */
(async function () {
  const $ = (s) => document.querySelector(s);
  const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; r(res); }));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  $('#ver').textContent = 'v' + CDS.VERSION;

  let settings = await CDS.getSettings();
  let savedTimer = null;
  const flashSaved = () => { $('#saved').classList.add('on'); clearTimeout(savedTimer); savedTimer = setTimeout(() => $('#saved').classList.remove('on'), 1200); };
  async function save(patch) { settings = await send({ type: 'cds:setSettings', patch }) || await CDS.setSettings(patch); flashSaved(); }

  // ---- simple field binding ---------------------------------------------------
  const FIELDS = {
    justtcgApiKey: 'text', justtcgGameEn: 'text', justtcgGameJa: 'text', pricechartingToken: 'text', pricechartingLpFactor: 'num', cacheTtlHours: 'num',
    blendMode: 'text', manualEnabled: 'bool', comparisonBasis: 'text', minPriceForBadge: 'num', useSniffedCondition: 'bool',
    offerTargetRatio: 'num', offerMaxDiscount: 'num', resalePlatform: 'text', shippingCost: 'num', suppliesCost: 'num',
    notifyOnWatchHit: 'bool', notifyOnSteal: 'bool', patrolEnabled: 'bool', patrolIntervalMin: 'num',
    showUnknownBadge: 'bool', showTrend: 'bool', dimSeen: 'bool', badgePosition: 'text', debug: 'bool'
  };
  function fill() {
    for (const [k, t] of Object.entries(FIELDS)) { const el = document.getElementById(k); if (!el) continue; if (t === 'bool') el.checked = !!settings[k]; else el.value = settings[k] ?? ''; }
    $('#providerOrder').value = (settings.providerOrder || CDS.DEFAULTS.providerOrder).join(',');
    $('#th_steal').value = settings.thresholds.steal; $('#th_offer').value = settings.thresholds.offer; $('#th_fair').value = settings.thresholds.fair;
    $('#fee_ebay_pct').value = settings.fees.ebay.pct; $('#fee_ebay_fixed').value = settings.fees.ebay.processingFixed;
    $('#fee_mercari_pct').value = settings.fees.mercari.pct; $('#fee_mercari_ppct').value = settings.fees.mercari.processingPct; $('#fee_mercari_fixed').value = settings.fees.mercari.processingFixed;
    $('#site_mercari').checked = settings.sites.mercari !== false; $('#site_ebay').checked = settings.sites.ebay !== false; $('#site_generic').checked = settings.sites.generic !== false;
  }
  fill();
  for (const [k, t] of Object.entries(FIELDS)) {
    const el = document.getElementById(k); if (!el) continue;
    el.addEventListener('change', async () => {
      const v = t === 'bool' ? el.checked : t === 'num' ? parseFloat(el.value) : el.value.trim();
      if (t === 'num' && isNaN(v)) return;
      await save({ [k]: v });
      if (k === 'justtcgApiKey' || k === 'pricechartingToken') await send({ type: 'cds:clearCache' });
    });
  }
  $('#providerOrder').addEventListener('change', (e) => save({ providerOrder: e.target.value.split(',') }));
  for (const id of ['th_steal', 'th_offer', 'th_fair']) document.getElementById(id).addEventListener('change', () => save({ thresholds: { steal: parseFloat($('#th_steal').value), offer: parseFloat($('#th_offer').value), fair: parseFloat($('#th_fair').value) } }));
  const feeSave = () => save({ fees: { ebay: { pct: parseFloat($('#fee_ebay_pct').value), processingPct: 0, processingFixed: parseFloat($('#fee_ebay_fixed').value) }, mercari: { pct: parseFloat($('#fee_mercari_pct').value), processingPct: parseFloat($('#fee_mercari_ppct').value), processingFixed: parseFloat($('#fee_mercari_fixed').value) } } });
  for (const id of ['fee_ebay_pct', 'fee_ebay_fixed', 'fee_mercari_pct', 'fee_mercari_ppct', 'fee_mercari_fixed']) document.getElementById(id).addEventListener('change', feeSave);
  const siteSave = () => save({ sites: { mercari: $('#site_mercari').checked, ebay: $('#site_ebay').checked, generic: $('#site_generic').checked } });
  for (const id of ['site_mercari', 'site_ebay', 'site_generic']) document.getElementById(id).addEventListener('change', siteSave);

  // ---- provider tests ----------------------------------------------------------
  document.querySelectorAll('button[data-test]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.test; const out = $('#' + id + 'Status');
    // make sure the latest typed key is saved first
    const keyEl = $('#' + (id === 'justtcg' ? 'justtcgApiKey' : 'pricechartingToken'));
    await save({ [id === 'justtcg' ? 'justtcgApiKey' : 'pricechartingToken']: keyEl.value.trim() });
    out.textContent = 'Testing…'; out.className = 'hint';
    const res = await send({ type: 'cds:testProvider', provider: id });
    out.textContent = res && res.ok ? '✓ ' + res.message : '✗ ' + (res && res.message || 'failed');
    out.className = 'hint ' + (res && res.ok ? 'ok' : 'err');
    if (id === 'justtcg' && res && res.ok && res.games) {
      const ja = res.games.find((g) => /pokemon/i.test(g.id + ' ' + g.name) && /japan/i.test(g.id + ' ' + g.name));
      const en = res.games.find((g) => /^pokemon$/i.test(g.id) || /^pok[eé]mon$/i.test(g.name));
      const patch = {};
      if (ja && !settings.justtcgGameJa) patch.justtcgGameJa = ja.id;
      if (en && !settings.justtcgGameEn) patch.justtcgGameEn = en.id;
      if (Object.keys(patch).length) { await save(patch); fill(); }
      if (!ja) out.textContent += ' — no Japanese Pokémon game found; JP lookups will search all games and prefer Japanese sets.';
    }
  }));
  $('#btnClearCache').addEventListener('click', async () => { await send({ type: 'cds:clearCache' }); flashSaved(); });

  // ---- watchlist ---------------------------------------------------------------
  async function renderWatch() {
    const list = await CDS.getWatchlist();
    const tb = $('#watchTable tbody'); tb.innerHTML = '';
    if (!list.length) tb.innerHTML = '<tr><td colspan="7" class="muted">Nothing yet.</td></tr>';
    for (const w of list) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><b>${esc(w.name)}</b></td><td>${esc(w.number || '')}</td><td>${esc(w.setCode || '')}</td><td>${esc(w.language || 'any')}</td><td>${w.maxPrice ? '$' + w.maxPrice : ''}</td><td class="muted">${esc(w.note || '')}</td><td><button class="danger" data-del="${w.id}">remove</button></td>`;
      tb.append(tr);
    }
    tb.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', async () => { await CDS.setWatchlist((await CDS.getWatchlist()).filter((w) => w.id !== b.dataset.del)); renderWatch(); flashSaved(); }));
  }
  $('#btnAddWatch').addEventListener('click', async () => {
    const name = $('#w_name').value.trim(); if (!name) return;
    const list = await CDS.getWatchlist();
    list.push({ id: CDS.uid(), name, number: $('#w_number').value.trim().replace(/^#/, ''), setCode: $('#w_set').value.trim(), language: $('#w_lang').value, maxPrice: parseFloat($('#w_max').value) || null, note: '', createdAt: Date.now() });
    await CDS.setWatchlist(list);
    ['w_name', 'w_number', 'w_set', 'w_max'].forEach((id) => { document.getElementById(id).value = ''; });
    renderWatch(); flashSaved();
  });
  renderWatch();

  // ---- saved searches ------------------------------------------------------------
  async function renderSearches() {
    const list = await CDS.getSavedSearches();
    const tb = $('#searchTable tbody'); tb.innerHTML = '';
    if (!list.length) tb.innerHTML = '<tr><td colspan="4" class="muted">No saved searches. Paste a Mercari/eBay search URL above.</td></tr>';
    for (const s of list) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><b>${esc(s.label || '')}</b></td><td class="url" title="${esc(s.url)}"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></td><td><input type="checkbox" data-toggle="${s.id}" ${s.enabled !== false ? 'checked' : ''}></td><td><button class="danger" data-del="${s.id}">remove</button></td>`;
      tb.append(tr);
    }
    tb.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', async () => { await CDS.setSavedSearches((await CDS.getSavedSearches()).filter((s) => s.id !== b.dataset.del)); renderSearches(); flashSaved(); }));
    tb.querySelectorAll('input[data-toggle]').forEach((c) => c.addEventListener('change', async () => { const l = await CDS.getSavedSearches(); const s = l.find((x) => x.id === c.dataset.toggle); if (s) s.enabled = c.checked; await CDS.setSavedSearches(l); flashSaved(); }));
  }
  $('#btnAddSearch').addEventListener('click', async () => {
    const url = $('#s_url').value.trim(); if (!/^https?:\/\//.test(url)) return;
    const list = await CDS.getSavedSearches();
    list.push({ id: CDS.uid(), label: $('#s_label').value.trim() || new URL(url).hostname, url, enabled: true });
    await CDS.setSavedSearches(list); $('#s_url').value = ''; $('#s_label').value = ''; renderSearches(); flashSaved();
  });
  $('#btnPatrolNow').addEventListener('click', async () => { if (!settings.patrolEnabled) { await save({ patrolEnabled: true }); fill(); } await send({ type: 'cds:patrolNow' }); flashSaved(); });
  renderSearches();

  // ---- manual sheet --------------------------------------------------------------
  async function loadSheet() {
    const rows = await CDS.getManualSheet();
    $('#sheetStatus').textContent = rows.length ? `${rows.length} rows saved` : 'empty';
    if (rows.length && !$('#sheetText').value) $('#sheetText').value = 'name,number,set,language,nm,lp,note\n' + rows.map((r) => [r.name, r.number, r.setCode, r.language, r.nm, r.lp, r.note].map((v) => /[",\n]/.test(String(v ?? '')) ? '"' + String(v).replace(/"/g, '""') + '"' : (v ?? '')).join(',')).join('\n');
  }
  $('#btnImportSheet').addEventListener('click', async () => {
    const rows = CDS.parseManualCsv($('#sheetText').value);
    await CDS.setManualSheet(rows); await send({ type: 'cds:clearCache' });
    $('#sheetStatus').textContent = `${rows.length} rows saved`; flashSaved();
  });
  $('#sheetFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; $('#sheetText').value = await f.text(); });
  loadSheet();

  // ---- extra sites ------------------------------------------------------------------
  async function renderSites() {
    const sites = await new Promise((r) => chrome.storage.sync.get('enabledSites', (x) => r(x.enabledSites || [])));
    const el = $('#extraSites');
    if (!sites.length) { el.textContent = 'none — use "Enable on this site" in the popup'; return; }
    el.innerHTML = sites.map((s) => `<span class="inline" style="margin-right:12px">${esc(s)} <button data-site="${esc(s)}" class="danger">remove</button></span>`).join('');
    el.querySelectorAll('button[data-site]').forEach((b) => b.addEventListener('click', async () => { await send({ type: 'cds:unregisterSite', origin: b.dataset.site }); renderSites(); }));
  }
  renderSites();

  // ---- backup ---------------------------------------------------------------------------
  $('#btnExport').addEventListener('click', async () => {
    const data = { settings: await CDS.getSettings(), watchlist: await CDS.getWatchlist(), savedSearches: await CDS.getSavedSearches(), manualSheet: await CDS.getManualSheet(), exportedAt: new Date().toISOString() };
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = 'card-deal-scout-backup.json'; a.click();
  });
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.settings) await CDS.replaceSettings(data.settings);
      if (data.watchlist) await CDS.setWatchlist(data.watchlist);
      if (data.savedSearches) await CDS.setSavedSearches(data.savedSearches);
      if (data.manualSheet) await CDS.setManualSheet(data.manualSheet);
      settings = await CDS.getSettings(); fill(); renderWatch(); renderSearches(); loadSheet(); flashSaved();
    } catch (err) { alert('Import failed: ' + err.message); }
  });
  $('#btnReset').addEventListener('click', async () => { if (!confirm('Reset all settings to defaults? (watchlist, searches and sheet are kept)')) return; await CDS.replaceSettings({}); settings = await CDS.getSettings(); fill(); flashSaved(); });
})();
