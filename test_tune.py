"""Regression tests for the live tuning path planner (tune.py).

Run: python3 -m unittest test_tune -v
"""
import math
import os
import tempfile
import unittest
from unittest import mock

import numpy as np

import tune
from tune import build_dials, check_actions, make_context, plan


def _ctx(power=10.0, limits=None, ngrid=151):
    """L-network (shunt C at source, series L at load) on an 80 m load.

    Target values are the analytic match for 25-j60 ohm at 3.65 MHz.
    """
    f = np.linspace(3.5e6, 3.8e6, 31)
    zl = (25 - 60j) * np.ones(31)
    segs = [
        {"id": "p1", "kind": "shunt", "etype": "C", "val": 872.08e-12,
         "q": 1000},
        {"id": "s1", "kind": "series", "etype": "L", "val": 3.7063e-6,
         "q": 200},
    ]
    setup = {"zline": 50.0, "line_len": 0.0, "vf": 0.83, "line_loss": 0.0}
    limits = limits or {"swr": 3.0, "v": 500.0, "i": 5.0, "loss": 6.0}
    return make_context(f, zl, segs, setup, 50.0, 3.5e6, 3.8e6,
                        power, limits, ngrid=ngrid)


CURRENT = {"p1": 760e-12, "s1": 3.3e-6}
TARGET = {"p1": 872.08e-12, "s1": 3.7063e-6}
STEPS = {"p1": 25e-12, "s1": 0.1e-6}


class TestDials(unittest.TestCase):
    def test_uniform_grid_endpoints_exact(self):
        d = build_dials({"a": 1e-6}, {"a": 2e-6}, {"a": 0.25e-6}, ["a"])
        self.assertEqual(len(d["a"]), 5)
        self.assertAlmostEqual(d["a"][0], 1e-6, places=15)
        self.assertAlmostEqual(d["a"][-1], 2e-6, places=15)

    def test_decreasing_direction(self):
        d = build_dials({"a": 900e-12}, {"a": 700e-12}, {"a": 50e-12},
                        ["a"])
        self.assertEqual(len(d["a"]), 5)
        self.assertAlmostEqual(d["a"][0], 900e-12, places=18)
        self.assertAlmostEqual(d["a"][-1], 700e-12, places=18)
        self.assertTrue(all(d["a"][k] > d["a"][k + 1]
                            for k in range(len(d["a"]) - 1)))

    def test_fixed_component_single_detent(self):
        d = build_dials({"a": 1e-6}, {"a": 1e-6}, {"a": 1e-7}, ["a"])
        self.assertEqual(d["a"], [1e-6])

    def test_missing_step_raises(self):
        with self.assertRaises(ValueError):
            build_dials({"a": 1e-6}, {"a": 2e-6}, {}, ["a"])


class TestPlan(unittest.TestCase):
    def test_finds_shortest_safe_path(self):
        ctx = _ctx()
        res = plan(ctx, CURRENT, TARGET, STEPS)
        self.assertTrue(res["ok"], res.get("error"))
        steps = res["steps"]
        # 4 capacitor detents + 4 inductor detents = 8 single-knob moves
        self.assertEqual(len(steps), 8)
        for s in steps:
            self.assertEqual(s["violations"], [])
            self.assertLess(s["risk"], 1.0)
        # ends exactly at the target values
        self.assertAlmostEqual(steps[-1]["values"]["s1"], TARGET["s1"])
        self.assertAlmostEqual(steps[-1]["values"]["p1"], TARGET["p1"])
        # first step starts from the current values
        self.assertAlmostEqual(steps[0]["fallback"]["s1"], CURRENT["s1"])
        # dial readings run 0..N
        self.assertEqual(steps[-1]["dials"]["s1"], [4, 4])
        self.assertEqual(steps[-1]["dials"]["p1"], [4, 4])

    def test_linked_knobs_move_together(self):
        ctx = _ctx()
        res = plan(ctx, CURRENT, TARGET, STEPS, links=[["p1", "s1"]])
        self.assertTrue(res["ok"], res.get("error"))
        steps = res["steps"]
        # ganged: max(4, 4) = 4 combined moves
        self.assertEqual(len(steps), 4)
        multi = [s for s in steps if len(s["action"]["changes"]) == 2]
        self.assertEqual(len(multi), 4)  # every move turns both knobs
        self.assertAlmostEqual(steps[-1]["values"]["p1"], TARGET["p1"])

    def test_start_unsafe_reported(self):
        ctx = _ctx(limits={"swr": 1.0, "v": 1e9, "i": 1e9, "loss": 1e9})
        res = plan(ctx, CURRENT, TARGET, STEPS)
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason"], "start-unsafe")
        self.assertIn("swr", [v["metric"] for v in
                              res["metrics"]["violations"]])

    def test_no_path_reports_stuck_dial_freq_metric(self):
        ctx = _ctx()
        real = tune.state_metrics

        def wall(c, values, power=None):
            m = real(c, values, power)
            # wall between the 2nd detent and the target: intermediate
            # inductor settings are "unsafe", the target itself is fine
            if 3.55e-6 < values["s1"] < 3.70e-6:
                m["violations"] = [{"metric": "swr", "comp": None,
                                    "value": 3.5, "limit": 3.0,
                                    "freq": 3.5e6}]
            return m

        with mock.patch.object(tune, "state_metrics", side_effect=wall):
            res = plan(ctx, CURRENT, TARGET, STEPS)
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason"], "no-path")
        st = res["stuck"][0]
        # stuck at the inductor's 2nd detent (~3.503 uH), 2 steps short
        self.assertAlmostEqual(st["values"]["s1"], 3.50315e-6)
        self.assertEqual(st["dials"]["s1"], [2, 4])
        self.assertEqual(st["dist"], 2)
        self.assertTrue(st["blocked"])
        v = st["blocked"][0]["violations"][0]
        self.assertEqual(v["metric"], "swr")
        self.assertAlmostEqual(v["freq"], 3.5e6)
        self.assertGreater(v["value"], v["limit"])

    def test_prefix_is_executed_then_planned(self):
        ctx = _ctx()
        prefix = [{"type": "set", "changes": {"p1": 788.02e-12}},
                  {"type": "power", "power": 5.0}]
        res = plan(ctx, CURRENT, TARGET, STEPS, prefix=prefix)
        self.assertTrue(res["ok"], res.get("error"))
        steps = res["steps"]
        # 1 prefix knob move + power node + remaining 3+4 moves
        self.assertEqual(len(steps), 2 + 7)
        self.assertEqual(steps[1]["action"]["type"], "power")
        # everything after the power node runs at 5 W
        self.assertTrue(all(s["power"] == 5.0 for s in steps[1:]))

    def test_prefix_violation_aborts(self):
        ctx = _ctx(limits={"swr": 1.2, "v": 1e9, "i": 1e9, "loss": 1e9})
        prefix = [{"type": "set", "changes": {"s1": 2.0e-6}}]
        res = plan(ctx, CURRENT, TARGET, STEPS, prefix=prefix)
        self.assertFalse(res["ok"])
        self.assertEqual(res["reason"], "prefix")
        self.assertTrue(res["steps"][0]["violations"])


class TestCheck(unittest.TestCase):
    def test_power_node_scales_voltage(self):
        ctx = _ctx()
        actions = [{"type": "power", "power": 40.0}]
        steps, _, pw = check_actions(ctx, CURRENT, actions)
        m10 = tune.state_metrics(ctx, CURRENT, 10.0)
        # V ~ sqrt(P): quadrupling power doubles component voltage
        self.assertAlmostEqual(
            steps[0]["metrics"]["comps"]["s1"]["v"]
            / m10["comps"]["s1"]["v"], 2.0, places=6)
        self.assertEqual(pw, 40.0)

    def test_violation_carries_freq_and_limit(self):
        ctx = _ctx(limits={"swr": 1.5, "v": 1e9, "i": 1e9, "loss": 1e9})
        actions = [{"type": "set", "changes": {"s1": 2.0e-6}}]
        steps, _, _ = check_actions(ctx, CURRENT, actions)
        v = steps[0]["violations"][0]
        self.assertEqual(v["metric"], "swr")
        self.assertEqual(v["limit"], 1.5)
        self.assertTrue(3.4e6 <= v["freq"] <= 3.9e6)

    def test_unknown_action_rejected(self):
        ctx = _ctx()
        with self.assertRaises(ValueError):
            check_actions(ctx, CURRENT, [{"type": "jump"}])

    def test_dial_readings_computed_when_dials_given(self):
        ctx = _ctx()
        dials = build_dials(CURRENT, TARGET, STEPS, ["p1", "s1"])
        actions = [{"type": "set", "changes": {"p1": 788.02e-12}}]
        steps, _, _ = check_actions(ctx, CURRENT, actions, dials=dials)
        self.assertEqual(steps[0]["dials"]["p1"], [1, 4])
        self.assertEqual(steps[0]["dials"]["s1"], [0, 4])


class TestApi(unittest.TestCase):
    """Flask endpoints with a temporary SQLite database."""

    @classmethod
    def setUpClass(cls):
        import db as dbmod
        fd, cls.dbpath = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        os.unlink(cls.dbpath)
        dbmod.DB_PATH = cls.dbpath
        import app as appmod
        cls.client = appmod.app.test_client()

    @classmethod
    def tearDownClass(cls):
        if os.path.exists(cls.dbpath):
            os.unlink(cls.dbpath)

    def _payload(self):
        f = np.linspace(3.5e6, 3.8e6, 31)
        zl = (25 - 60j) * np.ones(31)
        segs = [
            {"id": "p1", "kind": "shunt", "etype": "C", "val": 872.08e-12,
             "q": 1000},
            {"id": "s1", "kind": "series", "etype": "L", "val": 3.7063e-6,
             "q": 200},
        ]
        return {
            "freq": list(f), "zload": [[25.0, -60.0]] * len(f),
            "z0": 50.0, "flow": 3.5e6, "fhigh": 3.8e6,
            "setup": {"zline": 50.0, "line_len": 0.0, "vf": 0.83,
                      "line_loss": 0.0},
            "segments": segs,
        }

    def test_plan_check_and_path_crud(self):
        c = self.client
        body = self._payload()
        body.update({
            "current": CURRENT, "target": TARGET, "steps": STEPS,
            "links": [], "power": 10.0,
            "limits": {"swr": 3.0, "v": 500.0, "i": 5.0, "loss": 6.0},
        })
        r = c.post("/api/tune/plan", json=body)
        self.assertEqual(r.status_code, 200)
        plan_res = r.get_json()
        self.assertTrue(plan_res["ok"], plan_res.get("error"))
        self.assertEqual(len(plan_res["steps"]), 8)

        # check endpoint with an inserted power node
        actions = ([plan_res["steps"][0]["action"],
                    {"type": "power", "power": 5.0}] +
                   [s["action"] for s in plan_res["steps"][1:]])
        r = c.post("/api/tune/check", json=dict(
            self._payload(), start=CURRENT, actions=actions, power=10.0,
            limits={"swr": 3.0, "v": 500.0, "i": 5.0, "loss": 6.0},
            dials=plan_res["dials"]))
        chk = r.get_json()
        self.assertTrue(chk["ok"])
        self.assertEqual(chk["steps"][1]["power"], 5.0)

        # save a version (target) and a path linked to it
        vid = c.post("/api/versions", json={
            "name": "目标", "topology": "L-l-LC", "note": "",
            "data": {"code": "L-l-LC", "segments": body["segments"]},
        }).get_json()["id"]
        r = c.post("/api/tune/paths", json={
            "name": "p", "target_version_id": vid, "note": "n",
            "data": {"actions": actions},
        })
        pid = r.get_json()["id"]
        lst = c.get(f"/api/tune/paths?version_id={vid}").get_json()
        self.assertEqual(len(lst["paths"]), 1)
        one = c.get(f"/api/tune/paths/{pid}").get_json()
        self.assertEqual(one["target_version_id"], vid)
        # the version row itself is untouched by the path save
        v = c.get(f"/api/versions/{vid}").get_json()
        self.assertEqual(v["name"], "目标")
        self.assertNotIn("paths", v["data"])
        # delete
        self.assertTrue(c.delete(f"/api/tune/paths/{pid}")
                        .get_json()["ok"])
        self.assertEqual(c.get(f"/api/tune/paths/{pid}").status_code, 404)

    def test_plan_requires_target_version_for_save(self):
        r = self.client.post("/api/tune/paths", json={
            "name": "x", "data": {}})
        self.assertEqual(r.status_code, 400)

    def test_plan_rejects_bad_step(self):
        body = self._payload()
        body.update({
            "current": CURRENT, "target": TARGET,
            "steps": {"p1": 0.0, "s1": 1e-7},  # zero step -> invalid
            "links": [], "power": 10.0, "limits": {},
        })
        r = self.client.post("/api/tune/plan", json=body)
        self.assertEqual(r.status_code, 400)
        self.assertIn("步进", r.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
