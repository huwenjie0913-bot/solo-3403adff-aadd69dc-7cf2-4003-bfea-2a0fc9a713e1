"""
rf.py - RF primitives for the antenna matching network designer.

Conventions
-----------
* All frequencies in Hz, inductances in H, capacitances in F, lengths in m.
* A network is a list of segments, ordered source -> load:
    {"id","kind":"series"|"shunt","etype":"L"|"C"|"line", ...}
  - lumped L/C: {"val": L or C}
  - series line: {"z0", "len"}
  - shunt stub (line across the line): {"z0", "len", "termin":"open"|"short"}
* Complex numbers follow e^{jwt}; impedance of an inductor is +jwL,
  a capacitor is 1/(jwC).
"""

import cmath
import math

import numpy as np

C_LIGHT = 2.99792458e8


# --------------------------------------------------------------------------
# Transmission lines
# --------------------------------------------------------------------------

def feedline_input(zload, f, z0c, length, vf, loss_db100m=0.0):
    """Transform *zload* through a lossy (or lossless) feedline.

    loss_db100m is matched-line attenuation per 100 m, converted to a
    (weakly frequency-scaled) real propagation constant so dissipation is
    accounted for.
    """
    f = np.asarray(f, dtype=float)
    zload = np.asarray(zload, dtype=complex)
    vp = vf * C_LIGHT
    beta = 2.0 * np.pi * f / vp
    # dB/100m -> Np/m, scale gently with sqrt(f/f_ref) like skin effect
    alpha0 = loss_db100m / (100.0 * 8.685889638)
    fref = f[np.nonzero(f)]
    f0 = np.median(fref) if fref.size else 1.0
    alpha = alpha0 * np.sqrt(f / f0)
    gamma = alpha + 1j * beta
    th = gamma * length
    z0c = complex(z0c)
    return z0c * (zload + z0c * np.tanh(th)) / (z0c + zload * np.tanh(th))


def line_input(zload, z0c, theta):
    """Input impedance of a lossless line terminated in zload, theta=beta*l."""
    t = np.tan(theta)
    return z0c * (zload + 1j * z0c * t) / (z0c + 1j * zload * t)


def stub_admittance(z0c, theta, termin):
    """Shunt admittance of an open/short-circuited lossless stub."""
    t = np.tan(theta)
    if termin == "open":
        # Zin = -j Z0 cot(theta)  ->  Y = j tan(theta)/Z0
        return 1j * t / z0c
    # short: Zin = j Z0 tan(theta) -> Y = -j/(Z0 tan theta)
    return -1j / (z0c * t)


# --------------------------------------------------------------------------
# Lumped elements (with finite-Q loss models)
# --------------------------------------------------------------------------

def _seg_impedance(seg, w):
    t = seg["etype"]
    q = seg.get("q", 0.0) or 0.0
    if t == "L":
        x = w * seg["val"]
        return (x / q if q else 0.0) + 1j * x
    # capacitor, series resistance model
    xc = -1.0 / (w * seg["val"])
    r = abs(xc) / q if q else 0.0
    return r + xc


# --------------------------------------------------------------------------
# Network evaluation (vectorised over frequency)
# --------------------------------------------------------------------------

def _theta(seg, f):
    vp = seg.get("vf", 1.0) * C_LIGHT
    return 2.0 * np.pi * np.asarray(f, dtype=float) * seg["len"] / vp


def evaluate(freq, zload, segments, z0, power=1.0):
    """Full analysis of a matching network.

    Returns a dict with input impedance, VSWR/RL, losses and per-component
    peak voltage/current/dissipation arrays (one value per frequency).
    """
    f = np.asarray(freq, dtype=float)
    w = 2.0 * np.pi * f
    z = np.asarray(zload, dtype=complex).copy()
    if z.shape != f.shape:
        z = np.broadcast_to(z, f.shape).astype(complex)

    before = []
    for seg in segments:
        before.append(z.copy())
        kind, et = seg["kind"], seg["etype"]
        if et in ("L", "C"):
            zs = _seg_impedance(seg, w)
            if kind == "series":
                z = z + zs
            else:
                z = 1.0 / (1.0 / z + 1.0 / zs)
        elif et == "line":
            th = _theta(seg, f)
            zl = line_input(z, seg["z0"], th) if kind == "series" else None
            if kind == "series":
                z = zl
            else:
                ys = stub_admittance(seg["z0"], th, seg.get("termin", "open"))
                z = 1.0 / (1.0 / z + ys)
        else:
            raise ValueError(et)

    zin = z
    gamma = (zin - z0) / (zin + z0)
    mag = np.abs(gamma)
    mag_safe = np.clip(mag, 1e-12, None)
    swr = np.where(mag >= 1.0, np.inf, (1.0 + mag) / np.maximum(1.0 - mag, 1e-12))
    rl = -20.0 * np.log10(np.maximum(mag_safe, 1e-15))
    mismatch_db = -10.0 * np.log10(np.maximum(1.0 - mag ** 2, 1e-15))

    # ---- forward voltage/current sweep, Thevenin source Vth=2 sqrt(P Z0) --
    vth = 2.0 * math.sqrt(max(power, 0.0) * z0)
    v = vth * zin / (z0 + zin)
    comps = {}
    p_diss = np.zeros_like(f)

    for seg, zb in zip(segments, before):
        cid = seg["id"]
        kind, et = seg["kind"], seg["etype"]
        q = seg.get("q", 0.0) or 0.0
        if et in ("L", "C"):
            zs = _seg_impedance(seg, w)
            if kind == "series":
                i_line = v / zb
                vcomp = i_line * zs
                v_after = v - vcomp
                vrms = np.abs(vcomp)
                irms = np.abs(i_line)
                pd = irms ** 2 * (zs.real if q else 0.0)
                v = v_after
            else:
                ys = 1.0 / zs
                ish = v * ys
                vrms = np.abs(v)
                irms = np.abs(ish)
                if q:
                    rp = q * max(abs(zs.imag), 1e-12)  # parallel equivalent
                    pd = vrms ** 2 / rp
                else:
                    pd = np.zeros_like(f)
        else:  # line
            th = _theta(seg, f)
            if kind == "series":
                # ABCD: V_before = V_after (cosθ + j Z0 sinθ / Z_after)
                z_after = line_input_inv(zb, seg["z0"], th)
                denom = np.cos(th) + 1j * seg["z0"] * np.sin(th) / z_after
                v_after = v / denom
                # standing-wave maxima on the lossless segment
                gl = (z_after - seg["z0"]) / (z_after + seg["z0"])
                vplus = np.abs(v_after / (1.0 + gl))
                rho = np.abs(gl)
                vrms = vplus * (1.0 + rho)
                irms = vplus / seg["z0"] * (1.0 + rho)
                pd = np.zeros_like(f)
                v = v_after
            else:
                ys = stub_admittance(seg["z0"], th, seg.get("termin", "open"))
                ish = v * ys
                vrms = np.abs(v)
                irms = np.abs(ish)
                pd = np.zeros_like(f)
        p_diss = p_diss + pd
        comps[cid] = {"v": vrms, "i": irms, "p": pd}

    # power entering the network (RMS phasor convention: P = Re(V I*))
    i_in = vth / (z0 + zin)
    p_in = np.real(v * np.conj(i_in))
    p_load = np.maximum(p_in - p_diss, 1e-30)
    eta = np.clip(p_load / np.maximum(p_in, 1e-30), 0.0, 1.0)
    diss_db = -10.0 * np.log10(np.maximum(eta, 1e-12))
    loss_db = mismatch_db + diss_db

    return {
        "zin": zin,
        "gamma": gamma,
        "swr": swr,
        "rl": rl,
        "loss_db": loss_db,
        "mismatch_db": mismatch_db,
        "diss_db": diss_db,
        "comps": comps,
        "eta": eta,
    }


def line_input_inv(z_before, z0c, theta):
    """Given input impedance of a lossless series line, return load Z."""
    t = np.tan(theta)
    # invert z_in = z0 (zl + j z0 t)/(z0 + j zl t)
    return z0c * (z_before - 1j * z0c * t) / (z0c - 1j * z_before * t)


# --------------------------------------------------------------------------
# Helpers shared with the solver
# --------------------------------------------------------------------------

def reactance_bounds(etype, f0, limits):
    """Signed-reactance bounds (ohms) implied by component value limits."""
    w0 = 2.0 * math.pi * f0
    if etype == "L":
        return w0 * limits["lmin"], w0 * limits["lmax"]
    # C: X = -1/(w C); Cmin -> largest |X|
    return (-1.0 / (w0 * limits["cmin"]), -1.0 / (w0 * limits["cmax"]))


def x_to_value(etype, x, f0):
    w0 = 2.0 * math.pi * f0
    if etype == "L":
        return x / w0
    return -1.0 / (w0 * x)


def gamma_of(zin, z0):
    g = (zin - z0) / (zin + z0)
    return abs(g)


def swr_bandwidth(f_dense, swr_dense, f0, flow, fhigh, threshold):
    """Contiguous match bandwidth (Hz) containing f0 where SWR <= threshold."""
    ok = swr_dense <= threshold
    idx0 = int(np.argmin(np.abs(f_dense - f0)))
    if not ok[idx0]:
        return 0.0
    lo = idx0
    while lo > 0 and ok[lo - 1] and f_dense[lo - 1] >= flow:
        lo -= 1
    hi = idx0
    n = len(f_dense)
    while hi < n - 1 and ok[hi + 1] and f_dense[hi + 1] <= fhigh:
        hi += 1
    return float(f_dense[hi] - f_dense[lo])
