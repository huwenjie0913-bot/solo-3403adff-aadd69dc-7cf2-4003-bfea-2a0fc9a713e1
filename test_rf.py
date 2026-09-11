"""Regression tests for the RF impedance engine and candidate solver.

Run: python3 -m unittest test_rf -v
"""
import math
import unittest

import numpy as np

from rf import _seg_impedance, evaluate
from search import TOPOS, _zin_scalar


class TestLumpedImpedance(unittest.TestCase):
    def test_capacitor_esr_and_reactance(self):
        # 1 nF at 1 MHz, Q = 1000 -> ESR = |X|/Q in the real part,
        # capacitive reactance in the *imaginary* part.
        f = 1e6
        w = 2 * math.pi * f
        seg = {"etype": "C", "val": 1e-9, "q": 1000.0}
        z = _seg_impedance(seg, w)
        self.assertAlmostEqual(z.real, 0.15915494309189532, places=12)
        self.assertAlmostEqual(z.imag, -159.15494309189532, places=10)

    def test_capacitor_lossless_is_pure_negative_imaginary(self):
        w = 2 * math.pi * 1e6
        z = _seg_impedance({"etype": "C", "val": 1e-9}, w)
        self.assertAlmostEqual(z.real, 0.0, places=14)
        self.assertAlmostEqual(z.imag, -159.15494309189535, places=10)

    def test_inductor_esr_and_reactance(self):
        # normalised reactance 1 against Z0 = 50 ohm means X = +50 ohm,
        # i.e. Z = R + j50 (imaginary part carries the reactance).
        f = 1e6
        w = 2 * math.pi * f
        L = 50.0 / w  # wL = 50
        seg = {"etype": "L", "val": L, "q": 200.0}
        z = _seg_impedance(seg, w)
        self.assertAlmostEqual(z.real, 50.0 / 200.0, places=12)
        self.assertAlmostEqual(z.imag, 50.0, places=10)

    def test_normalised_inductor_input_is_50_plus_50j(self):
        # config containing one series inductor, parameter xn = 1, Z0 = 50
        cfg = {"params": [
            {"id": "s1", "kind": "series", "etype": "L",
             "ptype": "x", "place": "source"}]}
        z = _zin_scalar(np.array([1.0]), cfg, 1e6, complex(50, 0), 50.0, {})
        self.assertAlmostEqual(z.real, 50.0, places=10)
        self.assertAlmostEqual(z.imag, 50.0, places=10)

    def test_shunt_capacitor_input_imaginary_only(self):
        # shunt C with normalised x = -1 across 50-ohm load must not alter
        # the real part of the input impedance (a lossless shunt C cannot).
        cfg = {"params": [
            {"id": "p1", "kind": "shunt", "etype": "C",
             "ptype": "x", "place": "source"}]}
        z = _zin_scalar(np.array([-1.0]), cfg, 1e6, complex(50, 0), 50.0, {})
        self.assertAlmostEqual(z.real, 25.0, places=10)
        self.assertAlmostEqual(z.imag, -25.0, places=10)


class TestEvaluate(unittest.TestCase):
    def test_matched_load_swr_one(self):
        seg = {"id": "c", "kind": "series", "etype": "C", "val": 1e-9}
        # 50-ohm resistor through a series L at resonance... simpler:
        # just a matched resistive load, no network.
        res = evaluate(np.array([1e6, 2e6]),
                       np.array([50 + 0j, 50 + 0j]), [], 50.0, power=100)
        np.testing.assert_allclose(res["swr"], [1.0, 1.0], rtol=1e-12)
        # perfect match: |Gamma| clips at 1e-12 -> 240 dB return loss
        self.assertTrue(all(res["rl"] >= 200.0))
        self.assertTrue(np.allclose(res["zin"], 50.0))

    def test_series_resonant_tank_matches(self):
        # series L and C chosen to resonate at 1 MHz over a 50-ohm load
        f0 = 1e6
        w = 2 * math.pi * f0
        L = 1e-6
        C = 1 / (w ** 2 * L)
        segs = [
            {"id": "L", "kind": "series", "etype": "L", "val": L},
            {"id": "C", "kind": "series", "etype": "C", "val": C},
        ]
        res = evaluate(np.array([f0]), np.array([50 + 0j]), segs, 50.0)
        self.assertAlmostEqual(res["swr"][0], 1.0, places=9)
        self.assertAlmostEqual(abs(res["zin"][0] - 50), 0.0, places=7)

    def test_capacitor_voltage_stress_is_physical(self):
        # series C (Xc = -50 ohm) between a 50-ohm source and 50-ohm load,
        # 100 W available power: total loop = 50 + 50 - j50 ohm.
        f0 = 1e6
        w = 2 * math.pi * f0
        C = 1 / (w * 50.0)
        segs = [{"id": "C", "kind": "series", "etype": "C", "val": C}]
        res = evaluate(np.array([f0]), np.array([50 + 0j]), segs, 50.0,
                       power=100.0)
        vth = 2 * math.sqrt(100 * 50)
        i_exp = vth / abs(complex(100, -50))
        self.assertAlmostEqual(res["comps"]["C"]["i"][0], i_exp, places=6)
        self.assertAlmostEqual(res["comps"]["C"]["v"][0], i_exp * 50,
                               places=6)

    def test_load_side_shunt_ordering(self):
        # L network with the shunt element on the LOAD side: analytic
        # match must reproduce Zin = 50 ohm when evaluate() orders nodes
        # correctly during its backward/forward passes.
        from search import solve_l_analytic
        f0 = 3.65e6
        zl = complex(20.1274, -76.1779)
        setup = {"zline": 50, "zstub": 50}
        limits = {"lmin": 10e-9, "lmax": 100e-6, "cmin": 1e-12,
                  "cmax": 10e-6, "lmin_m": 0.02, "lmax_m": 40.0}
        cfg = [c for c in TOPOS["L"] if c["code"] == "L-s-LL"][0]
        sols = solve_l_analytic(cfg, f0, zl, 50.0, setup, limits)
        self.assertTrue(len(sols) >= 1)
        from search import _segments_from_x
        segs = _segments_from_x(sols[0], cfg, f0, 50.0, setup, limits)
        res = evaluate(np.array([f0]), np.array([zl]), segs, 50.0)
        self.assertAlmostEqual(res["swr"][0], 1.0, places=6)


if __name__ == "__main__":
    unittest.main()
