// FPL agent model v1.4 (Node 20+). v1.4: top-1000 elite sample, set-piece takers, price tracking. v1.3: armband value with vice cover, autosub bench order, league threats for current squad and plan, projection backtest. Runs on GitHub Actions from public FPL data; no login needed.
// Usage: node fpl.mjs  -> writes reports/latest.txt and reports/latest.json
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
const ENTRY = +(process.env.FPL_ENTRY || 531300);
const LEAGUES = (process.env.FPL_LEAGUES || '54818,392003').split(',').map(Number).filter(Boolean);
const FPLA = (() => {
  const BASE = 'https://fantasy.premierleague.com';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function J(u) {
    const url = u.startsWith('/') ? BASE + u : u;
    for (let a = 0; a < 4; a++) {
      try { const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
        if (r.ok) return await r.json();
        if (r.status === 404) throw new Error(url + ' 404');
        if (a === 3) throw new Error(url + ' ' + r.status);
      } catch (e) { if (a === 3 || String(e).includes(' 404')) throw e; }
      await sleep(1500 * (a + 1));
    }
  }
  // Rebuilds what /api/my-team/ gives a signed-in user, from public endpoints only.
  async function publicTeam(entry, bs, hist) {
    const ev = bs.events, nx = ev.find(e => e.is_next), n = nx.id, cur = (ev.find(e => e.is_current) || {}).id || n - 1;
    const used = hist.chips || [];
    const fhCur = used.some(c => c.name === 'freehit' && c.event === cur);
    const base = await J(`/api/entry/${entry}/event/${fhCur ? cur - 1 : cur}/picks/`);
    const trs = await J(`/api/entry/${entry}/transfers/`);
    let squad = base.picks.map(p => p.element), bank = base.entry_history.bank;
    if (fhCur) { const curP = await J(`/api/entry/${entry}/event/${cur}/picks/`); bank = curP.entry_history.bank; }
    const pend = trs.filter(t => t.event === n);
    for (const t of pend) { squad = squad.map(x => x === t.element_out ? t.element_in : x); bank += t.element_out_cost - t.element_in_cost; }
    const P = {}; bs.elements.forEach(e => P[e.id] = e);
    const fhEvents = new Set(used.filter(c => c.name === 'freehit').map(c => c.event));
    const picks = squad.map(id => {
      const buy = trs.filter(t => t.element_in === id && !fhEvents.has(t.event)).sort((a, b) => new Date(b.time) - new Date(a.time))[0];
      const now = P[id].now_cost, bp = buy ? buy.element_in_cost : now - P[id].cost_change_start;
      return { element: id, selling_price: now > bp ? bp + Math.floor((now - bp) / 2) : now, purchase_price: bp };
    });
    let ft = 1; const cap = 1 + (bs.game_config.rules.max_extra_free_transfers ?? 4);
    for (const h of hist.current) { if (h.event < 2 || h.event > cur) continue;
      const chip = used.find(c => c.event === h.event && (c.name === 'wildcard' || c.name === 'freehit'));
      if (!chip) ft = Math.max(ft - h.event_transfers, 0);
      ft = Math.min(ft + 1, cap); }
    const limit = Math.max(ft - pend.length, 0);
    const chips = (bs.chips || []).filter(c => n >= (c.start_event ?? 1) && n <= (c.stop_event ?? 38)).map(c => ({ name: c.name,
      status_for_entry: used.some(u => u.name === c.name && u.event >= (c.start_event ?? 1) && u.event <= (c.stop_event ?? 38)) ? 'played' : 'available' }));
    return { picks, transfers: { bank, limit, cost: 4, pending: pend.length }, chips };
  }
  const POS = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' }, PK = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const erf = x => { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; };
  const pGE = (mean, thr) => { if (mean <= 0) return 0; const sd = Math.sqrt(2 * mean); return 0.5 * (1 - erf((thr - 0.5 - mean) / (sd * Math.SQRT2))); };
  const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
  const m = x => (x / 10).toFixed(1);
  let OUT = '';

  async function run(o = {}) {
    const t0 = Date.now();
    const entry = o.entry || 531300, H = o.H || 6, leagues = o.leagues || [], eliteN = o.elite ?? 50;
    const [bs, fx, hist, ent] = await Promise.all([J('/api/bootstrap-static/'), J('/api/fixtures/'), J(`/api/entry/${entry}/history/`), J(`/api/entry/${entry}/`)]);
    const mt = await publicTeam(entry, bs, hist);
    const sc = bs.game_config.scoring, ev = bs.events;
    const nx = ev.find(e => e.is_next), n = nx.id, cur = (ev.find(e => e.is_current) || {}).id || n - 1;
    const GWs = []; for (let g = n; g < n + H && g <= 38; g++) GWs.push(g);
    const W = GWs.map((g, i) => Math.pow(0.9, i));
    const T = {}; bs.teams.forEach(t => T[t.id] = t);
    const el = bs.elements, P = {}; el.forEach(e => P[e.id] = e);
    const done = fx.filter(f => f.finished || f.finished_provisional);
    const gp = {}; bs.teams.forEach(t => gp[t.id] = 0); done.forEach(f => { gp[f.team_h]++; gp[f.team_a]++; });

    // Team attack (xG per game) and defence (xGC per game), shrunk and blended with FPL strength ratings
    const tAtt = {}, tDef = {};
    bs.teams.forEach(t => {
      const ps = el.filter(e => e.team === t.id);
      tAtt[t.id] = gp[t.id] ? ps.reduce((s, e) => s + +e.expected_goals, 0) / gp[t.id] : null;
      const gk = ps.filter(e => e.element_type === 1).sort((a, b) => b.minutes - a.minutes)[0];
      tDef[t.id] = gk && gk.minutes > 0 ? +gk.expected_goals_conceded / gk.minutes * 90 : null;
    });
    const avg = a => { const v = Object.values(a).filter(x => x != null); return v.reduce((s, x) => s + x, 0) / v.length; };
    const A = avg(tAtt), D = avg(tDef);
    const sA = id => (T[id].strength_attack_home + T[id].strength_attack_away) / 2, sD = id => (T[id].strength_defence_home + T[id].strength_defence_away) / 2;
    const mSA = bs.teams.reduce((s, t) => s + sA(t.id), 0) / bs.teams.length, mSD = bs.teams.reduce((s, t) => s + sD(t.id), 0) / bs.teams.length;
    const att = {}, def = {};
    const useR = mSA > 0 && mSD > 0 && bs.teams.every(t => sA(t.id) > 0 && sD(t.id) > 0); // FPL publishes 0 ratings some seasons
    bs.teams.forEach(t => {
      const g = gp[t.id], sh = (x, mu) => (g * x + 5 * mu) / (g + 5);
      const oa = sh(tAtt[t.id] ?? A, A), od = sh(tDef[t.id] ?? D, D);
      att[t.id] = useR ? 0.65 * oa + 0.35 * A * sA(t.id) / mSA : oa;
      def[t.id] = useR ? 0.65 * od + 0.35 * D * mSD / sD(t.id) : od;
    });
    const fxBy = {};
    fx.filter(f => f.event && GWs.includes(f.event)).forEach(f => {
      [[f.team_h, f.team_a, 1], [f.team_a, f.team_h, 0]].forEach(([t, op, h]) => { (fxBy[t + '_' + f.event] = fxBy[t + '_' + f.event] || []).push({ o: op, h }); });
    });

    // Set pieces. FPL publishes the taker order per team but not penalties taken, so observed xG already contains
    // whatever penalties a player has taken. The extra value is added only to the prior part of the blend (weight 1 - w),
    // so it matters for players with few minutes and fades as their own xG data grows.
    // If a team's first-choice taker is out (status i/s/u or chance under 50%), the next available taker inherits the role.
    const SP_PEN_XG90 = 0.10;   // about 0.13 penalties per team per match x about 0.78 xG per penalty
    const SP_DFK_XG90 = 0.02, SP_CNR_XA90 = 0.04;
    const avail = e => !['i', 's', 'u', 'n'].includes(e.status) && (e.chance_of_playing_next_round == null || e.chance_of_playing_next_round >= 50);
    const firstTaker = {};
    for (const [key, field] of [['pen', 'penalties_order'], ['dfk', 'direct_freekicks_order'], ['cnr', 'corners_and_indirect_freekicks_order']]) {
      bs.teams.forEach(t => {
        const c = el.filter(e => e.team === t.id && e[field] != null).sort((a, b) => a[field] - b[field]);
        const f = c.find(avail); if (f) firstTaker[key + '_' + t.id] = f.id;
      });
    }
    const takes = (e, key) => firstTaker[key + '_' + e.team] === e.id;
    const prior = { 1: [0, .02], 2: [.04, .05], 3: [.12, .12], 4: [.32, .10] }, thr = { 2: 10, 3: 12, 4: 12 };
    // lastPA: probability the player gets any minutes in this gameweek (set by proj, read by compute).
    let lastPA = 0;
    function proj(e, gw, idx) {
      lastPA = 0;
      const fs = fxBy[e.team + '_' + gw] || []; if (!fs.length || e.removed || e.status === 'u') return 0;
      const t = e.element_type, pk = PK[t], g = Math.max(gp[e.team], 1), mins = e.minutes;
      const mps = e.starts ? clamp(mins / e.starts, 0, 90) : clamp(mins / g, 0, 90);
      let xMin = clamp(mins / g, 0, 90);
      if (e.__recent != null) xMin = 0.45 * xMin + 0.55 * e.__recent;
      const c = e.chance_of_playing_next_round;
      let av = 1;
      if (c != null) av = idx === 0 ? c / 100 : (c === 0 ? (idx === 1 ? 0.3 : 0.75) : Math.min(1, c / 100 + 0.2 * idx));
      xMin *= av;
      const share = clamp(xMin / Math.max(mps, 30), 0, 1);
      const p60 = share * clamp((mps - 30) / 45, 0, 1);
      const papp = xMin > 0 ? clamp(share * 1.05 + 0.05, 0, 1) : 0;
      lastPA = c != null ? Math.min(papp, av) : papp; // FPL's chance-of-playing is the probability of any minutes
      const w = mins / (mins + 400), cst = e.now_cost / 10, pr = { 1: [0, .02], 2: [Math.max(.02, .01 * cst - .01), Math.max(.03, .015 * cst - .03)], 3: [Math.max(.05, .04 * cst - .12), Math.max(.06, .03 * cst - .05)], 4: [Math.max(.15, .06 * cst - .1), .012 * cst] }[t];
      // A player who has only inherited the penalty role (listed below first) has no penalties in his own xG, so he gets
      // the full penalty value rather than the prior share.
      const penInh = takes(e, 'pen') && e.penalties_order !== 1;
      const spG = (takes(e, 'pen') && !penInh ? SP_PEN_XG90 : 0) + (takes(e, 'dfk') ? SP_DFK_XG90 : 0), spA = takes(e, 'cnr') ? SP_CNR_XA90 : 0;
      const xg90 = w * +e.expected_goals_per_90 + (1 - w) * (pr[0] + spG) + (penInh ? SP_PEN_XG90 : 0);
      const xa90 = w * +e.expected_assists_per_90 + (1 - w) * (pr[1] + spA);
      const b90 = w * (mins ? e.bonus / mins * 90 : 0) + (1 - w) * 0.12;
      const y90 = mins ? e.yellow_cards / mins * 90 : 0.08;
      const sv90 = w * +e.saves_per_90 + (1 - w) * 2.6;
      const dc90 = +e.defensive_contribution_per_90 || 0;
      let pts = 0; const ppg = +e.points_per_game || 0, wp = 0.3 * w;
      for (const f of fs) { let fp = 0;
        const hf = f.h ? 1.08 : 0.92;
        const lamF = att[e.team] * (def[f.o] / D) * hf, fac = lamF / att[e.team];
        const lamA = att[f.o] * (def[e.team] / D) * (2 - hf);
        fp += papp * sc.short_play + p60 * (sc.long_play - sc.short_play);
        fp += xg90 * xMin / 90 * fac * sc.goals_scored[pk] + xa90 * xMin / 90 * fac * sc.assists;
        fp += Math.exp(-lamA) * p60 * sc.clean_sheets[pk];
        if (t <= 2) fp += sc.goals_conceded[pk] * p60 * (lamA / 2 - 0.25 * (1 - Math.exp(-2 * lamA)));
        if (t === 1) fp += sv90 / 3 * xMin / 90 * (lamA / A) * sc.saves;
        if (t > 1) fp += p60 * pGE(dc90 * mps / 90, thr[t]) * sc.defensive_contribution[pk];
        fp += b90 * xMin / 90 * (0.7 + 0.3 * fac) - y90 * xMin / 90;
        pts += (1 - wp) * fp + wp * ppg * share * (t > 2 ? fac : 0.5 + 0.5 * Math.exp(-lamA) / Math.exp(-D));
      }
      if (idx === 0) pts = 0.8 * pts + 0.2 * (+e.ep_next || 0);
      return pts;
    }
    let EP = {}, PA = {};
    const compute = () => { EP = {}; PA = {}; el.forEach(e => { EP[e.id] = []; PA[e.id] = []; GWs.forEach((g, i) => { EP[e.id].push(proj(e, g, i)); PA[e.id].push(lastPA); }); }); };
    const HV = id => EP[id].reduce((s, v, i) => s + W[i] * v, 0);
    compute();

    const squad = mt.picks.map(p => p.element), sell = {}; mt.picks.forEach(p => sell[p.element] = p.selling_price);
    const bank = mt.transfers.bank, FT = mt.transfers.limit, hitCost = mt.transfers.cost || 4;
    const pickCands = () => { const c = {}; [1, 2, 3, 4].forEach(t => {
      const pool = el.filter(e => e.element_type === t && e.can_select !== false && e.status !== 'u' && !e.removed);
      const top = [...pool].sort((a, b) => HV(b.id) - HV(a.id)).slice(0, t === 1 ? 10 : 30);
      const val = [...pool].sort((a, b) => HV(b.id) / b.now_cost - HV(a.id) / a.now_cost).slice(0, t === 1 ? 5 : 15);
      c[t] = [...new Map([...top, ...val].map(e => [e.id, e])).values()];
    }); return c; };
    let cand = pickCands();

    // Recent minutes from element-summary for squad + candidates, then recompute
    const need = [...new Set([...squad, ...Object.values(cand).flat().map(e => e.id)])];
    for (let i = 0; i < need.length; i += 12) {
      await Promise.all(need.slice(i, i + 12).map(async id => {
        try { const s = await J(`/api/element-summary/${id}/`); const h = s.history || []; const rounds = [...new Set(h.map(x => x.round))].slice(-3);
          if (rounds.length) P[id].__recent = h.filter(x => rounds.includes(x.round)).reduce((a, x) => a + x.minutes, 0) / rounds.length; } catch (x) { }
      }));
    }
    compute(); cand = pickCands();

    function xi(ids, k) {
      const by = { 1: [], 2: [], 3: [], 4: [] };
      ids.forEach(id => { const pa = PA[id][k]; by[P[id].element_type].push({ id, t: P[id].element_type, v: EP[id][k], pa, cond: pa > 0.05 ? EP[id][k] / pa : 0 }); });
      Object.values(by).forEach(a => a.sort((x, y) => y.v - x.v));
      const sel = [by[1][0], ...by[2].slice(0, 3), ...by[3].slice(0, 2), by[4][0]].filter(Boolean);
      const cnt = { 2: 3, 3: 2, 4: 1 }, mx = { 2: 5, 3: 5, 4: 3 };
      for (const p of [...by[2].slice(3), ...by[3].slice(2), ...by[4].slice(1)].sort((x, y) => y.v - x.v)) { if (sel.length >= 11) break; if (cnt[p.t] < mx[p.t]) { sel.push(p); cnt[p.t]++; } }
      // Armband value: if the captain gets no minutes, the vice-captain's points are doubled instead.
      // Expected armband points = EP(c) + (1 - P(c plays)) * EP(vc), with EP already weighted by availability.
      const capOpts = sel.map(c => { const vc = sel.filter(p => p !== c).sort((a, b) => b.v - a.v)[0]; return { c, vc, val: c.v + (1 - c.pa) * (vc ? vc.v : 0) }; }).sort((a, b) => b.val - a.val);
      const top = capOpts[0];
      // Autosubs only use a bench player who actually plays, so order the outfield bench by points if he plays.
      const bench = [by[1][1], ...[...by[2], ...by[3], ...by[4]].filter(p => !sel.includes(p)).sort((a, b) => b.cond - a.cond || b.v - a.v)].filter(Boolean);
      return { sel, c: top.c, vc: top.vc, capVal: top.val, capOpts, score: sel.reduce((s, p) => s + p.v, 0) + top.val, bench, benchSum: bench.reduce((s, p) => s + p.v, 0) };
    }
    const sqVal = (ids, wts = W) => GWs.reduce((s, g, k) => { if (!wts[k]) return s; const r = xi(ids, k); return s + wts[k] * (r.score + 0.1 * r.benchSum); }, 0);
    const teamCount = ids => { const c = {}; ids.forEach(id => c[P[id].team] = (c[P[id].team] || 0) + 1); return c; };
    function expand(st) {
      const res = [], tc = teamCount(st.ids);
      for (const out of st.ids) {
        if (st.ins.includes(out)) continue;
        const pe = P[out], sp = sell[out] ?? pe.now_cost;
        for (const c of cand[pe.element_type]) {
          if (st.ids.includes(c.id) || st.outs.includes(c.id) || c.now_cost > st.bank + sp) continue;
          if (c.team !== pe.team && (tc[c.team] || 0) >= 3) continue;
          res.push({ ids: st.ids.map(x => x === out ? c.id : x), bank: st.bank + sp - c.now_cost, outs: [...st.outs, out], ins: [...st.ins, c.id] });
        }
      }
      return res;
    }
    function beam(maxD, B, wts = W) {
      const best = []; let lvl = [{ ids: squad, bank, outs: [], ins: [], v: sqVal(squad, wts) }]; best[0] = lvl[0];
      for (let d = 1; d <= maxD; d++) {
        const seen = new Map();
        for (const st of lvl) for (const nx of expand(st)) { const key = [...nx.ids].sort().join(','); if (!seen.has(key)) { nx.v = sqVal(nx.ids, wts); seen.set(key, nx); } }
        lvl = [...seen.values()].sort((a, b) => b.v - a.v).slice(0, B);
        if (!lvl.length) break; best[d] = lvl[0]; best[d].alts = lvl.slice(1, 4);
      }
      return best;
    }
    const carryVal = [0, 1.5, 2.5, 3.2, 3.7, 3.7];
    const net = (st, d) => { const carry = FT - d; const nextFT = Math.min(5, Math.max(carry, 0) + 1); const wasted = Math.max(0, (Math.max(carry, 0) + 1) - 5);
      return st.v - hitCost * Math.max(0, d - FT) + carryVal[Math.min(Math.max(carry, 0), 5)] - 2 * wasted; };
    const plans = beam(Math.min(FT + 2, 6), 12);
    const scored = plans.map((st, d) => st ? { d, st, net: net(st, d) } : null).filter(Boolean).sort((a, b) => b.net - a.net);
    const bestPlan = scored[0];

    // Chips
    const wc = beam(15, 5), wcBest = wc.filter(Boolean).reduce((a, b) => b.v > a.v ? b : a);
    const fhW = W.map((x, i) => i === 0 ? 1 : 0), fh = beam(15, 5, fhW), fhBest = fh.filter(Boolean).reduce((a, b) => b.v > a.v ? b : a);
    const chips = mt.chips.filter(c => c.status_for_entry === 'available').map(c => c.name);

    // Ownership: leagues and elite
    async function standings(id, pages = 1) { const r = []; let meta = null; for (let p = 1; p <= pages; p++) { const d = await J(`/api/leagues-classic/${id}/standings/?page_standings=${p}`); meta = d.league; r.push(...d.standings.results); if (!d.standings.has_next) break; } return { meta, r }; }
    async function picksOf(ids) { const out = {}; for (let i = 0; i < ids.length; i += 10) await Promise.all(ids.slice(i, i + 10).map(async e => { try { out[e] = await J(`/api/entry/${e}/event/${cur}/picks/`); } catch (x) { } })); return out; }
    const eo = pk => { const c = {}, N = Object.keys(pk).length || 1; Object.values(pk).forEach(p => p.picks.forEach(x => { c[x.element] = (c[x.element] || 0) + (x.multiplier || 0); })); Object.keys(c).forEach(k => c[k] /= N); return c; };
    const L = [];
    for (const id of leagues) {
      try {
        const s = await standings(id, 2); const me = s.r.find(x => x.entry === entry);
        const pk = await picksOf(s.r.map(x => x.entry));
        const capt = {}; Object.values(pk).forEach(p => { const c = p.picks.find(x => x.is_captain); if (c) capt[c.element] = (capt[c.element] || 0) + 1; });
        L.push({ id, name: s.meta.name, n: s.r.length, me, leader: s.r[0], eo: eo(pk), capt });
      } catch (x) { L.push({ id, err: String(x) }); }
    }
    // Elite effective ownership from the top eliteN managers overall (league 314). Failed fetches are skipped, and the
    // report states how many managers were actually sampled.
    let EE = {}, EEn = 0, EEerr = '';
    try { const s = await standings(314, Math.ceil(eliteN / 50)); const pk = await picksOf(s.r.slice(0, eliteN).map(x => x.entry)); EEn = Object.keys(pk).length; EE = eo(pk); } catch (x) { EEerr = String(x); }

    // Report
    const nm = id => P[id].web_name, tm = id => T[P[id].team].short_name;
    const fixStr = id => GWs.slice(0, 4).map(g => (fxBy[P[id].team + '_' + g] || []).map(f => T[f.o].short_name + (f.h ? 'H' : 'a')).join('+') || '-').join(' ');
    const now = xi(squad, 0);
    const lines = [];
    lines.push(`Generated ${new Date().toISOString()} | ${ent.name} | overall rank ${ent.summary_overall_rank} | ${ent.summary_overall_points} pts`);
    lines.push(`GW${n} deadline ${nx.deadline_time} | FT ${FT} (reconstructed; pending transfers already made: ${mt.transfers.pending}) bank ${m(bank)} hit ${hitCost} | chips ${chips.join(',') || 'none'} | horizon GW${GWs[0]}-${GWs[GWs.length - 1]}`);
    lines.push('SQUAD (GW pts proj next | 6GW wtd | eliteEO | fixtures):');
    [...squad].sort((a, b) => HV(b) - HV(a)).forEach(id => lines.push(`${POS[P[id].element_type]} ${nm(id)} ${tm(id)} ${m(P[id].now_cost)}/${m(sell[id])} ${P[id].status}${P[id].chance_of_playing_next_round ?? ''} | ${f1(EP[id][0])} | ${f1(HV(id))} | ${Math.round((EE[id] || 0) * 100)}% | ${fixStr(id)}`));
    const desc = st => st.outs.map((o, i) => `${nm(o)}(${m(sell[o])})->${nm(st.ins[i])}(${m(P[st.ins[i]].now_cost)} eEO${Math.round((EE[st.ins[i]] || 0) * 100)}%)`).join(', ') || 'roll';
    lines.push('PLANS by net value (squad 6GW wtd value, less hits, plus value of banked FT):');
    scored.slice(0, 5).forEach(s => lines.push(`${s.d}T net ${f1(s.net)} (val ${f1(s.st.v)}) bank ${m(s.st.bank)}: ${desc(s.st)}`));
    const bp = bestPlan.st, r0 = xi(bp.ids, 0);
    lines.push(`BEST PLAN XI GW${n}: ` + r0.sel.map(p => `${nm(p.id)} ${f1(p.v)}`).join(', '));
    const pct = x => Math.round(x * 100) + '%';
    lines.push(`C ${nm(r0.c.id)} armband ${f1(r0.capVal)} | VC ${nm(r0.vc.id)} ${f1(r0.vc.v)} | bench (autosub order) ${r0.bench.map(p => nm(p.id) + ' ' + f1(p.v) + ' (if plays ' + f1(p.cond) + ')').join(', ')}`);
    lines.push(`Current squad GW${n} XI proj ${f1(now.score)} (C ${nm(now.c.id)}, VC ${nm(now.vc.id)}) vs best plan ${f1(r0.score)}`);
    const capOpts = r0.capOpts.slice(0, 4).map(o => `${nm(o.c.id)} ${f1(o.val)} (proj ${f1(o.c.v)}, plays ${pct(o.c.pa)}, vice ${nm(o.vc.id)}) eEO${pct(EE[o.c.id] || 0)}`);
    lines.push('Captain options by armband value (projection plus vice cover if he does not play): ' + capOpts.join(', '));
    lines.push('Current-squad captain options (if no transfers): ' + now.capOpts.slice(0, 3).map(o => `${nm(o.c.id)} ${f1(o.val)} (proj ${f1(o.c.v)}, plays ${pct(o.c.pa)}, vice ${nm(o.vc.id)})`).join(', '));
    lines.push(`CHIPS: TC gain GW${n} ~${f1(r0.capVal)}; BB gain GW${n} ~${f1(r0.benchSum)}; WC 6GW gain vs best plan ${f1(wcBest.v - bp.v)}; FH GW${n} gain ${f1(fhBest.v - sqVal(bp.ids, fhW))}`);
    const tcBest = GWs.map((g, k) => ({ g, v: xi(bp.ids, k).capVal })).sort((a, b) => b.v - a.v)[0], bbBest = GWs.map((g, k) => ({ g, v: xi(bp.ids, k).benchSum })).sort((a, b) => b.v - a.v)[0];
    lines.push(`Best TC GW in horizon: GW${tcBest.g} ${f1(tcBest.v)}; best BB GW: GW${bbBest.g} ${f1(bbBest.v)}; DGW/BGW: ${GWs.map(g => { const c = bs.teams.map(t => (fxBy[t.id + '_' + g] || []).length); return `GW${g} dbl${c.filter(x => x > 1).length}/blank${c.filter(x => x === 0).length}`; }).join(' ')}`);
    for (const l of L) {
      if (l.err) { lines.push(`LEAGUE ${l.id} error ${l.err}`); continue; }
      lines.push(`LEAGUE ${l.name} (${l.id}): rank ${l.me?.rank}/${l.n}, ${l.me?.total} pts; leader ${l.leader.entry_name} ${l.leader.total} (gap ${l.leader.total - (l.me?.total || 0)})`);
      // l.eo is league effective ownership (includes captaincy), so can exceed 100%.
      const threatsVs = ids => { const s = new Set(ids); return Object.entries(l.eo).filter(([id]) => !s.has(+id) && P[id]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, v]) => `${nm(id)} EO${Math.round(v * 100)}% proj${f1(EP[id][0])}`); };
      const sells = bp.outs.map(id => `${nm(id)} EO${Math.round((l.eo[id] || 0) * 100)}%`);
      const buys = bp.ins.map(id => `${nm(id)} EO${Math.round((l.eo[id] || 0) * 100)}%`);
      const diffs = bp.ids.filter(id => (l.eo[id] || 0) < 0.15).map(id => `${nm(id)} EO${Math.round((l.eo[id] || 0) * 100)}%`);
      const cap = Object.entries(l.capt).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, c]) => `${nm(id)} ${c}`);
      lines.push(` threats not owned (current squad): ${threatsVs(squad).join(', ') || 'none'}`);
      lines.push(` threats not owned (after best plan): ${threatsVs(bp.ids).join(', ') || 'none'} | plan sells: ${sells.join(', ') || 'nothing'} | plan buys: ${buys.join(', ') || 'nothing'}`);
      lines.push(` differentials after best plan (league EO under 15%): ${diffs.join(', ') || 'none'} | rival captains: ${cap.join(', ')}`);
    }
    const eliteThreats = Object.entries(EE).filter(([id]) => !bp.ids.includes(+id) && P[id]).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, v]) => `${nm(id)} ${tm(id)} eEO${Math.round(v * 100)}% proj${f1(EP[id][0])}`);
    lines.push(`ELITE threats not owned after best plan (overall-rank risk): ${eliteThreats.join(', ') || 'none'}`);
    const spList = id => ['pen', 'dfk', 'cnr'].filter(k => takes(P[id], k)).map(k => k === 'pen' ? (P[id].penalties_order === 1 ? 'pens' : 'pens (inherited)') : k === 'dfk' ? 'direct FKs' : 'corners').join('+');
    const spSquad = [...new Set([...squad, ...bp.ids])].filter(id => spList(id)).map(id => `${nm(id)} ${spList(id)}`);
    lines.push(`SET PIECES (first available taker per FPL order) in squad or plan: ${spSquad.join(', ') || 'none'}`);
    const inh = bs.teams.map(t => firstTaker['pen_' + t.id]).filter(id => id && P[id].penalties_order !== 1).map(id => `${nm(id)} ${tm(id)}`);
    if (inh.length) lines.push(`Penalty role inherited because the listed taker is unavailable: ${inh.join(', ')}`);
    lines.push(`Elite sample: top ${eliteN} overall requested, ${EEn} sampled${EEerr ? ' (error: ' + EEerr + ')' : ''}. Model runtime ${Math.round((Date.now() - t0) / 1000)}s.`);
    OUT = lines.join('\n');
    globalThis.__FPLA_STATE = { ent, mt, EP, PA, P, GWs, bestPlan, plans, wcBest, fhBest, L, EE, bs, n, deadline: nx.deadline_time, r0, now, squad, EEn };
    return `done ${OUT.length} chars, ${Math.ceil(OUT.length / 900)} chunks`;
  }
  return { run, J, out: i => OUT.slice(i * 900, (i + 1) * 900), all: () => OUT, append: s => { OUT += '\n' + s; } };
})();

const res = await FPLA.run({ entry: ENTRY, leagues: LEAGUES, elite: +(process.env.FPL_ELITE || 1000) });
const st = globalThis.__FPLA_STATE, P = st.P, nm = id => P[id].web_name;
const bp = st.bestPlan;
const r2 = x => +x.toFixed(2);
const json = { generated: new Date().toISOString(), entry: ENTRY, gws: st.GWs, transfers: st.mt.transfers, chips: st.mt.chips,
  squad: st.mt.picks.map(p => ({ id: p.element, name: nm(p.element), sell: p.selling_price / 10, proj: st.EP[p.element].map(r2), p_play: st.PA[p.element].map(r2) })),
  best_plan: { n_transfers: bp.d, net: r2(bp.net), out: bp.st.outs.map(nm), in: bp.st.ins.map(nm), bank: bp.st.bank / 10,
    captain: nm(st.r0.c.id), vice: nm(st.r0.vc.id), armband_value: r2(st.r0.capVal) } };
mkdirSync('reports/history', { recursive: true });

// Backtest step 1: snapshot this gameweek's projections. Each run overwrites the file until the deadline passes,
// so the file left behind is the last projection made before the deadline.
const HIST = 'reports/history';
const snap = { gw: st.n, deadline: st.deadline, generated: json.generated, proj: {},
  recommended: { xi: st.r0.sel.map(p => p.id), captain: st.r0.c.id, vice: st.r0.vc.id, armband_value: r2(st.r0.capVal), xi_proj: r2(st.r0.score), n_transfers: bp.d, in: bp.st.ins, out: bp.st.outs },
  current: { xi: st.now.sel.map(p => p.id), captain: st.now.c.id, vice: st.now.vc.id, armband_value: r2(st.now.capVal), xi_proj: r2(st.now.score) } };
for (const id in st.EP) if (st.EP[id][0] > 0) snap.proj[id] = [r2(st.EP[id][0]), r2(st.PA[id][0])];
writeFileSync(`${HIST}/gw${String(st.n).padStart(2, '0')}.json`, JSON.stringify(snap));

// Backtest step 2: for every finished, data-checked gameweek with a snapshot, compare projections with actual points.
const bt = { gws: [], players: [], xi: [] };
try {
  const evs = Object.fromEntries(st.bs.events.map(e => [e.id, e]));
  for (const f of readdirSync(HIST).filter(f => /^gw\d+\.json$/.test(f)).sort()) {
    const s = JSON.parse(readFileSync(`${HIST}/${f}`, 'utf8'));
    const e = evs[s.gw]; if (!e || !e.finished || !e.data_checked) continue;
    if (!s.actual) {
      const live = await FPLA.J(`/api/event/${s.gw}/live/`);
      s.actual = {}; for (const x of live.elements) s.actual[x.id] = [x.stats.total_points, x.stats.minutes];
      writeFileSync(`${HIST}/${f}`, JSON.stringify(s));
    }
    bt.gws.push(s.gw);
    for (const id in s.proj) bt.players.push([s.proj[id][0], (s.actual[id] || [0])[0]]);
    const act = id => (s.actual[id] || [0, 0]);
    for (const k of ['recommended', 'current']) {
      const r = s[k], cap = act(r.captain)[1] > 0 ? r.captain : r.vice;
      bt.xi.push({ gw: s.gw, kind: k, proj: r.xi_proj, actual: r.xi.reduce((a, id) => a + act(id)[0], 0) + act(cap)[0], armband_proj: r.armband_value, armband_actual: act(cap)[0] });
    }
  }
} catch (x) { bt.error = String(x); }
const lines = [];
if (bt.error) lines.push(`BACKTEST error: ${bt.error}`);
else if (!bt.gws.length) lines.push(`BACKTEST: no finished gameweek with a stored projection yet (first snapshot: GW${st.n}; results once it is finished and data-checked).`);
else {
  const sel = bt.players.filter(([p]) => p >= 0.5), N = sel.length;
  const mp = sel.reduce((a, [p]) => a + p, 0) / N, ma = sel.reduce((a, [, y]) => a + y, 0) / N;
  const mae = sel.reduce((a, [p, y]) => a + Math.abs(p - y), 0) / N;
  const sxx = sel.reduce((a, [p]) => a + (p - mp) ** 2, 0), sxy = sel.reduce((a, [p, y]) => a + (p - mp) * (y - ma), 0);
  const slope = sxx > 0 ? sxy / sxx : NaN;
  const bins = [[0.5, 2], [2, 4], [4, 6], [6, 99]].map(([lo, hi]) => { const b = sel.filter(([p]) => p >= lo && p < hi); const n = b.length;
    return `${lo}-${hi === 99 ? '+' : hi}: n${n} proj ${n ? (b.reduce((a, [p]) => a + p, 0) / n).toFixed(2) : '-'} actual ${n ? (b.reduce((a, [, y]) => a + y, 0) / n).toFixed(2) : '-'}`; });
  lines.push(`BACKTEST GW${bt.gws.join(',')} | players projected 0.5+: n${N}, mean proj ${mp.toFixed(2)} vs actual ${ma.toFixed(2)}, MAE ${mae.toFixed(2)}, slope ${slope.toFixed(2)} (above 1 means projections too compressed, below 1 too spread)`);
  lines.push(` calibration by projection band: ${bins.join(' | ')}`);
  for (const k of ['recommended', 'current']) { const r = bt.xi.filter(x => x.kind === k); if (!r.length) continue;
    const sum = f => r.reduce((a, x) => a + x[f], 0);
    lines.push(` ${k} XI incl. armband: proj ${sum('proj').toFixed(1)} vs actual ${sum('actual')} over ${r.length} GW; armband proj ${sum('armband_proj').toFixed(1)} vs actual ${sum('armband_actual')}`); }
}
// Price changes. FPL's price algorithm is not public, so this is measurement, not a prediction model.
// Each run stores every player's price and cumulative transfers. A player's "pressure" is net transfers since his last
// observed price change, as a share of his current owners. When a price change is observed between two runs, the
// pressure at the earlier run is logged as a calibration sample, so the thresholds are learnt from this season's data.
try {
  const PF = 'reports/prices.json';
  let ps = { players: {}, samples: [] }; try { ps = JSON.parse(readFileSync(PF, 'utf8')); } catch (x) { }
  const bs = st.bs, total = bs.total_players || 1, now = new Date().toISOString();
  const owners = e => Math.max(1, +e.selected_by_percent / 100 * total);
  const cumNet = e => e.transfers_in - e.transfers_out;
  const prevRun = ps.run || null, seen = [];
  const pr = {};
  for (const e of bs.elements) {
    const o = ps.players[e.id];
    // [cost, cumulative net transfers, anchor = cumulative net at last observed change, pressure at this run]
    let anchor;
    if (!o) anchor = cumNet(e) - (e.transfers_in_event - e.transfers_out_event); // first sight: start from this gameweek
    else if (o[0] !== e.now_cost) {
      const dir = e.now_cost > o[0] ? 'rise' : 'fall';
      seen.push({ id: e.id, dir, from: o[0], to: e.now_cost });
      ps.samples.push({ t: now, prev: prevRun, id: e.id, dir, pressure: o[3], owners: Math.round(owners(e)) });
      anchor = cumNet(e);
    } else anchor = o[2];
    const p = (cumNet(e) - anchor) / owners(e);
    ps.players[e.id] = [e.now_cost, cumNet(e), anchor, +p.toFixed(5)];
    pr[e.id] = p;
  }
  ps.samples = ps.samples.slice(-2000); ps.run = now;
  writeFileSync(PF, JSON.stringify(ps));
  const pc = x => (x * 100).toFixed(1) + '%';
  const nmT = id => `${nm(id)}`;
  const out = [];
  out.push(`PRICES (pressure = net transfers since last observed change / owners; heuristic, FPL's algorithm is not public)`);
  if (prevRun) out.push(` changes since previous run (${prevRun.slice(0, 16)}Z): ${seen.length ? seen.length + ' players; ' : 'none'}${seen.filter(s => st.squad.includes(s.id) || bp.st.ins.includes(s.id)).map(s => `${nmT(s.id)} ${s.dir} ${(s.from / 10).toFixed(1)}->${(s.to / 10).toFixed(1)}`).join(', ')}`);
  else out.push(' first run of price tracking; changes are detected from the next run onwards');
  const watch = [...new Set([...st.squad, ...bp.st.ins])];
  out.push(` squad and plan: ${watch.sort((a, b) => Math.abs(pr[b]) - Math.abs(pr[a])).map(id => `${nmT(id)}${st.squad.includes(id) ? '' : '*'} ${pr[id] >= 0 ? '+' : ''}${pc(pr[id])}`).join(', ')} (* = plan buy)`);
  const live = bs.elements.filter(e => e.status !== 'u' && +e.selected_by_percent >= 0.5);
  out.push(` strongest rise pressure (owned 0.5%+): ${[...live].sort((a, b) => pr[b.id] - pr[a.id]).slice(0, 6).map(e => `${e.web_name} +${pc(pr[e.id])}`).join(', ')}`);
  out.push(` strongest fall pressure (owned 0.5%+): ${[...live].sort((a, b) => pr[a.id] - pr[b.id]).slice(0, 6).map(e => `${e.web_name} ${pc(pr[e.id])}`).join(', ')}`);
  const cal = d => { const v = ps.samples.filter(s => s.dir === d && s.pressure != null).map(s => Math.abs(s.pressure)).sort((a, b) => a - b); return v.length ? `${d}s n${v.length}, pressure at previous run: 25th pct ${pc(v[Math.floor(v.length * .25)])}, median ${pc(v[Math.floor(v.length * .5)])}` : `${d}s n0`; };
  out.push(` calibration from observed changes (pressure measured at the run before the change): ${cal('rise')} | ${cal('fall')}${ps.samples.length < 20 ? ' (too few samples to rely on yet)' : ''}`);
  FPLA.append(out.join('\n'));
} catch (x) { FPLA.append(`PRICES error: ${x}`); }
FPLA.append(lines.join('\n'));
writeFileSync('reports/backtest.json', JSON.stringify(bt.gws.length ? { gws: bt.gws, xi: bt.xi, n_players: bt.players.length } : { gws: [], note: lines[0] }, null, 1));
writeFileSync('reports/latest.txt', FPLA.all() + '\n');
writeFileSync('reports/latest.json', JSON.stringify(json, null, 1));
console.log(res + '\n' + FPLA.all());
