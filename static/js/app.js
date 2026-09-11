/* app.js - state management and UI wiring. */
(function () {
  "use strict";

  const $ = id => document.getElementById(id);
  const toast = msg => {
    const t = $("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2200);
  };

  // ---- value parsers with unit suffixes ----
  const UNIT = {
    pH: 1e-12, nH: 1e-9, uH: 1e-6, "µH": 1e-6, mH: 1e-3, H: 1,
    pF: 1e-12, nF: 1e-9, uF: 1e-6, "µF": 1e-6, mF: 1e-3, F: 1,
    mm: 1e-3, cm: 1e-2, m: 1,
  };
  function parseVal(s, def) {
    if (s == null || s === "") return def;
    const m = String(s).trim().match(/^([\d.eE+-]+)\s*([pnuµm]?[HFm]?)$/i);
    if (!m) { const v = parseFloat(s); return isNaN(v) ? def : v; }
    const num = parseFloat(m[1]);
    let u = (m[2] || "").replace("μ", "µ");
    if (!u) return num;
    // resolve case-insensitively
    const key = Object.keys(UNIT).find(k => k.toLowerCase() === u.toLowerCase());
    return num * (key ? UNIT[key] : 1);
  }

  // ---- global state ----
  const S = {
    freq: [], zload: [],          // imported (Hz, complex {re,im})
    zFeed: [],                    // after feedline transform
    z0: 50, power: 100,
    setup: {}, limits: {},
    flow: 3.5e6, fhigh: 3.8e6, f0: 3.65e6,
    families: ["L", "Pi", "T", "stub"],
    candidates: [],
    cur: null,                    // {code,name,cfg,segments,traces,score}
    cursorF: null,
    metric: "swr",
    compareIds: new Set(),
    versions: [],
  };

  const smith = new Smith($("smith"));
  const schematic = new Schematic($("schematic"), onDrag);
  const response = new ResponseChart($("response"), f => setCursor(f));

  // ------------------------------------------------------------- setup
  function readSetup() {
    S.z0 = +$("z0").value || 50;
    S.power = +$("power").value || 100;
    S.flow = +$("flow").value * 1e6;
    S.fhigh = +$("fhigh").value * 1e6;
    S.f0 = (S.flow + S.fhigh) / 2;
    S.setup = {
      zline: +$("zline").value || 50,
      vf: +$("vf").value || 1,
      line_len: +$("lineLen").value || 0,
      line_loss: +$("lineLoss").value || 0,
      zstub: +$("zstub").value || 50,
      qL: +$("qL").value || 0,
      qC: +$("qC").value || 0,
      power: S.power,
    };
    S.limits = {
      lmin: parseVal($("lmin").value, 10e-9),
      lmax: parseVal($("lmax").value, 100e-6),
      cmin: parseVal($("cmin").value, 1e-12),
      cmax: parseVal($("cmax").value, 10e-6),
      lmin_m: parseVal($("llenmin").value, 0.02),
      lmax_m: parseVal($("llenmax").value, 40),
      v_rating: +$("vrate").value || 1e9,
      i_rating: +$("irate").value || 1e9,
      p_rating: 5,
      swr_target: +$("swrTarget").value || 1.5,
      swr_hard: 8,
    };
  }

  // recompute feedline transform from imported data
  function recomputeFeed() {
    if (!S.freq.length) return;
    S.zFeed = RF.feedlineInput(S.zload, S.freq, S.setup.zline,
      S.setup.line_len, S.setup.vf, S.setup.line_loss || 0);
  }

  // dense grid including f0
  function denseGrid() {
    const span = Math.max(S.fhigh - S.flow, 0.05 * S.f0);
    const lo = Math.min(S.freq[0], S.flow - 0.15 * span);
    const hi = Math.max(S.freq[S.freq.length - 1], S.fhigh + 0.15 * span);
    const n = 400, fd = [];
    for (let i = 0; i < n; i++) fd.push(lo + (hi - lo) * i / (n - 1));
    let j = 0, best = Infinity;
    fd.forEach((f, i) => {
      const d = Math.abs(f - S.f0);
      if (d < best) { best = d; j = i; }
    });
    fd[j] = S.f0;
    const zd = RF.interpZ(fd, S.freq, S.zFeed);
    return { fd, zd };
  }

  // ------------------------------------------------------------- analysis
  function analyze() {
    if (!S.cur || !S.freq.length) return;
    const { fd, zd } = denseGrid();
    S.denseF = fd;
    S.denseZ = zd;
    S.cur.res = RF.evaluate(fd, zd, S.cur.segments, S.z0, S.power);
    // cursor defaults to center frequency
    if (S.cursorF == null) S.cursorF = S.f0;
    renderAll();
  }

  function onDrag() {
    analyze();
  }

  // ------------------------------------------------------------- rendering
  function renderSmith() {
    smith.clear();
    if (!S.freq.length) return;
    const n = S.freq.length;
    // load trajectory (gamma of raw load)
    smith.plotTrajectory(S.zload, S.z0, "tr-load");
    // feedline trajectory
    if (S.setup.line_len > 0)
      smith.plotTrajectory(S.zFeed, S.z0, "tr-feed");
    // matched network input trajectory
    if (S.cur)
      smith.plotTrajectory(S.cur.res.zin, S.z0, "tr-match");

    // endpoint markers
    const fEnd = [S.freq[0], S.freq[n - 1], S.f0];
    fEnd.forEach((f, k) => {
      const zl = RF.interpZ([f], S.freq, S.zload)[0];
      let p = smith.plotPoint(zl, S.z0, "tr-load", k === 2 ? 4 : 3);
      if (S.setup.line_len > 0) {
        const zf = RF.interpZ([f], S.freq, S.zFeed)[0];
        smith.plotPoint(zf, S.z0, "tr-feed", k === 2 ? 4 : 3);
      }
      if (S.cur) {
        const zm = {
          re: RF.interp1(f, S.denseF, S.cur.res.zin.map(z => z.re)),
          im: RF.interp1(f, S.denseF, S.cur.res.zin.map(z => z.im)),
        };
        smith.plotPoint(zm, S.z0, "tr-match", k === 2 ? 5 : 3);
      }
    });
    smith.plotLabel("负载", ...xyLast(S.zload), "");

    // cursor markers
    if (S.cursorF != null) {
      const items = [];
      items.push({
        z: RF.interpZ([S.cursorF], S.freq, S.zload)[0],
        z0: S.z0, cls: "c-load",
      });
      if (S.setup.line_len > 0)
        items.push({
          z: RF.interpZ([S.cursorF], S.freq, S.zFeed)[0],
          z0: S.z0, cls: "c-feed",
        });
      if (S.cur)
        items.push({
          z: {
            re: RF.interp1(S.cursorF, S.denseF,
              S.cur.res.zin.map(z => z.re)),
            im: RF.interp1(S.cursorF, S.denseF,
              S.cur.res.zin.map(z => z.im)),
          }, z0: S.z0, cls: "c-match",
        });
      smith.setCursor(items);
    }
  }
  function xyLast(arr) {
    const z = arr[arr.length - 1];
    const g = smith.gamma(z, S.z0);
    const cx = smith.cx + g.re * smith.R;
    const cy = smith.cy - g.im * smith.R;
    return [cx, cy];
  }

  function renderSchematic() {
    if (!S.cur) {
      $("schematic").innerHTML =
        '<text x="380" y="150" fill="#8595ab" text-anchor="middle">' +
        '导入数据并搜索 / 选择候选后显示电路</text>';
      return;
    }
    // stress at cursor frequency
    const stress = {};
    const res = S.cur.res;
    S.cur.segments.forEach(seg => {
      const c = res.comps[seg.id];
      const v = RF.interp1(S.cursorF, S.denseF, c.v);
      const i = RF.interp1(S.cursorF, S.denseF, c.i);
      const p = RF.interp1(S.cursorF, S.denseF, c.p);
      const over = v > S.limits.v_rating || i > S.limits.i_rating ||
        p > S.limits.p_rating;
      stress[seg.id] = { v, i, p, over };
    });
    schematic.render(S.cur.segments, stress, S.cursorF);
  }

  function renderResponse() {
    response.setBand(S.flow, S.fhigh);
    const series = [];
    if (S.metric === "swr") {
      // unmatched vs matched
      const un = RF.evaluate(S.freq, S.zFeed, [], S.z0, S.power);
      series.push({
        name: "未匹配 SWR", color: "#8595ab",
        xs: S.freq.slice(), ys: un.swr.map(v => Math.min(v, 8)),
        yMax: 6, yLabel: "SWR",
      });
      if (S.cur) series.push({
        name: "匹配后 SWR", color: "#ffd166",
        xs: S.denseF.slice(),
        ys: S.cur.res.swr.map(v => Math.min(v, 6)),
        yMax: 6, yLabel: "SWR",
      });
    } else if (S.metric === "rl") {
      if (S.cur) series.push({
        name: "回波损耗 dB", color: "#4ea1ff",
        xs: S.denseF.slice(), ys: S.cur.res.rl.map(v => Math.min(v, 40)),
        yMax: 40, yLabel: "RL dB",
      });
    } else {
      if (S.cur) series.push({
        name: "总损耗 dB", color: "#ef5f6a",
        xs: S.denseF.slice(), ys: S.cur.res.loss,
        yMax: Math.max(1, Math.max(...S.cur.res.loss) * 1.2),
        yLabel: "dB",
      });
      series.push({
        name: "失配损耗 dB", color: "#8595ab",
        xs: S.denseF.slice(), ys: S.cur ? S.cur.res.mismatch :
          S.freq.map(() => 0),
        yMax: Math.max(1, ...(S.cur ? S.cur.res.loss : [1])),
        yLabel: "dB",
      });
    }
    // tuning-step overlay (set by tune.js when a step is selected)
    if (S._respOverlay) series.push(S._respOverlay);
    response.setSeries(series);
  }

  function clsBy(v, good, warn) {
    return v <= good ? "good" : v <= warn ? "warn" : "bad";
  }

  function renderMetrics() {
    $("curFreq").textContent = S.cursorF ? (S.cursorF / 1e6).toFixed(3) : "—";
    if (!S.cur) return;
    const r = S.cur.res;
    const idx = nearestIdx(S.denseF, S.cursorF);
    const swr = r.swr[idx], rl = r.rl[idx], loss = r.loss[idx],
      mis = r.mismatch[idx];
    setMetric("mSWR", isFinite(swr) ? swr.toFixed(2) : "∞",
      clsBy(swr, 1.5, 2.5));
    setMetric("mRL", rl.toFixed(1) + " dB", clsBy(-rl, -20, -12));
    setMetric("mLoss", loss.toFixed(2) + " dB", clsBy(loss, 0.3, 1));
    setMetric("mMism", mis.toFixed(2) + " dB", clsBy(mis, 0.2, 0.8));
  }

  function setMetric(id, txt, cls) {
    const e = $(id); e.textContent = txt;
    e.className = "v " + (cls || "");
  }

  function renderStress() {
    const tb = $("stressTable").querySelector("tbody");
    tb.innerHTML = "";
    if (!S.cur) return;
    const r = S.cur.res;
    S.cur.segments.forEach(seg => {
      const c = r.comps[seg.id];
      const v = RF.interp1(S.cursorF, S.denseF, c.v);
      const i = RF.interp1(S.cursorF, S.denseF, c.i);
      const p = RF.interp1(S.cursorF, S.denseF, c.p);
      const over = v > S.limits.v_rating || i > S.limits.i_rating ||
        p > S.limits.p_rating;
      const name = compName(seg);
      const tr = document.createElement("tr");
      if (over) tr.className = "over";
      tr.innerHTML =
        `<td>${name}</td><td>${v.toFixed(1)}</td>` +
        `<td>${i.toFixed(2)}</td><td>${p.toFixed(2)}</td>`;
      tb.appendChild(tr);
    });
  }

  function compName(seg) {
    if (seg.etype === "L") return "L" + seg.id + " (" + fmtVal(seg.val, "L") + ")";
    if (seg.etype === "C") return "C" + seg.id + " (" + fmtVal(seg.val, "C") + ")";
    return "TL" + seg.id + " (" + fmtLen(seg.len) + ")";
  }

  function renderFlags() {
    const box = $("flagList");
    if (!S.cur || !S.cur.flags || !S.cur.flags.length) {
      box.innerHTML = '<span class="muted">无</span>';
      return;
    }
    box.innerHTML = "";
    S.cur.flags.forEach(fl => {
      const d = document.createElement("div");
      d.className = "flag-item " + fl.kind;
      d.textContent = fl.msg +
        (fl.freq ? `  ▸ ${(fl.freq / 1e6).toFixed(3)} MHz` : "");
      d.onclick = () => fl.freq && setCursor(fl.freq);
      box.appendChild(d);
    });
  }

  function renderAll() {
    renderSmith();
    renderSchematic();
    renderResponse();
    renderMetrics();
    renderStress();
    renderFlags();
  }

  function nearestIdx(arr, f) {
    let best = 0, bd = Infinity;
    arr.forEach((x, i) => {
      const d = Math.abs(x - f);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  function setCursor(f) {
    S.cursorF = f;
    renderSmith(); renderMetrics(); renderStress(); renderSchematic();
    $("curFreq").textContent = (f / 1e6).toFixed(3);
  }

  // ------------------------------------------------------------- candidates
  function renderCandidates() {
    const tb = $("candBody");
    tb.innerHTML = "";
    S.candidates.forEach((c, i) => {
      const tr = document.createElement("tr");
      tr.className = "cand-row" + (S.cur && S.cur._idx === i ? " sel" : "");
      const tags = c.flags.map(f =>
        `<span class="tag ${f.kind}" data-i="${i}" data-f="${f.freq || ""}">` +
        `${flagLabel(f.kind)}</span>`).join("");
      tr.innerHTML =
        `<td>${i + 1}</td><td>${c.name}</td>` +
        `<td>${c.score.swr_max.toFixed(2)}</td>` +
        `<td>${(c.score.bw_frac * 100).toFixed(0)}%</td>` +
        `<td>${c.score.loss_max.toFixed(2)}</td><td>${tags}</td>`;
      tr.onclick = e => {
        if (e.target.classList.contains("tag")) return;
        loadCandidate(i);
      };
      tb.appendChild(tr);
    });
    tb.querySelectorAll(".tag").forEach(t => {
      t.onclick = e => {
        e.stopPropagation();
        const i = +t.getAttribute("data-i");
        const f = parseFloat(t.getAttribute("data-f"));
        loadCandidate(i);
        if (isFinite(f)) setCursor(f);
      };
    });
  }

  function flagLabel(k) {
    return { spike: "窄带尖峰", overrating: "元件越额", edge: "参数触边",
      highq: "高Q", multi: "近似多解", mismatch: "失配" }[k] || k;
  }

  function loadCandidate(i) {
    const c = S.candidates[i];
    const cfg = TOPO.byCode(c.code);
    // build fresh segment objects with client-side Q values
    readSetup();
    const values = {};
    c.params.forEach(p => {
      values[p.id] = p.etype === "line" ? p.len : p.val;
    });
    const segments = TOPO.segmentsFromValues(cfg, values, S.setup);
    S.cur = {
      _idx: i, code: c.code, name: c.name, cfg, segments,
      flags: c.flags, score: c.score, cand: c,
    };
    S.cursorF = S.f0;
    analyze();
    renderCandidates();
    if (window.TuneUI) TuneUI.refreshPair();
    toast("已载入: " + c.name);
  }

  // ------------------------------------------------------------- CSV
  async function parseCsv(text) {
    const r = await fetch("/api/parse", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv: text }),
    });
    return r.json();
  }

  async function doParse() {
    readSetup();
    const text = $("csvInput").value;
    if (!text.trim()) { toast("请粘贴 CSV 或载入示例"); return; }
    const d = await parseCsv(text);
    if (d.error) { toast(d.error); return; }
    applyDataset(d);
    toast(`已解析 ${d.n} 个频点（${d.unit}）`);
  }

  function applyDataset(d) {
    S.freq = d.freq;
    S.zload = d.zload.map(([re, im]) => ({ re, im }));
    $("parseInfo").textContent = `${d.n} 点 · ${(d.freq[0] / 1e6).toFixed(3)}–${
      (d.freq[d.freq.length - 1] / 1e6).toFixed(3)} MHz`;
    // suggest band covering middle 60%
    readSetup();
    recomputeFeed();
    if (!S.cur) renderAll();
    else analyze();
  }

  async function loadSample() {
    const r = await fetch("/api/sample");
    const d = await r.json();
    $("csvInput").value = d.csv.replace(/^#.*\n/, "");
    applyDataset(d.parsed);
    toast("已载入 80m 短垂直天线示例");
  }

  // ------------------------------------------------------------- search
  async function doSearch() {
    readSetup();
    if (S.freq.length < 2) { toast("请先导入并解析 CSV"); return; }
    recomputeFeed();
    $("searchInfo").textContent = "搜索中…（约 10–30 秒）";
    const t0 = performance.now();
    const r = await fetch("/api/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        freq: S.freq,
        zload: S.zload.map(z => [z.re, z.im]),
        z0: S.z0, flow: S.flow, fhigh: S.fhigh,
        families: S.families, setup: S.setup, limits: S.limits,
      }),
    });
    const d = await r.json();
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    if (d.error) { $("searchInfo").textContent = d.error; return; }
    S.candidates = d.candidates;
    $("searchInfo").textContent =
      `找到 ${d.count} 个候选，用时 ${dt} s`;
    renderCandidates();
    if (d.candidates.length) loadCandidate(0);
  }

  // ------------------------------------------------------------- versions
  async function saveVersion() {
    if (!S.cur) { toast("没有可保存的方案"); return; }
    readSetup();
    const name = $("verName").value ||
      (S.cur.name + " " + new Date().toLocaleTimeString());
    const payload = {
      name, topology: S.cur.code,
      note: `SWRmax ${S.cur.score.swr_max.toFixed(2)}`,
      data: {
        code: S.cur.code, name: S.cur.name,
        segments: S.cur.segments,
        score: S.cur.score,
        flags: S.cur.flags,
        traces: {
          f: S.denseF,
          zin: S.cur.res.zin.map(z => [z.re, z.im]),
          swr: S.cur.res.swr, rl: S.cur.res.rl, loss: S.cur.res.loss,
        },
        setup: S.setup, z0: S.z0, power: S.power,
        f0: S.f0, flow: S.flow, fhigh: S.fhigh,
        dataset: { freq: S.freq, zload: S.zload.map(z => [z.re, z.im]) },
      },
    };
    const r = await fetch("/api/versions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    toast("已保存版本 #" + d.id);
    $("verName").value = "";
    loadVersions();
  }

  async function loadVersions() {
    const r = await fetch("/api/versions");
    const d = await r.json();
    S.versions = d.versions;
    const box = $("verList");
    box.innerHTML = "";
    d.versions.forEach(v => {
      const row = document.createElement("div");
      row.className = "vrow";
      row.innerHTML =
        `<input type="checkbox" data-id="${v.id}" class="vchk">` +
        `<span class="nm">#${v.id} ${v.name} <span class="muted">${
          v.topology} · ${v.note || ""}</span></span>` +
        `<button class="ghost small vload">载入</button>` +
        `<button class="ghost small vdel">×</button>`;
      row.querySelector(".vload").onclick = () => openVersion(v.id);
      row.querySelector(".vdel").onclick = async () => {
        await fetch("/api/versions/" + v.id, { method: "DELETE" });
        loadVersions();
      };
      box.appendChild(row);
    });
    if (window.TuneUI) TuneUI.refreshVersions();
  }

  async function openVersion(id) {
    const r = await fetch("/api/versions/" + id);
    const v = await r.json();
    const d = v.data;
    // restore dataset
    S.freq = d.dataset.freq;
    S.zload = d.dataset.zload.map(([re, im]) => ({ re, im }));
    S.z0 = d.z0; S.power = d.power;
    S.setup = d.setup; S.f0 = d.f0; S.flow = d.flow; S.fhigh = d.fhigh;
    recomputeFeed();
    const cfg = TOPO.byCode(d.code);
    S.cur = {
      _idx: -1, code: d.code, name: d.name, cfg,
      segments: d.segments, flags: d.flags || [], score: d.score,
    };
    analyze();
    if (window.TuneUI) TuneUI.refreshPair();
    toast("已载入版本 #" + id);
  }

  async function compareVersions() {
    const ids = [...document.querySelectorAll(".vchk:checked")]
      .map(c => +c.getAttribute("data-id"));
    if (ids.length < 2) { toast("请勾选至少两个版本"); return; }
    const vs = [];
    for (const id of ids) {
      const r = await fetch("/api/versions/" + id);
      vs.push(await r.json());
    }
    const bw = t => {
      const d = t.data;
      return RF.swrBandwidth(d.traces.f, d.traces.f.map(z => z),
        d.flow, d.fhigh, 1.5);
    };
    let html = "<table class='stress-table'><tr><th>版本</th><th>SWRmax</th>" +
      "<th>1.5:1 带宽</th><th>损耗</th><th>元件</th></tr>";
    vs.forEach(v => {
      const d = v.data;
      const b = RF.swrBandwidth(d.traces.f, d.traces.swr,
        d.flow, d.fhigh, 1.5);
      const comps = d.segments.map(s =>
        s.etype === "line" ? (s.len * 100).toFixed(1) + "cm"
          : fmtVal(s.val, s.etype)).join(", ");
      html += `<tr><td>#${v.id} ${v.name}</td>` +
        `<td>${d.score.swr_max.toFixed(2)}</td>` +
        `<td>${(b / 1e6).toFixed(2)} MHz</td>` +
        `<td>${d.score.loss_max.toFixed(2)} dB</td>` +
        `<td style="text-align:left">${comps}</td></tr>`;
    });
    html += "</table>";
    $("cmpOut").innerHTML = html;
  }

  // ------------------------------------------------------------- exports
  function doExports(kind) {
    if (!S.cur) { toast("请先选择一个方案"); return; }
    readSetup();
    const base = S.cur.code + "-" + (S.f0 / 1e6).toFixed(3) + "MHz";
    if (kind === "svg")
      Exporter.exportSvg($("schematic"), S.cur.name);
    else if (kind === "bom")
      Exporter.exportBom(S.cur.cfg, S.cur.segments, base);
    else
      Exporter.exportJson({
        topologyName: S.cur.name, topologyCode: S.cur.code,
        segments: S.cur.segments, z0: S.z0, power: S.power,
        f0: S.f0, flow: S.flow, fhigh: S.fhigh, setup: S.setup,
        name: base,
        traces: {
          f: S.denseF,
          zin: S.cur.res.zin.map(z => [z.re, z.im]),
          swr: S.cur.res.swr, rl: S.cur.res.rl,
          loss: S.cur.res.loss,
        },
      });
  }

  // ------------------------------------------------------------- events
  $("btnParse").onclick = doParse;
  $("btnSample").onclick = loadSample;
  $("btnSearch").onclick = doSearch;
  $("btnSave").onclick = saveVersion;
  $("btnVersions").onclick = loadVersions;
  $("btnCompare").onclick = compareVersions;
  $("btnSvg").onclick = () => doExports("svg");
  $("btnBom").onclick = () => doExports("bom");
  $("btnJson").onclick = () => doExports("json");

  document.querySelectorAll("#famChips .chip").forEach(ch => {
    ch.onclick = () => {
      const f = ch.getAttribute("data-fam");
      ch.classList.toggle("on");
      S.families = [...document.querySelectorAll("#famChips .chip.on")]
        .map(x => x.getAttribute("data-fam"));
    };
  });
  document.querySelectorAll(".tabs .tab").forEach(t => {
    t.onclick = () => {
      document.querySelectorAll(".tabs .tab").forEach(x =>
        x.classList.remove("on"));
      t.classList.add("on");
      S.metric = t.getAttribute("data-metric");
      renderResponse();
    };
  });
  // recompute feedline when its parameters change
  ["zline", "vf", "lineLen", "lineLoss", "z0", "power"].forEach(id =>
    $(id).addEventListener("change", () => {
      readSetup(); recomputeFeed();
      if (S.cur) analyze(); else renderSmith();
    }));

  // init
  readSetup();
  loadVersions();
  renderAll();

  // bridge for tune.js (live tuning path planner)
  window.App = {
    S, readSetup, denseGrid, recomputeFeed, analyze, renderResponse,
    setCursor, toast, parseVal, loadVersions,
    get responseOverlay() { return S._respOverlay; },
    set responseOverlay(v) { S._respOverlay = v; },
  };
})();
