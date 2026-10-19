/* Card Deal Scout — Pokémon card title parser (EN + JP listings).
 * Turns a messy marketplace title into a structured card identity we can price:
 *   { name, number, total, setCode, setHint, language, rarity, printings[], firstEdition, graded, isLot, year, confidence }
 * Classic script: attaches to globalThis.CDS. */
(function (root) {
  const CDS = (root.CDS = root.CDS || {});

  // Words that never belong to a card's name.
  const NOISE = new Set([
    'pokemon', 'pokémon', 'poke', 'tcg', 'card', 'cards', 'trading', 'game', 'ccg', 'single', 'singles',
    'japanese', 'japan', 'jpn', 'jp', 'english', 'eng', 'korean', 'kor', 'chinese', 'traditional', 'simplified', 'version',
    'holo', 'holographic', 'holofoil', 'foil', 'reverse', 'rev', 'non-holo', 'nonholo', 'non',
    'mint', 'nm', 'near', 'lp', 'lightly', 'light', 'played', 'mp', 'moderately', 'hp', 'heavily', 'dmg', 'damaged', 'condition', 'cond', 'shown', 'pack', 'fresh', 'pulled', 'pull', 'straight',
    'see', 'pics', 'pictures', 'photos', 'photo', 'pic', 'picture', 'read', 'description', 'desc', 'please', 'look', 'actual',
    'free', 'shipping', 'ships', 'fast', 'ship', 'shipped', 'tracked', 'tracking', 'same', 'day', 'bundle', 'discount', 'offers', 'offer', 'obo',
    'authentic', 'genuine', 'official', 'real', 'original', 'rare', 'ultra', 'secret', 'super', 'hyper', 'special', 'illustration', 'alt', 'alternate', 'art', 'full', 'character', 'amazing', 'radiant', 'shiny', 'gold', 'rainbow', 'double', 'triple', 'textured', 'promo', 'promotional', 'prerelease', 'staff', 'stamped', 'stamp',
    'set', 'series', 'edition', 'ed', 'unlimited', 'shadowless', 'first', '1st', 'base', 'expansion', 'booster', 'box', 'collection',
    'new', 'sealed', 'graded', 'raw', 'ungraded', 'slab', 'slabbed', 'gem', 'mt', 'cert',
    'the', 'a', 'an', 'of', 'and', 'with', 'in', 'for', 'from', 'to', 'by', 'on', 'or', 'w', 'x',
    'lot', 'bulk', 'playset', 'vintage', 'wotc', 'old', 'retro', 'classic', 'htf', 'oop', 'nib', 'nwt', 'rare!', 'wow',
    'hp80', 'hp', 'lv', 'level', 'no', 'no.', 'number', 'num', 'sv', 'swsh', 'xy', 'sm', 'bw', 'dp', 'pl', 'hgss',
    'sar', 'sr', 'ar', 'ur', 'hr', 'chr', 'csr', 'rr', 'rrr', 'ssr', 'r', 'u', 'c', 'tg', 'gg', 'ir', 'sir', 'ace', 'spec',
    'psa', 'bgs', 'cgc', 'sgc', 'ars', 'tag', 'hga', 'beckett',
    'nintendo', 'creatures', 'gamefreak', 'game', 'freak', 'tomy', 'bandai', 'topps',
    'ex-', 'vs.', 'cp', 'kids', 'carddass', 'bandai'
  ]);

  // Tokens that are part of a Pokémon's printed name (kept even though short/odd).
  const NAME_SUFFIX = new Set(['ex', 'gx', 'v', 'vmax', 'vstar', 'v-union', 'break', 'prime', 'legend', 'lv.x', 'lvx', 'δ', 'delta', 'star', 'tag', 'team', '&', 'mega', 'm', 'primal', 'shining', 'dark', 'light', 'shadow', 'radiant', 'galarian', 'alolan', 'hisuian', 'paldean', 'origin', 'forme', 'form']);
  // Trainer-owner prefixes common in vintage JP sets (Rocket's Suicune, Blaine's Typhlosion, Bruno's Steelix…)
  const OWNER_RE = /^[A-Z][a-z]+(?:'s|’s|s')$/;

  const RARITY_RE = [
    [/\bspecial\s+illustration\s+rare\b|\bSIR\b|\bSAR\b/i, 'SAR'],
    [/\billustration\s+rare\b|\bIR\b(?!\w)|\bAR\b/i, 'AR'],
    [/\bhyper\s+rare\b|\brainbow\s+rare\b|\bHR\b/i, 'HR'],
    [/\bultra\s+rare\b|\bUR\b/i, 'UR'],
    [/\bsecret\s+rare\b|\bSR\b/i, 'SR'],
    [/\bcharacter\s+super\s+rare\b|\bCSR\b/i, 'CSR'],
    [/\bcharacter\s+rare\b|\bCHR\b/i, 'CHR'],
    [/\bshiny\s+super\s+rare\b|\bSSR\b/i, 'SSR'],
    [/\bdouble\s+rare\b|\bRR\b/i, 'RR'],
    [/\bRRR\b/i, 'RRR'],
    [/\bamazing\s+rare\b/i, 'AmazingRare'],
    [/\bradiant\b/i, 'Radiant'],
    [/\bgold\s+star\b/i, 'GoldStar'],
    [/\balt(?:ernate)?\s+art\b/i, 'AltArt'],
    [/\bfull\s+art\b|\bFA\b/i, 'FullArt'],
    [/\btrainer\s+gallery\b|\bTG\d{2}\b/i, 'TG'],
    [/\bgalarian\s+gallery\b|\bGG\d{2}\b/i, 'GG'],
    [/\bACE\s*SPEC\b/i, 'ACESPEC']
  ];

  // Set codes: Japanese (s12a, sv2a, sm12, m1l, cp6…) and a few English abbreviations.
  const SETCODE_RE = /(?:^|[\s\[\(#])((?:sv|s|sm|xy|bw|m|cp|dp|pt|l|sc|svp|sp)\s?-?(?:\d{1,2}[a-z]{0,2}|p)\b)/i;

  // Known set names → hint (longest first). Not exhaustive; numbers carry most of the matching weight.
  const SET_HINTS = [
    // Scarlet & Violet era
    'Prismatic Evolutions', 'Surging Sparks', 'Stellar Crown', 'Shrouded Fable', 'Twilight Masquerade', 'Temporal Forces', 'Paldean Fates', 'Paradox Rift', 'Obsidian Flames', 'Paldea Evolved', 'Scarlet & Violet', 'Scarlet and Violet', 'Journey Together', 'Destined Rivals', 'Black Bolt', 'White Flare', 'Mega Evolution', 'Phantasmal Flames',
    'Shiny Treasure ex', 'Shiny Treasures', 'Terastal Festival', 'Super Electric Breaker', 'Battle Partners', 'Heat Wave Arena', 'Glory of Team Rocket', 'Mega Brave', 'Mega Symphonia', 'Inferno X', 'Ninja Spinner', 'Wild Force', 'Cyber Judge', 'Crimson Haze', 'Mask of Change', 'Night Wanderer', 'Stellar Miracle', 'Paradise Dragona', 'Raging Surf', 'Ancient Roar', 'Future Flash', 'Ruler of the Black Flame', 'Pokemon Card 151', 'Pokémon Card 151', 'Triplet Beat', 'Snow Hazard', 'Clay Burst', 'Violet ex', 'Scarlet ex',
    // Sword & Shield era
    'Crown Zenith', 'Silver Tempest', 'Lost Origin', 'Pokemon GO', 'Astral Radiance', 'Brilliant Stars', 'Fusion Strike', 'Celebrations', 'Evolving Skies', 'Chilling Reign', 'Battle Styles', 'Shining Fates', 'Vivid Voltage', 'Champion\'s Path', 'Darkness Ablaze', 'Rebel Clash', 'Sword & Shield', 'Sword and Shield',
    'VSTAR Universe', 'Paradigm Trigger', 'Incandescent Arcana', 'Lost Abyss', 'Dark Phantasma', 'Space Juggler', 'Time Gazer', 'Battle Region', 'Star Birth', 'VMAX Climax', 'Fusion Arts', 'Blue Sky Stream', 'Skyscraping Perfection', 'Eevee Heroes', 'Silver Lance', 'Jet-Black Spirit', 'Shiny Star V', 'Vivid Voltage', 'Legendary Heartbeat', 'Amazing Volt Tackle', 'Explosive Walker', 'Infinity Zone', 'Rebellion Crash',
    // Sun & Moon era
    'Cosmic Eclipse', 'Hidden Fates', 'Unified Minds', 'Unbroken Bonds', 'Team Up', 'Lost Thunder', 'Dragon Majesty', 'Celestial Storm', 'Forbidden Light', 'Ultra Prism', 'Crimson Invasion', 'Shining Legends', 'Burning Shadows', 'Guardians Rising', 'Sun & Moon', 'Sun and Moon', 'Tag Team GX All Stars', 'Tag All Stars', 'Dream League', 'Alter Genesis', 'Remix Bout', 'Sky Legend', 'GX Ultra Shiny', 'Ultra Shiny', 'Night Unison', 'Tag Bolt',
    // XY / BW
    'Evolutions', 'Steam Siege', 'Fates Collide', 'Generations', 'BREAKpoint', 'BREAKthrough', 'Ancient Origins', 'Roaring Skies', 'Double Crisis', 'Primal Clash', 'Phantom Forces', 'Furious Fists', 'Flashfire', 'Plasma Blast', 'Plasma Freeze', 'Plasma Storm', 'Boundaries Crossed', 'Dragons Exalted', 'Dark Explorers', 'Next Destinies', 'Noble Victories', 'Emerging Powers', 'Black & White', 'Black and White',
    // DP / HGSS / Platinum
    'Call of Legends', 'Triumphant', 'Undaunted', 'Unleashed', 'HeartGold SoulSilver', 'HeartGold & SoulSilver', 'Arceus', 'Supreme Victors', 'Rising Rivals', 'Platinum', 'Stormfront', 'Legends Awakened', 'Majestic Dawn', 'Great Encounters', 'Secret Wonders', 'Mysterious Treasures', 'Diamond & Pearl', 'Diamond and Pearl',
    // EX era
    'Power Keepers', 'Dragon Frontiers', 'Crystal Guardians', 'Holon Phantoms', 'Legend Maker', 'Delta Species', 'Unseen Forces', 'Emerald', 'Deoxys', 'Team Rocket Returns', 'FireRed & LeafGreen', 'FireRed LeafGreen', 'Hidden Legends', 'Team Magma vs Team Aqua', 'Dragon', 'Sandstorm', 'Ruby & Sapphire', 'Ruby and Sapphire',
    // WotC / e-series / vintage JP
    'Skyridge', 'Aquapolis', 'Expedition', 'Legendary Collection', 'Neo Destiny', 'Neo Revelation', 'Neo Discovery', 'Neo Genesis', 'Gym Challenge', 'Gym Heroes', 'Team Rocket', 'Base Set 2', 'Base Set', 'Fossil', 'Jungle', 'Southern Islands', 'Wizards Black Star Promo', 'Black Star Promo',
    'Pokemon VS', 'Pokémon VS', 'VS Series', 'Vs set', 'VS', 'Web Series', 'Pokemon Web', 'Neo 4', 'Neo 3', 'Neo 2', 'Neo 1', 'e-Series', 'e Series', 'e-Card', 'Wind from the Sea', 'Town on No Map', 'Mysterious Mountains', 'Split Earth', 'Darkness and to Light', 'Crossing the Ruins', 'Awakening Legends', 'Rocket Gang', 'Gym 1', 'Gym 2', 'Leader\'s Stadium', 'Challenge from the Darkness', 'CD Promo', 'Vending Series', 'Topsun', 'Bandai Carddass'
  ].sort((a, b) => b.length - a.length);

  const CONDITION_WORDS = /\b(nm|lp|mp|hp|dmg|near\s*mint|lightly\s*played|light\s*play|moderately\s*played|heavily\s*played|damaged|mint|pack\s*fresh|played|excellent|good|fair|poor)\b/gi;

  const normalize = (s) =>
    String(s || '')
      .normalize('NFKC')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/[【】\[\]()｜|•·★☆✨🔥💎⭐️‼️!]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const stripLeadingZeros = (n) => String(n || '').replace(/^0+(?=\d)/, '');

  function detectLanguage(text) {
    if (/\b(japanese|japan|jpn|jp)\b/i.test(text) || /[ぁ-んァ-ン一-龯]/.test(text) || /\b(s\d{1,2}[a-z]?|sv\d{1,2}[a-z]?|sm\d{1,2}[a-z]?)\b/i.test(text)) return 'ja';
    if (/\b(korean|kor)\b/i.test(text)) return 'ko';
    if (/\b(chinese|chn|t-chinese|s-chinese)\b/i.test(text)) return 'zh';
    return 'en';
  }

  function detectGraded(text) {
    const m = text.match(/\b(PSA|BGS|CGC|SGC|ARS|TAG|ACE|HGA|Beckett)\s*(?:GEM\s*(?:MT|MINT)\s*)?(10|9\.5|[1-9](?:\.5)?)\b/i);
    if (m) return { company: m[1].toUpperCase(), grade: parseFloat(m[2]) };
    if (/\b(graded|slab|slabbed)\b/i.test(text)) return { company: null, grade: null };
    return null;
  }

  function detectSealed(text) {
    return /\b(booster\s*(box|pack|bundle|display)|elite\s*trainer\s*box|\bETB\b|blister|tin\b|collection\s*box|premium\s*collection|build\s*&?\s*battle|starter\s*deck|theme\s*deck|battle\s*deck|sealed\s*(box|pack|product|case)|factory\s*sealed|\bcase\b.*\bsealed\b|sleeves|binder\s*(only)?|playmat|deck\s*box)\b/i.test(text);
  }

  function detectLot(text) {
    return /\b(lot|bundle|bulk|binder|collection|playset|set\s+of\s+\d+|x\s?[2-9]\b|\b[2-9]\s?x\b|\b\d{2,}\s+cards?)\b/i.test(text) && !/\bvs\s+set\b/i.test(text);
  }

  function detectNumber(text) {
    // 115/083, #096/141, 199 / 165, No.025/165
    let m = text.match(/(?:#|no\.?\s*)?(\d{1,3})\s*\/\s*(\d{1,3})\b/i);
    if (m) return { number: stripLeadingZeros(m[1]), total: stripLeadingZeros(m[2]), raw: m[0] };
    // TG12/TG30, GG45/GG70, SV107/SV122, SWSH284, XY120
    m = text.match(/\b((?:TG|GG|SV|SWSH|XY|SM|BW|DP|HGSS|RC)\s?\d{1,3})(?:\s*\/\s*(?:TG|GG|SV)?\d{1,3})?\b/i);
    if (m) return { number: m[1].replace(/\s/g, '').toUpperCase(), total: null, raw: m[0] };
    // bare "#25"
    m = text.match(/#\s?(\d{1,3})\b/);
    if (m) return { number: stripLeadingZeros(m[1]), total: null, raw: m[0] };
    return null;
  }

  function detectSetCode(text) {
    const m = text.match(SETCODE_RE);
    if (!m) return null;
    const code = m[1].replace(/[\s-]/g, '').toLowerCase();
    // guard against years/HP values etc: must start with letters
    if (!/^[a-z]+/.test(code)) return null;
    // "m1" style codes are valid but "m" + 2 digits can be a false hit from e.g. "m25" — accept anyway, low weight
    return code;
  }

  function detectSetHint(text) {
    const lower = text.toLowerCase();
    for (const name of SET_HINTS) {
      const n = name.toLowerCase();
      // word-boundary match; 'vs' needs care because it's a common abbreviation ("x vs y")
      const idx = lower.indexOf(n);
      if (idx === -1) continue;
      const before = idx === 0 ? ' ' : lower[idx - 1];
      const after = idx + n.length >= lower.length ? ' ' : lower[idx + n.length];
      if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
      if (n === 'vs' && /\b(vs|versus)\s+[a-z]/i.test(text) && !/\b(pokemon|pokémon)\s+vs\b|\bvs\s+(set|series)\b|\bvs\b.*\b\d{1,3}\/141\b/i.test(text)) continue;
      return name;
    }
    return null;
  }

  function detectRarity(text) {
    for (const [re, tag] of RARITY_RE) if (re.test(text)) return tag;
    return null;
  }

  function detectPrintings(text) {
    const p = [];
    if (/\b1st\s*(?:ed(?:ition)?\.?)?\b|\bfirst\s+edition\b/i.test(text)) p.push('1st Edition');
    if (/\bshadowless\b/i.test(text)) p.push('Shadowless');
    if (/\breverse\s*(?:holo|foil)?\b|\brev\s*holo\b/i.test(text)) p.push('Reverse Holofoil');
    else if (/\b(holo|holofoil|holographic|foil)\b/i.test(text)) p.push('Holofoil');
    if (/\bunlimited\b/i.test(text)) p.push('Unlimited');
    if (/\b(promo|prerelease|staff)\b/i.test(text)) p.push('Promo');
    if (/\bcosmos\b/i.test(text)) p.push('Cosmos Holo');
    return p;
  }

  function extractName(text, found) {
    let t = ' ' + text + ' ';
    // remove the pieces we've already identified
    if (found.number && found.number.raw) t = t.replace(found.number.raw, ' ');
    if (found.setHint) t = t.replace(new RegExp(found.setHint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
    t = t.replace(SETCODE_RE, ' ');
    t = t.replace(/\b(PSA|BGS|CGC|SGC|ARS|TAG|ACE|HGA|Beckett)\s*(?:GEM\s*(?:MT|MINT)\s*)?(10|9\.5|[1-9](?:\.5)?)\b/gi, ' ');
    t = t.replace(/\b(19|20)\d{2}\b/g, ' '); // years
    t = t.replace(/\bhp\s*\d{2,3}\b/gi, ' ');
    t = t.replace(CONDITION_WORDS, ' ');
    t = t.replace(/\b1st\s*(?:ed(?:ition)?\.?)?\b/gi, ' ');
    t = t.replace(/\b(TG|GG|SV|SWSH|XY|SM|BW|DP|RC)\s?\d{1,3}\b/g, ' ');
    t = t.replace(/[,;:/"#*+=~^<>]/g, ' ');
    t = t.replace(/\s-\s/g, ' ');

    const rawTokens = t.split(/\s+/).filter(Boolean);
    const kept = [];
    for (let tok of rawTokens) {
      const clean = tok.replace(/^[-'".]+|[-'".]+$/g, '');
      if (!clean) continue;
      const lower = clean.toLowerCase();
      if (NAME_SUFFIX.has(lower)) { kept.push(clean); continue; }
      if (OWNER_RE.test(clean)) { kept.push(clean); continue; }
      if (NOISE.has(lower)) continue;
      if (/^\d+$/.test(lower)) continue; // stray numbers
      if (/^[a-z]$/i.test(lower) && lower !== 'v' && lower !== 'm') continue; // single letters
      if (/^(\d+(st|nd|rd|th))$/.test(lower)) continue;
      kept.push(clean);
    }

    // Prefer the run of tokens that ends with a name suffix (ex/V/VMAX) or precedes the number position.
    // Heuristic: take up to 5 consecutive kept tokens starting from the first capitalised / suffix-bearing token.
    if (!kept.length) return '';
    let start = 0;
    for (let i = 0; i < kept.length; i++) {
      if (/^[A-Z]/.test(kept[i]) || NAME_SUFFIX.has(kept[i].toLowerCase())) { start = i; break; }
    }
    let run = kept.slice(start, start + 5);
    // trim trailing suffix-only garbage like a lone "&"
    while (run.length && run[run.length - 1] === '&') run.pop();
    // If the run contains a suffix (ex/gx/v/vmax/vstar), cut right after the last suffix token to drop trailing set words
    let lastSuffix = -1;
    run.forEach((w, i) => { if (['ex', 'gx', 'v', 'vmax', 'vstar', 'break', 'prime', 'legend', 'lvx', 'lv.x', 'star'].includes(w.toLowerCase())) lastSuffix = i; });
    if (lastSuffix >= 0) run = run.slice(0, lastSuffix + 1);
    else run = run.slice(0, 4);
    return run.join(' ').replace(/\s+&\s+/g, ' & ').trim();
  }

  CDS.parseCardTitle = function parseCardTitle(rawTitle) {
    const text = normalize(rawTitle);
    const out = {
      raw: rawTitle, text,
      name: '', number: null, total: null, numberRaw: null,
      setCode: null, setHint: null, language: 'en', rarity: null, printings: [],
      firstEdition: false, graded: null, isLot: false, isSealed: false, year: null, confidence: 0
    };
    if (!text) return out;
    const yr = text.match(/\b(19[9]\d|20[0-2]\d)\b/);
    if (yr) out.year = parseInt(yr[1], 10);
    out.language = detectLanguage(text);
    out.graded = detectGraded(text);
    out.isLot = detectLot(text);
    out.isSealed = detectSealed(text);
    if (out.isSealed) { out.confidence = 0; return out; } // sealed product / accessories: not a single card
    const num = detectNumber(text);
    if (num) { out.number = num.number; out.total = num.total; out.numberRaw = num.raw; }
    out.setCode = detectSetCode(text);
    out.setHint = detectSetHint(text);
    out.rarity = detectRarity(text);
    out.printings = detectPrintings(text);
    out.firstEdition = out.printings.includes('1st Edition');
    out.name = extractName(text, { number: num, setHint: out.setHint });

    // confidence: how identifiable is this card from the title alone?
    let c = 0;
    if (out.name) c += 0.45;
    if (out.number) c += 0.35;
    if (out.total) c += 0.05;
    if (out.setCode || out.setHint) c += 0.15;
    out.confidence = Math.min(1, c);
    return out;
  };

  /** Stable cache key for a parsed card (same card across listings → same lookup). */
  CDS.lookupKey = function (p) {
    return [p.language, (p.name || '').toLowerCase().replace(/[^a-z0-9&' ]/g, '').trim(), p.number || '', p.total || '', p.setCode || (p.setHint || '').toLowerCase(), p.firstEdition ? '1st' : ''].join('|');
  };

  /** Plain search string for provider APIs. */
  CDS.searchQuery = function (p) {
    return (p.name || '').replace(/\s+/g, ' ').trim();
  };

  const tokenSet = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9&' ]/g, ' ').split(/\s+/).filter((w) => w && !NOISE.has(w)));
  const numEq = (a, b) => {
    if (!a || !b) return false;
    const na = String(a).toUpperCase().replace(/^0+(?=\d)/, '');
    const nb = String(b).toUpperCase().replace(/^0+(?=\d)/, '');
    return na === nb;
  };
  /** Split a provider card number like "115/083", "096/141", "TG12/TG30" into {number,total}. */
  CDS.splitNumber = function (s) {
    const m = String(s || '').match(/^\s*#?\s*([A-Za-z]*\d{1,3}[A-Za-z]?)\s*(?:\/\s*([A-Za-z]*\d{1,3}))?/);
    if (!m) return { number: null, total: null };
    return { number: stripLeadingZeros(m[1].toUpperCase()), total: m[2] ? stripLeadingZeros(m[2].toUpperCase()) : null };
  };

  /** Score how well a provider candidate matches the parsed listing. 0–100. */
  CDS.matchScore = function (parsed, cand) {
    // cand: {name, number, total, set, setCode, language}
    let s = 0;
    const cn = CDS.splitNumber(cand.number);
    const pn = { number: parsed.number, total: parsed.total };
    if (pn.number && cn.number) {
      if (numEq(pn.number, cn.number)) {
        s += 45;
        if (pn.total && cn.total) s += numEq(pn.total, cn.total) ? 15 : -25;
      } else s -= 30;
    }
    const a = tokenSet(parsed.name), b = tokenSet(cand.name);
    if (a.size && b.size) {
      let inter = 0; a.forEach((w) => { if (b.has(w)) inter++; });
      const overlap = inter / Math.max(a.size, b.size);
      s += Math.round(overlap * 30);
      if (inter === 0) s -= 20;
    }
    const setText = ((cand.set || '') + ' ' + (cand.setCode || '')).toLowerCase();
    if (parsed.setCode && setText.includes(parsed.setCode.toLowerCase())) s += 10;
    if (parsed.setHint && setText.includes(parsed.setHint.toLowerCase())) s += 10;
    if (parsed.language === 'ja' && /japan/i.test(setText + ' ' + (cand.language || '') + ' ' + (cand.game || ''))) s += 5;
    if (parsed.language === 'en' && /japan/i.test(setText + ' ' + (cand.game || ''))) s -= 10;
    return Math.max(0, Math.min(100, s));
  };
})(globalThis);
