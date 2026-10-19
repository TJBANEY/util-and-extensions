/* Card Deal Scout — Mercari (US) adapter.
 * Verified against mercari.com DOM (Oct 2026):
 *   list cell:  a[data-testid="ProductThumbWrapper"] > div[data-testid="ItemContainer"] (position: relative)
 *               p[data-testid="ItemName"], [data-testid="ProductThumbItemPrice"] (+ ProductThumbItemDiscountedPrice = struck original)
 *   detail:     h1[data-testid="ItemName"], [data-testid="ItemPrice"], [data-testid="ItemDetailsCondition"],
 *               [data-testid="ItemDetailsDescription"], [data-testid="MakeOfferButton_"], [data-testid="SellerRatingCount"] */
(function (root) {
  const CDS = (root.CDS = root.CDS || {});
  CDS.adapters = CDS.adapters || {};

  const money = (s) => { const m = String(s || '').replace(/,/g, '').match(/\$\s?(\d+(?:\.\d{1,2})?)/); return m ? parseFloat(m[1]) : null; };
  const text = (el) => (el ? el.textContent.trim() : '');

  CDS.adapters.mercari = {
    id: 'mercari',
    name: 'Mercari',
    matches: (loc) => /(^|\.)mercari\.com$/i.test(loc.hostname),

    pageType(loc) {
      if (/\/item\/m\d+/i.test(loc.pathname) || /\/us\/item\//i.test(loc.pathname)) return 'detail';
      if (document.querySelector('[data-testid="ItemContainer"]')) return 'list';
      return 'other';
    },

    listCells() {
      return [...document.querySelectorAll('[data-testid="ItemContainer"]')];
    },

    /** @returns {{title, price, url, id, mount}|null} */
    extractCell(cell) {
      const titleEl = cell.querySelector('[data-testid="ItemName"]');
      const priceEl = cell.querySelector('[data-testid="ProductThumbItemPrice"]');
      if (!titleEl || !priceEl) return null;
      const discounted = cell.querySelector('[data-testid="ProductThumbItemDiscountedPrice"]');
      let priceText = text(priceEl);
      if (discounted) priceText = priceText.replace(text(discounted), ' ');
      const price = money(priceText);
      const a = cell.closest('a[href]') || cell.querySelector('a[href]');
      const href = a ? a.getAttribute('href') : '';
      const idm = href.match(/\/item\/(m\d+)/i);
      const url = href ? new URL(href, location.origin).href.split('?')[0] : location.href;
      return {
        title: text(titleEl), price, url, id: idm ? idm[1] : url,
        mount: cell.querySelector('[data-testid="StyledProductThumb"]')?.parentElement || cell,
        isSold: /sold/i.test(text(cell.querySelector('[data-testid="ItemDecorationRectangle"], [data-testid="BadgeWrapper"]')))
      };
    },

    /** @returns {{title, price, description, siteCondition, offerAvailable, sellerRating, url, id, mount}|null} */
    extractDetail() {
      const titleEl = document.querySelector('h1[data-testid="ItemName"], [data-testid="ItemName"]');
      const priceEl = document.querySelector('[data-testid="ItemPrice"]');
      if (!titleEl || !priceEl) return null;
      const idm = location.pathname.match(/\/item\/(m\d+)/i);
      const priceRow = document.querySelector('[data-testid="ItemPriceLabelRow"]') || priceEl;
      return {
        title: text(titleEl), price: money(text(priceEl)),
        description: text(document.querySelector('[data-testid="ItemDetailsDescription"]')),
        siteCondition: text(document.querySelector('[data-testid="ItemDetailsCondition"]')).replace(/^condition/i, '').trim(),
        offerAvailable: !!document.querySelector('[data-testid="MakeOfferButton_"], [data-testid^="MakeOfferButton"]'),
        sellerRating: text(document.querySelector('[data-testid="SellerRatingCount"]')),
        url: location.href.split('?')[0], id: idm ? idm[1] : location.pathname,
        mount: priceRow.closest('[data-testid="ItemInfo"]') ? priceRow : priceEl.parentElement,
        mountMode: 'after'
      };
    }
  };
})(globalThis);
