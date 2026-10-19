/* Card Deal Scout — content script: scans list/detail pages, asks the service worker for prices, draws badges. */
(function () {
  if (window.__cdsLoaded) return;
  window.__cdsLoaded = true;
  const CDS = globalThis.CDS;
  if (!CDS || typeof chrome === 'undefined' || !chrome.runtime) return;

  const state = {
    settings: null, watchlist: [], seen: {}, adapter: null, pageType: 'other',
    entries: new Map(), // key → entry
    detail: null, lastUrl: location.href, scanning: false, scanAgain: false, notified: new Set()
  };
  const log = (...a) => { if (state.settings && state.settings.debug) console.log('[CDS]', ...a); };
  const send = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; resolve(res); }); } catch (e) { resolve(null); }
  });
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = CDS.fmtMoney, pct = CDS.fmtPct;

  // ---------------------------------------------------------------------------
  // init + live settings
  // ---------------------------------------------------------------------------
  async function init() {
    state.settings = await CDS.getSettings();
    state.watchlist = await CDS.getWatchlist();
    state.seen = await CDS.getSeen();
    state.adapter = CDS.pickAdapter(location, state.settings);
    if (!state.adapter) return log('site disabled');
    log('adapter', state.adapter.id);
    observe();
    scan();
  }
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'sync' && (changes.settings || changes.watchlist)) {
      state.settings = await CDS.getSettings();
      state.watchlist = await CDS.getWatchlist();
      for (const e of state.entries.values()) { computeDeal(e); renderBadge(e); }
      if (state.detail) { computeDeal(state.detail); renderPanel(state.detail); }
      report();
    }
  });

  // ---------------------------------------------------------------------------
  // scanning
  // ---------------------------------------------------------------------------
  let scanTimer = null;
  function requestScan(delay = 350) { clearTimeout(scanTimer); scanTimer = setTimeout(scan, delay); }

  async function scan() {
    if (!state.adapter) return;
    if (state.scanning) { state.scanAgain = true; return; }
    state.scanning = true;
    try {
      state.pageType = state.adapter.pageType(location);
      if (state.pageType === 'detail') await scanDetail();
      else if (state.pageType === 'list') await scanList();
    } catch (e) { console.warn('[CDS] scan error', e); }
    finally {
      state.scanning = false;
      if (state.scanAgain) { state.scanAgain = false; requestScan(200); }
    }
  }

  async function scanList() {
    const cells = state.adapter.listCells();
    const fresh = [];
    for (const cell of cells) {
      if (cell.dataset.cdsCell) {
        // re-attach badge if the site re-rendered the cell's innards (SPA virtualisation)
        const e = state.entries.get(cell.dataset.cdsCell);
        if (e && e.badge && !e.badge.isConnected) { e.info = state.adapter.extractCell(cell) || e.info; renderBadge(e); }
        continue;
      }
      const info = state.adapter.extractCell(cell);
      if (!info || !info.title) continue;
      const key = state.adapter.id + ':' + info.id;
      cell.dataset.cdsCell = key;
      const parsed = CDS.parseCardTitle(info.title);
      const sniff = CDS.sniffCondition({ title: info.title });
      const entry = { key, cell, info, parsed, sniff, result: null, deal: null, badge: null, kind: 'list' };
      state.entries.set(key, entry);
      if (!parsed.name || !(info.price > 0) || info.price < (state.settings.minPriceForBadge || 0)) {
        entry.result = { status: (sniff.isLot || parsed.isLot) ? 'lot' : 'unparsed' }; computeDeal(entry); renderBadge(entry); continue;
      }
      entry.result = { status: 'loading' }; computeDeal(entry); renderBadge(entry);
      fresh.push(entry);
    }
    // prune entries whose cells left the DOM
    for (const [k, e] of state.entries) if (!e.cell.isConnected) state.entries.delete(k);
    if (fresh.length) await lookupBatch(fresh);
    report();
  }

  async function lookupBatch(entries) {
    const CH = 12;
    for (let i = 0; i < entries.length; i += CH) {
      const chunk = entries.slice(i, i + CH);
      const res = await send({ type: 'cds:lookupBatch', items: chunk.map((e) => ({ key: e.key, parsed: e.parsed })) });
      for (const e of chunk) {
        e.result = (res && res[e.key]) || { status: 'error', error: 'no response from background' };
        computeDeal(e); renderBadge(e);
      }
      report();
    }
  }

  async function scanDetail() {
    const info = state.adapter.extractDetail();
    if (!info || !info.title) return;
    const key = state.adapter.id + ':' + info.id;
    if (state.detail && state.detail.key === key && state.detail.panel && state.detail.panel.isConnected) return;
    if (state.detail && state.detail.panel) state.detail.panel.remove();
    const parsed = CDS.parseCardTitle(info.title);
    const sniff = CDS.sniffCondition({ title: info.title, description: info.description, siteCondition: info.siteCondition });
    const entry = { key, info, parsed, sniff, result: { status: 'loading' }, deal: null, panel: null, kind: 'detail' };
    state.detail = entry;
    computeDeal(entry); renderPanel(entry);
    send({ type: 'cds:markSeen', key });
    if (!parsed.name) { entry.result = { status: 'unparsed' }; computeDeal(entry); renderPanel(entry); return; }
    const res = await send({ type: 'cds:lookup', parsed });
    entry.result = res || { status: 'error', error: 'no response' };
    computeDeal(entry); renderPanel(entry);
    const hist = await send({ type: 'cds:getHistory', key: CDS.lookupKey(parsed) });
    if (hist && hist.history && hist.history.length > 1) { entry.history = hist.history; renderPanel(entry); }
    report();
  }

  // ---------------------------------------------------------------------------
  // scoring
  // ---------------------------------------------------------------------------
  function computeDeal(e) {
    const s = state.settings;
    const r = e.result || {};
    const asking = e.info.price;
    const graded = e.sniff.graded || e.parsed.graded;
    const isLot = e.sniff.isLot || e.parsed.isLot;
    if (r.status === 'ok' && r.prices) {
      // graded slab with a matching graded comp (PriceCharting) → compare against that grade instead of raw
      const gp = graded && graded.grade != null && r.primary && r.primary.graded ? r.primary.graded[String(graded.grade)] : null;
      if (gp && !isLot) {
        e.deal = CDS.scoreDeal({ asking, prices: { NM: gp }, tier: null, settings: s, graded: null, isLot: false });
        e.deal.basisTier = `${graded.company || 'graded'} ${graded.grade}`;
        e.deal.gradedBasis = true;
        e.deal.range = null;
      } else {
        e.deal = CDS.scoreDeal({ asking, prices: r.prices, tier: e.sniff.tier, settings: s, graded, isLot });
      }
      e.deal.graded = graded;
      e.offer = e.deal.tier === 'slab' ? null : CDS.suggestOffer({ asking, basisPrice: e.deal.basisPrice, settings: s });
      const resale = e.deal.gradedBasis ? e.deal.basisPrice : (r.prices.NM || e.deal.basisPrice);
      e.flip = e.deal.tier === 'slab' ? null : CDS.estimateFlip({ cost: asking, resale, settings: s });
      e.flipAtOffer = e.offer && e.offer.offer ? CDS.estimateFlip({ cost: e.offer.offer, resale, settings: s }) : null;
      e.breakEven = e.deal.tier === 'slab' ? null : CDS.breakEven({ resale, settings: s });
    } else {
      const t = r.status === 'loading' ? 'loading' : r.status === 'nosource' ? 'nosource' : r.status === 'error' ? 'error' : r.status === 'lot' ? 'lot' : 'unknown';
      e.deal = { tier: t, label: t === 'loading' ? 'PRICING' : (CDS.TIERS[t] || CDS.TIERS.unknown).label, basisPrice: null, ratio: null, pctDiff: null, blurb: (CDS.TIERS[t] || CDS.TIERS.unknown).blurb, graded };
      if (r.status === 'nomatch') e.deal.blurb = 'No pricing match for this title — try the manual sheet or check the card name/number.';
      e.offer = null; e.flip = null; e.flipAtOffer = null;
    }
    e.watchHit = state.watchlist.some((w) => CDS.matchesWatch(e.parsed, asking, e.deal, w));
    if (e.watchHit && !state.notified.has(e.key) && r.status !== 'loading') {
      state.notified.add(e.key);
      send({ type: 'cds:watchHit', deal: dealSummary(e) });
    }
  }

  function dealSummary(e) {
    return {
      key: e.key, site: state.adapter.id, name: e.result && e.result.primary ? e.result.primary.matchedName : e.parsed.name, title: e.info.title, url: e.info.url,
      asking: e.info.price, tier: e.deal.tier, label: e.deal.label, basisPrice: e.deal.basisPrice, basisTier: e.deal.basisTier, ratio: e.deal.ratio, pctDiff: e.deal.pctDiff,
      prices: e.result && e.result.prices, condition: e.sniff.tier, offer: e.offer && e.offer.offer, flipNet: e.flip && e.flip.net, watchHit: !!e.watchHit,
      number: e.parsed.number, set: e.result && e.result.primary ? e.result.primary.matchedSet : (e.parsed.setHint || e.parsed.setCode || ''), language: e.parsed.language, seen: !!state.seen[e.key], status: e.result && e.result.status
    };
  }

  let reportTimer = null;
  function report() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      const deals = [...state.entries.values()].map(dealSummary);
      if (state.detail) deals.push(dealSummary(state.detail));
      const counts = {};
      deals.forEach((d) => { counts[d.tier] = (counts[d.tier] || 0) + 1; });
      send({ type: 'cds:scanReport', site: state.adapter.id, pageType: state.pageType, url: location.href, deals, counts });
    }, 250);
  }

  // ---------------------------------------------------------------------------
  // badges (list pages)
  // ---------------------------------------------------------------------------
  function badgeText(e) {
    const d = e.deal; const r = e.result || {};
    const gradedTag = d.graded && d.graded.grade != null ? `${d.graded.company || ''} ${d.graded.grade}`.trim() : null;
    const l1 = [h('span', { class: 'cds-lab' }, d.label)];
    if (d.tier === 'slab') { if (gradedTag) l1.push(h('span', { class: 'cds-pct' }, gradedTag)); }
    else if (d.pctDiff != null) l1.push(h('span', { class: 'cds-pct' }, pct(d.pctDiff) + (d.gradedBasis && gradedTag ? ' · ' + gradedTag : '')));
    let l2 = null;
    if (d.gradedBasis) l2 = h('div', { class: 'cds-l2' }, `${gradedTag} comp ${$(d.basisPrice)}`);
    else if (d.range) {
      const range = d.range.lo === d.range.hi ? $(d.range.lo) : `${$(d.range.lo)}–${$(d.range.hi)}`;
      l2 = h('div', { class: 'cds-l2' }, `${d.tier === 'slab' ? 'raw ' : 'LP–NM '}${range}`);
      const tr = r.primary && r.primary.trend && r.primary.trend.d7;
      if (state.settings.showTrend && typeof tr === 'number' && Math.abs(tr) >= 1) l2.append(h('span', { class: 'cds-trend ' + (tr > 0 ? 'cds-up' : 'cds-down') }, (tr > 0 ? '▲' : '▼') + Math.round(Math.abs(tr)) + '%'));
    } else if (d.tier === 'unknown' && r.status === 'nomatch') l2 = h('div', { class: 'cds-l2' }, 'no match');
    else if (d.tier === 'unknown' && r.status === 'unparsed') l2 = h('div', { class: 'cds-l2' }, e.parsed.isSealed ? 'sealed / not a single' : 'not a card?');
    return [h('div', { class: 'cds-l1' }, ...l1), l2];
  }

  function renderBadge(e) {
    const s = state.settings;
    const d = e.deal;
    if (d.tier === 'unknown' && !s.showUnknownBadge) { if (e.badge) e.badge.remove(); return; }
    const mount = e.info.mount || e.cell;
    if (getComputedStyle(mount).position === 'static') mount.classList.add('cds-host-rel');
    if (!e.badge || !e.badge.isConnected) {
      e.badge = h('div', { class: 'cds-badge', 'data-cds-key': e.key, onmouseenter: () => showPop(e, e.badge), onmouseleave: () => hidePopSoon(), onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); showPop(e, e.badge, true); } });
      mount.append(e.badge);
    }
    e.badge.className = `cds-badge cds-tier-${d.tier}` + (e.watchHit ? ' cds-watch' : '') + (s.dimSeen && state.seen[e.key] ? ' cds-seen' : '') + (e.info.isSold ? ' cds-sold' : '');
    e.badge.style.top = e.badge.style.left = e.badge.style.right = e.badge.style.bottom = '';
    if (s.badgePosition === 'top-right') { e.badge.style.left = 'auto'; e.badge.style.right = '6px'; }
    if (s.badgePosition === 'bottom-left') { e.badge.style.top = 'auto'; e.badge.style.bottom = '6px'; }
    e.badge.replaceChildren(...badgeText(e).filter(Boolean));
    if (e.cell) e.cell.classList.toggle('cds-watch-cell', !!e.watchHit);
  }

  // mark seen when a cell is clicked
  document.addEventListener('click', (ev) => {
    const cell = ev.target.closest && ev.target.closest('[data-cds-cell]');
    if (!cell || (ev.target.closest && ev.target.closest('.cds-badge'))) return;
    const e = state.entries.get(cell.dataset.cdsCell);
    if (e) { state.seen[e.key] = Date.now(); send({ type: 'cds:markSeen', key: e.key }); }
  }, true);

  // ---------------------------------------------------------------------------
  // shared popover
  // ---------------------------------------------------------------------------
  let pop = null, popTimer = null, popPinned = false, popEntry = null;
  function ensurePop() {
    if (pop) return pop;
    pop = h('div', { id: 'cds-pop', onmouseenter: () => clearTimeout(popTimer), onmouseleave: () => hidePopSoon() });
    document.body.append(pop);
    document.addEventListener('click', (ev) => { if (popPinned && !pop.contains(ev.target) && !(ev.target.closest && ev.target.closest('.cds-badge'))) hidePop(); }, true);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hidePop(); });
    return pop;
  }
  function hidePop() { popPinned = false; popEntry = null; if (pop) pop.classList.remove('cds-open'); }
  function hidePopSoon() { if (popPinned) return; clearTimeout(popTimer); popTimer = setTimeout(hidePop, 180); }
  function showPop(e, anchor, pin) {
    clearTimeout(popTimer);
    const p = ensurePop();
    if (pin) popPinned = !(popPinned && popEntry === e); else if (popPinned && popEntry !== e) return;
    popEntry = e;
    p.replaceChildren(...popContent(e));
    p.classList.add('cds-open');
    const r = anchor.getBoundingClientRect();
    const w = 300, hgt = p.offsetHeight || 260;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 6);
    p.style.left = left + 'px'; p.style.top = top + 'px';
  }

  function crossLinks(e) {
    const p = e.parsed;
    const q = [p.language === 'ja' ? 'Japanese' : '', p.name, p.number ? p.number + (p.total ? '/' + p.total : '') : '', 'pokemon'].filter(Boolean).join(' ');
    const enc = encodeURIComponent(q);
    const links = [
      ['eBay sold', `https://www.ebay.com/sch/i.html?_nkw=${enc}&LH_Sold=1&LH_Complete=1&_sop=13`],
      ['TCGplayer', `https://www.tcgplayer.com/search/pokemon${p.language === 'ja' ? '-japan' : ''}/product?q=${encodeURIComponent((p.name || '') + (p.number ? ' ' + p.number : ''))}&view=grid`],
      ['PriceCharting', `https://www.pricecharting.com/search-products?type=prices&q=${enc}`],
      ['130point', `https://130point.com/sales/`]
    ];
    if (e.result && e.result.primary && e.result.primary.url) links.unshift([e.result.primary.sourceLabel.split(' ')[0], e.result.primary.url]);
    return h('div', { class: 'cds-links' }, ...links.map(([t, u]) => h('a', { href: u, target: '_blank', rel: 'noopener' }, t + ' ↗')));
  }

  function flagsBox(e, cls) {
    const flags = [...(e.sniff.flags || [])];
    if (e.parsed.confidence < 0.6) flags.push('low-confidence title match — verify the card');
    if (e.result && e.result.primary && e.result.primary.matchScore < 70) flags.push(`fuzzy match (${e.result.primary.matchScore}/100)`);
    const tr = e.result && e.result.primary && e.result.primary.trend;
    if (tr && typeof tr.d7 === 'number' && tr.d7 <= -10) flags.push(`falling knife: ${Math.round(tr.d7)}% in 7 days`);
    if (tr && typeof tr.d7 === 'number' && tr.d7 >= 15) flags.push(`spiking: +${Math.round(tr.d7)}% in 7 days`);
    return flags.length ? h('div', { class: cls || 'cds-flags' }, '⚠ ' + flags.join(' · ')) : null;
  }

  function watchBtn(e, cls) {
    const already = state.watchlist.some((w) => w.name && e.parsed.name && w.name.toLowerCase() === e.parsed.name.toLowerCase() && (!w.number || w.number === e.parsed.number));
    return h('button', { class: cls, onclick: async (ev) => {
      ev.stopPropagation();
      const list = await CDS.getWatchlist();
      if (already) { await CDS.setWatchlist(list.filter((w) => !(w.name.toLowerCase() === e.parsed.name.toLowerCase() && (!w.number || w.number === e.parsed.number)))); toast('Removed from watchlist'); }
      else {
        const maxPrice = e.deal && e.deal.basisPrice ? Math.round(e.deal.basisPrice * (state.settings.thresholds.offer || 0.92)) : null;
        list.push({ id: CDS.uid(), name: e.parsed.name, number: e.parsed.number || '', setCode: e.parsed.setCode || '', language: e.parsed.language, maxPrice, note: e.info.title.slice(0, 80), createdAt: Date.now() });
        await CDS.setWatchlist(list); toast(`Watching ${e.parsed.name}${maxPrice ? ' under ' + $(maxPrice) : ''}`);
      }
      state.watchlist = await CDS.getWatchlist();
    } }, already ? '★ Watching' : '☆ Watch this card');
  }

  const gradedTag = (d) => (d.graded && d.graded.grade != null ? `${d.graded.company || 'Graded'} ${d.graded.grade}` : 'Graded');

  function matchedLine(e) {
    const r = e.result && e.result.primary;
    if (!r) return null;
    return h('div', { class: 'cds-pop-sub' }, `${r.matchedName}${r.matchedNumber ? ' #' + r.matchedNumber : ''}${r.matchedSet ? ' · ' + r.matchedSet : ''}${r.printing && r.printing !== 'Ungraded' ? ' · ' + r.printing : ''}`);
  }

  function popContent(e) {
    const d = e.deal, r = e.result || {}, pr = r.primary;
    const nodes = [];
    nodes.push(h('div', { class: 'cds-pop-head' }, h('span', { class: 'cds-pill ' + d.tier }, d.label), h('div', {}, h('div', { class: 'cds-pop-title' }, e.parsed.name || e.info.title.slice(0, 60)), matchedLine(e))));
    if (d.blurb) nodes.push(h('div', { class: 'cds-blurb' }, d.blurb));
    if (r.status === 'ok' && r.prices) {
      const g = h('div', { class: 'cds-grid' });
      const row = (k, v, cls) => { g.append(h('span', { class: 'cds-k' }, k), h('span', { class: cls || '' }, v)); };
      row('Asking', h('b', {}, $(e.info.price)));
      row(d.tier === 'slab' || d.gradedBasis ? 'Raw market' : 'Market', `NM ${$(r.prices.NM)}${r.prices.LP != null ? ' · LP ' + $(r.prices.LP) : ''}${r.prices.MP != null ? ' · MP ' + $(r.prices.MP) : ''}`);
      if (d.tier === 'slab') row('Graded', h('span', { class: 'cds-warn' }, `${gradedTag(d)} — no graded comp from this source; raw shown for reference`));
      else row('Vs ' + d.basisTier, h('span', { class: d.pctDiff < -0.05 ? 'cds-good' : d.pctDiff > 0.1 ? 'cds-bad' : '' }, `${$(d.basisPrice)} → ${pct(d.pctDiff)}`));
      row('Condition', d.graded && d.graded.grade != null ? `${gradedTag(d)} slab` : `${e.sniff.tier ? CDS.tierLabel(e.sniff.tier) : 'unknown'}${e.sniff.source !== 'unknown' ? ' (' + e.sniff.source + ')' : ''}`);
      if (e.offer && e.offer.offer) row('Offer', h('span', {}, h('b', { class: 'cds-good' }, $(e.offer.offer)), ` (${pct(-e.offer.pctBelowAsk)} vs ask) `, h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); navigator.clipboard.writeText(String(e.offer.offer)).then(() => toast('Copied ' + $(e.offer.offer))); } }, 'copy')));
      else if (e.offer) row('Offer', h('span', { class: 'cds-k' }, e.offer.reason));
      if (e.flip) row('Flip @ NM', h('span', { class: e.flip.net > 0 ? 'cds-good' : 'cds-bad' }, `${$(e.flip.net)} net (${pct(e.flip.roi)} ROI) on ${e.flip.platform}`));
      if (e.flipAtOffer) row('Flip @ offer', h('span', { class: e.flipAtOffer.net > 0 ? 'cds-good' : 'cds-bad' }, `${$(e.flipAtOffer.net)} net (${pct(e.flipAtOffer.roi)} ROI)`));
      if (e.breakEven) row('Break-even', `pay ≤ ${$(e.breakEven)}`);
      const tr = pr && pr.trend;
      if (tr && (tr.d7 != null || tr.d30 != null)) row('Trend', `${tr.d7 != null ? '7d ' + pct(tr.d7 / 100) : ''}${tr.d30 != null ? '  ·  30d ' + pct(tr.d30 / 100) : ''}`);
      if (pr && pr.graded && Object.keys(pr.graded).length) row('Graded', Object.entries(pr.graded).slice(0, 4).map(([k, v]) => `${/^\d/.test(k) ? 'PSA ' + k : k.toUpperCase()} ${$(v)}`).join(' · '));
      nodes.push(g);
    } else if (r.status === 'nomatch') {
      nodes.push(h('div', { class: 'cds-grid' }, h('span', { class: 'cds-k' }, 'Parsed as'), h('span', {}, `${e.parsed.name || '—'}${e.parsed.number ? ' #' + e.parsed.number : ''}${e.parsed.total ? '/' + e.parsed.total : ''} (${e.parsed.language.toUpperCase()})`)));
    } else if (r.status === 'error') {
      nodes.push(h('div', { class: 'cds-flags' }, 'Lookup error: ' + (r.error || 'unknown')));
    }
    const fb = flagsBox(e); if (fb) nodes.push(fb);
    nodes.push(crossLinks(e));
    nodes.push(h('div', { class: 'cds-actions' }, watchBtn(e, 'cds-btn cds-primary'), h('button', { class: 'cds-btn', onclick: (ev) => { ev.stopPropagation(); window.open(e.info.url, '_blank'); } }, 'Open ↗'), h('button', { class: 'cds-btn', onclick: (ev) => { ev.stopPropagation(); state.seen[e.key] = Date.now(); send({ type: 'cds:markSeen', key: e.key }); renderBadge(e); hidePop(); } }, 'Seen')));
    if (pr && pr.candidates && pr.candidates.length > 1) {
      nodes.push(h('details', {}, h('summary', {}, 'Other candidates'), h('ul', {}, ...pr.candidates.map((c) => h('li', {}, `${c.name}${c.number ? ' #' + c.number : ''}${c.set ? ' · ' + c.set : ''} (${c.score})`)))));
    }
    nodes.push(h('div', { class: 'cds-foot' }, h('span', {}, pr ? pr.sourceLabel + (r.cached ? ' · cached' : '') : 'Card Deal Scout'), h('span', {}, pr && pr.updatedAt ? 'updated ' + new Date(pr.updatedAt).toLocaleDateString() : '')));
    return nodes;
  }

  // ---------------------------------------------------------------------------
  // detail-page panel
  // ---------------------------------------------------------------------------
  function sparkline(hist) {
    const pts = hist.map((p) => p.nm ?? p.lp).filter((v) => typeof v === 'number');
    if (pts.length < 2) return null;
    const w = 300, hh = 34, min = Math.min(...pts), max = Math.max(...pts);
    const x = (i) => (i / (pts.length - 1)) * (w - 4) + 2, y = (v) => hh - 3 - ((v - min) / ((max - min) || 1)) * (hh - 6);
    const dpath = pts.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${hh}`); svg.setAttribute('class', 'cds-spark'); svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = `<path d="${dpath}" fill="none" stroke="${pts[pts.length - 1] >= pts[0] ? '#16a34a' : '#dc2626'}" stroke-width="2"/>`;
    return svg;
  }

  function renderPanel(e) {
    const d = e.deal, r = e.result || {}, pr = r.primary, s = state.settings;
    const mount = e.info.mount;
    if (!mount || !mount.isConnected) return;
    if (!e.panel || !e.panel.isConnected) {
      e.panel = h('div', { class: 'cds-panel' });
      if (e.info.mountMode === 'before') mount.before(e.panel); else mount.after(e.panel);
    }
    e.panel.className = 'cds-panel ' + d.tier;
    const kids = [];
    kids.push(h('div', { class: 'cds-ph' }, h('span', { class: 'cds-pill ' + d.tier }, d.label), e.watchHit ? h('span', { class: 'cds-pill watch' }, '★ WATCHLIST HIT') : null,
      h('div', {}, h('b', {}, e.parsed.name || e.info.title.slice(0, 60)), matchedLine(e)), h('span', { class: 'cds-brand' }, 'Card Deal Scout')));
    if (d.blurb) kids.push(h('div', { class: 'cds-blurb' }, d.blurb));

    if (r.status === 'ok' && r.prices) {
      const cols = h('div', { class: 'cds-cols' });
      // market
      const m = h('div', { class: 'cds-sec' }, h('h4', {}, 'Market (raw)'));
      m.append(h('div', { class: 'cds-big' }, `${r.prices.LP != null ? $(r.prices.LP) + ' – ' : ''}${$(r.prices.NM)}`), h('div', { class: 'cds-muted' }, `LP – NM · ${pr.sourceLabel}${pr.printing && pr.printing !== 'Ungraded' ? ' · ' + pr.printing : ''}`));
      ['MP', 'HP', 'DMG'].forEach((t) => { if (r.prices[t] != null) m.append(h('div', { class: 'cds-row' }, h('span', { class: 'cds-muted' }, CDS.tierLabel(t)), h('span', {}, $(r.prices[t])))); });
      if (pr.trend && (pr.trend.d7 != null || pr.trend.d30 != null)) m.append(h('div', { class: 'cds-row' }, h('span', { class: 'cds-muted' }, 'Trend'), h('span', { class: (pr.trend.d7 || 0) < -5 ? 'cds-bad' : (pr.trend.d7 || 0) > 5 ? 'cds-good' : '' }, `${pr.trend.d7 != null ? '7d ' + pct(pr.trend.d7 / 100) : ''}${pr.trend.d30 != null ? ' · 30d ' + pct(pr.trend.d30 / 100) : ''}`)));
      if (e.history) { const sp = sparkline(e.history); if (sp) { m.append(h('div', { class: 'cds-muted', style: 'margin-top:6px' }, `Your lookups, last ${e.history.length} days`), sp); } }
      if (pr.graded && Object.keys(pr.graded).length) m.append(h('div', { class: 'cds-muted', style: 'margin-top:4px' }, 'Graded: ' + Object.entries(pr.graded).slice(0, 5).map(([k, v]) => `${/^\d/.test(k) ? 'PSA ' + k : k.toUpperCase()} ${$(v)}`).join(' · ')));
      cols.append(m);
      // this listing
      const l = h('div', { class: 'cds-sec' }, h('h4', {}, 'This listing'));
      if (d.tier === 'slab') {
        l.append(h('div', { class: 'cds-big' }, `${$(e.info.price)} · ${gradedTag(d)}`));
        l.append(h('div', { class: 'cds-muted' }, 'Graded slab — raw LP–NM is reference only. PriceCharting adds PSA 7–10 comps when configured.'));
      } else {
        l.append(h('div', { class: 'cds-big ' + (d.pctDiff < -0.05 ? 'cds-good' : d.pctDiff > 0.1 ? 'cds-bad' : '') }, `${$(e.info.price)} · ${pct(d.pctDiff)}`));
        l.append(h('div', { class: 'cds-muted' }, `vs ${d.basisTier} ${$(d.basisPrice)}`));
      }
      l.append(h('div', { class: 'cds-row' }, h('span', { class: 'cds-muted' }, 'Condition'), h('span', {}, d.graded && d.graded.grade != null ? `${gradedTag(d)} slab` : `${e.sniff.tier ? CDS.tierLabel(e.sniff.tier) : 'unknown'}${e.sniff.source !== 'unknown' ? ' · from ' + e.sniff.source : ''}`)));
      if (e.info.siteCondition) l.append(h('div', { class: 'cds-row' }, h('span', { class: 'cds-muted' }, 'Seller says'), h('span', {}, e.info.siteCondition)));
      if (e.info.sellerRating) l.append(h('div', { class: 'cds-row' }, h('span', { class: 'cds-muted' }, 'Seller ratings'), h('span', {}, e.info.sellerRating)));
      if (e.sniff.notes && e.sniff.notes.length) l.append(h('div', { class: 'cds-muted', style: 'font-size:11px' }, e.sniff.notes.join(' · ')));
      cols.append(l);
      // offer + flip
      const o = h('div', { class: 'cds-sec' }, h('h4', {}, 'Offer & flip'));
      if (e.offer && e.offer.offer) {
        o.append(h('div', { class: 'cds-big cds-good' }, `Offer ${$(e.offer.offer)}`), h('div', { class: 'cds-muted' }, `${pct(-e.offer.pctBelowAsk)} vs ask · ${e.offer.ratioToMarket ? Math.round(e.offer.ratioToMarket * 100) + '% of market · ' : ''}${e.offer.reason}${e.info.offerAvailable === false ? ' · (no offer button on this listing)' : ''}`));
      } else if (e.offer) o.append(h('div', { class: 'cds-muted' }, e.offer.reason));
      const platSel = h('select', { class: 'cds-sel', onchange: async (ev) => { await CDS.setSettings({ resalePlatform: ev.target.value }); } }, ...['ebay', 'mercari'].map((p) => { const op = h('option', { value: p }, p === 'ebay' ? 'eBay' : 'Mercari'); if ((s.resalePlatform || 'ebay') === p) op.selected = true; return op; }));
      o.append(h('div', { class: 'cds-row', style: 'margin-top:6px' }, h('span', { class: 'cds-muted' }, 'Resell on'), platSel));
      if (e.flip) o.append(h('div', { class: 'cds-row' }, h('span', { class: 'cds-muted' }, `Buy at ask → sell @ NM ${$(e.flip.resale)}`), h('span', { class: e.flip.net > 0 ? 'cds-good' : 'cds-bad' }, `${$(e.flip.net)} (${pct(e.flip.roi)})`)));
      if (e.flipAtOffer) o.append(h('div', { class: 'cds-row' }, h('span', { class: 'cds-muted' }, `Buy at offer ${$(e.flipAtOffer.cost)}`), h('span', { class: e.flipAtOffer.net > 0 ? 'cds-good' : 'cds-bad' }, `${$(e.flipAtOffer.net)} (${pct(e.flipAtOffer.roi)})`)));
      if (e.flip) o.append(h('div', { class: 'cds-muted', style: 'font-size:11px' }, `fees ${$(e.flip.fees)} + ship ${$(e.flip.shipping)} + supplies ${$(e.flip.supplies)} · break-even buy ≤ ${$(e.breakEven)}`));
      if (d.tier !== 'slab') cols.append(o);
      kids.push(cols);
    } else if (r.status === 'loading') {
      kids.push(h('div', { class: 'cds-muted' }, 'Looking up market price…'));
    } else if (r.status === 'nosource') {
      kids.push(h('div', { class: 'cds-flags' }, 'No pricing source configured. ', h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); send({ type: 'cds:openOptions' }); } }, 'Add a JustTCG API key →')));
    } else if (r.status === 'nomatch') {
      kids.push(h('div', { class: 'cds-flags' }, `No pricing match. Parsed as “${e.parsed.name || '—'}${e.parsed.number ? ' #' + e.parsed.number : ''}${e.parsed.total ? '/' + e.parsed.total : ''}” (${e.parsed.language.toUpperCase()}). Add it to your manual sheet, or check the title.`));
    } else if (r.status === 'error') {
      kids.push(h('div', { class: 'cds-flags' }, 'Lookup error: ' + (r.error || 'unknown')));
    } else if (r.status === 'unparsed') {
      kids.push(h('div', { class: 'cds-muted' }, 'Could not find a card name in this title.'));
    }
    const fb = flagsBox(e); if (fb) kids.push(fb);
    kids.push(crossLinks(e));
    kids.push(h('div', { class: 'cds-actions' }, watchBtn(e, 'cds-btn cds-primary'),
      e.offer && e.offer.offer ? h('button', { class: 'cds-btn', onclick: () => navigator.clipboard.writeText(String(e.offer.offer)).then(() => toast('Copied ' + $(e.offer.offer))) }, 'Copy offer amount') : null,
      h('button', { class: 'cds-btn', onclick: async () => { e.result = { status: 'loading' }; computeDeal(e); renderPanel(e); e.result = (await send({ type: 'cds:lookup', parsed: e.parsed, force: true })) || { status: 'error' }; computeDeal(e); renderPanel(e); } }, 'Refresh price')));
    if (pr && pr.candidates && pr.candidates.length > 1) kids.push(h('details', {}, h('summary', {}, 'Other candidates considered'), h('ul', {}, ...pr.candidates.map((c) => h('li', {}, `${c.name}${c.number ? ' #' + c.number : ''}${c.set ? ' · ' + c.set : ''} (score ${c.score})`)))));
    kids.push(h('div', { class: 'cds-foot' }, h('span', {}, pr ? `${pr.sourceLabel}${r.cached ? ' · cached' : ''} · match ${pr.matchScore}/100` : ''), h('span', {}, pr && pr.updatedAt ? 'price updated ' + new Date(pr.updatedAt).toLocaleString() : '')));
    e.panel.replaceChildren(...kids.filter(Boolean));
  }

  // ---------------------------------------------------------------------------
  // misc UI
  // ---------------------------------------------------------------------------
  let toastEl = null;
  function toast(msg) {
    if (!toastEl) { toastEl = h('div', { class: 'cds-toast' }); document.body.append(toastEl); }
    toastEl.textContent = msg; toastEl.style.display = 'block';
    clearTimeout(toastEl._t); toastEl._t = setTimeout(() => { toastEl.style.display = 'none'; }, 2200);
  }

  // ---------------------------------------------------------------------------
  // observe DOM + SPA navigation
  // ---------------------------------------------------------------------------
  function observe() {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.target.closest && m.target.closest('.cds-badge, .cds-panel, #cds-pop, .cds-toast')) continue;
        requestScan(); return;
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
      if (location.href !== state.lastUrl) {
        state.lastUrl = location.href;
        hidePop();
        if (state.detail && state.detail.panel) state.detail.panel.remove();
        state.detail = null;
        for (const [k, e] of state.entries) if (!e.cell.isConnected) state.entries.delete(k);
        requestScan(400);
      }
    }, 500);
  }

  // ---------------------------------------------------------------------------
  // messages from popup / background
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'cds:ping': sendResponse({ ok: true, site: state.adapter && state.adapter.id, pageType: state.pageType, url: location.href }); break;
      case 'cds:getPageDeals': {
        const deals = [...state.entries.values()].map(dealSummary);
        if (state.detail) deals.push(dealSummary(state.detail));
        sendResponse({ ok: true, site: state.adapter && state.adapter.id, pageType: state.pageType, url: location.href, deals });
        break;
      }
      case 'cds:rescan': {
        document.querySelectorAll('[data-cds-cell]').forEach((c) => delete c.dataset.cdsCell);
        document.querySelectorAll('.cds-badge, .cds-panel').forEach((b) => b.remove());
        state.entries.clear(); state.detail = null; state.notified.clear();
        if (msg.force) send({ type: 'cds:clearCache' }).then(() => requestScan(50)); else requestScan(50);
        sendResponse({ ok: true }); break;
      }
      case 'cds:jumpTo': {
        const e = state.entries.get(msg.key);
        if (e && e.cell) { e.cell.scrollIntoView({ behavior: 'smooth', block: 'center' }); e.cell.classList.add('cds-flash'); setTimeout(() => e.cell.classList.remove('cds-flash'), 2600); }
        sendResponse({ ok: !!e }); break;
      }
      default: return false;
    }
    return true;
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
