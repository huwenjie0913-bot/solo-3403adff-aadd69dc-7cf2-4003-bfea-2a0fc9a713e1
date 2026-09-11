/* smith.js - interactive Smith chart rendered in SVG.
 * Draws load, feedline transform and matched-network trajectories.
 */
(function (global) {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";

  function el(name, attrs) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  class Smith {
    constructor(svg) {
      this.svg = svg;
      this.size = 460;
      this.cx = this.size / 2;
      this.cy = this.size / 2;
      this.R = this.size / 2 - 14;
      this.cursor = null; // {freq, ...}
      this._grid();
    }

    // normalised gamma (z0-normalised) -> chart x/y pixels
    _xy(g, z0) {
      return [this.cx + g.re * this.R, this.cy - g.im * this.R];
    }

    gamma(z, z0) {
      const d = (z.re + z0) ** 2 + z.im ** 2;
      return {
        re: ((z.re ** 2 + z.im ** 2 - z0 ** 2) / d),
        im: (2 * z.im * z0 / d),
      };
    }

    _grid() {
      const grid = el("g", { class: "sm-grid" });
      this.svg.appendChild(grid);
      const R0 = this.R, cx = this.cx, cy = this.cy;

      // outer unit circle
      grid.appendChild(el("circle", {
        cx, cy, r: R0, class: "sm-outer",
      }));

      // constant-resistance circles r = 0.2,0.5,1,2,5 ; r=0 is the outer
      for (const r of [0.2, 0.5, 1, 2, 5]) {
        const rr = R0 / (1 + r);
        grid.appendChild(el("circle", {
          cx: cx + R0 * r / (1 + r), cy, r: rr,
          class: "sm-r", "data-r": r,
        }));
      }
      // constant-reactance arcs x = +/- 0.2,0.5,1,2,5
      for (const xm of [0.2, 0.5, 1, 2, 5]) {
        for (const sgn of [1, -1]) {
          const x = sgn * xm;
          const ccx = cx + R0;
          const ccy = cy - R0 / x;
          const rad = R0 / Math.abs(x);
          // arc from the unit-circle intersection to (cx+R0, cy)
          const gInt = {
            re: (1 - 1 + xm * xm) / (1 + 1 + xm * xm + 0),
            im: 2 * x / (x * x + 4),
          };
          // intersection with |gamma|=1 for constant-x arc endpoint
          const t = 2 / (1 + xm * xm);
          const ex = cx + R0 * (1 - t);
          const ey = cy - R0 * (x * t / 2);
          const path = `M ${cx + R0} ${cy} A ${rad} ${rad} 0 0 ${sgn > 0 ? 1 : 0} ${ex} ${ey}`;
          grid.appendChild(el("path", {
            d: path, class: "sm-x",
          }));
        }
      }
      // center + axes
      grid.appendChild(el("line", {
        x1: cx - R0, y1: cy, x2: cx + R0, y2: cy, class: "sm-axis",
      }));
      grid.appendChild(el("circle", { cx, cy, r: 2.2, class: "sm-center" }));

      // labels
      const lbl = (txt, x, y, anchor = "middle") => {
        const t = el("text", { x, y, class: "sm-label", "text-anchor": anchor });
        t.textContent = txt;
        grid.appendChild(t);
      };
      lbl("0", cx - R0 - 2, cy + 12, "end");
      lbl("∞", cx + R0 + 8, cy + 4);
      lbl("1", cx, cy + 12);
      lbl("+j1", cx + R0 - 26, cy - R0 / 2 - 4);
      lbl("−j1", cx + R0 - 30, cy + R0 / 2 + 12);

      this.dataLayer = el("g", { class: "sm-data" });
      this.svg.appendChild(this.dataLayer);
      this.cursorLayer = el("g", { class: "sm-cursor" });
      this.svg.appendChild(this.cursorLayer);
    }

    clear() {
      while (this.dataLayer.firstChild)
        this.dataLayer.removeChild(this.dataLayer.firstChild);
      while (this.cursorLayer.firstChild)
        this.cursorLayer.removeChild(this.cursorLayer.firstChild);
    }

    _path(points, cls, attrs = {}) {
      if (!points.length) return null;
      const d = points.map((p, i) =>
        `${i ? "L" : "M"} ${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(" ");
      const path = el("path", Object.assign({ d, class: cls }, attrs));
      this.dataLayer.appendChild(path);
      return path;
    }

    _dot(x, y, cls, r = 3.5) {
      this.dataLayer.appendChild(el("circle", { cx: x, cy: y, r, class: cls }));
    }

    // zSeries: array of {re,im} across freq at each network node,
    // ordered source -> load.  Trajectory = curve as freq sweeps.
    plotTrajectory(zArr, z0, cls, withDots = true) {
      const pts = zArr.map(z => {
        const g = this.gamma(z, z0);
        return this._xy(g, z0);
      });
      this._path(pts, cls);
      if (withDots && pts.length) {
        this._dot(pts[0][0], pts[0][1], cls + " sm-end", 3);
        this._dot(pts[pts.length - 1][0], pts[pts.length - 1][1],
          cls + " sm-end", 3);
      }
    }

    plotPoint(z, z0, cls, r = 4) {
      const g = this.gamma(z, z0);
      const [x, y] = this._xy(g, z0);
      this._dot(x, y, cls, r);
      return [x, y];
    }

    plotLabel(text, x, y, cls) {
      const t = el("text", { x: x + 6, y: y - 6, class: "sm-txt " + cls });
      t.textContent = text;
      this.dataLayer.appendChild(t);
    }

    // draw a marker at a given frequency for several node series
    setCursor(items) {
      while (this.cursorLayer.firstChild)
        this.cursorLayer.removeChild(this.cursorLayer.firstChild);
      for (const it of items) {
        const g = this.gamma(it.z, it.z0);
        const [x, y] = this._xy(g, it.z0);
        this.cursorLayer.appendChild(el("circle", {
          cx: x, cy: y, r: 5, class: "sm-cur " + it.cls,
        }));
      }
    }

    // convert pointer event to a gamma location (for click-to-locate)
    eventToGamma(evt) {
      const rect = this.svg.getBoundingClientRect();
      const sx = (evt.clientX - rect.left) * this.size / rect.width;
      const sy = (evt.clientY - rect.top) * this.size / rect.height;
      let gx = (sx - this.cx) / this.R;
      let gy = -(sy - this.cy) / this.R;
      const m = Math.hypot(gx, gy);
      if (m > 1) { gx /= m; gy /= m; }
      return { re: gx, im: gy };
    }
  }

  global.Smith = Smith;
})(window);
