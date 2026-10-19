/* Card Deal Scout — generic adapter for sites we don't have a hand-tuned adapter for.
 * Heuristic: find price text nodes, climb to the smallest repeating "card cell" ancestor that also holds
 * a title-like text + link, then pick the title candidate whose parse confidence is highest. */
(function (root) {
  const CDS = (root.CDS = root.CDS || {});
  CDS.adapters = CDS.adapters || {};

  const PRICE_RE = /(?:US\s?)?\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?(?!\d)/;
  const money = (s) => { const m = String(s || '').replace(/,/g, '').match(/\$\s?(\d+(?:\.\d{1,2})?)/); return m ? parseFloat(m[1]) : null; };
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'HEAD', 'META', 'LINK', 'IFRAME']);

  function priceLeafElements() {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP_TAGS.has(p.tagName) || p.closest('.cds-badge, .cds-panel, header, nav, footer')) return NodeFilter.FILTER_REJECT;
        return PRICE_RE.test(n.nodeValue) && n.nodeValue.trim().length <= 40 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let n; while ((n = walker.nextNode())) out.push(n.parentElement);
    return out;
  }

  const sig = (el) => el.tagName + '.' + [...el.classList].slice(0, 3).join('.');

  function findCellFor(priceEl) {
    let el = priceEl;
    for (let depth = 0; depth < 9 && el && el !== document.body; depth++) {
      el = el.parentElement;
      if (!el) break;
      const t = text(el);
      if (t.length > 700) return null; // climbed into a container of many items
      const hasLink = el.tagName === 'A' || !!el.querySelector('a[href]');
      const prices = (t.match(new RegExp(PRICE_RE.source, 'g')) || []).length;
      if (prices > 3) return null;
      const titleish = t.replace(PRICE_RE, '').trim().length >= 12;
      if (hasLink && titleish && (el.querySelector('img') || depth >= 2)) return el;
    }
    return null;
  }

  function bestTitle(cell) {
    // 1) structural candidates: headings, title/name-ish classes, link/img labels
    const structural = new Set();
    cell.querySelectorAll('h1,h2,h3,h4,h5,h6,[class*="title" i],[class*="name" i],[data-testid*="title" i],[data-testid*="name" i],a[title],img[alt],a[aria-label]').forEach((el) => {
      const t = el.getAttribute?.('title') || el.getAttribute?.('alt') || el.getAttribute?.('aria-label') || text(el);
      if (t && t.length >= 8 && t.length <= 200 && !PRICE_RE.test(t)) structural.add(t);
    });
    const pick = (set, minC) => {
      let best = '', bestC = -1;
      for (const t of set) { const c = CDS.parseCardTitle(t).confidence + Math.min(0.1, t.length / 2000); if (c > bestC) { bestC = c; best = t; } }
      return bestC >= minC ? best : '';
    };
    const s = pick(structural, 0.45);
    if (s) return s;
    // 2) any leaf text, but only when it parses strongly (name + number)
    const leaves = new Set();
    cell.querySelectorAll('*').forEach((el) => { if (el.children.length === 0) { const t = text(el); if (t.length >= 12 && t.length <= 200 && !PRICE_RE.test(t)) leaves.add(t); } });
    const l = pick(leaves, 0.75);
    if (l) return l;
    // 3) fall back to the longest structural candidate so sealed/lot detection still gets a sensible title
    return [...structural].sort((a, b) => b.length - a.length)[0] || '';
  }

  CDS.adapters.generic = {
    id: 'generic',
    name: 'Generic (heuristic)',
    matches: () => true,

    pageType() {
      const cells = this.listCells();
      if (cells.length >= 3) return 'list';
      const h1 = document.querySelector('h1');
      if (h1 && CDS.parseCardTitle(text(h1)).confidence >= 0.45) return 'detail';
      return 'other';
    },

    _cells: null, _cellsAt: 0,
    listCells() {
      if (this._cells && Date.now() - this._cellsAt < 800) return this._cells;
      const cells = new Map();
      for (const p of priceLeafElements()) { const c = findCellFor(p); if (c) cells.set(c, (cells.get(c) || 0) + 1); }
      // keep only cells whose signature repeats (grids/lists), drop lonely ones
      const bySig = new Map();
      for (const c of cells.keys()) { const s = sig(c); bySig.set(s, (bySig.get(s) || 0) + 1); }
      const out = [...cells.keys()].filter((c) => bySig.get(sig(c)) >= 3 && !c.querySelector('[data-cds-cell]') && !c.closest('[data-cds-cell]'));
      this._cells = out; this._cellsAt = Date.now();
      return out;
    },

    extractCell(cell) {
      const title = bestTitle(cell);
      const priceText = (text(cell).match(new RegExp(PRICE_RE.source, 'g')) || [])[0];
      const price = money(priceText);
      if (!title || !price) return null;
      const a = cell.tagName === 'A' ? cell : cell.querySelector('a[href]');
      const url = a ? a.href.split('?')[0] : location.href;
      const img = cell.querySelector('img');
      return { title, price, url, id: url, mount: (img && img.parentElement) || cell };
    },

    extractDetail() {
      const h1 = document.querySelector('h1');
      if (!h1) return null;
      const title = text(h1);
      const prices = priceLeafElements().filter((el) => money(text(el)) > 0);
      // first price after the h1 in document order
      const after = prices.find((el) => h1.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || prices[0];
      if (!after) return null;
      const condEl = [...document.querySelectorAll('dt,th,span,div,p')].find((el) => el.children.length === 0 && /^condition:?$/i.test(text(el)));
      const siteCondition = condEl ? text(condEl.nextElementSibling || condEl.parentElement).replace(/^condition:?/i, '').trim().slice(0, 40) : '';
      const main = document.querySelector('main, article, #main, [role="main"]') || document.body;
      return {
        title, price: money(text(after)), description: text(main).slice(0, 4000), siteCondition,
        offerAvailable: /make\s+(an\s+)?offer|best\s+offer/i.test(text(main)), sellerRating: '',
        url: location.href.split('?')[0], id: location.pathname, mount: after, mountMode: 'after'
      };
    }
  };
})(globalThis);
