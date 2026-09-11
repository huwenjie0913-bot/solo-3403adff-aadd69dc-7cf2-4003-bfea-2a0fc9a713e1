"""
search.py - topology catalogue and candidate search.

Solving model
-------------
Every component is represented by a signed normalised reactance at f0:
    xn = X/Z0  (>0 inductor, <0 capacitor)
and every line/stub by its electrical angle theta = beta*l at f0 (degrees).

For each topology configuration we minimise |Zin(f0)-Z0|/Z0 with
scipy.optimize.least_squares under component value / length limits, then
score the exact solution across the whole band and tag problems.
"""

import math

import numpy as np
from scipy.optimize import least_squares

from rf import (
    C_LIGHT,
    evaluate,
    feedline_input,
    line_input,
    reactance_bounds,
    stub_admittance,
    swr_bandwidth,
    x_to_value,
)

INF = 1e9


# --------------------------------------------------------------------------
# Topology catalogue
# --------------------------------------------------------------------------
# A "config" is (code, display name, list of param specs).
# Param spec: (id, kind, etype, ptype, extra)
#   ptype "x"   -> signed normalised reactance at f0
#   ptype "th"  -> electrical angle in degrees at f0
def topologies():
    L, P, T, S = [], [], [], []

    # ---- L networks: one series + one shunt, both placements ----
    # pos: position from source (0 = source-adjacent, 1 = load-adjacent)
    for series_near in ("source", "load"):
        for et_series in ("L", "C"):
            for et_shunt in ("L", "C"):
                code = f"L-{series_near[0]}-{et_series}{et_shunt}"
                s_pos = 0 if series_near == "source" else 1
                p_pos = 1 - s_pos
                params = [
                    dict(id="s1", kind="series", etype=et_series,
                         place=series_near, ptype="x", pos=s_pos),
                    dict(id="p1", kind="shunt", etype=et_shunt,
                         place="load" if series_near == "source" else "source",
                         ptype="x", pos=p_pos),
                ]
                name = f"L: 串{et_series}+并{et_shunt} (串在{'源' if series_near=='source' else '负载'}侧)"
                L.append(dict(code=code, name=name, family="L", params=params))

    # ---- Pi: shunt-series-shunt (source -> load) ----
    for p1 in ("L", "C"):
        for s2 in ("L", "C"):
            for p3 in ("L", "C"):
                code = f"Pi-{p1}{s2}{p3}"
                params = [
                    dict(id="p1", kind="shunt", etype=p1, ptype="x", pos=0,
                         place="source"),
                    dict(id="s2", kind="series", etype=s2, ptype="x", pos=1),
                    dict(id="p3", kind="shunt", etype=p3, ptype="x", pos=2,
                         place="load"),
                ]
                name = f"Π: 并{p1}-串{s2}-并{p3}"
                P.append(dict(code=code, name=name, family="Pi", params=params))

    # ---- T: series-shunt-series (source -> load) ----
    for s1 in ("L", "C"):
        for p2 in ("L", "C"):
            for s3 in ("L", "C"):
                code = f"T-{s1}{p2}{s3}"
                params = [
                    dict(id="s1", kind="series", etype=s1, ptype="x", pos=0,
                         place="source"),
                    dict(id="p2", kind="shunt", etype=p2, ptype="x", pos=1),
                    dict(id="s3", kind="series", etype=s3, ptype="x", pos=2,
                         place="load"),
                ]
                name = f"T: 串{s1}-并{p2}-串{s3}"
                T.append(dict(code=code, name=name, family="T", params=params))

    # ---- single-stub tuners: series line, then shunt stub at load ----
    for termin in ("open", "short"):
        code = f"Stb-{termin}"
        params = [
            dict(id="s1", kind="series", etype="line", ptype="th",
                 z0="zline", vf=1.0, pos=0, place="source"),
            dict(id="p1", kind="shunt", etype="line", ptype="th",
                 z0="zstub", vf=1.0, termin=termin, pos=1, place="load"),
        ]
        zh = "开路" if termin == "open" else "短路"
        name = f"短截线: {zh}短截线 (串线段+并短截线)"
        S.append(dict(code=code, name=name, family="stub",
                      params=params, termin=termin))

    return {"L": L, "Pi": P, "T": T, "stub": S}


TOPOS = topologies()


# --------------------------------------------------------------------------
# Parameter <-> segment conversion
# --------------------------------------------------------------------------

def _bounds(spec, f0, z0, limits):
    if spec["ptype"] == "x":
        lo, hi = reactance_bounds(spec["etype"], f0, limits)
        return lo / z0, hi / z0
    # angle in degrees, line length limits
    lo_deg = limits["lmin_m"] * 360.0 * f0 / (spec.get("vf", 1.0) * C_LIGHT)
    hi_deg = limits["lmax_m"] * 360.0 * f0 / (spec.get("vf", 1.0) * C_LIGHT)
    return max(lo_deg, 1e-3), hi_deg


def _make_segment(spec, x, f0, z0, setup):
    seg = dict(id=spec["id"], kind=spec["kind"], etype=spec["etype"])
    if spec["ptype"] == "x":
        X = x * z0
        seg["val"] = x_to_value(spec["etype"], X, f0)
        qkey = "qL" if spec["etype"] == "L" else "qC"
        if setup.get(qkey):
            seg["q"] = setup[qkey]
    else:
        seg["z0"] = setup.get(spec.get("z0", "zline"), z0)
        seg["vf"] = spec.get("vf", 1.0)
        if "termin" in spec:
            seg["termin"] = spec["termin"]
        seg["len"] = x / 360.0 * (seg["vf"] * C_LIGHT) / f0
    return seg


def _segments_from_x(xs, cfg, f0, z0, setup, limits):
    segs = []
    # emit segments in source -> load order (param "pos")
    pairs = sorted(zip(cfg["params"], xs), key=lambda kv: kv[0].get("pos", 0))
    for spec, x in pairs:
        segs.append(_make_segment(spec, float(x), f0, z0, setup))
    return segs


# --------------------------------------------------------------------------
# Input impedance at f0 (scalar, for the solver)
# --------------------------------------------------------------------------

def _zin_scalar(xs, cfg, f0, zl0, z0, setup):
    z = complex(zl0)
    # start from the load (largest pos) and fold elements toward source
    pairs = sorted(zip(cfg["params"], xs),
                   key=lambda kv: -kv[0].get("pos", 0))
    for spec, x in pairs:
        if spec["ptype"] == "x":
            # signed normalised reactance: +1 at f0 means X = +Z0 (j Z0)
            zs = 1j * x * z0
            if spec["kind"] == "series":
                z = z + zs
            else:
                z = 1.0 / (1.0 / z + 1.0 / zs)
        else:
            th = math.radians(x)
            zline = setup.get(spec.get("z0", "zline"), z0)
            if spec["kind"] == "series":
                z = line_input(z, zline, th)
            else:
                y = stub_admittance(zline, th, spec["termin"])
                z = complex(1.0 / (1.0 / z + y))
    return z


def _residual(xs, cfg, f0, zl0, z0, setup):
    z = _zin_scalar(xs, cfg, f0, zl0, z0, setup)
    return [(z.real - z0) / z0, z.imag / z0]


# --------------------------------------------------------------------------
# Search
# --------------------------------------------------------------------------

def _starts(spec, lo, hi):
    if spec["ptype"] == "th":
        # two electrical-length bands; least_squares handles tan wraps poorly
        return np.array([max(min(45.0, hi), lo),
                         max(min(135.0, hi), lo),
                         max(min(225.0, hi), lo)])
    if spec["etype"] == "L":
        vals = np.array([0.02, 0.08, 0.3, 1.0, 3.0, 8.0])
    else:
        vals = np.array([-0.02, -0.08, -0.3, -1.0, -3.0, -8.0])
    vals = vals[(vals >= lo) & (vals <= hi)]
    if len(vals) == 0:
        vals = np.array([np.clip(0.3, lo, hi) if spec["etype"] == "L"
                         else np.clip(-0.3, lo, hi)])
    return vals


# --------------------------------------------------------------------------
# Analytic L-network solutions (shunt-first at the source node)
# --------------------------------------------------------------------------

def solve_l_analytic(cfg, f0, zl0, z0, setup, limits):
    """Exact L match for a series element + shunt element.

    Two placements are supported via the per-param "place" hint.
    Returns parameter vectors in cfg['params'] order (s1, p1).
    """
    series = next(p for p in cfg["params"] if p["kind"] == "series")
    shunt = next(p for p in cfg["params"] if p["kind"] == "shunt")
    R, X = zl0.real, zl0.imag
    out = []

    if shunt.get("place") == "source":
        # topology (source) -- shunt jb -- series jx -- load (R+jX)
        # z1 = R + j(X+x), require Re(1/z1) = 1/Z0 and Im(1/z1) = -b.
        val = z0 / R - 1.0
        if val >= 0:
            for s in (1.0, -1.0):
                x_plus_x = s * R * math.sqrt(val)
                x = x_plus_x - X
                b = -(1.0 / complex(R, x_plus_x)).imag
                vec = _l_vec(cfg, series, shunt, x, b, f0, z0, limits)
                if vec is not None:
                    out.append(vec)
    else:
        # topology (source) -- series jx -- node [shunt jb] -- load (R+jX)
        # z_par = 1/(y + jb), y = 1/(R+jX); require Re(z_par) = Z0,
        # then the series element cancels Im(z_par).
        y = 1.0 / complex(R, X)
        gr, bi = y.real, y.imag
        val = gr / z0 - gr ** 2
        if val >= 0:
            for s in (1.0, -1.0):
                b = -bi + s * math.sqrt(val)
                z_par = 1.0 / complex(gr, bi + b)
                x = -z_par.imag
                vec = _l_vec(cfg, series, shunt, x, b, f0, z0, limits)
                if vec is not None:
                    out.append(vec)
    return out


def _l_vec(cfg, series, shunt, x, b, f0, z0, limits):
    """Map signed reactance/susceptance onto the config's element types,
    honouring value limits.  Returns [xn_series, xn_shunt] or None."""
    # series: x > 0 -> L; shunt: b > 0 -> C (Y=jwC), b < 0 -> L
    xn = x / z0
    if not ((series["etype"] == "L" and xn > 0) or
            (series["etype"] == "C" and xn < 0)):
        return None
    # shunt element reactance: X_sh = -1/b (in Z0 units, xn_sh = -1/(b Z0))
    xsh = -1.0 / b
    xn_sh = xsh / z0
    if not ((shunt["etype"] == "L" and xn_sh > 0) or
            (shunt["etype"] == "C" and xn_sh < 0)):
        return None
    # limit check
    lo, hi = _bounds(series, f0, z0, limits)
    if not (lo <= xn <= hi):
        return None
    lo, hi = _bounds(shunt, f0, z0, limits)
    if not (lo <= xn_sh <= hi):
        return None
    return np.array([xn, xn_sh])


def val_at_bound(spec, x, f0, z0, limits, frac=0.02):
    """True when the physical component value is within frac (log) of a limit."""
    if spec["ptype"] == "th":
        lo_deg = limits["lmin_m"] * 360.0 * f0 / (spec.get("vf", 1.0) * C_LIGHT)
        hi_deg = limits["lmax_m"] * 360.0 * f0 / (spec.get("vf", 1.0) * C_LIGHT)
        return x <= lo_deg * (1 + frac) or x >= hi_deg / (1 + frac)
    val = x_to_value(spec["etype"], x * z0, f0)
    if spec["etype"] == "L":
        vlo, vhi = limits["lmin"], limits["lmax"]
    else:
        vlo, vhi = limits["cmin"], limits["cmax"]
    return val <= vlo * (1 + frac) or val >= vhi / (1 + frac)


def _solve_config(cfg, f0, zl0, z0, setup, limits, scanned=None):
    specs = cfg["params"]
    bounds = np.array([_bounds(s, f0, z0, limits) for s in specs]).T
    sols = []

    if scanned is not None:
        # Two-stage: coarse screen (few grid points, one start each), then
        # refine only configurations which actually match.
        k = len(specs) - 1
        lo, hi = bounds[:, k]
        spk = specs[k]
        if spk["ptype"] == "th":
            coarse = np.linspace(lo, min(hi, 270.0), 12)
            fine = np.linspace(lo, min(hi, 270.0), 30)
        elif spk["etype"] == "L":
            coarse = np.geomspace(max(lo, 1e-6), hi, 10)
            fine = np.geomspace(max(lo, 1e-6), hi, 26)
        else:
            coarse = -np.geomspace(max(-lo, 1e-6), max(-hi, 1e-6), 10)[::-1]
            fine = -np.geomspace(max(-lo, 1e-6), max(-hi, 1e-6), 26)[::-1]
        others = [i for i in range(len(specs)) if i != k]
        slist = [_starts(specs[j], bounds[0][j], bounds[1][j]) for j in others]
        combos = _start_grid(slist, max_combos=4)
        hit_combo = None
        for gv in coarse:
            x0 = np.zeros(len(specs))
            x0[k] = gv
            for ci, cb in enumerate(combos):
                for j, v in zip(others, cb):
                    x0[j] = v
                sol = _run_lsq(x0, cfg, f0, zl0, z0, setup, bounds, specs, k, gv)
                if sol is not None:
                    hit_combo = cb
                    break
            if hit_combo is not None:
                break
        if hit_combo is None:
            return []
        for gv in fine:
            x0 = np.zeros(len(specs))
            x0[k] = gv
            for j, val in zip(others, hit_combo):
                x0[j] = val
            sol = _run_lsq(x0, cfg, f0, zl0, z0, setup, bounds, specs, k, gv)
            if sol is not None and not any(
                    val_at_bound(specs[j], float(sol[j]),
                                 f0, z0, limits)
                    for j in range(len(specs))):
                sols.append(sol)
    else:
        starts = [_starts(s, bounds[0][i], bounds[1][i])
                  for i, s in enumerate(specs)]
        for combo in _start_grid(starts, max_combos=12):
            sol = _run_lsq(np.array(combo), cfg, f0, zl0, z0, setup,
                           bounds, specs)
            if sol is not None and not any(
                    val_at_bound(specs[i], float(v), f0, z0, limits)
                    for i, v in enumerate(sol)):
                sols.append(sol)

    return _dedup(sols, specs)


def _start_grid(slists, max_combos):
    grids = np.meshgrid(*slists, indexing="ij") if len(slists) > 1 \
        else [np.asarray(slists[0])]
    combos = np.column_stack([g.ravel() for g in grids])
    if len(combos) > max_combos:
        idx = np.linspace(0, len(combos) - 1, max_combos).astype(int)
        combos = combos[idx]
    return combos


def _run_lsq(x0, cfg, f0, zl0, z0, setup, bounds, specs, fixed_k=None,
             fixed_v=None):
    if fixed_k is None:
        try:
            r = least_squares(_residual, x0, args=(cfg, f0, zl0, z0, setup),
                              bounds=bounds, method="trf",
                              x_scale="jac", ftol=1e-12, xtol=1e-12,
                              max_nfev=300)
        except Exception:
            return None
        if r.cost > 0.5 * (1e-7 ** 2):
            return None
        return r.x

    # fix one coordinate
    free = [i for i in range(len(specs)) if i != fixed_k]

    def res_free(xf):
        x = np.zeros(len(specs))
        x[fixed_k] = fixed_v
        for i, v in zip(free, xf):
            x[i] = v
        return _residual(x, cfg, f0, zl0, z0, setup)

    fb = bounds[:, free]
    try:
        r = least_squares(res_free, x0[free],
                          args=(), bounds=fb, method="trf",
                          x_scale="jac", ftol=1e-12, xtol=1e-12,
                          max_nfev=200)
    except Exception:
        return None
    if r.cost > 0.5 * (1e-7 ** 2):
        return None
    x = np.zeros(len(specs))
    x[fixed_k] = fixed_v
    for i, v in zip(free, r.x):
        x[i] = v
    return x


def _dedup(sols, specs, rel=0.05):
    """Merge solutions within rel on each parameter (angle: 3 deg)."""
    uniq = []
    for s in sols:
        dup = False
        for u in uniq:
            same = True
            for a, b, sp in zip(s, u, specs):
                if sp["ptype"] == "th":
                    if abs(a - b) > 3.0:
                        same = False
                        break
                else:
                    ref = max(abs(a), abs(b), 0.02)
                    if abs(a - b) / ref > rel:
                        same = False
                        break
            if same:
                dup = True
                break
        if not dup:
            uniq.append(s)
    return uniq


# --------------------------------------------------------------------------
# Candidate scoring & flags
# --------------------------------------------------------------------------

def _max_node_q(xs, cfg, z0):
    qmax = 0.0
    for spec, x in zip(cfg["params"], xs):
        if spec["ptype"] == "x":
            qmax = max(qmax, abs(float(x)))
    return qmax


def search_candidates(data):
    """Main entry: data dict -> list of candidate dicts."""
    f = np.asarray(data["freq"], dtype=float)
    zl = np.asarray(data["zload"], dtype=complex)
    z0 = float(data["z0"])
    setup = data["setup"]
    limits = data["limits"]
    families = data.get("families", ["L", "Pi", "T", "stub"])

    flow = float(data["flow"])
    fhigh = float(data["fhigh"])
    f0 = 0.5 * (flow + fhigh)

    # feedline transform
    z_at = feedline_input(zl, f, setup["zline"], setup["line_len"],
                          setup["vf"], setup.get("line_loss", 0.0))

    # dense grid for bandwidth/stress; force f0 onto the grid so the exact
    # match point is represented, and cover a margin beyond the band
    fspan = max(fhigh - flow, 0.05 * f0)
    f_lo = min(f.min(), flow - 0.15 * fspan)
    f_hi = max(f.max(), fhigh + 0.15 * fspan)
    ngrid = 400
    fd = np.linspace(f_lo, f_hi, ngrid)
    j0 = int(round((f0 - f_lo) / (f_hi - f_lo) * (ngrid - 1)))
    fd[j0] = f0
    zd = np.interp(fd, f, z_at.real) + 1j * np.interp(fd, f, z_at.imag)
    in_band = (fd >= flow) & (fd <= fhigh)

    z0f = np.interp(f0, f, z_at.real) + 1j * np.interp(f0, f, z_at.imag)

    power = float(setup.get("power", 100.0))
    swr_target = float(limits.get("swr_target", 1.5))

    cands = []
    for fam in families:
        for cfg in TOPOS[fam]:
            if fam == "L":
                sols = solve_l_analytic(cfg, f0, z0f, z0, setup, limits)
            else:
                scanned = 1 if fam in ("Pi", "T") else None
                sols = _solve_config(cfg, f0, z0f, z0, setup, limits, scanned)
                # limit raw solutions per configuration, spread by node Q
                if len(sols) > 6:
                    qs = [_max_node_q(s, cfg, z0) for s in sols]
                    order = np.argsort(qs)
                    pick = np.linspace(0, len(sols) - 1, 6).astype(int)
                    sols = [sols[order[i]] for i in pick]

            for xs in sols:
                segs = _segments_from_x(xs, cfg, f0, z0, setup, limits)
                # hard acceptance: the network must actually match at f0,
                # guarding against weakly-converged numerical solutions
                zchk = _zin_scalar(xs, cfg, f0, z0f, z0, setup)
                gchk = abs((zchk - z0) / (zchk + z0))
                if gchk > 1e-4:  # SWR ~1.0002
                    continue
                res_d = evaluate(fd, zd, segs, z0, power=power)

                # all values/limits must be physical (already bounded);
                # gather metrics over band
                swr_b = res_d["swr"][in_band]
                rl_b = res_d["rl"][in_band]
                loss_b = res_d["loss_db"][in_band]
                swr_max = float(np.max(swr_b))
                rl_min = float(np.min(rl_b))
                loss_max = float(np.max(loss_b))
                diss_max = float(np.max(res_d["diss_db"][in_band]))

                # keep every finite physical solution; the "spike" flag
                # marks narrow / poor band coverage instead of dropping it
                if not np.isfinite(swr_max):
                    continue

                bw15 = swr_bandwidth(fd, res_d["swr"], f0,
                                     flow, fhigh, swr_target)
                bw_frac = bw15 / (fhigh - flow)

                # per-component peak stress in band
                stress = {}
                over = []
                edges = []
                for seg in segs:
                    sp = None
                    for s0 in cfg["params"]:
                        if s0["id"] == seg["id"]:
                            sp = s0
                    c = res_d["comps"][seg["id"]]
                    vpk = float(np.max(c["v"][in_band]))
                    ipk = float(np.max(c["i"][in_band]))
                    ppk = float(np.max(c["p"][in_band]))
                    stress[seg["id"]] = dict(v=vpk, i=ipk, p=ppk)
                    if seg["etype"] in ("L", "C"):
                        vrate = float(limits.get("v_rating", 1e9))
                        irate = float(limits.get("i_rating", 1e9))
                        prate = float(limits.get("p_rating", 1e9))
                        if vpk > vrate or ipk > irate or ppk > prate:
                            over.append(seg["id"])
                        vmin, vmax = (limits["lmin"], limits["lmax"]) \
                            if seg["etype"] == "L" \
                            else (limits["cmin"], limits["cmax"])
                        span = math.log10(vmax / vmin)
                        pos = (math.log10(seg["val"] / vmin)) / span
                        if pos < 0.03 or pos > 0.97:
                            edges.append(seg["id"])
                    else:
                        if seg["len"] > limits["lmax_m"] * 0.97 or \
                                seg["len"] < limits["lmin_m"] * 1.03:
                            edges.append(seg["id"])

                # flags
                flags = []
                if over:
                    f_in = fd[in_band]
                    fb = f_in[np.argmax(res_d["swr"][in_band])]
                    flags.append(dict(kind="overrating",
                                      msg=f"元件越额: {', '.join(over)}",
                                      freq=float(fb)))
                if edges:
                    flags.append(dict(kind="edge",
                                      msg=f"参数触边: {', '.join(edges)}",
                                      freq=float(f0)))
                # narrowband spike: matched at f0 but poor at edges /
                # match bandwidth much narrower than requested band
                swr_edges = max(
                    float(np.interp(flow, fd, res_d["swr"])),
                    float(np.interp(fhigh, fd, res_d["swr"])))
                if swr_bandwidth(fd, res_d["swr"], f0, flow, fhigh,
                                 swr_target) / (fhigh - flow) < 0.5:
                    fbad = fd[in_band][np.argmax(swr_b)]
                    flags.append(dict(
                        kind="spike",
                        msg=f"窄带尖峰: {swr_target:g}:1 带宽仅覆盖"
                            f" {bw_frac*100:.0f}% 目标频段",
                        freq=float(fbad)))
                if _max_node_q(xs, cfg, z0) > 8:
                    flags.append(dict(kind="highq",
                                      msg=f"节点 Q≈{_max_node_q(xs,cfg,z0):.1f} 偏高",
                                      freq=float(f0)))
                if swr_max > swr_target * 2:
                    flags.append(dict(kind="mismatch",
                                      msg=f"带内最差驻波 {swr_max:.1f}:1 "
                                          f"(目标 ≤{swr_target:g}:1)",
                                      freq=float(fd[in_band][np.argmax(swr_b)])))

                # component descriptor for storage / UI
                comps_out = []
                for seg, spec, xv in zip(segs, cfg["params"], xs):
                    d = dict(id=seg["id"], kind=seg["kind"],
                             etype=seg["etype"])
                    if seg["etype"] in ("L", "C"):
                        d["val"] = seg["val"]
                        d["x"] = float(xv * z0)
                        d["unit"] = "H" if seg["etype"] == "L" else "F"
                    else:
                        d["z0"] = seg["z0"]
                        d["len"] = seg["len"]
                        d["theta"] = float(xv)
                        d["vf"] = seg.get("vf", 1.0)
                        d["termin"] = seg.get("termin")
                    comps_out.append(d)

                # per-frequency traces on the dense grid (contains f0)
                traces = dict(
                    f=[float(x) for x in fd],
                    zin=[[float(z.real), float(z.imag)]
                         for z in res_d["zin"]],
                    swr=[float(x) for x in res_d["swr"]],
                    rl=[float(x) for x in res_d["rl"]],
                    loss=[float(x) for x in res_d["loss_db"]],
                )

                cands.append(dict(
                    code=cfg["code"], name=cfg["name"], family=cfg["family"],
                    params=comps_out,
                    segments=_segments_json(segs),
                    score=dict(
                        swr_max=swr_max, rl_min=rl_min,
                        loss_max=loss_max, diss_max=diss_max,
                        bw_frac=float(bw_frac),
                        swr_edges=swr_edges,
                        qmax=_max_node_q(xs, cfg, z0),
                    ),
                    stress=stress,
                    flags=flags,
                    traces=traces,
                ))

    # multi-solution / ambiguity detection (post-pass, within family)
    _tag_multi(cands)

    # rank: satisfy SWR target first, then loss, then bandwidth
    def rank(c):
        s = c["score"]
        hard = 0 if s["swr_max"] <= swr_target else 1
        return (hard, len(c["flags"]), -s["bw_frac"], s["loss_max"],
                s["swr_max"])
    cands.sort(key=rank)
    for i, c in enumerate(cands):
        c["rank"] = i + 1
    return cands[:60]


def _segments_json(segs):
    out = []
    for s in segs:
        d = {k: v for k, v in s.items()}
        out.append(d)
    return out


def _tag_multi(cands, tol=0.2):
    """Flag near-multiple solutions: same center match within tol,
    but component values differing >20%."""
    for i, a in enumerate(cands):
        for b in cands[i + 1:]:
            if a["family"] != b["family"] or a["code"] != b["code"]:
                continue
            if abs(a["score"]["swr_max"] - b["score"]["swr_max"]) > 0.02:
                continue
            av = {c["id"]: c.get("val", c.get("len")) for c in a["params"]}
            bv = {c["id"]: c.get("val", c.get("len")) for c in b["params"]}
            diff = False
            for k in av:
                ref = max(abs(av[k]), abs(bv[k]), 1e-30)
                if abs(av[k] - bv[k]) / ref > 0.2:
                    diff = True
                    break
            if diff:
                msg = "近似多解: 同拓扑存在另一组相近性能的元件值"
                if not any(fl["kind"] == "multi" for fl in a["flags"]):
                    a["flags"].append(dict(kind="multi", msg=msg, freq=None))
                if not any(fl["kind"] == "multi" for fl in b["flags"]):
                    b["flags"].append(dict(kind="multi", msg=msg, freq=None))
