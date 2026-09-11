"""
app.py - Flask backend for the antenna matching network designer.

Run locally:  python3 app.py   (http://127.0.0.1:5000)
"""
import io
import csv
import math
import re

import numpy as np
from flask import Flask, jsonify, request, send_from_directory

import db as dbmod
import tune as tunemod
from rf import feedline_input
from search import TOPOS, search_candidates

app = Flask(__name__, static_url_path="", static_folder="static")
dbmod.init_db()


# --------------------------------------------------------------------------
# CSV parsing
# --------------------------------------------------------------------------

_CPLX_RE = re.compile(
    r"^\s*([+-]?[\d.eE+]+)\s*([+-])\s*([\d.eE+]+)\s*[jJ]\s*$")


def parse_csv(text):
    """Parse frequency / complex-impedance CSV.

    Accepted rows (with or without header):
        freq,rs,xs           (MHz assumed when values look like MHz)
        freq,zreal,zimag
        MHz,R,X
        7.100,42.3,-18.7
    Also accepts a single complex column "42.3-18.7j".
    """
    reader = csv.reader(io.StringIO(text))
    rows = [r for r in reader
            if r and any(c.strip() for c in r)
            and not r[0].strip().startswith(("#", ";"))]
    if not rows:
        raise ValueError("CSV 为空")

    start = 0
    first = [c.strip().lower() for c in rows[0]]
    if not _looks_number(first[0]):
        start = 1  # skip header

    freq, zload = [], []
    for r in rows[start:]:
        cells = [c.strip() for c in r if c.strip() != ""]
        if len(cells) < 2:
            raise ValueError(f"无法解析行: {r}")
        f = float(cells[0])
        if len(cells) == 2:
            m = _CPLX_RE.match(cells[1])
            if not m:
                raise ValueError(f"复阻抗格式错误: {cells[1]}")
            re_, sign, im_ = m.groups()
            x = float(im_) * (1.0 if sign == "+" else -1.0)
            rr = float(re_)
        else:
            rr, x = float(cells[1]), float(cells[2])
        freq.append(f)
        zload.append([rr, x])

    if len(freq) < 2:
        raise ValueError("至少需要两个频点")

    # unit detection: ham-band CSV files almost always list MHz
    fmax = max(freq)
    unit = "MHz" if fmax < 1e6 else "Hz"
    if unit == "MHz":
        freq = [v * 1e6 for v in freq]
    order = np.argsort(freq)
    freq = [freq[i] for i in order]
    zload = [zload[i] for i in order]
    return {"freq": freq, "zload": zload, "unit": unit, "n": len(freq)}


def _looks_number(s):
    try:
        float(s)
        return True
    except ValueError:
        return False


@app.route("/api/parse", methods=["POST"])
def api_parse():
    text = request.json.get("csv", "")
    try:
        return jsonify(parse_csv(text))
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# --------------------------------------------------------------------------
# Example dataset
# --------------------------------------------------------------------------

@app.route("/api/sample")
def api_sample():
    """80 m band example: short vertical, R~18-40 ohm with capacitive X."""
    n = 25
    f = np.linspace(3.40e6, 3.90e6, n)
    f0 = 3.65e6
    # simple physical-ish model: R rises with f, X = -1/(w C)+jwL series
    r = 16.0 + 26.0 * (f / f0 - 0.93) ** 2 + 8.0 * (f - 3.4e6) / 0.5e6
    x = -1.0 / (2 * math.pi * f * 430e-12) + 2 * math.pi * f * 1.1e-6
    buf = io.StringIO()
    buf.write("# 80m 短垂直天线示例 (MHz, R, X)\n")
    buf.write("freq_MHz,R_ohm,X_ohm\n")
    for fi, ri, xi in zip(f, r, x):
        buf.write(f"{fi/1e6:.4f},{ri:.2f},{xi:.1f}\n")
    parsed = parse_csv(buf.getvalue())
    return jsonify({"csv": buf.getvalue(), "parsed": parsed})


# --------------------------------------------------------------------------
# Candidate search
# --------------------------------------------------------------------------

@app.route("/api/topologies")
def api_topologies():
    return jsonify({fam: [{"code": c["code"], "name": c["name"]}
                          for c in cfgs]
                    for fam, cfgs in TOPOS.items()})


@app.route("/api/search", methods=["POST"])
def api_search():
    d = request.json or {}
    try:
        f = np.asarray(d["freq"], dtype=float)
        zl = np.array([complex(a, b) for a, b in d["zload"]], dtype=complex)
        if f.size < 2 or zl.shape != f.shape:
            return jsonify({"error": "频率/阻抗数据不足"}), 400
        payload = dict(
            freq=f,
            zload=zl,
            z0=float(d.get("z0", 50.0)),
            setup=d["setup"],
            limits=d["limits"],
            flow=float(d["flow"]),
            fhigh=float(d["fhigh"]),
            families=d.get("families", ["L", "Pi", "T", "stub"]),
        )
        cands = search_candidates(payload)
        return jsonify({"candidates": cands, "count": len(cands)})
    except KeyError as e:
        return jsonify({"error": f"缺少字段: {e}"}), 400
    except Exception as e:  # noqa: BLE001
        app.logger.exception("search failed")
        return jsonify({"error": f"搜索失败: {e}"}), 500


@app.route("/api/feedline", methods=["POST"])
def api_feedline():
    d = request.json or {}
    f = np.asarray(d["freq"], dtype=float)
    zl = np.array([complex(a, b) for a, b in d["zload"]], dtype=complex)
    s = d["setup"]
    z = feedline_input(zl, f, s["zline"], s["line_len"], s["vf"],
                       s.get("line_loss", 0.0))
    return jsonify({"zin": [[float(v.real), float(v.imag)] for v in z]})


# --------------------------------------------------------------------------
# Saved versions
# --------------------------------------------------------------------------

@app.route("/api/versions", methods=["GET", "POST"])
def api_versions():
    if request.method == "POST":
        d = request.json or {}
        vid = dbmod.save_version(
            d.get("name", "未命名"),
            d.get("topology", ""),
            d.get("note", ""),
            d.get("data", {}),
        )
        return jsonify({"id": vid})
    return jsonify({"versions": dbmod.list_versions()})


@app.route("/api/versions/<int:vid>", methods=["GET", "DELETE"])
def api_version(vid):
    if request.method == "DELETE":
        dbmod.delete_version(vid)
        return jsonify({"ok": True})
    v = dbmod.get_version(vid)
    if v is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(v)


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


# --------------------------------------------------------------------------
# Live tuning path planning
# --------------------------------------------------------------------------

def _tune_ctx(d):
    """Shared planning/check context from a request payload."""
    f = np.asarray(d["freq"], dtype=float)
    zl = np.array([complex(a, b) for a, b in d["zload"]], dtype=complex)
    return tunemod.make_context(
        f, zl, d["segments"], d["setup"],
        z0=float(d.get("z0", 50.0)),
        flow=float(d["flow"]), fhigh=float(d["fhigh"]),
        power=float(d.get("power", 10.0)),
        limits=d.get("limits") or {},
        ngrid=int(d.get("ngrid", 301)),
    )


@app.route("/api/tune/plan", methods=["POST"])
def api_tune_plan():
    d = request.json or {}
    try:
        ctx = _tune_ctx(d)
        res = tunemod.plan(
            ctx, d["current"], d["target"],
            d.get("steps") or {}, links=d.get("links") or [],
            prefix=d.get("prefix"),
            max_states=int(d.get("max_states", 40000)),
        )
        return jsonify(res)
    except (KeyError, ValueError) as e:
        return jsonify({"error": f"参数错误: {e}"}), 400
    except Exception as e:  # noqa: BLE001
        app.logger.exception("tune plan failed")
        return jsonify({"error": f"规划失败: {e}"}), 500


@app.route("/api/tune/check", methods=["POST"])
def api_tune_check():
    d = request.json or {}
    try:
        ctx = _tune_ctx(d)
        steps, final, _power = tunemod.check_actions(
            ctx, d["start"], d.get("actions") or [],
            dials=d.get("dials"))
        ok = not any(s["violations"] for s in steps)
        resp = {"steps": steps, "final_values": final}
        # 除逐步安全上限外，还必须核对最终旋钮值到达目标方案
        if d.get("target") is not None:
            mism = tunemod.target_mismatch(final, d["target"], ctx["ids"])
            resp["reached_target"] = not mism
            if mism:
                resp["mismatch"] = mism
                ok = False
        else:
            resp["reached_target"] = None
        resp["ok"] = ok
        return jsonify(resp)
    except (KeyError, ValueError) as e:
        return jsonify({"error": f"参数错误: {e}"}), 400
    except Exception as e:  # noqa: BLE001
        app.logger.exception("tune check failed")
        return jsonify({"error": f"复算失败: {e}"}), 500


@app.route("/api/tune/paths", methods=["GET", "POST"])
def api_tune_paths():
    if request.method == "POST":
        d = request.json or {}
        if not d.get("target_version_id"):
            return jsonify({"error": "路径必须关联到一个已存目标方案"}), 400
        pid = dbmod.save_tune_path(
            d.get("name", "未命名路径"),
            int(d["target_version_id"]),
            d.get("note", ""),
            d.get("data", {}),
        )
        return jsonify({"id": pid})
    vid = request.args.get("version_id", type=int)
    return jsonify({"paths": dbmod.list_tune_paths(vid)})


@app.route("/api/tune/paths/<int:pid>", methods=["GET", "DELETE"])
def api_tune_path(pid):
    if request.method == "DELETE":
        dbmod.delete_tune_path(pid)
        return jsonify({"ok": True})
    p = dbmod.get_tune_path(pid)
    if p is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(p)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
