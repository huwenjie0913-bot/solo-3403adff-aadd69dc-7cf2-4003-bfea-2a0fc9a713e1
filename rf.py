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
    # capacitor, series resistance (ESR) model: R + 1/(jwC) = R - j/(wC)
    xc = -1.0 / (w * seg["val"])
    r = abs(xc) / q if q else 0.0
    return r + 1j * xc


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
    # Backward pass: segments are listed source -> load, so impedances
    # looking into the network are accumulated from the load end.
    # z_after[i] = impedance seen at segment i's load-side port.
    z = np.asarray(zload, dtype=complex).copy()
    if z.shape != f.shape:
        z = np.broadcast_to(z, f.shape).astype(complex)

    z_after = [None] * len(segments)
    for i in range(len(segments) - 1, -1, -1):
        seg = segments[i]
        z_after[i] = z.copy()
        kind, et = seg["kind"], seg["etype"]
        if et in ("L", "C"):
            zs = _seg_impedance(seg, w)
            if kind == "series":
                z = z + zs
            else:
                z = 1.0 / (1.0 / z + 1.0 / zs)
        elif et == "line":
            th = _theta(seg, f)
            if kind == "series":
                z = line_input(z, seg["z0"], th)
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
    # Vth and Zs are RMS phasors: available power P = |Vth|^2/(4 Z0).
    vth = 2.0 * math.sqrt(max(power, 0.0) * z0)
    i_in = vth / (z0 + zin)
    v_in = vth - z0 * i_in
    vline, iline = v_in, i_in  # node voltage / line current so far

    comps = {}
    p_diss = np.zeros_like(f)

    for i, seg in enumerate(segments):
        cid = seg["id"]
        kind, et = seg["kind"], seg["etype"]
        za = z_after[i]
        if et in ("L", "C"):
            zs = _seg_impedance(seg, w)
            if kind == "series":
                vcomp = iline * zs
                vrms = np.abs(vcomp)
                irms = np.abs(iline)
                pd = irms ** 2 * zs.real
                vline = vline - vcomp
            else:
                vsh = iline * za  # voltage at the shunt node
                ish = vsh / zs
                vrms = np.abs(vsh)
                irms = np.abs(ish)
                pd = vrms ** 2 / (
                    (seg.get("q", 0.0) or 0.0) *
                    np.maximum(np.abs(zs.imag), 1e-12)
                ) if seg.get("q", 0.0) else np.zeros_like(f)
                iline = iline - ish
                vline = vsh
        else:  # lossless line / stub
            th = _theta(seg, f)
            if kind == "series":
                # ABCD: V_in = V_out (cosθ + j Z0 sinθ / Z_out)
                denom = np.cos(th) + 1j * seg["z0"] * np.sin(th) / za
                v_out = vline / denom
                gl = (za - seg["z0"]) / (za + seg["z0"])
                vplus = np.abs(v_out / (1.0 + gl))
                rho = np.abs(gl)
                vrms = vplus * (1.0 + rho)               # SW voltage max
                irms = vplus / seg["z0"] * (1.0 + rho)   # SW current max
                pd = np.zeros_like(f)
                vline, iline = v_out, v_out / za
            else:
                vsh = iline * za
                ys = stub_admittance(seg["z0"], th, seg.get("termin", "open"))
                ish = vsh * ys
                vrms = np.abs(vsh)
                irms = np.abs(ish)
                pd = np.zeros_like(f)
                iline = iline - ish
                vline = vsh
        p_diss = p_diss + pd
        comps[cid] = {"v": vrms, "i": irms, "p": pd}

    # power entering the network (RMS phasor convention: P = Re(V I*))
    p_in = np.real(v_in * np.conj(i_in))
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
