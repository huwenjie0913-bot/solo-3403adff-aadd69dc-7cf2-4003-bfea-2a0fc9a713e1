/* tune.js - 带电调谐路径规划 UI。
 *
 * 选择拓扑/元件编号一致的两个方案（起点 → 目标），按各旋钮步进把可达
 * 刻度交给后端组成状态图并规划安全调节顺序；步骤轨道支持点击查看、
 * 固定前缀、调整先后、插入降功率节点后复算；路径仅关联到目标方案保存，
 * 可导出打印调谐卡与 JSON。
 */
(function () {
  "use strict";

  const $ = id => document.getElementById(id);
  const App = window.App;

  // ------------------------------------------------------------------ state
  const T = {
    pair: null,     // {code, ids, segsById, template, from:{label,values},
                    //  to:{label,values,vid}}
    stepsDef: {},   // 各旋钮步进（SI 单位）
    links: [],
    power: 10,
    limits: {},
    dials: null,    // {id: [v0 ... v1]}
    steps: [],      // 轨道步骤（含 action/values/metrics/violations/risk）
    sel: -1,
    verified: false, // 最近一次规划/复算通过且到达目标，才允许保存
  };

  const esc = s => String(s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function toast(m) { App.toast(m); }

  // ------------------------------------------------------------ 方案解析
  async function resolveDesign(key) {
    if (!key) return null;
    if (key === "cur") {
      const c = App.S.cur;
      if (!c) return null;
      const values = {};
      c.segments.forEach(s => {
        values[s.id] = s.etype === "line" ? s.len : s.val;
      });
      return {
        label: "当前电路", code: c.code, values,
        segments: JSON.parse(JSON.stringify(c.segments)), vid: null,
      };
    }
    const r = await fetch("/api/versions/" + key);
    if (!r.ok) return null;
    const v = await r.json();
    const d = v.data;
    const values = {};
    d.segments.forEach(s => {
      values[s.id] = s.etype === "line" ? s.len : s.val;
    });
    return {
      label: "#" + v.id + " " + v.name, code: d.code,
      values, segments: d.segments, vid: v.id,
    };
  }

  function compLabel(id) {
    const seg = T.pair && T.pair.segsById[id];
    if (!seg) return id;
    const p = seg.etype === "line" ? "TL" : seg.etype;
    return p + id;
  }

  function fmtV(v, seg) {
    if (seg && seg.etype === "line") return fmtLen(v);
    return fmtVal(v, seg ? seg.etype : "L");
  }

  // ---------------------------------------------------------- 方案对校验
  async function refreshPair() {
    const info = $("tunePairInfo");
    const fk = $("tuneFrom").value, tk = $("tuneTo").value;
    T.pair = null;
    T.verified = false;
    buildStepInputs();
    if (!fk || !tk) {
      info.textContent = "选择拓扑与元件编号一致的两个方案";
      return;
    }
    if (fk === tk) {
      info.textContent = "起点与目标需为两个不同方案";
      return;
    }
    const [a, b] = await Promise.all(
      [resolveDesign(fk), resolveDesign(tk)]);
    if (!a || !b) {
      info.textContent = "请选择起点与目标方案（可先保存当前方案为版本）";
      return;
    }
    if (a.code !== b.code) {
      info.textContent = `拓扑不一致：${a.code} ≠ ${b.code}`;
      return;
    }
    const ida = Object.keys(a.values).sort();
    const idb = Object.keys(b.values).sort();
    if (ida.join(",") !== idb.join(",")) {
      info.textContent = "元件编号不一致，无法规划调谐路径";
      return;
    }
    const segsById = {};
    b.segments.forEach(s => { segsById[s.id] = s; });
    T.pair = {
      code: a.code, ids: ida, segsById,
      template: b.segments, from: a, to: b,
    };
    info.textContent =
      `拓扑 ${a.code} · ${ida.length} 个旋钮 · ${a.label} → ${b.label}`;
    buildStepInputs();
  }

  // 每个旋钮一行：步进输入 + 联动勾选；值不变的旋钮标记为固定
  function buildStepInputs() {
    const box = $("tuneSteps");
    box.innerHTML = "";
    if (!T.pair) return;
    T.pair.ids.forEach(id => {
      const seg = T.pair.segsById[id];
      const v0 = T.pair.from.values[id];
      const v1 = T.pair.to.values[id];
      const row = document.createElement("div");
      row.className = "row";
      if (Math.abs(v1 - v0) <= 1e-30 * Math.max(1, Math.abs(v0))) {
        row.innerHTML =
          `<label>${compLabel(id)}</label>` +
          `<span class="muted" style="font-size:11px">固定 ${fmtV(v0, seg)}</span>`;
        box.appendChild(row);
        return;
      }
      const def = T.stepsDef[id] || Math.abs(v1 - v0) / 8;
      row.innerHTML =
        `<label>${compLabel(id)}</label>` +
        `<input id="step_${id}" value="${fmtV(def, seg)}" title="旋钮步进">` +
        `<span class="rng">${fmtV(v0, seg)}→${fmtV(v1, seg)}</span>` +
        `<input type="checkbox" id="link_${id}" title="允许与其它勾选旋钮联动">`;
      box.appendChild(row);
    });
    const hint = document.createElement("div");
    hint.className = "muted";
    hint.style.fontSize = "10px";
    hint.textContent = "勾选 ☐ 的旋钮允许同动（编为一组）";
    box.appendChild(hint);
  }

  function readTuneForm() {
    App.readSetup();
    const steps = {};
    if (T.pair) {
      T.pair.ids.forEach(id => {
        const el = $("step_" + id);
        if (el) steps[id] = App.parseVal(el.value, 0);
      });
    }
    const linked = T.pair ? T.pair.ids.filter(id => {
      const c = $("link_" + id);
      return c && c.checked;
    }) : [];
    return {
      steps,
      links: linked.length >= 2 ? [linked] : [],
      power: +$("tunePower").value || 10,
      limits: {
        swr: +$("tuneSwr").value || 3,
        v: +$("tuneV").value || 1e9,
        i: +$("tuneI").value || 1e9,
        loss: +$("tuneLoss").value || 1e9,
      },
    };
  }

  function basePayload() {
    const S = App.S;
    return {
      freq: S.freq,
      zload: S.zload.map(z => [z.re, z.im]),
      z0: S.z0, flow: S.flow, fhigh: S.fhigh, setup: S.setup,
      segments: T.pair.template,
    };
  }

  async function post(url, body) {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  // ---------------------------------------------------------------- 规划
  async function doPlan(prefix) {
    if (!T.pair) { toast("请先选择拓扑一致的两个方案"); return; }
    if (!App.S.freq.length) { toast("请先导入扫频数据"); return; }
    const form = readTuneForm();
    const body = Object.assign(basePayload(), {
      current: T.pair.from.values,
      target: T.pair.to.values,
      steps: form.steps, links: form.links,
      power: form.power, limits: form.limits,
    });
    if (prefix && prefix.length) body.prefix = prefix;
    $("tuneInfo").textContent = "规划中…（状态图搜索）";
    const t0 = performance.now();
    const d = await post("/api/tune/plan", body);
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    if (d.error && !d.steps) {
      T.verified = false;
      $("tuneInfo").textContent = d.error;
      if (d.stuck) showStuck(d);
      return;
    }
    T.dials = d.dials || null;
    T.stepsDef = form.steps;
    T.links = form.links;
    T.power = form.power;
    T.limits = form.limits;
    const nPrefix = prefix ? prefix.length : 0;
    T.steps = (d.steps || []).map((s, i) =>
      Object.assign(s, { pinned: i < nPrefix }));
    T.verified = !!d.ok;
    if (d.ok) {
      $("tuneInfo").textContent =
        `找到 ${d.steps.length} 步安全路径（访问 ${d.states} 个状态，${dt} s）`;
      T.sel = T.steps.length - 1;
      renderTrack();
    } else {
      renderTrack();
      if (d.stuck) showStuck(d);
      else if (d.metrics) showUnsafe(d);
      $("tuneInfo").textContent = d.error || "未找到安全路径";
    }
  }

  // 复算当前序列（调整先后 / 插入功率节点 / 修改上限后）：
  // 除逐步安全上限外，后端同时核对最终旋钮值是否到达目标方案
  async function doRecheck() {
    if (!T.pair || !T.steps.length) { toast("没有可复算的序列"); return; }
    const form = readTuneForm();
    T.power = form.power;
    T.limits = form.limits;
    const pins = T.steps.map(s => !!s.pinned);
    const body = Object.assign(basePayload(), {
      start: T.pair.from.values,
      target: T.pair.to.values,
      actions: T.steps.map(s => s.action),
      power: T.power, limits: T.limits,
      dials: T.dials || undefined,
    });
    $("tuneInfo").textContent = "复算中…";
    const d = await post("/api/tune/check", body);
    if (d.error) {
      T.verified = false;
      $("tuneInfo").textContent = d.error;
      return;
    }
    T.steps = d.steps.map((s, i) =>
      Object.assign(s, { pinned: pins[i] || false }));
    if (T.sel >= T.steps.length) T.sel = T.steps.length - 1;
    T.verified = !!(d.ok && d.reached_target !== false);
    if (d.ok) {
      $("tuneInfo").textContent = "复算通过：全程未超限，已到达目标";
    } else if (d.reached_target === false) {
      const mm = (d.mismatch || []).map(m => {
        const seg = T.pair.segsById[m.id];
        return `${compLabel(m.id)} 目标 ${fmtV(m.expected, seg)}，` +
          `实际 ${fmtV(m.actual, seg)}`;
      }).join("；");
      $("tuneInfo").textContent =
        "复算失败：最终旋钮值未到达目标方案 — " + mm;
    } else {
      $("tuneInfo").textContent = "复算完成：存在超限步骤（红色）";
    }
    renderTrack();
  }

  // 保留📌前缀，重新规划其余
  function doReplan() {
    let k = -1;
    T.steps.forEach((s, i) => { if (s.pinned) k = i; });
    const prefix = k >= 0 ? T.steps.slice(0, k + 1).map(s => s.action) : null;
    doPlan(prefix);
  }

  // ------------------------------------------------------------ 轨道渲染
  function actionText(s) {
    const a = s.action;
    if (a.type === "power") return "⚡ 功率→" + a.power + " W";
    return Object.keys(a.changes).map(id => {
      const seg = T.pair ? T.pair.segsById[id] : null;
      let t = `${compLabel(id)}→${fmtV(a.changes[id], seg)}`;
      if (s.dials && s.dials[id])
        t += ` (${s.dials[id][0]}/${s.dials[id][1]})`;
      return t;
    }).join("＋");
  }

  function renderTrack() {
    const box = $("tuneTrack");
    box.innerHTML = "";
    if (!T.steps.length) {
      box.innerHTML = '<span class="muted">尚未规划</span>';
      renderDetail();
      return;
    }
    T.steps.forEach((s, i) => {
      const isPower = s.action.type === "power";
      const card = document.createElement("div");
      let cls = "tstep";
      if (isPower) cls += " power";
      else if (s.violations && s.violations.length) cls += " bad";
      else cls += (s.risk > 0.7 ? " warn" : " ok");
      if (i === T.sel) cls += " sel";
      card.className = cls;
      card.innerHTML =
        `<div class="tno">#${i + 1}${s.pinned ? ' <span class="pin">📌</span>' : ""}</div>` +
        `<div class="tact">${esc(actionText(s))}</div>` +
        `<div class="tmet">${isPower ? "功率节点"
          : "SWR " + s.metrics.swr_max.toFixed(2) +
            " · 险 " + Math.round(s.risk * 100) + "%"}</div>`;
      card.onclick = () => selectStep(i === T.sel ? -1 : i);
      box.appendChild(card);
    });
    renderDetail();
  }

  function selectStep(i) {
    T.sel = i;
    renderTrack();
    updateOverlay();
  }

  // 在主响应图上叠加所选步骤的频响
  function updateOverlay() {
    if (T.sel < 0 || !T.steps[T.sel] || !T.pair || !App.S.freq.length) {
      App.responseOverlay = null;
    } else {
      const s = T.steps[T.sel];
      const segs = T.pair.template.map(seg => {
        const c = Object.assign({}, seg);
        const v = s.values[c.id];
        if (v != null) {
          if (c.etype === "line") c.len = v; else c.val = v;
        }
        return c;
      });
      const g = App.denseGrid();
      const res = RF.evaluate(g.fd, g.zd, segs, App.S.z0, s.power);
      const metric = App.S.metric;
      const ys = metric === "rl" ? res.rl.map(v => Math.min(v, 40))
        : metric === "loss" ? res.loss
        : res.swr.map(v => Math.min(v, 6));
      App.responseOverlay = {
        name: `步骤${T.sel + 1}`, color: "#3fce7a",
        xs: g.fd.slice(), ys,
        yMax: metric === "rl" ? 40 : metric === "loss"
          ? Math.max(1, Math.max(...res.loss) * 1.2) : 6,
        yLabel: "",
      };
    }
    App.renderResponse();
  }

  // ------------------------------------------------------------ 步骤详情
  function violText(v) {
    const names = { swr: "驻波", loss: "损耗", v: "电压", i: "电流" };
    const val = v.metric === "swr" ? v.value.toFixed(2)
      : v.value.toFixed(v.metric === "loss" ? 2 : 1);
    return `${names[v.metric] || v.metric}${v.comp ? "(" + v.comp + ")" : ""} ` +
      `${val} > ${v.limit} @ ${(v.freq / 1e6).toFixed(3)} MHz`;
  }

  function renderDetail() {
    const box = $("tuneDetail");
    const s = T.steps[T.sel];
    if (!s) { box.innerHTML = ""; return; }
    const isPower = s.action.type === "power";
    let html =
      `<div class="row" style="margin-top:6px">` +
      `<b>步骤 #${T.sel + 1}</b><span>${esc(actionText(s))}</span>` +
      `<span class="muted">功率 ${s.power} W</span>` +
      `<span class="spacer"></span><span class="btns">` +
      `<button class="ghost small" id="tdPin">${s.pinned ? "取消固定" : "📌固定"}</button>` +
      `<button class="ghost small" id="tdLeft" ${s.pinned ? "disabled" : ""}>◀ 前移</button>` +
      `<button class="ghost small" id="tdRight" ${s.pinned ? "disabled" : ""}>后移 ▶</button>` +
      `<button class="ghost small" id="tdPwr" ${s.pinned ? "disabled" : ""}>⚡前插降功率</button>` +
      `<button class="ghost small" id="tdDel" ${s.pinned ? "disabled" : ""}>🗑 删除</button>` +
      `</span></div>`;
    if (!isPower && T.pair) {
      html += '<table class="stress-table"><thead><tr><th>元件</th>' +
        "<th>上一刻度</th><th>本步</th><th>刻度</th>" +
        "<th>峰值V</th><th>峰值A</th></tr></thead><tbody>";
      T.pair.ids.forEach(id => {
        const seg = T.pair.segsById[id];
        const c = (s.metrics.comps || {})[id] || {};
        const dial = s.dials && s.dials[id]
          ? `${s.dials[id][0]} / ${s.dials[id][1]}` : "—";
        const chg = s.fallback[id] !== s.values[id];
        html += `<tr${chg ? ' class="chg"' : ""}><td>${compLabel(id)}</td>` +
          `<td>${fmtV(s.fallback[id], seg)}</td>` +
          `<td>${fmtV(s.values[id], seg)}</td><td>${dial}</td>` +
          `<td>${c.v != null ? c.v.toFixed(1) : "—"}</td>` +
          `<td>${c.i != null ? c.i.toFixed(2) : "—"}</td></tr>`;
      });
      html += "</tbody></table>";
    }
    const m = s.metrics;
    html += `<div class="tmetline">SWRmax <b>${m.swr_max.toFixed(2)}</b> @ ` +
      `${(m.swr_freq / 1e6).toFixed(3)} MHz · 损耗 ` +
      `<b>${m.loss_max.toFixed(2)}</b> dB @ ` +
      `${(m.loss_freq / 1e6).toFixed(3)} MHz · 风险 ` +
      `<b>${Math.round(s.risk * 100)}%</b></div>`;
    if (s.violations && s.violations.length) {
      html += s.violations.map(v =>
        `<div class="flag-item mismatch">超限: ${esc(violText(v))}</div>`)
        .join("");
    }
    if (T.pair) {
      html += `<div class="muted" style="font-size:10px;margin-top:4px">回退值: ` +
        esc(T.pair.ids.map(id =>
          `${compLabel(id)}=${fmtV(s.fallback[id], T.pair.segsById[id])}`)
          .join(", ")) + "</div>";
    }
    box.innerHTML = html;

    $("tdPin").onclick = () => togglePin(T.sel);
    $("tdLeft").onclick = () => moveStep(T.sel, -1);
    $("tdRight").onclick = () => moveStep(T.sel, +1);
    $("tdPwr").onclick = () => insertPower(T.sel);
    $("tdDel").onclick = () => deleteStep(T.sel);
  }

  // 固定 = 前缀锁定：固定第 k 步即固定 1..k
  function togglePin(i) {
    const target = !T.steps[i].pinned;
    T.steps.forEach((s, j) => {
      if (target && j <= i) s.pinned = true;
      if (!target && j >= i) s.pinned = false;
    });
    renderTrack();
  }

  function moveStep(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= T.steps.length) return;
    if (T.steps[i].pinned || T.steps[j].pinned) return;
    const t = T.steps[i];
    T.steps[i] = T.steps[j];
    T.steps[j] = t;
    T.sel = j;
    T.verified = false;   // 顺序已变，需复算确认安全且到达目标
    doRecheck();
  }

  function insertPower(i) {
    const def = Math.max(1, Math.round(T.power / 5));
    const v = prompt("降功率节点：该步起的调谐功率 (W)", String(def));
    if (v == null) return;
    const p = +v;
    if (!(p > 0)) { toast("功率必须为正"); return; }
    T.steps.splice(i, 0, {
      action: { type: "power", power: p }, pinned: false,
    });
    T.sel = i;
    T.verified = false;
    doRecheck();
  }

  function deleteStep(i) {
    if (T.steps[i].pinned) return;
    T.steps.splice(i, 1);
    if (T.sel >= T.steps.length) T.sel = T.steps.length - 1;
    T.verified = false;
    doRecheck();
  }

  // ---------------------------------------------------------- 失败报告
  function showStuck(d) {
    const box = $("tuneDetail");
    let html = `<div class="stuck"><b>未找到安全路径</b> — ` +
      `搜索 ${d.states} 个状态后受阻：</div>`;
    (d.stuck || []).forEach(st => {
      const dials = T.pair ? T.pair.ids.map(id => {
        const dr = st.dials[id];
        return `${compLabel(id)} 刻度 ${dr[0]}/${dr[1]} ` +
          `(${fmtV(st.values[id], T.pair.segsById[id])})`;
      }).join("，") : "";
      html += `<div class="stuck">卡在：${esc(dials)}，` +
        `距目标还差 ${st.dist} 步`;
      (st.blocked || []).forEach(b => {
        const chg = Object.keys(b.changes).map(id =>
          `${compLabel(id)}→${fmtV(b.changes[id],
            T.pair ? T.pair.segsById[id] : null)}`).join("＋");
        html += `<div class="blk">受阻动作 ${esc(chg)}：<br>` +
          b.violations.map(v => `⚠ ${esc(violText(v))}`).join("<br>") +
          `</div>`;
      });
      html += "</div>";
    });
    box.innerHTML = html;
    T.sel = -1;
    App.responseOverlay = null;
    App.renderResponse();
  }

  function showUnsafe(d) {
    const box = $("tuneDetail");
    const m = d.metrics;
    box.innerHTML = `<div class="stuck"><b>${esc(d.error)}</b><br>` +
      (m.violations || []).map(v => `⚠ ${esc(violText(v))}`).join("<br>") +
      "</div>";
  }

  // ------------------------------------------------------------ 保存/载入
  async function savePath() {
    if (!T.steps.length) { toast("没有可保存的路径"); return; }
    if (!T.verified) {
      toast("序列未通过复算或未到达目标方案，不能保存");
      return;
    }
    if (!T.pair || !T.pair.to.vid) {
      toast("目标方案需为已存版本——路径仅关联到目标方案，不改动原方案");
      return;
    }
    const name = prompt("路径名称",
      T.pair.from.label + " → " + T.pair.to.label);
    if (name == null) return;
    const data = {
      code: T.pair.code,
      from: { label: T.pair.from.label, values: T.pair.from.values },
      to: { label: T.pair.to.label, values: T.pair.to.values,
            vid: T.pair.to.vid },
      stepsDef: T.stepsDef, links: T.links,
      power: T.power, limits: T.limits,
      dials: T.dials,
      actions: T.steps.map(s => s.action),
      steps: T.steps.map(s => ({
        action: s.action, values: s.values, power: s.power,
        fallback: s.fallback, dials: s.dials || null,
        metrics: s.metrics, violations: s.violations, risk: s.risk,
      })),
      setup: App.S.setup, z0: App.S.z0,
      flow: App.S.flow, fhigh: App.S.fhigh,
      dataset: {
        freq: App.S.freq,
        zload: App.S.zload.map(z => [z.re, z.im]),
      },
    };
    const d = await post("/api/tune/paths", {
      name, target_version_id: T.pair.to.vid,
      note: `${T.steps.length} 步 · ${T.power} W`, data,
    });
    if (d.error) { toast(d.error); return; }
    toast("已保存调谐路径 #" + d.id + "（关联目标方案，原方案未改动）");
    loadPaths();
  }

  async function loadPaths() {
    const box = $("tunePaths");
    const tk = $("tuneTo").value;
    if (!tk || tk === "cur") { box.innerHTML = ""; return; }
    const r = await fetch("/api/tune/paths?version_id=" + tk);
    const d = await r.json();
    if (!d.paths || !d.paths.length) { box.innerHTML = ""; return; }
    let html = '<div class="muted" style="font-size:10px;margin-top:8px">' +
      "该目标方案已存的调谐路径：</div>";
    box.innerHTML = html;
    d.paths.forEach(p => {
      const row = document.createElement("div");
      row.className = "tpath-row";
      row.innerHTML =
        `<span class="nm">#${p.id} ${esc(p.name)} ` +
        `<span class="muted">${esc(p.note || "")} · ${p.created}</span></span>` +
        `<button class="ghost small">载入</button>` +
        `<button class="ghost small">×</button>`;
      const [btnLoad, btnDel] = row.querySelectorAll("button");
      btnLoad.onclick = () => loadPath(p.id);
      btnDel.onclick = async () => {
        await fetch("/api/tune/paths/" + p.id, { method: "DELETE" });
        loadPaths();
      };
      box.appendChild(row);
    });
  }

  async function loadPath(pid) {
    const r = await fetch("/api/tune/paths/" + pid);
    const p = await r.json();
    if (!p.data) { toast("路径数据缺失"); return; }
    const d = p.data;
    // 恢复扫频数据与系统设置，使频响叠加可用
    App.S.freq = d.dataset.freq;
    App.S.zload = d.dataset.zload.map(([re, im]) => ({ re, im }));
    App.S.z0 = d.z0;
    App.S.flow = d.flow;
    App.S.fhigh = d.fhigh;
    App.S.f0 = (d.flow + d.fhigh) / 2;
    Object.assign(App.S.setup, d.setup);
    App.recomputeFeed();
    // 目标方案模板（若版本仍在）
    let template = null, segsById = {};
    if (d.to.vid) {
      const rv = await fetch("/api/versions/" + d.to.vid);
      if (rv.ok) {
        const v = await rv.json();
        template = v.data.segments;
      }
    }
    if (template) template.forEach(s => { segsById[s.id] = s; });
    T.pair = {
      code: d.code, ids: Object.keys(d.from.values).sort(),
      segsById, template: template || [],
      from: { label: d.from.label, values: d.from.values },
      to: { label: d.to.label, values: d.to.values, vid: d.to.vid },
    };
    T.stepsDef = d.stepsDef || {};
    T.links = d.links || [];
    T.power = d.power;
    T.limits = d.limits || {};
    T.dials = d.dials || null;
    T.steps = (d.steps || []).map(s =>
      Object.assign({ metrics: { comps: {} } }, s, { pinned: false }));
    T.sel = T.steps.length ? 0 : -1;
    T.verified = true;   // 保存时即已校验通过并到达目标
    $("tunePower").value = T.power;
    if (T.limits.swr) $("tuneSwr").value = T.limits.swr;
    if (T.limits.v) $("tuneV").value = T.limits.v;
    if (T.limits.i) $("tuneI").value = T.limits.i;
    if (T.limits.loss) $("tuneLoss").value = T.limits.loss;
    $("tunePairInfo").textContent =
      `已载入路径 #${p.id}：${d.from.label} → ${d.to.label}` +
      (template ? "" : "（目标版本已删除，仅查看）");
    $("tuneInfo").textContent = "";
    renderTrack();
    toast("已载入调谐路径 #" + p.id);
  }

  // ---------------------------------------------------------------- 导出
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  function stepPeak(s, key) {
    let best = null;
    Object.keys(s.metrics.comps || {}).forEach(id => {
      const c = s.metrics.comps[id];
      if (best == null || c[key] > best.v) best = { id, v: c[key] };
    });
    return best;
  }

  function exportJson() {
    if (!T.steps.length) { toast("没有可导出的路径"); return; }
    const out = {
      exported: new Date().toISOString(),
      kind: "tuning-path",
      topology: T.pair ? T.pair.code : "",
      from: T.pair ? T.pair.from : null,
      to: T.pair ? T.pair.to : null,
      tuning_power_w: T.power,
      limits: T.limits,
      knob_steps: T.stepsDef,
      linked_groups: T.links,
      dials: T.dials,
      actions: T.steps.map(s => s.action),
      steps: T.steps.map(s => ({
        action: s.action, values: s.values, power: s.power,
        fallback: s.fallback, dials: s.dials || null,
        metrics: s.metrics, violations: s.violations, risk: s.risk,
      })),
    };
    download("tuning-path.json", JSON.stringify(out, null, 2),
      "application/json");
  }

  // 打印调谐卡：刻度、功率节点、回退值、逐步风险
  function exportCard() {
    if (!T.steps.length || !T.pair) { toast("没有可导出的路径"); return; }
    const L = T.limits;
    const lim = `SWR≤${L.swr} · 电压≤${L.v} V · 电流≤${L.i} A · ` +
      `损耗≤${L.loss} dB`;
    let dialRows = "";
    T.pair.ids.forEach(id => {
      const seg = T.pair.segsById[id];
      const n = T.dials && T.dials[id] ? T.dials[id].length - 1 : "—";
      dialRows += `<tr><td>${compLabel(id)}</td>` +
        `<td>${fmtV(T.pair.from.values[id], seg)}</td>` +
        `<td>${fmtV(T.pair.to.values[id], seg)}</td>` +
        `<td>${T.stepsDef[id] ? fmtV(T.stepsDef[id], seg) : "—"}</td>` +
        `<td>${n}</td></tr>`;
    });
    let rows = "";
    T.steps.forEach((s, i) => {
      if (s.action.type === "power") {
        rows += `<tr class="pwr"><td>${i + 1}</td>` +
          `<td colspan="2">⚡ 功率调整为 ${s.power} W</td>` +
          `<td>${s.power}</td><td colspan="4"></td>` +
          `<td>${fallbackText(s)}</td></tr>`;
        return;
      }
      const pv = stepPeak(s, "v"), pi = stepPeak(s, "i");
      const bad = s.violations && s.violations.length;
      const dials = Object.keys(s.action.changes).map(id =>
        s.dials && s.dials[id]
          ? `${compLabel(id)} ${s.dials[id][0]}/${s.dials[id][1]}` : "")
        .filter(Boolean).join("; ");
      rows += `<tr${bad ? ' class="bad"' : ""}><td>${i + 1}</td>` +
        `<td>${esc(actionText(s))}</td><td>${esc(dials)}</td>` +
        `<td>${s.power}</td>` +
        `<td>${s.metrics.swr_max.toFixed(2)} @ ` +
        `${(s.metrics.swr_freq / 1e6).toFixed(3)}</td>` +
        `<td>${s.metrics.loss_max.toFixed(2)}</td>` +
        `<td>${pv ? compLabel(pv.id) + " " + pv.v.toFixed(0) : "—"}</td>` +
        `<td>${pi ? compLabel(pi.id) + " " + pi.v.toFixed(2) : "—"}</td>` +
        `<td>${bad ? "超限" : Math.round(s.risk * 100) + "%"}</td>` +
        `<td>${fallbackText(s)}</td></tr>`;
    });
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>调谐卡 - ${esc(T.pair.to.label)}</title>
<style>
body{font:12px/1.5 "PingFang SC","Microsoft YaHei",sans-serif;color:#111;
  max-width:1000px;margin:18px auto;padding:0 12px}
h1{font-size:17px} h2{font-size:13px;margin:14px 0 6px}
table{border-collapse:collapse;width:100%}
td,th{border:1px solid #999;padding:3px 6px;font-size:11px;text-align:left}
th{background:#eee}
tr.pwr td{background:#fff3cd}
tr.bad td{color:#c00;font-weight:700}
.meta{color:#444;font-size:11px}
@media print{body{margin:0}}
</style></head><body>
<h1>带电调谐卡：${esc(T.pair.from.label)} → ${esc(T.pair.to.label)}</h1>
<div class="meta">拓扑 ${esc(T.pair.code)} · 生成 ${new Date().toLocaleString()} ·
Z0 ${App.S.z0} Ω · 频段 ${(App.S.flow / 1e6).toFixed(3)}–${(App.S.fhigh / 1e6).toFixed(3)} MHz ·
调谐功率 ${T.power} W<br>安全上限：${esc(lim)}</div>
<h2>旋钮刻度</h2>
<table><tr><th>旋钮</th><th>起点</th><th>目标</th><th>步进</th><th>刻度数</th></tr>
${dialRows}</table>
<h2>调谐步骤</h2>
<table><tr><th>#</th><th>动作</th><th>刻度</th><th>功率W</th>
<th>SWRmax @ MHz</th><th>损耗dB</th><th>峰值V</th><th>峰值A</th>
<th>风险</th><th>回退值</th></tr>
${rows}</table>
<p class="meta">注：任一步出现超限立即停止操作，将所有旋钮退回
「回退值」列所示的上一安全刻度，再排查原因。风险为各上限使用率的最大值。</p>
</body></html>`;
    download("tuning-card.html", html, "text/html");
  }

  function fallbackText(s) {
    if (!T.pair) return "";
    return T.pair.ids.map(id =>
      `${compLabel(id)}=${fmtV(s.fallback[id], T.pair.segsById[id])}`)
      .join(", ");
  }

  // ------------------------------------------------------------ 版本列表
  function refreshVersions() {
    const cur1 = $("tuneFrom").value || "cur";
    const cur2 = $("tuneTo").value;
    const opts = ['<option value="cur">当前电路</option>'].concat(
      (App.S.versions || []).map(v =>
        `<option value="${v.id}">#${v.id} ${esc(v.name)} ` +
        `(${esc(v.topology)})</option>`));
    $("tuneFrom").innerHTML = opts.join("");
    $("tuneTo").innerHTML = opts.join("");
    $("tuneFrom").value = cur1;
    $("tuneTo").value = cur2 === "cur" || !cur2
      ? ($("tuneTo").options[1] ? $("tuneTo").options[1].value : "cur")
      : cur2;
    loadPaths();
  }

  // ---------------------------------------------------------------- init
  $("tuneFrom").onchange = () => { refreshPair(); };
  $("tuneTo").onchange = () => { refreshPair(); loadPaths(); };
  $("btnTunePlan").onclick = () => doPlan(null);
  $("btnTuneRecheck").onclick = doRecheck;
  $("btnTuneReplan").onclick = doReplan;
  $("btnTuneSave").onclick = savePath;
  $("btnTuneCard").onclick = exportCard;
  $("btnTuneJson").onclick = exportJson;

  window.TuneUI = { refreshVersions, refreshPair };
  refreshVersions();
  refreshPair();
})();
