/* Card Deal Scout — JustTCG provider (https://justtcg.com)
 * GET https://api.justtcg.com/v1/cards?q=<name>&game=<gameId>&limit=20   header: x-api-key
 * Response: { data: [ { id, name, game, set, set_name?, number, rarity, tcgplayerId,
 *                       variants: [ { condition, printing, language?, price, lastUpdated, priceChange7d, priceChange30d, ... } ] } ],
 *             pagination, usage? }
 * Classic script for the service worker. */
(function (root) {
  const CDS = (root.CDS = root.CDS || {});
  CDS.providers = CDS.providers || {};

  const BASE = 'https://api.justtcg.com/v1';
  const COND_MAP = { 'near mint': 'NM', nm: 'NM', 'lightly played': 'LP', lp: 'LP', 'moderately played': 'MP', mp: 'MP', 'heavily played': 'HP', hp: 'HP', damaged: 'DMG', dmg: 'DMG' };
  const PRINT_PREF = ['Holofoil', 'Normal', 'Foil', 'Unlimited Holofoil', 'Unlimited', 'Reverse Holofoil', '1st Edition Holofoil', '1st Edition'];

  async function api(path, params, key) {
    const url = new URL(BASE + path);
    Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
    const res = await fetch(url.toString(), { headers: { 'x-api-key': key, accept: 'application/json' } });
    let body = null;
    try { body = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      const msg = (body && (body.error || body.message)) || `HTTP ${res.status}`;
      const err = new Error(msg); err.status = res.status; err.body = body; throw err;
    }
    // remember quota info if the API reports it
    const usage = (body && (body.usage || body.meta?.usage)) || null;
    const remaining = res.headers.get('x-ratelimit-remaining') || res.headers.get('x-daily-remaining');
    if (usage || remaining) {
      CDS.setProviderStatus('justtcg', { usage, remaining: remaining != null ? Number(remaining) : (usage && (usage.remaining ?? usage.dailyRemaining)) ?? null, lastOk: Date.now() }).catch(() => {});
    } else {
      CDS.setProviderStatus('justtcg', { lastOk: Date.now(), lastError: null }).catch(() => {});
    }
    return body;
  }

  /** Resolve the game id to use for a parsed card. */
  async function gameFor(parsed, settings) {
    if (parsed.language === 'ja') {
      if (settings.justtcgGameJa) return settings.justtcgGameJa;
      // try to auto-detect once from /games and persist
      try {
        const games = await CDS.providers.justtcg.listGames(settings.justtcgApiKey);
        const ja = games.find((g) => /pokemon/i.test(g.id + ' ' + g.name) && /japan/i.test(g.id + ' ' + g.name));
        if (ja) { await CDS.setSettings({ justtcgGameJa: ja.id }); return ja.id; }
      } catch (e) { /* fall through */ }
      return null; // search without game filter, then prefer japanese results by name
    }
    return settings.justtcgGameEn || 'pokemon';
  }

  function pickPrinting(variants, parsed) {
    const printings = [...new Set(variants.map((v) => v.printing || 'Normal'))];
    if (printings.length === 1) return printings[0];
    const want = [];
    if (parsed.firstEdition) want.push(/1st/i);
    if (parsed.printings.includes('Reverse Holofoil')) want.push(/reverse/i);
    else if (parsed.printings.includes('Holofoil')) want.push(/^holo|holofoil/i);
    if (parsed.printings.includes('Unlimited')) want.push(/unlimited/i);
    for (const re of want) { const hit = printings.find((p) => re.test(p) && !(parsed.firstEdition === false && /1st/i.test(p))); if (hit) return hit; }
    // modern ultra rares only exist as Holofoil; commons default to Normal
    for (const pref of PRINT_PREF) if (printings.includes(pref) && !(/1st/i.test(pref) && !parsed.firstEdition)) return pref;
    return printings[0];
  }

  function toResult(card, parsed, score) {
    const variants = Array.isArray(card.variants) ? card.variants : [];
    const printing = pickPrinting(variants, parsed);
    const prices = {}; const trend = {}; let updated = 0;
    for (const v of variants) {
      if ((v.printing || 'Normal') !== printing) continue;
      const c = COND_MAP[String(v.condition || '').toLowerCase()];
      if (!c || typeof v.price !== 'number') continue;
      prices[c] = Math.round(v.price * 100) / 100;
      if (c === 'NM' || (c === 'LP' && trend.d7 == null)) {
        if (typeof v.priceChange7d === 'number') trend.d7 = v.priceChange7d;
        if (typeof v.priceChange30d === 'number') trend.d30 = v.priceChange30d;
        if (typeof v.priceChange24hr === 'number') trend.d1 = v.priceChange24hr;
      }
      if (v.lastUpdated) updated = Math.max(updated, Number(v.lastUpdated) * (Number(v.lastUpdated) < 1e12 ? 1000 : 1));
    }
    if (!Object.keys(prices).length) return null;
    const setName = card.set_name || card.setName || card.set || '';
    return {
      source: 'justtcg', sourceLabel: 'JustTCG (TCGplayer market)',
      matchedName: card.name, matchedSet: setName, matchedNumber: card.number || '', matchedGame: card.game || '',
      printing, prices, trend, updatedAt: updated || Date.now(), matchScore: score,
      url: card.tcgplayerId ? `https://www.tcgplayer.com/product/${card.tcgplayerId}` : `https://justtcg.com/?q=${encodeURIComponent(card.name)}`,
      candidates: undefined
    };
  }

  CDS.providers.justtcg = {
    id: 'justtcg',
    name: 'JustTCG',
    needsKey: true,
    isConfigured: (settings) => !!settings.justtcgApiKey,

    async listGames(key) {
      const body = await api('/games', {}, key);
      const arr = body?.data || body?.games || [];
      return arr.map((g) => ({ id: g.id || g.slug || g.game_id || g.name, name: g.name || g.id }));
    },

    async test(settings) {
      const games = await this.listGames(settings.justtcgApiKey);
      return { ok: true, message: `Connected. ${games.length} games available: ${games.map((g) => g.id).slice(0, 12).join(', ')}${games.length > 12 ? '…' : ''}`, games };
    },

    /** @returns {Promise<object|null>} PriceResult or null when no confident match */
    async lookup(parsed, settings) {
      const key = settings.justtcgApiKey;
      if (!key) return null;
      const q = CDS.searchQuery(parsed);
      if (!q) return null;
      const game = await gameFor(parsed, settings);

      const search = async (query, g) => {
        try {
          const body = await api('/cards', { q: query, game: g || undefined, limit: 20 }, key);
          return body?.data || body?.cards || [];
        } catch (e) {
          if (g && (e.status === 400 || e.status === 404 || e.status === 422)) {
            // bad game id → retry unfiltered
            const body = await api('/cards', { q: query, limit: 20 }, key);
            return body?.data || body?.cards || [];
          }
          throw e;
        }
      };

      let cards = await search(q, game);
      // nickname / extra-word fallback: retry with the last two tokens ("Moonbreon Umbreon VMAX" → "Umbreon VMAX")
      if (!cards.length && q.split(' ').length > 2) cards = await search(q.split(' ').slice(-2).join(' '), game);
      if (!cards.length && parsed.number) cards = await search(q.split(' ')[0], game);
      if (!cards.length) return null;

      // when we couldn't resolve a JP game id, keep only japanese-looking results for JP listings
      if (parsed.language === 'ja' && !game) {
        const ja = cards.filter((c) => /japan/i.test((c.game || '') + ' ' + (c.set || '') + ' ' + (c.set_name || '')));
        if (ja.length) cards = ja;
      }
      const scored = cards.map((c) => ({ c, s: CDS.matchScore(parsed, { name: c.name, number: c.number, set: c.set_name || c.set, setCode: c.set, game: c.game, language: c.language }) }))
        .sort((a, b) => b.s - a.s);
      const best = scored[0];
      const minScore = parsed.number ? 55 : 30;
      if (!best || best.s < minScore) return null;
      const res = toResult(best.c, parsed, best.s);
      if (res) res.candidates = scored.slice(0, 5).map((x) => ({ name: x.c.name, number: x.c.number, set: x.c.set_name || x.c.set, score: x.s }));
      return res;
    }
  };
})(globalThis);
