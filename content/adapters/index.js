/* Card Deal Scout — adapter registry */
(function (root) {
  const CDS = (root.CDS = root.CDS || {});
  CDS.adapters = CDS.adapters || {};
  CDS.pickAdapter = function (loc, settings) {
    const order = ['mercari', 'ebay'];
    for (const id of order) {
      const a = CDS.adapters[id];
      if (a && a.matches(loc)) return settings.sites && settings.sites[id] === false ? null : a;
    }
    return settings.sites && settings.sites.generic === false ? null : CDS.adapters.generic;
  };
})(globalThis);
