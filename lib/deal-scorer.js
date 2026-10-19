/* Card Deal Scout — deal scoring, offer suggestion and flip estimator.
 * Classic script: attaches to globalThis.CDS. */
(function (root) {
  const CDS = (root.CDS = root.CDS || {});

  CDS.TIERS = {
    steal: { label: 'STEAL', short: 'STEAL', emoji: '🟢', blurb: 'Check this one out — looks like it could be a really good deal!' },
    offer: { label: 'OFFER IT', short: 'OFFER', emoji: '🪙', blurb: 'Could be a deal, especially with an offer under asking — not amazing where it sits now.' },
    fair: { label: 'AT MARKET', short: 'MARKET', emoji: '⚪', blurb: 'Basically right at market value. Boring, moving on.' },
    over: { label: 'WAY OVER', short: 'OVER', emoji: '🔴', blurb: "Whoa… this seller is asking WAY over market for this card. Couldn't hurt to lowball an offer though." },
    slab: { label: 'SLAB', short: 'SLAB', emoji: '🟣', blurb: 'Graded card — raw LP–NM price shown for reference only.' },
    lot: { label: 'LOT', short: 'LOT', emoji: '📦', blurb: 'Multiple cards — single-card price shown for reference.' },
    unknown: { label: '?', short: '?', emoji: '❔', blurb: 'Could not confidently match this listing to a card.' },
    nosource: { label: 'NO KEY', short: 'KEY', emoji: '🔑', blurb: 'Add a pricing API key in the extension options to see market prices.' }
  };

  const round2 = (n) => Math.round(n * 100) / 100;

  /** Pick the market price to compare against, given the sniffed tier and user settings. */
  CDS.pickBasis = function (prices, tier, settings) {
    const s = settings || CDS.DEFAULTS;
    const p = prices || {};
    const has = (k) => typeof p[k] === 'number' && p[k] > 0;
    let basisTier = null, basisPrice = null;
    if (s.useSniffedCondition && tier && has(tier)) { basisTier = tier; basisPrice = p[tier]; }
    else if (s.useSniffedCondition && tier && (tier === 'MP' || tier === 'HP' || tier === 'DMG') && has('LP')) {
      // provider lacks lower tiers (PriceCharting/manual): approximate from LP
      const f = { MP: 0.8, HP: 0.62, DMG: 0.45 }[tier];
      basisTier = tier; basisPrice = round2(p.LP * f);
    } else {
      const mode = s.comparisonBasis || 'mid';
      if (mode === 'nm' && has('NM')) { basisTier = 'NM'; basisPrice = p.NM; }
      else if (mode === 'lp' && has('LP')) { basisTier = 'LP'; basisPrice = p.LP; }
      else if (has('NM') && has('LP')) { basisTier = 'LP–NM'; basisPrice = round2((p.NM + p.LP) / 2); }
      else if (has('NM')) { basisTier = 'NM'; basisPrice = p.NM; }
      else if (has('LP')) { basisTier = 'LP'; basisPrice = p.LP; }
      else if (has('MP')) { basisTier = 'MP'; basisPrice = p.MP; }
    }
    return { basisTier, basisPrice };
  };

  /**
   * @param {{asking:number, prices:object, tier?:string|null, settings?:object, graded?:object|null, isLot?:boolean}} a
   */
  CDS.scoreDeal = function scoreDeal(a) {
    const s = a.settings || CDS.DEFAULTS;
    const th = { ...CDS.DEFAULTS.thresholds, ...(s.thresholds || {}) };
    const { basisTier, basisPrice } = CDS.pickBasis(a.prices, a.tier, s);
    const out = { tier: 'unknown', label: '?', basisTier, basisPrice, ratio: null, pctDiff: null, asking: a.asking, range: null };
    const p = a.prices || {};
    if (typeof p.LP === 'number' && typeof p.NM === 'number') out.range = { lo: Math.min(p.LP, p.NM), hi: Math.max(p.LP, p.NM) };
    else if (typeof p.NM === 'number') out.range = { lo: p.NM, hi: p.NM };
    else if (typeof p.LP === 'number') out.range = { lo: p.LP, hi: p.LP };
    if (!basisPrice || !(a.asking > 0)) { out.label = CDS.TIERS.unknown.label; return out; }
    out.ratio = a.asking / basisPrice;
    out.pctDiff = (a.asking - basisPrice) / basisPrice;
    let t;
    if (out.ratio <= th.steal) t = 'steal';
    else if (out.ratio <= th.offer) t = 'offer';
    else if (out.ratio <= th.fair) t = 'fair';
    else t = 'over';
    out.rawTier = t;
    if (a.graded && a.graded.grade != null) t = 'slab';
    else if (a.isLot) t = 'lot';
    out.tier = t;
    out.label = CDS.TIERS[t].label;
    out.blurb = CDS.TIERS[t].blurb;
    return out;
  };

  const niceRound = (n) => {
    if (n >= 200) return Math.round(n / 5) * 5;
    if (n >= 20) return Math.round(n);
    if (n >= 5) return Math.round(n * 2) / 2;
    return round2(n);
  };

  /** Suggest an offer price: target % of market, but never more than the platform's max discount below asking. */
  CDS.suggestOffer = function ({ asking, basisPrice, settings }) {
    const s = settings || CDS.DEFAULTS;
    if (!(asking > 0)) return null;
    const target = basisPrice ? basisPrice * (s.offerTargetRatio ?? 0.8) : asking * 0.85;
    const floor = asking * (1 - (s.offerMaxDiscount ?? 0.25));
    const clamped = target < floor;
    let offer = Math.max(target, floor);
    if (offer >= asking) return { offer: null, reason: basisPrice ? 'Asking is already at/below your target — just buy it.' : 'No market price to anchor an offer.' };
    offer = niceRound(offer);
    return {
      offer,
      pctBelowAsk: (asking - offer) / asking,
      ratioToMarket: basisPrice ? offer / basisPrice : null,
      clamped,
      reason: clamped ? `Capped at the ${Math.round((s.offerMaxDiscount ?? 0.25) * 100)}% max discount sellers will even see.` : `${Math.round((s.offerTargetRatio ?? 0.8) * 100)}% of market.`
    };
  };

  /** Estimate net if you bought at `cost` and resold at `resale` on `platform`. */
  CDS.estimateFlip = function ({ cost, resale, platform, settings }) {
    const s = settings || CDS.DEFAULTS;
    const plat = platform || s.resalePlatform || 'ebay';
    const f = (s.fees && s.fees[plat]) || CDS.DEFAULTS.fees.ebay;
    if (!(cost > 0) || !(resale > 0)) return null;
    const fees = resale * (f.pct || 0) + resale * (f.processingPct || 0) + (f.processingFixed || 0);
    const shipping = s.shippingCost ?? 1.5;
    const supplies = s.suppliesCost ?? 0.35;
    const net = resale - fees - shipping - supplies - cost;
    return { platform: plat, resale, cost, fees: round2(fees), shipping, supplies, net: round2(net), margin: net / resale, roi: net / cost };
  };

  /** Break-even purchase price for a given resale: what you can pay and still net $0. */
  CDS.breakEven = function ({ resale, platform, settings }) {
    const s = settings || CDS.DEFAULTS;
    const plat = platform || s.resalePlatform || 'ebay';
    const f = (s.fees && s.fees[plat]) || CDS.DEFAULTS.fees.ebay;
    if (!(resale > 0)) return null;
    const fees = resale * (f.pct || 0) + resale * (f.processingPct || 0) + (f.processingFixed || 0);
    return round2(resale - fees - (s.shippingCost ?? 1.5) - (s.suppliesCost ?? 0.35));
  };

  /** Does a parsed listing match a watchlist entry? */
  CDS.matchesWatch = function (parsed, asking, deal, w) {
    if (!w || !w.name) return false;
    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9&' ]/g, ' ').replace(/\s+/g, ' ').trim();
    const wn = norm(w.name), pn = norm(parsed.name), raw = norm(parsed.text);
    if (!wn) return false;
    const nameOk = pn.includes(wn) || wn.includes(pn) && pn.length > 3 || raw.includes(wn);
    if (!nameOk) return false;
    if (w.number && parsed.number && String(w.number).replace(/^0+/, '') !== String(parsed.number).replace(/^0+/, '')) return false;
    if (w.number && !parsed.number && !raw.includes(String(w.number))) return false;
    if (w.setCode && parsed.setCode && w.setCode.toLowerCase() !== parsed.setCode.toLowerCase()) return false;
    if (w.language && w.language !== 'any' && parsed.language !== w.language) return false;
    if (w.maxPrice && asking > w.maxPrice) return false;
    if (w.maxRatio && deal && deal.ratio != null && deal.ratio > w.maxRatio) return false;
    return true;
  };
})(globalThis);
