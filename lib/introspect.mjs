// Pure functions for the post-gameweek review and the self-calibration loop. No network or file access here,
// so everything can be tested offline against stored snapshots.
//
// Snapshot proj format (reports/history/gwNN.json, v1.5+): proj[id] = [uncal, pPlay, raw, epNext, cal, pPlayCal]
//   uncal  = model projection before calibration (this is what calibration is always fitted on, so fits never compound)
//   raw    = model projection before the blend with FPL's own ep_next
// Older snapshots (v1.3, v1.4) hold only [uncal, pPlay].
// Snapshot actual format: actual[id] = [points, minutes]

export const POSN = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const r2 = x => Math.round(x * 100) / 100;

// Best valid XI (1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD) by a value function. Greedy is optimal for this linear problem.
export function bestXI(ids, pos, val) {
  const by = { 1: [], 2: [], 3: [], 4: [] };
  ids.forEach(id => by[pos(id)].push(id));
  Object.values(by).forEach(a => a.sort((x, y) => val(y) - val(x)));
  const sel = [by[1][0], ...by[2].slice(0, 3), ...by[3].slice(0, 2), by[4][0]].filter(x => x != null);
  const cnt = { 2: 3, 3: 2, 4: 1 }, mx = { 2: 5, 3: 5, 4: 3 };
  for (const id of [...by[2].slice(3), ...by[3].slice(2), ...by[4].slice(1)].sort((x, y) => val(y) - val(x))) {
    if (sel.length >= 11) break; const t = pos(id); if (cnt[t] < mx[t]) { sel.push(id); cnt[t]++; }
  }
  return sel;
}

// Rows for calibration: one per player-gameweek with a stored projection and a known result.
export function rowsFrom(snaps, pos) {
  const rows = [];
  for (const s of snaps) {
    if (!s.actual) continue;
    for (const id in s.proj) {
      const p = s.proj[id], a = s.actual[id] || [0, 0], t = pos(+id);
      if (!t) continue;
      rows.push({ gw: s.gw, id: +id, t, u: p[0], pa: p[1], raw: p[2] ?? null, epn: p[3] ?? null, y: a[0], mins: a[1] });
    }
  }
  return rows;
}

// Residual variance model: Var(actual - proj) ~ c0 + c1 * proj, fitted on squared residuals. Used to judge whether a
// gameweek's gap is within normal variance. Falls back to a conservative heuristic with too little data.
export function varianceModel(rows) {
  const r = rows.filter(x => x.u >= 0.5);
  if (r.length < 300) return { c0: 1, c1: 2.5, n: r.length, fitted: false };
  const mx = r.reduce((s, x) => s + x.u, 0) / r.length, e2 = r.map(x => (x.y - x.u) ** 2), my = e2.reduce((s, v) => s + v, 0) / r.length;
  let sxx = 0, sxy = 0; r.forEach((x, i) => { sxx += (x.u - mx) ** 2; sxy += (x.u - mx) * (e2[i] - my); });
  const c1 = Math.max(0.5, sxx ? sxy / sxx : 2.5), c0 = Math.max(0.5, my - c1 * mx);
  return { c0: r2(c0), c1: r2(c1), n: r.length, fitted: true };
}

// ---------- Calibration ----------
// Point calibration per position: actual ~ a + b * proj on players projected 0.5+. OLS, then shrunk towards the
// identity (a=0, b=1) with prior weight N0 player-gameweeks, then bounded. This corrects systematic bias and
// compression without letting one wild gameweek move the model much.
const N0 = 600, B_LO = 0.8, B_HI = 1.25, A_LIM = 0.6;
export function fitPoints(rows) {
  const out = {};
  for (const t of [1, 2, 3, 4]) {
    const r = rows.filter(x => x.t === t && x.u >= 0.5), n = r.length;
    if (n < 30) { out[t] = { a: 0, b: 1, n }; continue; }
    const mx = r.reduce((s, x) => s + x.u, 0) / n, my = r.reduce((s, x) => s + x.y, 0) / n;
    let sxx = 0, sxy = 0; r.forEach(x => { sxx += (x.u - mx) ** 2; sxy += (x.u - mx) * (x.y - my); });
    const bo = sxx > 0 ? sxy / sxx : 1, ao = my - bo * mx, w = n / (n + N0);
    let b = 1 + w * (bo - 1); b = Math.min(B_HI, Math.max(B_LO, b));
    // Refit the intercept for the shrunk slope, then shrink and bound it.
    let a = w * (my - b * mx); a = Math.min(A_LIM, Math.max(-A_LIM, a));
    out[t] = { a: r2(a), b: r2(b), n, ols_a: r2(ao), ols_b: r2(bo) };
  }
  return out;
}
export const applyPoints = (cal, t, v) => (v > 0 && cal && cal[t]) ? Math.max(0, cal[t].a + cal[t].b * v) : v;

// Minutes calibration: the model's probability of any minutes against what happened, in four bands, each band's
// observed rate shrunk towards the predicted rate with prior weight M0. Stored as knots for piecewise-linear mapping.
const M0 = 40, BANDS = [[0, 0.3], [0.3, 0.6], [0.6, 0.85], [0.85, 1.01]];
export function fitMinutes(rows) {
  const knots = [[0, 0]], bands = [];
  for (const [lo, hi] of BANDS) {
    const b = rows.filter(x => x.pa >= lo && x.pa < hi), n = b.length;
    if (!n) continue;
    const pm = b.reduce((s, x) => s + x.pa, 0) / n, obs = b.filter(x => x.mins > 0).length / n;
    const adj = (n * obs + M0 * pm) / (n + M0);
    bands.push({ band: `${lo}-${Math.min(hi, 1)}`, n, pred: r2(pm), obs: r2(obs), adj: r2(adj) });
    knots.push([r2(pm), r2(Math.min(1, Math.max(0, adj)))]);
  }
  knots.push([1, Math.max(knots[knots.length - 1][1], r2(Math.min(1, knots[knots.length - 1][1] + 0.02)))]);
  for (let i = 1; i < knots.length; i++) if (knots[i][1] < knots[i - 1][1]) knots[i][1] = knots[i - 1][1]; // keep monotone
  return { knots, bands };
}
export function applyMinutes(knots, p) {
  if (!knots || knots.length < 2) return p;
  for (let i = 1; i < knots.length; i++) {
    const [x0, y0] = knots[i - 1], [x1, y1] = knots[i];
    if (p <= x1) return x1 > x0 ? y0 + (y1 - y0) * (p - x0) / (x1 - x0) : y1;
  }
  return knots[knots.length - 1][1];
}

// Blend weight on FPL's ep_next for the next gameweek: actual ~ (1 - alpha) * raw + alpha * epNext.
// Closed-form least squares, shrunk towards the current default 0.2, bounded to [0, 0.6].
export function fitBlend(rows) {
  const r = rows.filter(x => x.raw != null && x.epn != null && (x.raw >= 0.5 || x.epn >= 0.5)), n = r.length;
  if (n < 100) return { alpha: 0.2, n };
  let num = 0, den = 0; r.forEach(x => { const d = x.epn - x.raw; num += d * (x.y - x.raw); den += d * d; });
  const ao = den > 0 ? num / den : 0.2, w = n / (n + 800);
  return { alpha: r2(Math.min(0.6, Math.max(0, 0.2 + w * (ao - 0.2)))), n, ols: r2(ao) };
}

// Leave-one-gameweek-out validation: a learnt parameter set is only adopted if it would have improved accuracy on
// gameweeks it was not fitted on. Returns mean MAE / Brier with and without calibration.
export function validate(rows) {
  const gws = [...new Set(rows.map(x => x.gw))];
  if (gws.length < 3) return { gws: gws.length, ok: false, reason: `needs 3 finished gameweeks, has ${gws.length}` };
  let base = 0, cal = 0, bb = 0, bc = 0, n = 0, m = 0;
  for (const g of gws) {
    const train = rows.filter(x => x.gw !== g), test = rows.filter(x => x.gw === g);
    const pc = fitPoints(train), mc = fitMinutes(train);
    for (const x of test) {
      if (x.u >= 0.5) { base += Math.abs(x.y - x.u); cal += Math.abs(x.y - applyPoints(pc, x.t, x.u)); n++; }
      const o = x.mins > 0 ? 1 : 0; bb += (x.pa - o) ** 2; bc += (applyMinutes(mc.knots, x.pa) - o) ** 2; m++;
    }
  }
  const res = { gws: gws.length, mae_base: r2(base / n), mae_cal: r2(cal / n), brier_base: +(bb / m).toFixed(4), brier_cal: +(bc / m).toFixed(4) };
  res.points_ok = res.mae_cal < res.mae_base * 0.995;
  res.minutes_ok = res.brier_cal < res.brier_base * 0.995;
  res.ok = true;
  return res;
}

// Moves a learnt value at most `step` from where it was, so the model changes gradually between gameweeks.
const capStep = (old, nw, step) => old == null ? nw : r2(Math.min(old + step, Math.max(old - step, nw)));

// Produces the next params.json from all history and the previous params. Every adoption is gated by validation.
export function learn(rows, prev = {}) {
  const v = validate(rows), pts = fitPoints(rows), mins = fitMinutes(rows), blend = fitBlend(rows);
  const next = { version: (prev.version || 0) + 1, updated: new Date().toISOString(), validation: v, evidence: { points: pts, minutes: mins.bands, blend } };
  const changes = [];
  if (v.ok && v.points_ok) {
    next.calib = {};
    for (const t of [1, 2, 3, 4]) {
      const o = prev.calib?.[t] || { a: 0, b: 1 };
      next.calib[t] = { a: capStep(o.a, pts[t].a, 0.2), b: capStep(o.b, pts[t].b, 0.08) };
      if (next.calib[t].a !== o.a || next.calib[t].b !== o.b) changes.push(`${POSN[t]} points calibration a ${o.a}->${next.calib[t].a}, b ${o.b}->${next.calib[t].b} (n ${pts[t].n})`);
    }
  } else {
    next.calib = prev.calib || null;
    if (prev.calib && v.ok && !v.points_ok) { next.calib = null; changes.push('points calibration removed: no longer beats the uncalibrated model out of sample'); }
  }
  if (v.ok && v.minutes_ok) {
    next.minutes = mins.knots;
    if (JSON.stringify(prev.minutes) !== JSON.stringify(mins.knots)) changes.push(`minutes calibration knots ${JSON.stringify(mins.knots)}`);
  } else {
    next.minutes = prev.minutes || null;
    if (prev.minutes && v.ok && !v.minutes_ok) { next.minutes = null; changes.push('minutes calibration removed: no longer beats raw probabilities out of sample'); }
  }
  const oldA = prev.ep_blend ?? 0.2;
  next.ep_blend = blend.n >= 100 && v.ok ? capStep(oldA, blend.alpha, 0.05) : oldA;
  if (next.ep_blend !== oldA) changes.push(`ep_next blend weight ${oldA}->${next.ep_blend} (least squares ${blend.ols}, n ${blend.n})`);
  next.changes = changes;
  return next;
}
