// Run: node test/parser.test.js
const path = require('path');
globalThis.chrome = undefined;
require(path.join(__dirname, '..', 'lib', 'storage.js'));
require(path.join(__dirname, '..', 'lib', 'card-parser.js'));
require(path.join(__dirname, '..', 'lib', 'condition-sniffer.js'));
require(path.join(__dirname, '..', 'lib', 'deal-scorer.js'));
const { CDS } = globalThis;

const cases = [
  ['Pokemon TCG Japanese Mega Floette ex SAR 115/083 Ninja Spinner', { name: 'Mega Floette ex', number: '115', total: '83', language: 'ja', rarity: 'SAR' }],
  ["ARS 4 2001 Pokemon TCG Rocket's Suicune Pokemon VS #096/141 Holo Japanese 1st", { name: "Rocket's Suicune", number: '96', total: '141', language: 'ja', firstEdition: true, gradedCompany: 'ARS', grade: 4 }],
  ["VS Bruno’s Steelix 084/141 HP 80 Japanese Pokémon TCG 1st Ed Holo", { name: "Bruno's Steelix", number: '84', total: '141', language: 'ja', firstEdition: true }],
  ["Japanese Vs set Blaine's Typhlosion 1st edition condition shown", { name: "Blaine's Typhlosion", number: null, language: 'ja', firstEdition: true }],
  ["Rocket's Raikou 094/141 Pokemon vs Holo (Japanese)", { name: "Rocket's Raikou", number: '94', total: '141', language: 'ja' }],
  ['Charizard ex 199/165 Pokemon 151 SV2a Japanese Near Mint', { name: 'Charizard ex', number: '199', total: '165', setCode: 'sv2a', language: 'ja' }],
  ['PSA 10 Umbreon VMAX Alt Art 215/203 Evolving Skies GEM MINT', { name: 'Umbreon VMAX', number: '215', total: '203', language: 'en', gradedCompany: 'PSA', grade: 10, setHint: 'Evolving Skies' }],
  ['Pikachu ex 238/191 Surging Sparks SIR Special Illustration Rare NM', { name: 'Pikachu ex', number: '238', total: '191', rarity: 'SAR', setHint: 'Surging Sparks' }],
  ['1999 Pokemon Base Set Shadowless Charizard 4/102 Holo Rare LP', { name: 'Charizard', number: '4', total: '102', language: 'en', setHint: 'Base Set' }],
  ['Pokemon Japanese Lot of 50 cards holo bundle', { isLot: true }],
  ['Iono SAR 350/190 s12a VSTAR Universe Japanese', { name: 'Iono', number: '350', total: '190', setCode: 's12a', language: 'ja' }],
  ['Moonbreon Umbreon VMAX 215/203 - Evolving Skies - Pack Fresh - Free Shipping!', { name: 'Moonbreon Umbreon VMAX', number: '215' }],
  ['Pokémon Lugia V Alt Art 186/195 Silver Tempest Near Mint', { name: 'Lugia V', number: '186', total: '195', rarity: 'AltArt' }],
  ['Pokemon Card Japanese Gengar & Mimikyu GX SA 212/236 Shiny Star V', { name: 'Gengar & Mimikyu GX', number: '212' }],
  ['Pokemon TCG Mew ex 232/091 Paldean Fates Japanese Shiny Treasure ex', { name: 'Mew ex', number: '232' }],
  ['TG12/TG30 Pikachu VMAX Lost Origin Trainer Gallery', { name: 'Pikachu VMAX', number: 'TG12' }],
  ['Pokemon Japanese Rayquaza VMAX 252/184 HR Rainbow s8b VMAX Climax', { name: 'Rayquaza VMAX', number: '252', setCode: 's8b' }],
];

let pass = 0, fail = 0;
for (const [title, expect] of cases) {
  const p = CDS.parseCardTitle(title);
  const got = { name: p.name, number: p.number, total: p.total, language: p.language, rarity: p.rarity, setCode: p.setCode, setHint: p.setHint, firstEdition: p.firstEdition, isLot: p.isLot, gradedCompany: p.graded && p.graded.company, grade: p.graded && p.graded.grade };
  const errors = [];
  for (const k of Object.keys(expect)) if (got[k] !== expect[k]) errors.push(`${k}: expected ${JSON.stringify(expect[k])} got ${JSON.stringify(got[k])}`);
  if (errors.length) { fail++; console.log('FAIL', JSON.stringify(title)); errors.forEach((e) => console.log('   ', e)); console.log('    full:', JSON.stringify(got)); }
  else { pass++; console.log('ok  ', JSON.stringify(title), '→', p.name, p.number ? '#' + p.number : '', p.confidence.toFixed(2)); }
}
console.log(`\n${pass} passed, ${fail} failed`);

// match scoring sanity
const parsed = CDS.parseCardTitle("Rocket's Suicune Pokemon VS #096/141 Holo Japanese 1st");
const cands = [
  { name: "Rocket's Suicune", number: '096/141', set: 'Pokemon VS', game: 'Pokemon Japan' },
  { name: 'Suicune', number: '096/141', set: 'Pokemon VS', game: 'Pokemon Japan' },
  { name: "Rocket's Suicune", number: '245/165', set: 'Pokemon 151' },
  { name: 'Suicune ex', number: '96/198', set: 'Scarlet & Violet' }
];
console.log('\nmatch scores:', cands.map((c) => `${c.name} ${c.number} → ${CDS.matchScore(parsed, c)}`));

// condition sniffer
const sn = [
  { title: 'Charizard ex NM pack fresh', description: '', siteCondition: 'Like new' },
  { title: 'Charizard ex', description: 'Condition: Near Mint. Ships in toploader', siteCondition: 'Like new' },
  { title: 'Charizard ex LP', description: 'light whitening on back, see pics', siteCondition: 'Good' },
  { title: 'Charizard ex', description: 'has a crease across the top, heavily played', siteCondition: 'Fair' },
  { title: 'PSA 9 Charizard', description: '', siteCondition: 'Like new' },
  { title: 'Charizard', description: '', siteCondition: 'Good' },
];
for (const s of sn) console.log('sniff', JSON.stringify(s.title), s.siteCondition, '→', JSON.stringify(CDS.sniffCondition(s)));

// deal scorer
const settings = CDS.DEFAULTS;
for (const ask of [8, 14, 18, 21, 30]) {
  const d = CDS.scoreDeal({ asking: ask, prices: { NM: 22, LP: 18 }, tier: 'LP', settings });
  console.log('deal ask', ask, '→', d.tier, d.label, 'basis', d.basisPrice, 'ratio', d.ratio.toFixed(2), CDS.fmtPct(d.pctDiff));
}
console.log('offer', CDS.suggestOffer({ asking: 21, basisPrice: 18, settings }));
console.log('flip', CDS.estimateFlip({ cost: 15, resale: 22, platform: 'ebay', settings }));
process.exit(fail ? 1 : 0);
