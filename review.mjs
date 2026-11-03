// Post-gameweek review and self-calibration (Node 20+, public FPL data only, no login).
// For every finished, data-checked gameweek that has a pre-deadline snapshot in reports/history and no review yet:
//   1. records actual points and minutes for every player,
//   2. reconstructs what was actually fielded (autosubs, armband, chips, hits) and checks it against FPL's total,
//   3. attributes the gameweek's result to decisions (transfers, captain, lineup, bench, judgement overrides of the
//      model) and to projection error, and separates normal variance from systematic error,
//   4. writes reports/reviews/gwNN.md and .json.
// Then it refits the model's calibration from all history (model/params.json, read by fpl.mjs), adopting a change
// only if it beats the current model out of sample, logs every change in model/changelog.md, and regenerates the
// automated findings in model/lessons.md. Reflections written by the deadline agent in lessons.md are preserved.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { bestXI, rowsFrom, varianceModel, learn, POSN } from './lib/introspect.mjs';

const ENTRY = +(process.env.FPL_ENTRY || 531300);
const LEAGUES = (process.env.FPL_LEAGUES || '54818,392003').split(',').map(Number).filter(Boolean);
const FORCE = process.env.FPL_REVIEW_FORCE === '1';
const HIST = 'reports/history', REV = 'reports/reviews';
const BASE = 'https://fantasy.premierleague.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function J(u) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(BASE + u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (r.ok) return await r.json(); if (r.status === 404 || a === 3) throw new Error(u + ' ' + r.status);
    } catch (e) { if (a === 3 || String(e).includes(' 404')) throw e; }
    await sleep(1500 * (a + 1));
  }
}
const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
const sgn = x => (x > 0 ? '+' : '') + f1(x);
const rd = f => JSON.parse(readFileSync(f, 'utf8'));
const pad = g => String(g).padStart(2, '0');
mkdirSync(REV, { recursive: true }); mkdirSync('model', { recursive: true });

const bs = await J('/api/bootstrap-static/');
const ev = Object.fromEntries(bs.events.map(e => [e.id, e]));
const P = Object.fromEntries(bs.elements.map(e => [e.id, e]));
const T = Object.fromEntries(bs.teams.map(t => [t.id, t]));
const pos = id => P[id]?.element_type, nm = id => P[id]?.web_name ?? `#${id}`, tm = id => T[P[id]?.team]?.short_name ?? '?';
const curEv = (bs.events.find(e => e.is_current) || {}).id;

// Load snapshots and fill in actuals for finished, data-checked gameweeks.
const snaps = [];
for (const f of readdirSync(HIST).filter(f => /^gw\d+\.json$/.test(f)).sort()) {
  const s = rd(`${HIST}/${f}`), e = ev[s.gw];
  if (e && e.finished && e.data_checked && !s.actual) {
    const live = await J(`/api/event/${s.gw}/live/`);
    s.actual = {}; for (const x of live.elements) s.actual[x.id] = [x.stats.total_points, x.stats.minutes];
    writeFileSync(`${HIST}/${f}`, JSON.stringify(s));
  }
  snaps.push(s);
}
const done = snaps.filter(s => s.actual);
const varM = varianceModel(rowsFrom(done, pos));
const todo = done.filter(s => FORCE || !existsSync(`${REV}/gw${pad(s.gw)}.json`));

let hist = null, allTr = null;
if (todo.length) [hist, allTr] = await Promise.all([J(`/api/entry/${ENTRY}/history/`), J(`/api/entry/${ENTRY}/transfers/`)]);

for (const s of todo) {
  const g = s.gw, e = ev[g];
  const pk = await J(`/api/entry/${ENTRY}/event/${g}/picks/`);
  const eh = pk.entry_history, chip = pk.active_chip || null, capMult = chip === '3xc' ? 3 : 2;
  const act = id => s.actual[id] || [0, 0], pts = id => act(id)[0], mins = id => act(id)[1];
  const pr = id => s.proj[id] || [0, 0];
  const pj = id => pr(id)[4] ?? pr(id)[0];   // the projection the model actually decided on (calibrated if v1.5+)
  const pa = id => pr(id)[5] ?? pr(id)[1];
  const picks = [...pk.picks].sort((a, b) => a.position - b.position);
  const squad = picks.map(p => p.element);
  const startXI = picks.filter(p => p.position <= 11).map(p => p.element), bench = picks.filter(p => p.position > 11).map(p => p.element);
  const cap = picks.find(p => p.is_captain)?.element, vc = picks.find(p => p.is_vice_captain)?.element;
  // Fielded XI after automatic substitutions.
  let eff = [...startXI]; for (const a of pk.automatic_subs || []) eff = eff.map(x => x === a.element_out ? a.element_in : x);
  const scoring = chip === 'bboost' ? squad : eff;
  const effCap = cap && mins(cap) > 0 ? cap : (vc && mins(vc) > 0 ? vc : null);
  const xiPts = scoring.reduce((a, id) => a + pts(id), 0), armExtra = effCap ? pts(effCap) * (capMult - 1) : 0;
  const gross = xiPts + armExtra, hits = eh.event_transfers_cost || 0, net = eh.points - hits;
  const check = gross === eh.points ? 'reconciles with FPL' : `does not reconcile (computed ${gross}, FPL ${eh.points}); treat attribution with care`;

  // Projection of what was fielded, as the model valued it before the deadline.
  const projXI = startXI.reduce((a, id) => a + pj(id), 0) + (cap ? (capMult - 1) * (pj(cap) + (1 - pa(cap)) * (vc ? pj(vc) : 0)) : 0);
  // Variance: residual on the fielded XI only, against the fitted residual-variance model.
  const sdXI = Math.sqrt(startXI.reduce((a, id) => a + varM.c0 + varM.c1 * pj(id), 0) + (cap ? (capMult - 1) ** 2 * (varM.c0 + varM.c1 * pj(cap)) : 0));
  const z = sdXI ? (eh.points - projXI) / sdXI : 0;
  const verdict = Math.abs(z) < 1 ? 'within normal variance' : Math.abs(z) < 2 ? 'a notable deviation, but plausibly variance' : 'outside normal variance; look for a systematic cause';

  // Decision attribution, all in hindsight on actual points.
  const hindXI = bestXI(squad, pos, pts), hindXIpts = hindXI.reduce((a, id) => a + pts(id), 0);
  const hindCap = [...eff].sort((a, b) => pts(b) - pts(a))[0];
  const lineupRegret = chip === 'bboost' ? 0 : hindXIpts - xiPts;
  const capRegret = (pts(hindCap) - (effCap ? pts(effCap) : 0)) * (capMult - 1);
  const benchPts = chip === 'bboost' ? 0 : squad.filter(id => !eff.includes(id)).reduce((a, id) => a + pts(id), 0);
  const trs = allTr.filter(t => t.event === g);
  const trRows = trs.map(t => ({ out: t.element_out, in: t.element_in, d: pts(t.element_in) - pts(t.element_out), pd: pj(t.element_in) - pj(t.element_out) }));
  const trNet = trRows.reduce((a, t) => a + t.d, 0) - hits;

  // Where the executed decision departed from the model's last pre-deadline view (judgement overrides on news, or a
  // model that moved between the decision and the deadline).
  const R = s.recommended, C = s.current;
  const modelCap = R?.captain;
  const capOverride = modelCap && cap && modelCap !== cap ? { model: modelCap, used: cap, d: (pts(cap) - pts(modelCap)) * (capMult - 1) } : null;
  const recIns = new Set(R?.in || []), usedIns = new Set(trs.map(t => t.element_in));
  const trOverride = R && (R.in.length !== trs.length || [...usedIns].some(x => !recIns.has(x)))
    ? { model: R.in.map((id, i) => [R.out[i], id]), used: trs.map(t => [t.element_out, t.element_in]),
        d: trs.reduce((a, t) => a + pts(t.element_in) - pts(t.element_out), 0) - R.in.reduce((a, id, i) => a + pts(id) - pts(R.out[i]), 0) } : null;
  const scoreSnapXI = r => r ? r.xi.reduce((a, id) => a + pts(id), 0) + pts(mins(r.captain) > 0 ? r.captain : r.vice) : null;
  const recActual = scoreSnapXI(R), curActual = scoreSnapXI(C);

  // Player-level projection audit for everyone the decision touched.
  const touched = [...new Set([...squad, ...trs.map(t => t.element_out), ...(R?.in || [])])];
  const rows = touched.map(id => {
    const flags = [];
    if (pa(id) >= 0.7 && mins(id) === 0) flags.push('minutes miss');
    if (pa(id) < 0.5 && mins(id) >= 60) flags.push('unexpected start');
    if (pts(id) - pj(id) >= 6) flags.push('haul');
    if (mins(id) >= 60 && pts(id) <= 2 && pj(id) >= 4.5) flags.push('blank');
    return { id, name: nm(id), team: tm(id), pos: POSN[pos(id)] ?? '?', role: eff.includes(id) ? (id === effCap ? 'C' : 'XI') : squad.includes(id) ? 'bench' : trs.some(t => t.element_out === id) ? 'sold' : 'model buy',
      proj: +f1(pj(id)), p_play: Math.round(pa(id) * 100), pts: pts(id), mins: mins(id), resid: +f1(pts(id) - pj(id)), flags };
  });
  const minsMissXI = rows.filter(r => startXI.includes(r.id) && r.flags.includes('minutes miss'));
  const minsMissCost = minsMissXI.reduce((a, r) => a + r.proj, 0);

  const prevOR = hist.current.find(h => h.event === g - 1)?.overall_rank ?? null;
  const leagues = [];
  if (g === curEv) for (const id of LEAGUES) {
    try { const d = await J(`/api/leagues-classic/${id}/standings/`), me = d.standings.results.find(x => x.entry === ENTRY), top = d.standings.results[0];
      const best = [...d.standings.results].sort((a, b) => b.event_total - a.event_total)[0];
      if (me) leagues.push({ id, name: d.league.name, rank: me.rank, last: me.last_rank, gw: me.event_total, leader: top.entry_name, gap: top.total - me.total, best: best.entry_name, bestPts: best.event_total });
    } catch (x) { leagues.push({ id, err: String(x) }); }
  }

  const rev = { gw: g, generated: new Date().toISOString(), chip, points: eh.points, hits, net, gw_rank: eh.rank, overall_rank: eh.overall_rank, prev_overall_rank: prevOR,
    average: e.average_entry_score, highest: e.highest_score, reconcile: check, proj_fielded: +f1(projXI), z: +z.toFixed(2), verdict,
    attribution: { lineup_regret: lineupRegret, captain_regret: capRegret, bench_points: benchPts, transfers_net: trNet, minutes_miss_cost: +f1(minsMissCost) },
    captain: { used: cap, effective: effCap, hindsight_best: hindCap }, transfers: trRows, overrides: { captain: capOverride, transfers: trOverride },
    model_view: { recommended_actual: recActual, recommended_proj: R?.xi_proj, current_actual: curActual, current_proj: C?.xi_proj }, players: rows, leagues, variance_model: varM };
  writeFileSync(`${REV}/gw${pad(g)}.json`, JSON.stringify(rev, null, 1));
  writeFileSync(`${REV}/gw${pad(g)}.md`, renderReview(rev));
  console.log(`Reviewed GW${g}: ${net} net, ${verdict}`);
}

function renderReview(r) {
  const L = [];
  const orMove = r.prev_overall_rank ? ` from ${r.prev_overall_rank.toLocaleString('en-GB')}` : '';
  L.push(`# GW${r.gw} review`, '');
  L.push(`Scored ${r.points}${r.hits ? ` less a ${r.hits}-point hit (${r.net} net)` : ''}${r.chip ? ` with ${r.chip} active` : ''}, against a gameweek average of ${r.average} and a high of ${r.highest}. Gameweek rank ${r.gw_rank?.toLocaleString('en-GB')}; overall rank ${r.overall_rank?.toLocaleString('en-GB')}${orMove}. Squad reconstruction ${r.reconcile}.`, '');
  L.push(`The model projected ${r.proj_fielded} for the side fielded, so the result was ${sgn(r.points - r.proj_fielded)} against projection, ${f1(Math.abs(r.z))} standard deviations ${r.z < 0 ? 'below' : 'above'} expectation. That is ${r.verdict}.`, '');
  const a = r.attribution;
  L.push('## Where the points went', '');
  L.push(`Lineup: the best valid XI from the same 15 would have scored ${a.lineup_regret} more before the armband. Captain: ${nm(r.captain.used)} was the armband${r.captain.effective !== r.captain.used ? `, but did not play, so ${nm(r.captain.effective)} took it` : ''}; the best pick in the fielded XI was ${nm(r.captain.hindsight_best)}, a gap of ${a.captain_regret} armband points. Bench left ${a.bench_points} points unused. Transfers returned ${sgn(a.transfers_net)} this gameweek net of hits${r.transfers.length ? ` (${r.transfers.map(t => `${nm(t.out)} to ${nm(t.in)} ${sgn(t.d)}, projected ${sgn(t.pd)}`).join('; ')})` : ' (none made)'}. Starters the model expected to play who got no minutes cost about ${a.minutes_miss_cost} projected points before autosubs.`, '');
  const o = r.overrides;
  if (o.captain || o.transfers) {
    L.push('## Departures from the model', '');
    if (o.captain) L.push(`Armband: the model's last pre-deadline view had ${nm(o.captain.model)}; ${nm(o.captain.used)} was used. Outcome of the departure: ${sgn(o.captain.d)} points.`);
    if (o.transfers) L.push(`Transfers: the model's last view was ${o.transfers.model.map(([x, y]) => `${nm(x)} to ${nm(y)}`).join(', ') || 'roll'}; executed ${o.transfers.used.map(([x, y]) => `${nm(x)} to ${nm(y)}`).join(', ') || 'roll'}. Outcome of the departure this gameweek: ${sgn(o.transfers.d)} points.`);
    L.push('');
  }
  const mv = r.model_view;
  if (mv.recommended_actual != null) L.push(`For reference, the model's final recommended XI would have scored ${mv.recommended_actual} with armband (projected ${mv.recommended_proj}, no autosubs), and the squad with no transfers ${mv.current_actual} (projected ${mv.current_proj}).`, '');
  L.push('## Player audit', '', '| Player | Role | Proj | P(play) | Pts | Mins | Resid | Flags |', '|---|---|---|---|---|---|---|---|');
  for (const p of [...r.players].sort((x, y) => Math.abs(y.resid) - Math.abs(x.resid))) L.push(`| ${p.name} (${p.team} ${p.pos}) | ${p.role} | ${p.proj} | ${p.p_play}% | ${p.pts} | ${p.mins} | ${sgn(p.resid)} | ${p.flags.join(', ')} |`);
  L.push('');
  if (r.leagues.length) {
    L.push('## Leagues', '');
    for (const l of r.leagues) L.push(l.err ? `League ${l.id}: ${l.err}` : `${l.name}: rank ${l.rank} (was ${l.last}), ${l.gw} this gameweek, ${l.gap} behind ${l.leader}. Top score in the league this week: ${l.best} with ${l.bestPts}.`);
    L.push('');
  }
  L.push(`Variance model: residual variance ${r.variance_model.c0} + ${r.variance_model.c1} x projection (${r.variance_model.fitted ? `fitted on ${r.variance_model.n} player-gameweeks` : 'heuristic until 300 player-gameweeks are available'}).`);
  return L.join('\n') + '\n';
}

// ---------- Learning step ----------
const PF = 'model/params.json';
const prev = existsSync(PF) ? rd(PF) : {};
if (todo.length || !existsSync(PF)) {
  const next = learn(rowsFrom(done, pos), prev);
  writeFileSync(PF, JSON.stringify(next, null, 1));
  const v = next.validation;
  const vline = v.ok ? `out-of-sample MAE ${v.mae_base} raw vs ${v.mae_cal} calibrated; minutes Brier ${v.brier_base} vs ${v.brier_cal}` : v.reason;
  const entry = `## params v${next.version}, ${next.updated.slice(0, 10)} (after GW${done.map(s => s.gw).slice(-1)[0] ?? '-'})\n\nValidation over ${v.gws} gameweeks: ${vline}.\n\n${next.changes.length ? next.changes.map(c => `- ${c}`).join('\n') : 'No change adopted.'}\n`;
  const CL = 'model/changelog.md', old = existsSync(CL) ? readFileSync(CL, 'utf8') : '# Model changelog\n\nEvery learnt parameter change, newest first. Changes are adopted only if they beat the current model on gameweeks they were not fitted on, and move at most a fixed step per review.\n\n';
  const [head, ...rest] = old.split(/\n(?=## params)/);
  writeFileSync(CL, [head.trimEnd() + '\n', entry, ...rest].join('\n'));
  console.log(`params v${next.version}: ${next.changes.join('; ') || 'no change'}`);
}

// ---------- Automated findings in lessons.md ----------
const reviews = readdirSync(REV).filter(f => /^gw\d+\.json$/.test(f)).sort().map(f => rd(`${REV}/${f}`));
if (reviews.length) {
  const sum = k => reviews.reduce((a, r) => a + (r.attribution[k] || 0), 0);
  const last4 = reviews.slice(-4), F = [];
  F.push(`Season to date over ${reviews.length} reviewed gameweek(s): lineup regret ${sum('lineup_regret')}, captain regret ${sum('captain_regret')}, bench points unused ${sum('bench_points')}, transfers net ${sgn(sum('transfers_net'))}, minutes-miss cost ${f1(sum('minutes_miss_cost'))}.`);
  const ov = reviews.flatMap(r => [r.overrides.captain, r.overrides.transfers].filter(Boolean));
  if (ov.length) F.push(`Departures from the model: ${ov.length}, net ${sgn(ov.reduce((a, o) => a + o.d, 0))} points. A persistent negative total means judgement overrides are costing points and the bar for overriding should rise; a positive total means the news layer is adding value.`);
  // Recurring minutes misses by club across the last four reviews.
  const mm = {}; last4.forEach(r => r.players.filter(p => p.flags.includes('minutes miss')).forEach(p => { (mm[p.team] = mm[p.team] || new Set()).add(`${p.name} GW${r.gw}`); }));
  Object.entries(mm).filter(([, s]) => s.size >= 2).forEach(([t, s]) => F.push(`Rotation risk at ${t}: ${[...s].join(', ')} got no minutes when the model expected them to play. Discount ${t} starters' minutes or demand a higher margin before buying them.`));
  const capMiss = last4.filter(r => r.attribution.captain_regret >= 6).length;
  if (last4.length >= 3 && capMiss >= 3) F.push(`Armband missed by 6+ points in ${capMiss} of the last ${last4.length} gameweeks. Check whether the captain ranking leans too hard on one premium and weigh fixture-driven alternatives more.`);
  const benchHeavy = last4.filter(r => r.attribution.bench_points >= 10).length;
  if (benchHeavy >= 2) F.push(`10+ points left on the bench in ${benchHeavy} of the last ${last4.length} gameweeks. Bench spend may be too high, or the XI selection is not trusting bench players who are starting.`);
  const blanks = {}; last4.forEach(r => r.players.filter(p => p.flags.includes('blank') && p.role !== 'model buy').forEach(p => blanks[p.name] = (blanks[p.name] || 0) + 1));
  Object.entries(blanks).filter(([, c]) => c >= 3).forEach(([n, c]) => F.push(`${n} blanked (60+ minutes, 2 or fewer points, projected 4.5+) in ${c} of the last ${last4.length} gameweeks. The projection may be living on reputation; check underlying numbers before keeping or captaining.`));
  const pm = existsSync(PF) ? rd(PF) : {};
  F.push(`Calibration in force: ${pm.calib ? Object.entries(pm.calib).map(([t, c]) => `${POSN[t]} a ${c.a} b ${c.b}`).join(', ') : 'none (identity)'}; minutes mapping ${pm.minutes ? 'active' : 'none'}; ep_next blend ${pm.ep_blend ?? 0.2}. ${pm.validation?.ok ? '' : `Learning starts once ${3} gameweeks are reviewed.`}`);
  const LF = 'model/lessons.md';
  const old = existsSync(LF) ? readFileSync(LF, 'utf8') : '';
  const refl = old.includes('## Reflections') ? old.slice(old.indexOf('## Reflections')) : '## Reflections\n\nWritten by the deadline agent after each review, newest first. Each entry names what went wrong in its own judgement, the evidence, and the rule it will apply from now on. Rules here are advisory to the judgement layer; they do not change model code.\n';
  writeFileSync(LF, `# FPL agent lessons\n\nRead before every deadline decision.\n\n## Automated findings\n\nRegenerated after every review from reports/reviews/.\n\n${F.map(x => `- ${x}`).join('\n')}\n\n${refl.trimEnd()}\n`);
}
