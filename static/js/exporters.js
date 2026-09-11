/* export.js - circuit SVG, BOM (CSV) and per-frequency JSON export. */
(function (global) {
  "use strict";

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  function circuitSvg(schematicSvg, title) {
    // clone the live schematic and add a title/footer
    const clone = schematicSvg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const h = +clone.getAttribute("viewBox").split(" ")[3];
    const t = document.createElementNS(
      "http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", 12); t.setAttribute("y", 22);
    t.setAttribute("class", "exp-title");
    t.textContent = title || "天线匹配网络";
    clone.insertBefore(t, clone.firstChild);
    const f = document.createElementNS(
      "http://www.w3.org/2000/svg", "text");
    f.setAttribute("x", 12); f.setAttribute("y", h - 6);
    f.setAttribute("class", "exp-foot");
    f.textContent = new Date().toISOString().slice(0, 19);
    clone.appendChild(f);
    return new XMLSerializer().serializeToString(clone);
  }

  function exportSvg(schematicSvg, title) {
    const txt =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      circuitSvg(schematicSvg, title);
    download("matching-network.svg", txt, "image/svg+xml");
  }

  // one BOM row per physical component
  function bomRows(cfg, segs) {
    return segs.map(s => {
      if (s.etype === "L") {
        return ["L" + s.id, "电感",
          (s.val * 1e6).toFixed(3) + " uH",
          s.q ? ("Q>=" + s.q) : "",
          s.kind === "series" ? "串联" : "并联"];
      }
      if (s.etype === "C") {
        return ["C" + s.id, "电容",
          (s.val * 1e12).toFixed(2) + " pF",
          s.q ? ("Q>=" + s.q) : "",
          s.kind === "series" ? "串联" : "并联"];
      }
      return ["TL" + s.id, s.termin === "open" ? "开路短截线" :
        (s.termin === "short" ? "短路短截线" : "传输线段"),
        (s.len * 100).toFixed(1) + " cm",
        "Z0=" + s.z0 + " Ω",
        s.kind === "series" ? "串联线段" : "并联短截线"];
    });
  }

  function exportBom(cfg, segs, name) {
    const header = ["位号", "类型", "标称值", "额定/备注", "连接"];
    const rows = bomRows(cfg, segs);
    const csv = [header, ...rows]
      .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    download((name || "matching") + "-BOM.csv", "﻿" + csv, "text/csv");
  }

  function exportJson(state) {
    // per-frequency analysis payload
    const out = {
      exported: new Date().toISOString(),
      design: {
        topology: state.topologyName,
        code: state.topologyCode,
        z0: state.z0,
        center_hz: state.f0,
        band_hz: [state.flow, state.fhigh],
        power_w: state.power,
      },
      feedline: {
        z0: state.setup.zline, length_m: state.setup.line_len,
        velocity_factor: state.setup.vf,
        loss_db_per_100m: state.setup.line_loss || 0,
      },
      components: state.segments.map(s => {
        const c = { id: s.id, connection: s.kind, type: s.etype };
        if (s.etype === "line") {
          c.z0 = s.z0; c.length_m = +s.len.toFixed(4);
          if (s.termin) c.termination = s.termin;
        } else {
          c.value = s.val;
          c.unit = s.etype === "L" ? "H" : "F";
          if (s.q) c.q = s.q;
        }
        return c;
      }),
      frequency_points: state.traces.f.map((f, i) => ({
        f_hz: +f.toFixed(1),
        zin_re: +state.traces.zin[i][0].toFixed(4),
        zin_im: +state.traces.zin[i][1].toFixed(4),
        swr: +state.traces.swr[i].toFixed(4),
        return_loss_db: +state.traces.rl[i].toFixed(3),
        loss_db: +state.traces.loss[i].toFixed(4),
      })),
    };
    download((state.name || "matching") + "-analysis.json",
      JSON.stringify(out, null, 2), "application/json");
  }

  global.Exporter = { exportSvg, exportBom, exportJson, bomRows };
})(window);
