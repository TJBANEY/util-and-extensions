/* Card Deal Scout — popup (Deal Digest) */
(async function () {
  const $ = (s) => document.querySelector(s);
  const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; r(res); }));
  const sendTab = (tabId, msg) => new Promise((r) => chrome.tabs.sendMessage(tabId, msg, (res) => { void chrome.runtime.lastError; r(res); }));
  const money = CDS.fmtMoney, pct = CDS.fmtPct;

  const CONTENT_JS = ['lib/storage.js', 'lib/card-parser.js', 'lib/condition-sniffer.js', 'lib/deal-scorer.js', 'content/adapters/mercari.js', 'content/adapters/ebay.js', 'content/adapters/generic.js', 'content/adapters/index.js', 'content/content.js'];

  const state = { tab: null, deals: [], filter: new Set(['steal', 'offer', 'fair', 'over', 'slab', 'lot', 'unknown']), sort: 'ratio', hideSeen: false };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  $('#btnOptions').onclick = () => chrome.runtime.openOptionsPage();

  const settings = await CDS.getSettings();
  try { const st = JSON.parse(localStorage.getItem('cds.popup') || '{}'); if (st.sort) state.sort = st.sort; if (st.hideSeen) state.hideSeen = true; } catch (e) { /* ignore */ }
  $('#sort').value = state.sort; $('#hideSeen').checked = state.hideSeen;
  const savePopupState = () => { try { localStorage.setItem('cds.popup', JSON.stringify({ sort: state.sort, hideSeen: state.hideSeen })); } catch (e) { /* ignore */ } };

  async function statusLine() {
    const st = await send({ type: 'cds:getStatus' });
    const parts = [];
    const hasKey = !!settings.justtcgApiKey || !!settings.pricechartingToken;
    if (!hasKey) parts.push('<span class="warn">No API key set — add one in options</span>');
    else {
      const j = st && st.providers && st.providers.justtcg;
      if (settings.justtcgApiKey) parts.push('JustTCG' + (j && j.remaining != null ? ` · ${j.remaining} left` : '') + (j && j.lastError ? ` · <span class="warn">${escapeHtml(j.lastError).slice(0, 40)}</span>` : ''));
      if (settings.pricechartingToken) parts.push('PriceCharting');
    }
    if (settings.patrolEnabled) parts.push(`patrol ${settings.patrolIntervalMin}m` + (st && st.lastPatrol ? ` · last ${new Date(st.lastPatrol).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''));
    $('#status').innerHTML = `<span>${parts.join(' · ')}</span><span>v${CDS.VERSION}</span>`;
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function load() {
    const ping = tab && /^https?:/.test(tab.url || '') ? await sendTab(tab.id, { type: 'cds:ping' }) : null;
    if (!ping || !ping.ok) {
      $('#unsupported').classList.remove('hidden'); $('#main').classList.add('hidden');
      const ok = tab && /^https?:/.test(tab.url || '');
      $('#btnEnable').disabled = !ok;
      $('#unsupportedMsg').textContent = ok ? 'Card Deal Scout isn\'t running on this page.' : 'This page can\'t be scanned (browser or extension page).';
      $('#site').textContent = '';
      return;
    }
    $('#unsupported').classList.add('hidden'); $('#main').classList.remove('hidden');
    $('#site').textContent = `${ping.site || 'generic'} · ${ping.pageType}`;
    const res = await sendTab(tab.id, { type: 'cds:getPageDeals' });
    state.deals = (res && res.deals) || [];
    render();
  }

  function sortDeals(deals) {
    const by = {
      ratio: (a, b) => (a.ratio ?? 9) - (b.ratio ?? 9),
      savings: (a, b) => ((b.basisPrice || 0) - b.asking) - ((a.basisPrice || 0) - a.asking),
      price: (a, b) => a.asking - b.asking,
      flip: (a, b) => (b.flipNet ?? -1e9) - (a.flipNet ?? -1e9)
    }[state.sort] || ((a, b) => 0);
    return deals.slice().sort((a, b) => (b.watchHit - a.watchHit) || by(a, b));
  }

  function render() {
    const counts = {};
    state.deals.forEach((d) => { counts[d.tier] = (counts[d.tier] || 0) + 1; });
    const watch = state.deals.filter((d) => d.watchHit).length;
    const chips = $('#chips'); chips.innerHTML = '';
    for (const t of ['steal', 'offer', 'fair', 'over', 'slab', 'lot', 'unknown']) {
      if (!counts[t]) continue;
      const c = document.createElement('span');
      c.className = `chip ${t}` + (state.filter.has(t) ? ' on' : '');
      c.textContent = `${CDS.TIERS[t].short} ${counts[t]}`;
      c.onclick = () => { if (state.filter.has(t)) state.filter.delete(t); else state.filter.add(t); render(); };
      chips.append(c);
    }
    if (watch) { const c = document.createElement('span'); c.className = 'chip watch on'; c.textContent = `★ ${watch} watch`; chips.append(c); }
    const list = $('#list'); list.innerHTML = '';
    const visible = sortDeals(state.deals.filter((d) => state.filter.has(d.tier) && !(state.hideSeen && d.seen)));
    if (!visible.length) { list.innerHTML = `<li class="empty">${state.deals.length ? 'Nothing matches the current filter.' : 'No cards detected on this page yet. Scroll a bit or hit ↻.'}</li>`; }
    for (const d of visible) {
      const li = document.createElement('li');
      li.className = 'row' + (d.seen ? ' seen' : '');
      const diffCls = d.pctDiff == null ? '' : d.pctDiff < -0.05 ? 'good' : d.pctDiff > 0.1 ? 'bad' : '';
      li.innerHTML = `
        <span class="pill ${d.tier}">${d.watchHit ? '★ ' : ''}${escapeHtml(d.label)}</span>
        <div><div class="name" title="${escapeHtml(d.title)}">${escapeHtml(d.name || d.title)}${d.number ? ' #' + escapeHtml(d.number) : ''}</div>
          <div class="sub">${d.basisPrice ? `market ${money(d.basisPrice)} (${escapeHtml(d.basisTier || '')})` : escapeHtml(d.status || '')}${d.condition ? ' · ' + escapeHtml(d.condition) : ''}${d.offer ? ' · offer ' + money(d.offer) : ''}${d.flipNet != null ? ' · flip ' + money(d.flipNet) : ''}</div></div>
        <div class="num"><b>${money(d.asking)}</b><span class="${diffCls}">${d.pctDiff != null ? pct(d.pctDiff) : ''}</span></div>`;
      li.onclick = (ev) => { if (ev.shiftKey || ev.metaKey || ev.ctrlKey) chrome.tabs.create({ url: d.url, active: false }); else sendTab(tab.id, { type: 'cds:jumpTo', key: d.key }); };
      li.title = 'Click: scroll to it · Shift/Ctrl-click: open in new tab';
      list.append(li);
    }
    $('#btnOpenSteals').disabled = !state.deals.some((d) => d.tier === 'steal');
    $('#btnOpenSteals').textContent = counts.steal ? `Open ${Math.min(counts.steal, 15)} steal${counts.steal > 1 ? 's' : ''}` : 'Open all steals';
  }

  $('#sort').onchange = (e) => { state.sort = e.target.value; savePopupState(); render(); };
  $('#hideSeen').onchange = (e) => { state.hideSeen = e.target.checked; savePopupState(); render(); };
  $('#btnRescan').onclick = async () => { await sendTab(tab.id, { type: 'cds:rescan' }); setTimeout(load, 1500); };
  $('#btnOpenSteals').onclick = () => send({ type: 'cds:openTabs', urls: state.deals.filter((d) => d.tier === 'steal').map((d) => d.url) });
  $('#btnCsv').onclick = () => {
    const cols = ['tier', 'label', 'name', 'number', 'set', 'language', 'condition', 'asking', 'basisTier', 'basisPrice', 'pctDiff', 'offer', 'flipNet', 'watchHit', 'url', 'title'];
    const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const rows = [cols.join(',')].concat(sortDeals(state.deals).map((d) => cols.map((c) => esc(c === 'pctDiff' && d[c] != null ? Math.round(d[c] * 1000) / 10 + '%' : d[c])).join(',')));
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `deal-digest-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  };
  $('#btnEnable').onclick = async () => {
    const origin = new URL(tab.url).origin;
    const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
    if (!granted) return;
    await send({ type: 'cds:registerSite', origin });
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/overlay.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_JS });
    } catch (e) { console.warn(e); }
    setTimeout(load, 1200);
  };

  statusLine();
  load();
  // live refresh while the page keeps pricing cards
  const iv = setInterval(async () => { if ($('#main').classList.contains('hidden')) return; const res = await sendTab(tab.id, { type: 'cds:getPageDeals' }); if (res && res.deals) { state.deals = res.deals; render(); } }, 2000);
  window.addEventListener('unload', () => clearInterval(iv));
})();
