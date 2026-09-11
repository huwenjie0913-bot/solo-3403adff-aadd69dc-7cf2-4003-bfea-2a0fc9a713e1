/* topologies.js - mirror of search.TOPOS on the client. */
(function (global) {
  "use strict";

  function buildCatalog() {
    const L = [], Pi = [], T = [], stub = [];

    for (const near of ["source", "load"]) {
      for (const es of ["L", "C"]) {
        for (const ep of ["L", "C"]) {
          L.push({
            code: `L-${near[0]}-${es}${ep}`, family: "L",
            name: `L: 串${es}+并${ep} (串在${near === "source" ? "源" : "负载"}侧)`,
            params: [
              { id: "s1", kind: "series", etype: es, ptype: "x", place: near },
              { id: "p1", kind: "shunt", etype: ep, ptype: "x",
                place: near === "source" ? "load" : "source" },
            ],
          });
        }
      }
    }
    for (const p1 of ["L", "C"])
      for (const s2 of ["L", "C"])
        for (const p3 of ["L", "C"]) {
          Pi.push({
            code: `Pi-${p1}${s2}${p3}`, family: "Pi",
            name: `Π: 并${p1}-串${s2}-并${p3}`,
            params: [
              { id: "p1", kind: "shunt", etype: p1, ptype: "x", place: "source" },
              { id: "s2", kind: "series", etype: s2, ptype: "x" },
              { id: "p3", kind: "shunt", etype: p3, ptype: "x", place: "load" },
            ],
          });
        }
    for (const s1 of ["L", "C"])
      for (const p2 of ["L", "C"])
        for (const s3 of ["L", "C"]) {
          T.push({
            code: `T-${s1}${p2}${s3}`, family: "T",
            name: `T: 串${s1}-并${p2}-串${s3}`,
            params: [
              { id: "s1", kind: "series", etype: s1, ptype: "x", place: "source" },
              { id: "p2", kind: "shunt", etype: p2, ptype: "x" },
              { id: "s3", kind: "series", etype: s3, ptype: "x", place: "load" },
            ],
          });
        }
    for (const termin of ["open", "short"]) {
      stub.push({
        code: `Stb-${termin}`, family: "stub",
        name: `短截线: ${termin === "open" ? "开路" : "短路"}短截线 (串线段+并短截线)`,
        termin,
        params: [
          { id: "s1", kind: "series", etype: "line", ptype: "th",
            z0key: "zline", vf: 1 },
          { id: "p1", kind: "shunt", etype: "line", ptype: "th",
            z0key: "zstub", vf: 1, termin },
        ],
      });
    }
    return { L, Pi, T, stub };
  }

  const CATALOG = buildCatalog();
  const ALL = [].concat(CATALOG.L, CATALOG.Pi, CATALOG.T, CATALOG.stub);

  function byCode(code) {
    return ALL.find(t => t.code === code);
  }

  // Build evaluate()-ready segments (source -> load order) from the
  // parameter map {id: value} where value is L(H)/C(F)/length(m).
  function segmentsFromValues(cfg, values, setup) {
    const ordered = [...cfg.params].sort((a, b) =>
      (a.place === "load" ? 1 : 0) - (b.place === "load" ? 1 : 0));
    return ordered.map(sp => {
      const seg = { id: sp.id, kind: sp.kind, etype: sp.etype };
      const v = values[sp.id];
      if (sp.ptype === "x") {
        seg.val = v;
        seg.q = sp.etype === "L" ? (+setup.qL || 0) : (+setup.qC || 0);
      } else {
        seg.etype = "line";
        seg.z0 = +setup[sp.z0key] || 50;
        seg.vf = sp.vf;
        seg.len = v;
        if (sp.termin) seg.termin = sp.termin;
      }
      return seg;
    });
  }

  global.TOPO = { CATALOG, ALL, byCode, segmentsFromValues };
})(window);
