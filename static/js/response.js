/* response.js - SWR / return-loss / insertion-loss chart (SVG). */
(function (global) {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  function el(n, a, p) {
    const e = document.createElementNS(NS, n);
    for (const k in a) e.setAttribute(k, a[k]);
    if (p) p.appendChild(e);
    return e;
  }

  class ResponseChart {
    constructor(svg, onCursor) {
      this.svg = svg;
      this.W = 760; this.H = 220;
      this.ml = 48; this.mr = 12; this.mt = 14; this.mb = 30;
      this.onCursor = onCursor;
      this.series = []; // [{name, color, x,y, axis}]
      this.svg.setAttribute("viewBox", `0 0 ${this.W} ${this.H}`);
      this.svg.addEventListener("pointermove", e => this._move(e));
      this.svg.addEventListener("pointerleave", () => {
        if (this.cursor) { this.cursor.remove(); this.cursor = null; }
      });
    }

    setBand(flow, fhigh) { this.flow = flow; this.fhigh = fhigh; }

    setSeries(list) {
      // list: [{name,color,xs,ys,yMax,yLabel}]
      this.series = list;
      this._draw();
    }

    _x(f) {
      const f0 = this.fMin, f1 = this.fMax;
      return this.ml + (f - f0) / (f1 - f0) * (this.W - this.ml - this.mr);
    }
    _y(v, vmax) {
      return this.H - this.mb - Math.min(v, vmax) / vmax *
        (this.H - this.mt - this.mb);
    }

    _draw() {
      this.svg.innerHTML = "";
      if (!this.series.length || !this.series[0].xs.length) return;
      this.fMin = this.series[0].xs[0];
      this.fMax = this.series[0].xs[this.series[0].xs.length - 1];

      // band shading
      if (this.flow) {
        const x0 = this._x(Math.max(this.flow, this.fMin));
        const x1 = this._x(Math.min(this.fhigh, this.fMax));
        el("rect", { x: x0, y: this.mt, width: x1 - x0,
          height: this.H - this.mt - this.mb, class: "band" }, this.svg);
      }

      // gridlines + y ticks (use first series' axis)
      const vmax = this.series[0].yMax;
      for (let i = 0; i <= 4; i++) {
        const v = vmax * i / 4;
        const y = this._y(v, vmax);
        el("line", { x1: this.ml, y1: y, x2: this.W - this.mr, y2: y,
          class: "gridline" }, this.svg);
        const t = el("text", { x: this.ml - 6, y: y + 4,
          class: "tick", "text-anchor": "end" }, this.svg);
        t.textContent = v.toFixed(vmax < 4 ? 1 : 0);
      }
      // x ticks
      const nTick = 6;
      for (let i = 0; i <= nTick; i++) {
        const f = this.fMin + (this.fMax - this.fMin) * i / nTick;
        const x = this._x(f);
        const t = el("text", { x, y: this.H - 10, class: "tick",
          "text-anchor": "middle" }, this.svg);
        t.textContent = (f / 1e6).toFixed(2);
      }
      el("text", { x: this.W / 2, y: this.H - 0, class: "axis-label",
        "text-anchor": "middle" }, this.svg).textContent = "频率 (MHz)";
      el("text", { x: 14, y: this.H / 2, class: "axis-label",
        "text-anchor": "middle",
        transform: `rotate(-90 14 ${this.H / 2})` }, this.svg)
        .textContent = this.series[0].yLabel;

      // target SWR line at 1.5
      if (this.series[0].name.indexOf("SWR") >= 0) {
        const y = this._y(1.5, vmax);
        el("line", { x1: this.ml, y1: y, x2: this.W - this.mr, y2: y,
          class: "target-line", "stroke-dasharray": "4 3" }, this.svg);
      }

      for (const s of this.series) {
        const d = s.xs.map((f, i) =>
          `${i ? "L" : "M"} ${this._x(f).toFixed(1)} ${
            this._y(s.ys[i], s.yMax).toFixed(1)}`).join(" ");
        el("path", { d, class: "trace", stroke: s.color,
          fill: "none" }, this.svg);
      }

      // legend
      let lx = this.ml + 8;
      for (const s of this.series) {
        el("line", { x1: lx, y1: this.mt + 8, x2: lx + 16, y2: this.mt + 8,
          stroke: s.color, class: "legend-line" }, this.svg);
        const t = el("text", { x: lx + 20, y: this.mt + 12,
          class: "legend" }, this.svg);
        t.textContent = s.name;
        lx += 22 + s.name.length * 7 + 14;
      }
    }

    _move(e) {
      if (!this.series.length) return;
      const rect = this.svg.getBoundingClientRect();
      const px = (e.clientX - rect.left) * this.W / rect.width;
      const f = this.fMin + (px - this.ml) /
        (this.W - this.ml - this.mr) * (this.fMax - this.fMin);
      if (f < this.fMin || f > this.fMax) return;
      if (!this.cursor) {
        this.cursor = el("line", { x1: 0, y1: this.mt, x2: 0,
          y2: this.H - this.mb, class: "cursor-line" }, this.svg);
      }
      const x = this._x(f);
      this.cursor.setAttribute("x1", x);
      this.cursor.setAttribute("x2", x);
      this.onCursor && this.onCursor(f);
    }
  }

  global.ResponseChart = ResponseChart;
})(window);
