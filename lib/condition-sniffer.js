/* Card Deal Scout — condition & grading sniffer.
 * Reads the title, description and the marketplace's own condition field and decides
 * which price tier (NM / LP / MP / HP / DMG) the listing should be compared against.
 * Classic script: attaches to globalThis.CDS. */
(function (root) {
  const CDS = (root.CDS = root.CDS || {});

  const TIER_ORDER = ['NM', 'LP', 'MP', 'HP', 'DMG'];
  CDS.TIER_ORDER = TIER_ORDER;
  const worse = (a, b) => TIER_ORDER[Math.max(TIER_ORDER.indexOf(a), TIER_ORDER.indexOf(b))];

  // Marketplace condition fields → tier (conservative on purpose: protects the buyer)
  const SITE_MAP = [
    [/^(brand\s*new|new|new with tags|nwt)$/i, 'NM'],
    [/^(like\s*new|excellent|new \(other\)|mint)$/i, 'LP'],
    [/^(very\s*good|good|used|pre-?owned)$/i, 'MP'],
    [/^(fair|acceptable)$/i, 'HP'],
    [/^(poor|damaged|for parts|parts)$/i, 'DMG']
  ];

  const EXPLICIT = [
    [/\b(gem\s*mint|pack\s*fresh|pristine|flawless)\b/i, 'NM', 'pack fresh / gem mint'],
    [/\bnear\s*mint\b|\bNM\b|\bNM\/M\b|\bM\/NM\b|\bNM-?MT\b|\bmint\b/i, 'NM', 'stated NM'],
    [/\blightly\s*played\b|\blight\s*play\b|\bLP\b|\bNM\/LP\b|\bNM-LP\b|\bminor\s*(wear|whitening|scratch)/i, 'LP', 'stated LP'],
    [/\bmoderately\s*played\b|\bmoderate\s*play\b|\bMP\b|\bLP\/MP\b|\bplayed\b/i, 'MP', 'stated MP / played'],
    [/\bheavily\s*played\b|\bheavy\s*play\b|\bHP\b(?!\s*\d)/i, 'HP', 'stated HP'],
    [/\bdamaged\b|\bDMG\b|\bpoor\b/i, 'DMG', 'stated damaged']
  ];

  // Defect words: each bumps the tier down (at least to the given floor)
  const DEFECTS = [
    [/\b(crease|creased|bent|bend|fold|folded|tear|torn|rip|ripped|water\s*damage|ink|stain|peel|peeling|hole|chunk|missing)\b/i, 'DMG', 'major defect'],
    [/\b(heavy|lots\s+of|significant|major)\s+(whitening|wear|scratch|scratches|scuff|edge\s*wear)\b/i, 'HP', 'heavy wear'],
    [/\b(whitening|edge\s*wear|edgewear|scratch|scratches|scuff|scuffs|dent|dents|dings?|print\s*line|silvering|surface\s*wear|corner\s*wear)\b/i, 'LP', 'minor wear noted'],
    [/\b(wear|worn|played\s*condition|shows\s*wear|some\s*wear|see\s*(pics|photos|pictures)\s*for\s*condition)\b/i, 'LP', 'wear mentioned']
  ];
  const MINOR = /\b(minor|light|slight|tiny|small|very\s*light|barely)\b/i;

  /**
   * @param {{title?:string, description?:string, siteCondition?:string}} input
   * @returns {{tier:string|null, source:string, graded:object|null, isLot:boolean, flags:string[], notes:string[]}}
   */
  CDS.sniffCondition = function sniffCondition(input) {
    const title = String(input.title || '');
    const desc = String(input.description || '');
    const site = String(input.siteCondition || '').trim();
    const all = title + ' \n ' + desc;
    const out = { tier: null, source: 'unknown', graded: null, isLot: false, flags: [], notes: [] };

    // graded?
    const g = all.match(/\b(PSA|BGS|CGC|SGC|ARS|TAG|ACE|HGA|Beckett)\s*(?:GEM\s*(?:MT|MINT)\s*)?(10|9\.5|[1-9](?:\.5)?)\b/i);
    if (g) out.graded = { company: g[1].toUpperCase(), grade: parseFloat(g[2]) };
    else if (/\b(graded|slab|slabbed)\b/i.test(all) && !/\b(not|un)\s*graded\b|\bungraded\b|\braw\b/i.test(all)) out.graded = { company: null, grade: null };

    // lot / bundle?
    out.isLot = /\b(lot|bundle|bulk|binder|playset|collection|set\s+of\s+\d+|x\s?[2-9]\b|\b[2-9]\s?x\b|\b\d{2,}\s+cards?)\b/i.test(all) && !/\bvs\s+set\b/i.test(all);

    // 1) explicit condition statements in title/description (title wins ties)
    let tier = null, source = null;
    for (const [re, t, why] of EXPLICIT) {
      if (re.test(title)) { tier = t; source = 'title'; out.notes.push(why + ' (title)'); break; }
    }
    if (!tier) {
      for (const [re, t, why] of EXPLICIT) {
        if (re.test(desc)) { tier = t; source = 'description'; out.notes.push(why + ' (description)'); break; }
      }
    }
    // 2) marketplace field
    if (!tier && site) {
      for (const [re, t] of SITE_MAP) if (re.test(site)) { tier = t; source = 'site'; out.notes.push(`site condition "${site}"`); break; }
    }
    // 3) defects downgrade
    for (const [re, floor, why] of DEFECTS) {
      if (re.test(all)) {
        out.flags.push(why);
        const minor = MINOR.test(all);
        let f = floor;
        if (minor && floor === 'LP') f = 'LP';
        if (minor && floor === 'HP') f = 'MP';
        tier = tier ? worse(tier, f) : f;
        if (source !== 'title') source = source || 'defects';
        break; // strongest match listed first
      }
    }
    if (out.graded && out.graded.grade != null) {
      // graded slabs: raw tiers don't apply, but keep an approximation for display
      const gr = out.graded.grade;
      tier = gr >= 9 ? 'NM' : gr >= 7 ? 'LP' : gr >= 5 ? 'MP' : gr >= 3 ? 'HP' : 'DMG';
      source = 'graded';
      out.notes.push(`${out.graded.company} ${gr} slab — compared against raw for reference only`);
    }
    out.tier = tier;
    out.source = source || 'unknown';
    if (out.isLot) out.flags.push('lot / bundle — price is for multiple cards');
    return out;
  };

  CDS.tierLabel = (t) => ({ NM: 'Near Mint', LP: 'Lightly Played', MP: 'Moderately Played', HP: 'Heavily Played', DMG: 'Damaged' }[t] || 'Unknown');
})(globalThis);
