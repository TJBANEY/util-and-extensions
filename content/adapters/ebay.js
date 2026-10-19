/* Card Deal Scout — eBay adapter (search results + item pages).
 * eBay has been migrating from .s-item to .s-card markup; both are handled. */
(function (root) {
  const CDS = (root.CDS = root.CDS || {});
  CDS.adapters = CDS.adapters || {};

  const money = (s) => { const m = String(s || '').replace(/,/g, '').match(/(?:US\s?)?\$\s?(\d+(?:\.\d{1,2})?)/); return m ? parseFloat(m[1]) : null; };
  const text = (el) => (el ? el.textContent.trim() : '');

  CDS.adapters.ebay = {
    id: 'ebay',
    name: 'eBay',
    matches: (loc) => /(^|\.)ebay\.(com|ca|co\.uk|com\.au|de|fr|it|es)$/i.test(loc.hostname),

    pageType(loc) {
      if (/^\/itm\//i.test(loc.pathname)) return 'detail';
      if (document.querySelector('li.s-item, li.s-card, .s-item__wrapper, .srp-results')) return 'list';
      return 'other';
    },

    listCells() {
      return [...document.querySelectorAll('li.s-item, li.s-card, .s-item__wrapper')].filter((c) => !c.classList.contains('s-item--placeholder'));
    },

    extractCell(cell) {
      const titleEl = cell.querySelector('.s-item__title, .s-card__title');
      const priceEl = cell.querySelector('.s-item__price, .s-card__price');
      if (!titleEl || !priceEl) return null;
      const title = text(titleEl).replace(/^(new listing|shop on ebay)\s*/i, '');
      if (!title || /^shop on ebay$/i.test(title)) return null;
      const price = money(text(priceEl));
      const a = cell.querySelector('a.s-item__link, a.s-card__link, a[href*="/itm/"]');
      const href = a ? a.href : '';
      const idm = href.match(/\/itm\/(?:[^/]*\/)?(\d{9,15})/);
      const img = cell.querySelector('.s-item__image-wrapper, .s-card__image-wrapper, .s-item__image, .s-card__image');
      return { title, price, url: href.split('?')[0] || location.href, id: idm ? idm[1] : href, mount: img || cell, isSold: /sold/i.test(text(cell.querySelector('.s-item__title--tag, .POSITIVE'))) };
    },

    extractDetail() {
      const titleEl = document.querySelector('h1.x-item-title__mainTitle, h1[data-testid="x-item-title"], #itemTitle, h1');
      const priceEl = document.querySelector('.x-price-primary [itemprop="price"], .x-price-primary span, #prcIsum, [data-testid="x-price-primary"]');
      if (!titleEl || !priceEl) return null;
      const idm = location.pathname.match(/\/itm\/(?:[^/]*\/)?(\d{9,15})/);
      const condEl = document.querySelector('.x-item-condition-text .ux-textspans, [data-testid="x-item-condition"] .ux-textspans, #vi-itm-cond');
      const desc = text(document.querySelector('#desc_ifr') ? null : document.querySelector('.x-item-description, [data-testid="x-item-description"]'));
      return {
        title: text(titleEl).replace(/^details about\s*/i, ''), price: money(text(priceEl)),
        description: desc, siteCondition: text(condEl),
        offerAvailable: !!document.querySelector('[data-testid="x-offer-action"], .x-offer-action, [href*="makeBestOffer"], .vi-bbox-posTop3 a, a[data-testid="ux-call-to-action"][href*="offer"]'),
        sellerRating: text(document.querySelector('.x-sellercard-atf__info__about-seller span, [data-testid="x-sellercard-atf"] .ux-textspans--SECONDARY')),
        url: location.href.split('?')[0], id: idm ? idm[1] : location.pathname,
        mount: priceEl.closest('.x-price-primary') || priceEl.parentElement, mountMode: 'after'
      };
    }
  };
})(globalThis);
