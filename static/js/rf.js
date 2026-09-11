/* rf.js - browser-side RF engine, mirrors rf.py conventions.
 * Complex numbers are plain {re, im} objects. Frequencies in Hz.
 */
(function (global) {
  "use strict";

  const C_LIGHT = 2.99792458e8;

  function cadd(a, b) { return { re: a.re + b.re, im: a.im + b.im }; }
  function csub(a, b) { return { re: a.re - b.re, im: a.im - b.im }; }
  function cmul(a, b) {
    return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
  }
  function cdiv(a, b) {
    const d = b.re * b.re + b.im * b.im;
    return {
      re: (a.re * b.re + a.im * b.im) / d,
      im: (a.im * b.re - a.re * b.im) / d,
    };
  }
  function cneg(a) { return { re: -a.re, im: -a.im }; }
  function cabs(a) { return Math.hypot(a.re, a.im); }

  // ---------------------------------------------------------------- feedline
  function feedlineInput(zloadArr, fArr, z0c, len, vf, lossDb100m = 0) {
    const vp = vf * C_LIGHT;
    const fmed = median(fArr.filter(f => f > 0));
    return fArr.map((f, i) => {
      const beta = 2 * Math.PI * f / vp;
      const a0 = lossDb100m / (100 * 8.685889638);
      const alpha = a0 * Math.sqrt(f / (fmed || 1));
      const th = { re: alpha * len, im: beta * len }; // gamma*l = alpha*l + j beta*l
      const t = ctanh(th);
      const z = zloadArr[i];
      const num = cadd(z, cmul({ re: z0c, im: 0 }, t));
      const den = cadd({ re: z0c, im: 0 }, cmul(z, t));
      return cmul({ re: z0c, im: 0 }, cdiv(num, den));
    });
  }

  function ctanh(z) {
    // tanh(x+jy) = (sinh 2x + j sin 2y) / (cosh 2x + cos 2y)
    const a = 2 * z.re, b = 2 * z.im;
    const den = Math.cosh(a) + Math.cos(b);
    if (Math.abs(den) < 1e-12) {
      // singular (e.g. lossless quarter-wave): return a large pure-j value
      return { re: 0, im: Math.sign(Math.sin(b)) * 1e12 };
    }
    return { re: Math.sinh(a) / den, im: Math.sin(b) / den };
  }

  function lineInput(z, z0c, theta) {
    const t = Math.tan(theta);
    // z0*(z + j z0 t)/(z0 + j z t)
    const num = cadd(z, { re: 0, im: z0c * t });
    const den = cadd({ re: z0c, im: 0 }, cmul(z, { re: 0, im: t }));
    return cmul({ re: z0c, im: 0 }, cdiv(num, den));
  }

  function lineInputInv(zb, z0c, theta) {
    const t = Math.tan(theta);
    const num = csub(zb, { re: 0, im: z0c * t });
    const den = csub({ re: z0c, im: 0 }, cmul(zb, { re: 0, im: t }));
    return cmul({ re: z0c, im: 0 }, cdiv(num, den));
  }

  function stubY(z0c, theta, termin) {
    const t = Math.tan(theta);
    if (termin === "open") return { re: 0, im: t / z0c };
    return { re: 0, im: -1 / (z0c * t) };
  }

  function segZ(seg, w) {
    if (seg.etype === "L") {
      const x = w * seg.val;
      return { re: seg.q ? x / seg.q : 0, im: x };
    }
    const x = -1 / (w * seg.val);
    return { re: seg.q ? Math.abs(x) / seg.q : 0, im: x };
  }

  function segTheta(seg, f) {
    const vp = (seg.vf != null ? seg.vf : 1) * C_LIGHT;
    return 2 * Math.PI * f * seg.len / vp;
  }

  // -------------------------------------------------------------- evaluation
  function evaluate(freq, zload, segments, z0, power = 1) {
    const n = freq.length;
    const w = freq.map(f => 2 * Math.PI * f);

    // backward pass: impedance looking into the network at each node
    let z = zload.map(x => ({ ...x }));
    const zAfter = new Array(segments.length);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      zAfter[i] = z.map(x => ({ ...x }));
      z = z.map((zz, k) => stepBack(zz, seg, w[k], freq[k]));
    }
    const zin = z;

    const swr = new Array(n), rl = new Array(n), gamma = new Array(n),
      mismatch = new Array(n);
    for (let i = 0; i < n; i++) {
      const g = cdiv(csub(zin[i], { re: z0, im: 0 }),
        cadd(zin[i], { re: z0, im: 0 }));
      gamma[i] = g;
      const m = cabs(g);
      swr[i] = m >= 1 ? Infinity : (1 + m) / Math.max(1 - m, 1e-12);
      rl[i] = -20 * Math.log10(Math.max(m, 1e-15));
      mismatch[i] = -10 * Math.log10(Math.max(1 - m * m, 1e-15));
    }

    const vth = 2 * Math.sqrt(Math.max(power, 0) * z0);
    const iIn0 = zin.map(zz =>
      cdiv({ re: vth, im: 0 }, cadd(zz, { re: z0, im: 0 })));
    let vline = zin.map((zz, i) =>
      csub({ re: vth, im: 0 }, cmul({ re: z0, im: 0 }, iIn0[i])));
    let iline = iIn0.slice();
    const comps = {};
    const pDiss = new Array(n).fill(0);

    segments.forEach((seg, si) => {
      const vrms = new Array(n), irms = new Array(n), pd = new Array(n);
      for (let i = 0; i < n; i++) {
        const za = zAfter[si][i];
        if (seg.etype === "L" || seg.etype === "C") {
          const zs = segZ(seg, w[i]);
          if (seg.kind === "series") {
            const vc = cmul(iline[i], zs);
            vrms[i] = cabs(vc);
            irms[i] = cabs(iline[i]);
            pd[i] = irms[i] ** 2 * zs.re;
            vline[i] = csub(vline[i], vc);
          } else {
            const vsh = cmul(iline[i], za);
            const ish = cdiv(vsh, zs);
            vrms[i] = cabs(vsh);
            irms[i] = cabs(ish);
            if (seg.q) {
              const rp = seg.q * Math.max(Math.abs(zs.im), 1e-12);
              pd[i] = vrms[i] ** 2 / rp;
            } else pd[i] = 0;
            iline[i] = csub(iline[i], ish);
            vline[i] = vsh;
          }
        } else {
          const th = segTheta(seg, freq[i]);
          if (seg.kind === "series") {
            const denom = cadd(
              { re: Math.cos(th), im: 0 },
              cdiv({ re: 0, im: seg.z0 * Math.sin(th) }, za));
            const va = cdiv(vline[i], denom);
            const gl = cdiv(csub(za, { re: seg.z0, im: 0 }),
              cadd(za, { re: seg.z0, im: 0 }));
            const vplus = cabs(cdiv(va, cadd({ re: 1, im: 0 }, gl)));
            const rho = cabs(gl);
            vrms[i] = vplus * (1 + rho);
            irms[i] = vplus / seg.z0 * (1 + rho);
            pd[i] = 0;
            vline[i] = va;
            iline[i] = cdiv(va, za);
          } else {
            const vsh = cmul(iline[i], za);
            const ys = stubY(seg.z0, th, seg.termin);
            const ish = cmul(vsh, ys);
            vrms[i] = cabs(vsh);
            irms[i] = cabs(ish);
            pd[i] = 0;
            iline[i] = csub(iline[i], ish);
            vline[i] = vsh;
          }
        }
        pDiss[i] += pd[i];
      }
      comps[seg.id] = { v: vrms, i: irms, p: pd };
    });

    const loss = new Array(n), diss = new Array(n), eta = new Array(n),
      pIn = new Array(n);
    for (let i = 0; i < n; i++) {
      const vIn = csub({ re: vth, im: 0 },
        cmul({ re: z0, im: 0 }, iIn0[i]));
      pIn[i] = vIn.re * iIn0[i].re + vIn.im * iIn0[i].im;
      const pl = Math.max(pIn[i] - pDiss[i], 1e-30);
      eta[i] = Math.min(1, Math.max(0, pl / Math.max(pIn[i], 1e-30)));
      diss[i] = -10 * Math.log10(Math.max(eta[i], 1e-12));
      loss[i] = mismatch[i] + diss[i];
    }

    return { zin, gamma, swr, rl, loss, diss, mismatch, eta, comps };
  }

  function stepBack(z, seg, w, f) {
    if (seg.etype === "L" || seg.etype === "C") {
      const zs = segZ(seg, w);
      if (seg.kind === "series") return cadd(z, zs);
      return cdiv({ re: 1, im: 0 },
        cadd(cdiv({ re: 1, im: 0 }, z), cdiv({ re: 1, im: 0 }, zs)));
    }
    const th = segTheta(seg, f);
    if (seg.kind === "series") return lineInput(z, seg.z0, th);
    return cdiv({ re: 1, im: 0 },
      cadd(cdiv({ re: 1, im: 0 }, z), stubY(seg.z0, th, seg.termin)));
  }

  // ------------------------------------------------------------- interpolation
  function interpZ(fNew, f, z) {
    return fNew.map(fx => ({
      re: interp1(fx, f, z.map(q => q.re)),
      im: interp1(fx, f, z.map(q => q.im)),
    }));
  }

  function interp1(x, xs, ys) {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (xs[m] <= x) lo = m; else hi = m;
    }
    const t = (x - xs[lo]) / (xs[lo + 1] - xs[lo]);
    return ys[lo] + t * (ys[lo + 1] - ys[lo]);
  }

  function median(a) {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[s.length >> 1] : 1;
  }

  function swrBandwidth(fd, swr, flow, fhigh, threshold) {
    const ok = swr.map(s => s <= threshold);
    let idx0 = 0, best = Infinity;
    fd.forEach((f, i) => {
      const d = Math.abs(f - (flow + fhigh) / 2);
      if (d < best) { best = d; idx0 = i; }
    });
    if (!ok[idx0]) return 0;
    let lo = idx0, hi = idx0;
    while (lo > 0 && ok[lo - 1] && fd[lo - 1] >= flow) lo--;
    while (hi < fd.length - 1 && ok[hi + 1] && fd[hi + 1] <= fhigh) hi++;
    return fd[hi] - fd[lo];
  }

  global.RF = {
    C_LIGHT, cadd, csub, cmul, cdiv, cneg, cabs,
    feedlineInput, lineInput, stubY, segZ, segTheta,
    evaluate, interpZ, interp1, swrBandwidth,
  };
})(window);
