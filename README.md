# Card Deal Scout (v0.1.0)

Chrome extension that spots Pokémon cards (English + Japanese) on marketplace pages, pulls the current
**LP–NM raw market price**, and overlays a deal badge on every listing:

| Badge | Meaning | Default rule (asking ÷ market) |
|---|---|---|
| 🟢 **STEAL** (pulsing green) | *Check this one out — looks like it could be a really good deal!* | ≤ 0.72 |
| 🪙 **OFFER IT** (teal→gold) | *Could be a deal, especially with an offer under asking — not amazing where it sits now.* | ≤ 0.92 |
| ⚪ **AT MARKET** (gray, dark outline) | *Basically right at market value. Boring, moving on.* | ≤ 1.15 |
| 🔴 **WAY OVER** (red) | *Whoa… seller is asking WAY over market. Couldn't hurt to lowball an offer though.* | > 1.15 |

Plus special states: 🟣 **SLAB** (graded card — raw price shown for reference, or compared against the matching
PSA grade when PriceCharting is configured), 📦 **LOT**, dashed **?** (couldn't match / sealed product), and 🔑 **NO KEY**.

Hand-tuned adapters for **Mercari** (list + item pages) and **eBay** (search + item pages). Any other site can be
enabled from the popup; the extension then analyses the page layout heuristically (price text → repeating "card
cell" → best title candidate).

---

## Install (unpacked)

1. Unzip `card-deal-scout.zip` somewhere permanent (Chrome loads it from that folder).
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. **Load unpacked** → pick the `card-deal-scout` folder.
4. Click the extension icon → ⚙ → paste your **JustTCG API key** (free: <https://justtcg.com/dashboard>) → **Test**.
   The test also auto-detects JustTCG's Japanese Pokémon game id.
5. Open a Mercari search. Badges appear as cards are priced; hover one for the breakdown, click to pin it.

> No key yet? The **manual price sheet** (Options → Manual price sheet) works with zero APIs — paste
> `name,number,set,language,nm,lp` rows (e.g. from Card Ladder / Terapeak) and badges light up immediately.

---

## Features

### Core: price overlay
- Parses messy titles like `ARS 4 2001 Pokemon TCG Rocket's Suicune Pokemon VS #096/141 Holo Japanese 1st` into
  name / number / set code (`s12a`, `sv2a`…) / language / rarity (SAR, AR, SR…) / printing (1st Ed, Holo, Reverse) / graded.
- Looks the card up (cached 6h, de-duplicated, rate-limited) and compares the asking price against the right tier.
- Badge shows tier, % vs market, the LP–NM range and a 7-day trend arrow.
- Hover/click popover: asking vs NM/LP/MP, the exact basis used, condition sniffed, suggested offer, flip net, trend,
  cross-check links, watch button, "seen" button, other candidate matches.
- Item pages get a full **deal panel** under the price (market range, this listing, offer & flip, condition notes, 90-day
  sparkline of your own lookups, PSA comps when available).

### The 6 extras
1. **Offer & profit calculator** — suggested offer = target % of market (default 80%), capped at the max discount the
   site lets buyers send (Mercari ≈ 25%), rounded to a "human" number. Flip estimate nets out eBay/Mercari fees,
   shipping and supplies (all editable) and shows ROI at ask *and* at the suggested offer, plus a break-even buy price.
2. **Watchlist + deal alerts** — add cards (from any badge with one click, or in Options). Matching listings under your
   max price get an amber pulsing ring + Chrome notification. **Saved-search patrol** re-opens your saved Mercari/eBay
   search URLs in background tabs every N minutes, scans, closes them, and notifies on hits (and on STEALs if enabled).
3. **Condition & grading sniffer** — reads title, description and the site's condition field (Mercari "Like new" →
   LP, "Good" → MP…), detects NM/LP/MP/HP/DMG wording, defects (crease, whitening, edge wear…), lots/bundles, sealed
   product, and PSA/BGS/CGC/ARS/TAG slabs — then compares against the matching price tier (MP/HP/DMG are derived
   from LP when the source lacks them).
4. **Deal Digest popup** — every card on the current page ranked (best deal / biggest $ savings / cheapest / best flip),
   tier filter chips, hide-seen, jump-to-listing, **Open all steals**, **Export CSV**; the toolbar icon shows the
   steal count for the active tab.
5. **Trend & volatility signal** — 7d/30d price change from JustTCG on the badge, "falling knife" / "spiking" flags,
   and a local price history sparkline that builds up from your own lookups (works with any provider).
6. **Cross-check & seen-tracker** — one-click eBay sold / TCGplayer / PriceCharting / 130point searches pre-filled
   for the card; listings you've opened are dimmed with a 👁 so you don't re-evaluate the same card twice.

### Pricing providers (Options → Pricing sources)
| Provider | Needs | What you get |
|---|---|---|
| **JustTCG** (default) | free API key | per-condition prices (NM/LP/MP/HP/DMG), printing-aware, 7d/30d trend. TCGplayer-derived. |
| **PriceCharting** | paid token | eBay-sold-based "Ungraded" (LP estimated as 85% of it, editable) + PSA 7/8/9/9.5/10, BGS/CGC/SGC 10 comps. Deep vintage + Japanese coverage. |
| **Manual sheet** | nothing | your own CSV (Card Ladder, Terapeak, gut feel). Always available; also the fallback. |

Order and blend mode are configurable: "first hit wins" (saves quota) or "query all & average".

---

## Roadmap / Phase 2 (things we talked about)
- **Terapeak harvester** — opt-in, low-cadence (default every 3 days, jittered 45–90 s between queries, daily cap,
  pauses on captcha) scan of Seller Hub › Research for only the sets you configure, feeding *true* accepted-offer sale
  prices into the manual-sheet provider. eBay's APIs don't expose this (Finding API decommissioned Feb 2025, Marketplace
  Insights is limited-release), so it has to run in your logged-in browser — and it's technically against eBay's
  automated-access terms, hence opt-in.
- **Japanese domestic floor** — Yuyu-tei / Cardrush / Hareruya2 as a secondary "arbitrage floor" signal (JPY → USD +
  shipping). Japan prices run below US Mercari, so they're a buy trigger, not a benchmark.
- **PriceCharting × JustTCG blend tuning** once you have both keys: show ask-based vs sold-based side by side.
- **Grade-aware slabs**: use PriceCharting PSA comps for slabs (already wired when the grade matches a comp).
- Whatnot / TCGplayer / Collectr adapters if the heuristic mode isn't good enough there.

---

## Project layout
```
manifest.json                 MV3 manifest
background/service-worker.js  lookups (queue+cache), notifications, patrol alarms, site enablement, action badge
lib/card-parser.js            title → card identity (+ matchScore for ranking API candidates)
lib/condition-sniffer.js      title/description/site field → NM/LP/MP/HP/DMG, graded, lot, defects
lib/deal-scorer.js            tiers, suggested offer, flip estimate, watchlist matching
lib/providers/*.js            justtcg, pricecharting, manual + orchestrator (index.js)
content/adapters/*.js         mercari, ebay, generic (heuristic) DOM adapters
content/content.js            scanner, badges, popover, detail panel, SPA handling
popup/                        Deal Digest
options/                      settings, watchlist, patrol, manual sheet, backup
test/                         node unit tests (parser) + Playwright e2e (loads the real extension against fixtures)
```

Run tests: `node test/parser.test.js` and `NODE_PATH=$(npm root -g) node test/e2e.js` (needs Playwright + Chromium).

## Notes / known limits
- JustTCG response shapes follow their official JS SDK (`data[].variants[].{condition,printing,price,priceChange7d}`);
  the adapter is defensive, but if the **Test** button errors, turn on *Verbose console logging* in Options and check the
  service-worker console (`chrome://extensions` → Service worker).
- Market prices are only as good as the title parse + the provider's match; the popover shows the match score and the
  other candidates so you can sanity-check. Low-confidence matches get a ⚠ flag.
- Heuristic mode on unknown sites is best-effort — if a site renders listings in a very unusual way, badges may land
  on the wrong element or not at all.
- Keys are stored in `chrome.storage.sync` and only ever sent to that provider's API host (declared in `host_permissions`).
