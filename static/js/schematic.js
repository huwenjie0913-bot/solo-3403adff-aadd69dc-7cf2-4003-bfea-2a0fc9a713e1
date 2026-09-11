/* schematic.js - draws the L/Pi/T/stub network in SVG and provides
 * draggable handles on L/C values and stub lengths.
 */
(function (global) {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";

  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function fmtVal(v, etype) {
    if (etype === "L") {
      if (v >= 1e-6) return (v * 1e6).toFixed(2) + " µH";
      if (v >= 1e-9) return (v * 1e9).toFixed(2) + " nH";
      return (v * 1e6).toFixed(3) + " µH";
    }
    if (v >= 1e-9) return (v * 1e9).toFixed(2) + " nF";
    if (v >= 1e-12) return (v * 1e12).toFixed(1) + " pF";
    return (v * 1e12).toFixed(2) + " pF";
  }
  function fmtLen(m) {
    if (m >= 1) return m.toFixed(2) + " m";
    return (m * 100).toFixed(1) + " cm";
  }

  class Schematic {
    constructor(svg, onChange) {
      this.svg = svg;
      this.onChange = onChange;
      this.drag = null;
      this._bind();
    }

    render(segments, stress, f0) {
      this.svg.innerHTML = "";
      this.segments = segments;
      this.stress = stress || {};
      this.f0 = f0;

      const W = 760, H = 300;
      this.svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      const yMain = 150, yGnd = 240;
      const x0 = 60, x1 = W - 60;

      // source (radio) and load (antenna) boxes
      this._box(x0 - 46, yMain - 26, 52, 52, "电台", "src");
      this._box(x1 - 6, yMain - 26, 52, 52, "天线", "load");
      // ground rail
      el("line", { x1: x0, y1: yGnd, x2: x1, y2: yGnd, class: "wire" },
        this.svg);
      el("line", { x1: x0 - 20, y1: yMain + 26, x2: x0 - 20, y2: yGnd,
        class: "wire" }, this.svg);
      el("line", { x1: x1 + 20, y1: yMain + 26, x2: x1 + 20, y2: yGnd,
        class: "wire" }, this.svg);
      this._ground(x0 - 20, yGnd);
      this._ground(x1 + 20, yGnd);

      // lay out series/shunt components along the main rail
      const series = segments.filter(s => s.kind === "series");
      const shunts = segments.filter(s => s.kind === "shunt");
      const nSlot = Math.max(series.length, 1);
      const slotW = (x1 - x0) / (nSlot + 1);

      // x position of each node (between series elements / shunts)
      const nodes = [];
      let x = x0;
      el("line", { x1: x0 - 20, y1: yMain, x2: x0 + slotW / 2, y2: yMain,
        class: "wire" }, this.svg);
      let cursorX = x0;

      // interleave: positions based on "pos" if available; simpler:
      // draw series left-to-right, attach shunts at evenly spaced nodes
      const positions = segments.map((s, i) => {
        if (s.kind === "series") {
          const idx = series.indexOf(s);
          return { x: x0 + slotW * (idx + 1), y: yMain, s };
        }
        return null;
      });
      // node x positions: source, between each series element, load
      const nodeX = [x0];
      series.forEach((s, idx) => nodeX.push(x0 + slotW * (idx + 1)));
      nodeX.push(x1);

      let prevX = x0;
      segments.forEach((s, i) => {
        if (s.kind === "series") {
          const cx = nodeX[nodeX.length - 1] ; // placeholder
          const idx = series.indexOf(s);
          const midX = x0 + slotW * (idx + 1);
          el("line", { x1: prevX, y1: yMain, x2: midX - 22, y2: yMain,
            class: "wire" }, this.svg);
          this._seriesSymbol(s, midX, yMain);
          el("line", { x1: midX + 22, y1: yMain, x2: (idx === series.length - 1 ?
            x1 : midX + slotW - 0), y2: yMain, class: "wire" }, this.svg);
          prevX = midX + 22;
        }
      });
      // final wire to load
      el("line", { x1: prevX, y1: yMain, x2: x1, y2: yMain,
        class: "wire" }, this.svg);

      // shunts: distribute at the internal nodes
      const internalNodes = nodeX.slice(1, -1);
      shunts.forEach((s, i) => {
        // attach shunt at nearest internal node; with pure shunt network
        // use the midpoint
        let nx;
        if (internalNodes.length) {
          nx = internalNodes[Math.min(i, internalNodes.length - 1)];
        } else {
          nx = (x0 + x1) / 2;
          el("circle", { cx: nx, cy: yMain, r: 2.5, class: "node" },
            this.svg);
        }
        this._shuntSymbol(s, nx, yMain, yGnd);
      });
    }

    _box(x, y, w, h, text, cls) {
      el("rect", { x, y, width: w, height: h, rx: 6, class: "term " + cls },
        this.svg);
      const t = el("text", { x: x + w / 2, y: y + h / 2 + 5,
        class: "term-txt", "text-anchor": "middle" }, this.svg);
      t.textContent = text;
    }

    _ground(x, y) {
      el("line", { x1: x - 10, y1: y, x2: x + 10, y2: y, class: "wire" },
        this.svg);
      el("line", { x1: x - 6, y1: y + 5, x2: x + 6, y2: y + 5,
        class: "wire" }, this.svg);
      el("line", { x1: x - 3, y1: y + 10, x2: x + 3, y2: y + 10,
        class: "wire" }, this.svg);
    }

    _seriesSymbol(seg, cx, cy) {
      const g = el("g", { "data-id": seg.id, class: "comp series-comp" },
        this.svg);
      if (seg.etype === "line") {
        // coaxial line: thick bar
        el("rect", { x: cx - 22, y: cy - 7, width: 44, height: 14,
          class: "line-box", rx: 2 }, g);
        el("text", { x: cx, y: cy + 3, class: "sym-txt",
          "text-anchor": "middle" }, g).textContent = "Z₀";
      } else if (seg.etype === "L") {
        // inductor: 4 humps
        let d = `M ${cx - 22} ${cy}`;
        for (let i = 0; i < 4; i++) {
          const a = cx - 22 + i * 11;
          d += ` q 2.7 -9 5.5 0 t 5.5 0`;
        }
        el("path", { d, class: "sym L-sym", fill: "none" }, g);
      } else {
        // capacitor: two plates
        el("line", { x1: cx - 3, y1: cy - 12, x2: cx - 3, y2: cy + 12,
          class: "sym C-sym" }, g);
        el("line", { x1: cx + 3, y1: cy - 12, x2: cx + 3, y2: cy + 12,
          class: "sym C-sym" }, g);
      }
      this._label(g, seg, cx, cy - 20, true);
      this._handle(g, seg, cx + 24, cy - 14);
    }

    _shuntSymbol(seg, nx, yTop, yGnd) {
      const cy = (yTop + yGnd) / 2;
      const g = el("g", { "data-id": seg.id, class: "comp shunt-comp" },
        this.svg);
      this.svg.appendChild(g);
      el("line", { x1: nx, y1: yTop, x2: nx, y2: cy - 14,
        class: "wire" }, g);
      el("circle", { cx: nx, cy: yTop, r: 2.5, class: "node" }, g);

      if (seg.etype === "line") {
        // stub: vertical line with termination cap/short at bottom
        el("line", { x1: nx, y1: cy - 14, x2: nx, y2: cy + 14,
          class: "line-stub" }, g);
        if (seg.termin === "open") {
          el("circle", { cx: nx, cy: cy + 16, r: 3, class: "stub-open" }, g);
        } else {
          el("line", { x1: nx - 8, y1: cy + 16, x2: nx + 8, y2: cy + 16,
            class: "line-stub" }, g);
        }
      } else if (seg.etype === "L") {
        // rotated inductor (vertical humps)
        let d = `M ${nx} ${cy - 14}`;
        for (let i = 0; i < 4; i++)
          d += ` q 9 2.7 0 5.5 t 0 5.5`;
        el("path", { d, class: "sym L-sym", fill: "none" }, g);
      } else {
        el("line", { x1: nx - 12, y1: cy - 3, x2: nx + 12, y2: cy - 3,
          class: "sym C-sym" }, g);
        el("line", { x1: nx - 12, y1: cy + 3, x2: nx + 12, y2: cy + 3,
          class: "sym C-sym" }, g);
      }
      el("line", { x1: nx, y1: cy + 16, x2: nx, y2: yGnd, class: "wire" }, g);
      this._ground(nx, yGnd);
      this._label(g, seg, nx + 8, cy - 16, false);
      this._handle(g, seg, nx + 16, cy - 14);
    }

    _label(g, seg, x, y, anchorMid) {
      const st = this.stress[seg.id] || {};
      let txt;
      if (seg.etype === "line") txt = fmtLen(seg.len);
      else txt = fmtVal(seg.val, seg.etype);
      const t = el("text", { x, y, class: "val-label",
        "text-anchor": anchorMid ? "middle" : "start" }, g);
      t.textContent = txt;
      if (st.over) t.classList.add("over");
      // stress line
      if (seg.etype !== "line" && (st.v != null)) {
        const t2 = el("text", { x, y: y + 12, class: "stress-label",
          "text-anchor": anchorMid ? "middle" : "start" }, g);
        t2.textContent = `${st.v.toFixed(0)} V · ${st.i.toFixed(2)} A`;
        if (st.over) t2.classList.add("over");
      }
    }

    _handle(g, seg, hx, hy) {
      const c = el("circle", { cx: hx, cy: hy, r: 6,
        class: "drag-handle", "data-id": seg.id }, g);
      c.addEventListener("pointerdown", e => this._start(e, seg));
    }

    _start(e, seg) {
      e.preventDefault();
      e.stopPropagation();
      this.drag = {
        seg,
        startX: e.clientX,
        startY: e.clientY,
        startVal: seg.etype === "line" ? seg.len : seg.val,
      };
      const move = ev => this._move(ev);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.drag = null;
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    }

    _move(ev) {
      if (!this.drag) return;
      const d = this.drag;
      const dx = ev.clientX - d.startX;
      // horizontal drag changes log value; ~250 px per decade
      const factor = Math.pow(10, dx / 200);
      if (d.seg.etype === "line") {
        d.seg.len = Math.max(0.01, d.startVal * factor);
      } else {
        d.seg.val = d.startVal * factor;
      }
      this.onChange(d.seg);
    }

    _bind() {
      // wheel over a component nudges its value
      this.svg.addEventListener("wheel", e => {
        const handle = e.target.closest ? e.target.closest(".drag-handle") : null;
        if (!handle) return;
        e.preventDefault();
        const id = handle.getAttribute("data-id");
        const seg = this.segments.find(s => s.id === id);
        if (!seg) return;
        const f = Math.pow(10, -e.deltaY / 600);
        if (seg.etype === "line") seg.len = Math.max(0.01, seg.len * f);
        else seg.val = seg.val * f;
        this.onChange(seg);
      }, { passive: false });
    }
  }

  global.Schematic = Schematic;
  global.fmtVal = fmtVal;
  global.fmtLen = fmtLen;
})(window);
