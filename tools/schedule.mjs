// Writes reports/schedule.json: the moments in the current gameweek cycle when the deadline agent has useful work.
// Public FPL data only. The agent reads this at the end of each run and books its next run at the first pending wake,
// so it does not run on days when there is nothing to do (mid-gameweek, or long gaps such as international breaks).
//
// Wakes (UTC):
//   review  last kick-off of the gameweek in play + 16h (data check usually lands overnight); repeats every 8h until
//           reports/reviews/gwNN.md exists, the agent handles the retry.
//   draft   next deadline - 26h (inside the 16 to 40h draft window, after the morning or afternoon model run,
//           and before the overnight price change).
//   final   next deadline - 4h (after the last model run, with press-conference news in).
//   backup  next deadline - 1h45 (acts only if the final execution is not verified on FPL).
import { writeFileSync, existsSync } from 'node:fs';

const BASE = 'https://fantasy.premierleague.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function J(u) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(BASE + u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (r.ok) return await r.json(); if (a === 3) throw new Error(u + ' ' + r.status);
    } catch (e) { if (a === 3) throw e; }
    await sleep(1500 * (a + 1));
  }
}
const H = 3600e3, pad = g => String(g).padStart(2, '0');
const iso = t => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const whk = t => new Date(t + 2 * H).toISOString().slice(0, 16).replace('T', ' ') + ' Windhoek';

const [bs, fx] = await Promise.all([J('/api/bootstrap-static/'), J('/api/fixtures/')]);
const now = Date.now();
const started = bs.events.filter(e => Date.parse(e.deadline_time) <= now);
const cur = started[started.length - 1] || null;
const nxt = bs.events.find(e => Date.parse(e.deadline_time) > now) || null;

const lastKick = id => {
  const k = fx.filter(f => f.event === id && f.kickoff_time).map(f => Date.parse(f.kickoff_time));
  return k.length ? Math.max(...k) : null;
};

const wakes = [];
const add = (t, purpose, gw) => wakes.push({ at: iso(t), windhoek: whk(t), purpose, gw });

let curInfo = null;
if (cur) {
  const lk = lastKick(cur.id), reviewed = existsSync(`reports/reviews/gw${pad(cur.id)}.md`);
  curInfo = { gw: cur.id, deadline: cur.deadline_time, last_kickoff: lk ? iso(lk) : null,
    finished: !!cur.finished, data_checked: !!cur.data_checked, review_exists: reviewed };
  if (!reviewed && lk) add(Math.max(lk + 16 * H, now), 'review', cur.id);
}
let nxtInfo = null;
if (nxt) {
  const D = Date.parse(nxt.deadline_time), lk = lastKick(nxt.id);
  nxtInfo = { gw: nxt.id, deadline: nxt.deadline_time, deadline_windhoek: whk(D), last_kickoff: lk ? iso(lk) : null };
  if (D - 26 * H > now) add(D - 26 * H, 'draft', nxt.id);
  if (D - 4 * H > now) add(D - 4 * H, 'final', nxt.id);
  if (D - 1.75 * H > now) add(D - 1.75 * H, 'backup', nxt.id);
  // The review of the gameweek after the next deadline, so the chain never runs dry after a deadline.
  if (lk) add(lk + 16 * H, 'review', nxt.id);
}
wakes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

writeFileSync('reports/schedule.json', JSON.stringify({ generated: iso(now), current: curInfo, next: nxtInfo, wakes }, null, 1) + '\n');
console.log(wakes.map(w => `${w.purpose} GW${w.gw} ${w.windhoek}`).join('\n'));
