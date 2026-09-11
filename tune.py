"""
tune.py - 带电调谐路径规划（live tuning path planner）.

在同一拓扑、同一组元件编号的两组取值（当前 → 目标）之间规划安全调节顺序：

* 每个旋钮按给定步进离散为刻度，所有可达刻度组合成网格状状态图；
* 每次动作把一个旋钮（或一组允许联动的旋钮）朝目标方向转一格；
* 每个到达的状态都在完整扫频网格上校核驻波、元件电压/电流与损耗上限；
* A* 搜索最短安全动作序列；若无路，报告卡住的刻度、频点与超限指标。

约定与 rf.py / search.py 一致：频率 Hz，L 用 H，C 用 F，线段长度 m。
"""

import heapq

import numpy as np

from rf import evaluate, feedline_input

SWR_CAP = 9999.0
LOSS_CAP = 999.0


# --------------------------------------------------------------------------
# 规划上下文：扫频网格 + 网络模板 + 安全上限
# --------------------------------------------------------------------------

def make_context(freq, zload, segments, setup, z0, flow, fhigh, power,
                 limits, ngrid=301):
    """构造规划/校核共用的上下文。

    segments 为网络模板（源 → 负载顺序），其中的 val/len 会被各状态的
    取值覆盖；q、z0、vf、termin 等字段保留。
    """
    f = np.asarray(freq, dtype=float)
    zl = np.asarray(zload, dtype=complex)
    if f.size < 2 or zl.shape != f.shape:
        raise ValueError("频率/阻抗数据不足")
    z_at = feedline_input(zl, f, setup["zline"], setup["line_len"],
                          setup["vf"], setup.get("line_loss", 0.0))
    f0 = 0.5 * (flow + fhigh)
    fspan = max(fhigh - flow, 0.05 * f0)
    f_lo = min(f.min(), flow - 0.15 * fspan)
    f_hi = max(f.max(), fhigh + 0.15 * fspan)
    fd = np.linspace(f_lo, f_hi, int(ngrid))
    fd[int(np.argmin(np.abs(fd - f0)))] = f0
    zd = np.interp(fd, f, z_at.real) + 1j * np.interp(fd, f, z_at.imag)
    template = [dict(s) for s in segments]
    ids = [s["id"] for s in template]
    if len(set(ids)) != len(ids):
        raise ValueError("元件编号重复")
    return {
        "fd": fd, "zd": zd, "f0": f0,
        "in_band": (fd >= flow) & (fd <= fhigh),
        "template": template, "ids": ids,
        "z0": float(z0), "power": float(power),
        "limits": limits or {},
    }


def _segments_with(template, values):
    segs = []
    for s in template:
        s2 = dict(s)
        v = values.get(s2["id"])
        if v is not None:
            if s2["etype"] == "line":
                s2["len"] = float(v)
            else:
                s2["val"] = float(v)
        segs.append(s2)
    return segs


def _fin(v, cap):
    v = float(v)
    if not np.isfinite(v):
        return cap
    return min(max(v, 0.0), cap)


# --------------------------------------------------------------------------
# 单状态校核：完整扫频 + 上限比对
# --------------------------------------------------------------------------

def state_metrics(ctx, values, power=None):
    """评估一个状态（一组元件取值），返回关键指标与超限列表。"""
    lim = ctx["limits"]
    segs = _segments_with(ctx["template"], values)
    res = evaluate(ctx["fd"], ctx["zd"], segs, ctx["z0"],
                   power=ctx["power"] if power is None else float(power))
    ib = ctx["in_band"]
    fb = ctx["fd"][ib]

    swr_b = res["swr"][ib]
    k = int(np.argmax(swr_b))
    swr_max, f_swr = float(swr_b[k]), float(fb[k])
    loss_b = res["loss_db"][ib]
    k = int(np.argmax(loss_b))
    loss_max, f_loss = float(loss_b[k]), float(fb[k])

    comps = {}
    for s in segs:
        c = res["comps"][s["id"]]
        vb, ibb = c["v"][ib], c["i"][ib]
        kv, ki = int(np.argmax(vb)), int(np.argmax(ibb))
        comps[s["id"]] = {
            "v": float(vb[kv]), "v_freq": float(fb[kv]),
            "i": float(ibb[ki]), "i_freq": float(fb[ki]),
            "p": float(np.max(c["p"][ib])),
        }

    swr_lim = float(lim.get("swr", 1e9))
    loss_lim = float(lim.get("loss", 1e9))
    v_lim = float(lim.get("v", 1e9))
    i_lim = float(lim.get("i", 1e9))

    violations = []
    if swr_max > swr_lim:
        violations.append({"metric": "swr", "comp": None,
                           "value": _fin(swr_max, SWR_CAP),
                           "limit": swr_lim, "freq": f_swr})
    if loss_max > loss_lim:
        violations.append({"metric": "loss", "comp": None,
                           "value": _fin(loss_max, LOSS_CAP),
                           "limit": loss_lim, "freq": f_loss})
    for cid, c in comps.items():
        if c["v"] > v_lim:
            violations.append({"metric": "v", "comp": cid, "value": c["v"],
                               "limit": v_lim, "freq": c["v_freq"]})
        if c["i"] > i_lim:
            violations.append({"metric": "i", "comp": cid, "value": c["i"],
                               "limit": i_lim, "freq": c["i_freq"]})

    risk = max(
        _fin(swr_max, SWR_CAP) / max(swr_lim, 1e-30),
        _fin(loss_max, LOSS_CAP) / max(loss_lim, 1e-30),
        *([max(c["v"] / max(v_lim, 1e-30), c["i"] / max(i_lim, 1e-30))
           for c in comps.values()] or [0.0]),
    )
    return {
        "swr_max": _fin(swr_max, SWR_CAP), "swr_freq": f_swr,
        "loss_max": _fin(loss_max, LOSS_CAP), "loss_freq": f_loss,
        "comps": comps, "violations": violations,
        "risk": float(min(risk, 1e6)),
    }


# --------------------------------------------------------------------------
# 刻度（dial）：每个旋钮从当前值到目标值的等步进离散
# --------------------------------------------------------------------------

def build_dials(current, target, steps, ids):
    """{id: [v0, ..., v1]}；values[0]=当前值，values[-1]=目标值。"""
    dials = {}
    for cid in ids:
        v0, v1 = float(current[cid]), float(target[cid])
        dv = v1 - v0
        if abs(dv) <= 1e-30 * max(1.0, abs(v0)):
            dials[cid] = [v0]
            continue
        st = float((steps or {}).get(cid) or 0.0)
        if st <= 0:
            raise ValueError(f"元件 {cid} 缺少有效步进")
        n = max(1, int(round(abs(dv) / st)))
        dials[cid] = [v0 + dv * k / n for k in range(n + 1)]
    return dials


def _nearest_idx(arr, v):
    return int(np.argmin(np.abs(np.asarray(arr, dtype=float) - float(v))))


def target_mismatch(final, target, ids, rel=1e-9):
    """最终旋钮值与目标方案的差异列表；空列表表示已到达目标。

    容差按目标值相对取值（下限 1e-15，覆盖 H/F/m 的小量纲），
    一个步进以上的偏差必然被检出。
    """
    out = []
    for cid in ids:
        if cid not in target:
            continue
        t, a = float(target[cid]), float(final[cid])
        if abs(a - t) > rel * max(abs(t), 1e-15):
            out.append({"id": cid, "expected": t, "actual": a})
    return out


def _dial_reading(dials, ids, idx):
    return {cid: [int(k), len(dials[cid]) - 1] for cid, k in zip(ids, idx)}


# --------------------------------------------------------------------------
# 显式动作序列校核（复算）：set / power 两类动作
# --------------------------------------------------------------------------

def check_actions(ctx, start_values, actions, dials=None):
    """按顺序执行动作并逐状态校核。

    动作：
      {"type": "set",   "changes": {id: value, ...}}   转动旋钮到指定值
      {"type": "power", "power": W}                    降/升功率节点
    返回 (steps, final_values, final_power)。
    """
    values = {cid: float(start_values[cid]) for cid in ctx["ids"]}
    power = ctx["power"]
    steps = []
    for act in actions or []:
        fallback = dict(values)
        atype = act.get("type")
        if atype == "power":
            power = float(act["power"])
            if power <= 0:
                raise ValueError("功率必须为正")
        elif atype == "set":
            for cid, v in (act.get("changes") or {}).items():
                if cid not in values:
                    raise ValueError(f"未知元件 {cid}")
                values[cid] = float(v)
        else:
            raise ValueError(f"未知动作类型: {atype}")
        m = state_metrics(ctx, values, power)
        step = {
            "i": len(steps) + 1, "action": act,
            "values": dict(values), "power": power,
            "fallback": fallback,
            "metrics": m, "violations": m["violations"], "risk": m["risk"],
        }
        if dials:
            step["dials"] = {
                cid: [_nearest_idx(dials[cid], values[cid]),
                      len(dials[cid]) - 1] for cid in dials}
        steps.append(step)
    return steps, values, power


# --------------------------------------------------------------------------
# A* 路径规划
# --------------------------------------------------------------------------

def plan(ctx, current, target, steps_def, links=None, prefix=None,
         max_states=40000):
    """从 current 到 target 的安全调谐序列。

    links: 允许联动的旋钮组 [[id, id, ...], ...]；同组一次动作一起转，
           但组内旋钮的单独动作始终保留（联动只是额外选项）。
    prefix: 已固定（📌）的动作前缀，先执行并校核，再自动规划余下部分。
    """
    ids = ctx["ids"]
    for cid in ids:
        if cid not in current or cid not in target:
            raise ValueError(f"元件 {cid} 缺少起点或目标值")
    dials = build_dials(current, target, steps_def, ids)
    goal = tuple(len(dials[cid]) - 1 for cid in ids)

    # ---- 固定前缀：先执行，再从其结束状态继续规划 ----
    prefix_steps = []
    start_values = {cid: float(current[cid]) for cid in ids}
    power = ctx["power"]
    if prefix:
        prefix_steps, start_values, power = check_actions(
            ctx, start_values, prefix, dials)
        bad = next((s for s in prefix_steps if s["violations"]), None)
        if bad:
            return {"ok": False, "reason": "prefix",
                    "error": f"固定前缀在第 {bad['i']} 步已超限，无法继续规划",
                    "steps": prefix_steps, "dials": dials}
    start = tuple(_nearest_idx(dials[cid], start_values[cid]) for cid in ids)

    cache = {}

    def eval_idx(idx):
        if idx not in cache:
            vals = {cid: dials[cid][k] for cid, k in zip(ids, idx)}
            cache[idx] = state_metrics(ctx, vals, power)
        return cache[idx]

    m0 = eval_idx(start)
    if m0["violations"]:
        return {"ok": False, "reason": "start-unsafe",
                "error": "起点状态在调谐功率下已超限",
                "metrics": m0, "dials": dials, "steps": prefix_steps}
    mg = eval_idx(goal)
    if mg["violations"]:
        return {"ok": False, "reason": "target-unsafe",
                "error": "目标状态在调谐功率下超限，请降低功率或放宽上限",
                "metrics": mg, "dials": dials, "steps": prefix_steps}

    # ---- 动作组：联动组是额外选项，各旋钮的单独动作始终保留 ----
    # （安全路径若需要先单独调节组内某旋钮，联动不应把它排除掉）
    groups, seen = [], set()
    for grp in (links or []):
        members = tuple(sorted({ids.index(c) for c in grp if c in ids}))
        if len(members) >= 2 and members not in seen:
            groups.append(members)
            seen.add(members)
    groups += [(i,) for i in range(len(ids))]
    max_group = max((len(g) for g in groups), default=1)

    def moves(idx):
        for g in groups:
            if any(idx[m] < goal[m] for m in g):
                ns = list(idx)
                for m in g:
                    if ns[m] < goal[m]:
                        ns[m] += 1
                yield tuple(ns), g

    def h(idx):  # 可采纳启发：剩余步数 / 最大联动跨度
        return -(-sum(goal[i] - idx[i] for i in range(len(ids)))
                 // max_group)

    openh = [(h(start), 0, start)]
    best = {start: 0}
    parent = {}
    blocked = {}
    found = None
    capped = False
    while openh:
        _, g, idx = heapq.heappop(openh)
        if g > best.get(idx, 1 << 60):
            continue
        if idx == goal:
            found = idx
            break
        for ns, grp in moves(idx):
            m = eval_idx(ns)
            if len(cache) > max_states:
                capped = True
                break
            if m["violations"]:
                blocked[ns] = m
                continue
            ng = g + 1
            if ng < best.get(ns, 1 << 60):
                best[ns] = ng
                parent[ns] = (idx, grp)
                heapq.heappush(openh, (ng + h(ns), ng, ns))
        if capped:
            break

    if found is not None:
        seq = []
        idx = found
        while idx != start:
            prev, grp = parent[idx]
            seq.append((prev, grp, idx))
            idx = prev
        seq.reverse()
        steps_out = list(prefix_steps)
        values = {cid: dials[cid][k] for cid, k in zip(ids, start)}
        for prev, grp, idx in seq:
            fallback = dict(values)
            changes = {}
            for m in grp:
                if prev[m] != idx[m]:
                    cid = ids[m]
                    values[cid] = dials[cid][idx[m]]
                    changes[cid] = values[cid]
            met = cache[idx]
            steps_out.append({
                "i": len(steps_out) + 1,
                "action": {"type": "set", "changes": changes},
                "values": dict(values), "power": power,
                "fallback": fallback,
                "metrics": met, "violations": met["violations"],
                "risk": met["risk"],
                "dials": _dial_reading(dials, ids, idx),
            })
        return {"ok": True, "steps": steps_out, "dials": dials,
                "states": len(cache), "power": power}

    # ---- 失败：报告卡住的刻度、受阻动作、超限指标与频点 ----
    def dist(idx):
        return sum(goal[i] - idx[i] for i in range(len(ids)))

    safe_states = list(best.keys())
    dmin = min(dist(s) for s in safe_states)
    frontier = [s for s in safe_states if dist(s) == dmin]
    stuck = []
    for s in frontier[:3]:
        bmoves = []
        for ns, grp in moves(s):
            m = blocked.get(ns)
            if m is not None:
                bmoves.append({
                    "changes": {ids[mm]: dials[ids[mm]][ns[mm]]
                                for mm in grp if ns[mm] != s[mm]},
                    "violations": m["violations"],
                })
        stuck.append({
            "values": {cid: dials[cid][k] for cid, k in zip(ids, s)},
            "dials": _dial_reading(dials, ids, s),
            "dist": dmin,
            "metrics": cache[s],
            "blocked": bmoves,
        })
    reason = "cap" if capped else "no-path"
    msg = ("状态空间过大，未在限额内找到路径" if capped
           else "不存在满足上限的调节顺序")
    return {"ok": False, "reason": reason, "error": msg,
            "stuck": stuck, "dials": dials,
            "states": len(cache), "steps": prefix_steps}
