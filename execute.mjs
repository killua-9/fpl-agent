// FPL executor (Node 20+). Applies a decision file (decisions/gwNN.json) to Hold My Tzoli:
// transfers, then starting XI, bench order, captain and vice-captain. Never plays a chip.
//
// Usage:
//   node execute.mjs decisions/gw08.json            dry run: validates and prints, changes nothing
//   node execute.mjs decisions/gw08.json --apply    makes the changes, if the file also says "apply": true
//   node execute.mjs --check                        signs in and confirms the account (keeps the token alive)
//
// Sign-in: OAuth refresh token from FPL_TOKEN_FILE (latest, rotated) or the FPL_REFRESH_TOKEN secret.
// FPL rotates the refresh token on every use, so the new one is written back to FPL_TOKEN_FILE
// straight away; the workflow carries that file to the next run in an encrypted cache.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const RULES = {
  maxHits: 1,               // hard ceiling, whatever the decision file says
  maxTransfers: 5,
  deadlineBufferMin: 10,    // refuse to start this close to the deadline
  minChanceIncoming: 75,    // incoming players must be flagged available or at least this chance
  squadCounts: { 1: 2, 2: 5, 3: 5, 4: 3 },
  xiMin: { 1: 1, 2: 3, 3: 2, 4: 1 }, xiMax: { 1: 1, 2: 5, 3: 5, 4: 3 },
  maxPerClub: 3,
};
const POS = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const AUTHORITY = 'https://account.premierleague.com/as';
const CLIENT_ID = 'bfcbaf69-aade-4c1b-8f00-c1cb8a193030';
const SITE = 'https://fantasy.premierleague.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s).normalize('NFC').trim().toLowerCase();

// ---------- pure logic (unit-tested in test-execute.mjs) ----------

// A player reference is an element id, "Name", or "Name|TEAM" (team short name, e.g. "Mbeumo|MUN").
export function resolve(ref, bs, preferIds = new Set()) {
  if (typeof ref === 'number') {
    const e = bs.elements.find((x) => x.id === ref);
    if (!e) throw new Error(`No player with id ${ref}`);
    return e;
  }
  const [name, team] = String(ref).split('|');
  const teamId = team ? bs.teams.find((t) => norm(t.short_name) === norm(team))?.id : null;
  if (team && !teamId) throw new Error(`Unknown team "${team}" in "${ref}"`);
  let hits = bs.elements.filter((e) => norm(e.web_name) === norm(name) && (!teamId || e.team === teamId));
  if (hits.length > 1) {
    const owned = hits.filter((e) => preferIds.has(e.id));
    if (owned.length === 1) hits = owned;
  }
  if (hits.length !== 1) {
    throw new Error(`"${ref}" matches ${hits.length} players; use "Name|TEAM" or an id`);
  }
  return hits[0];
}

export function nextEvent(bs) {
  const ev = bs.events.find((e) => e.is_next);
  if (!ev) throw new Error('No next gameweek in bootstrap-static');
  return ev;
}

// Works out which of the decision's transfers still need making (re-runs are safe) and checks
// every rule before anything is posted. Returns { todo, hits, bankAfter, squadAfter }.
export function planTransfers(decision, bs, myTeam) {
  const E = new Map(bs.elements.map((e) => [e.id, e]));
  const squad = new Map(myTeam.picks.map((p) => [p.element, p]));
  const owned = new Set(squad.keys());
  const pairs = (decision.transfers || []).map((t) => ({
    out: resolve(t.out, bs, owned),
    in: resolve(t.in, bs),
  }));
  if (pairs.length > RULES.maxTransfers) throw new Error(`${pairs.length} transfers exceeds the cap of ${RULES.maxTransfers}`);

  const todo = [];
  for (const p of pairs) {
    const outOwned = owned.has(p.out.id), inOwned = owned.has(p.in.id);
    if (!outOwned && inOwned) continue; // already done on an earlier run or by hand
    if (!outOwned) throw new Error(`${p.out.web_name} is not in the squad`);
    if (inOwned) throw new Error(`${p.in.web_name} is already in the squad but ${p.out.web_name} is still there`);
    if (p.out.element_type !== p.in.element_type) {
      throw new Error(`${p.out.web_name} (${POS[p.out.element_type]}) cannot be replaced by ${p.in.web_name} (${POS[p.in.element_type]})`);
    }
    todo.push(p);
  }
  const ids = [...todo.flatMap((p) => [p.out.id, p.in.id])];
  if (new Set(ids).size !== ids.length) throw new Error('A player appears twice in the transfers');

  for (const p of todo) {
    const chance = p.in.chance_of_playing_next_round;
    if (p.in.status !== 'a' && !(chance != null && chance >= RULES.minChanceIncoming)) {
      throw new Error(`${p.in.web_name} is flagged (${p.in.status}, ${chance ?? '?'}%: ${p.in.news || 'no news'})`);
    }
  }

  const t = myTeam.transfers;
  const unlimited = t.limit == null;
  const freeLeft = unlimited ? Infinity : Math.max(t.limit - (t.made || 0), 0);
  const hits = Math.max(todo.length - freeLeft, 0);
  const allowed = Math.min(decision.max_hits ?? 0, RULES.maxHits);
  if (hits > allowed) throw new Error(`${todo.length} transfers with ${freeLeft} free would cost ${hits} hit(s); allowed ${allowed}`);

  let bank = t.bank;
  for (const p of todo) bank += squad.get(p.out.id).selling_price - p.in.now_cost;
  if (bank < 0) throw new Error(`Over budget by £${(-bank / 10).toFixed(1)}m`);

  const after = new Set(owned);
  for (const p of todo) { after.delete(p.out.id); after.add(p.in.id); }
  checkSquad([...after].map((id) => E.get(id)));
  return { todo, hits, freeLeft, bankAfter: bank, squadAfter: after };
}

export function checkSquad(players) {
  if (players.length !== 15) throw new Error(`Squad has ${players.length} players`);
  const byPos = {}, byClub = {};
  for (const e of players) {
    byPos[e.element_type] = (byPos[e.element_type] || 0) + 1;
    byClub[e.team] = (byClub[e.team] || 0) + 1;
  }
  for (const [pos, n] of Object.entries(RULES.squadCounts)) {
    if ((byPos[pos] || 0) !== n) throw new Error(`Squad would have ${byPos[pos] || 0} ${POS[pos]} (needs ${n})`);
  }
  for (const [club, n] of Object.entries(byClub)) {
    if (n > RULES.maxPerClub) throw new Error(`Squad would have ${n} players from club ${club}`);
  }
}

// Builds the my-team payload: XI in GK, DEF, MID, FWD order (positions 1-11), bench GK at 12,
// then outfield bench in the decision's autosub order (13-15).
export function buildLineup(decision, bs, squadIds) {
  const E = new Map(bs.elements.map((e) => [e.id, e]));
  const owned = new Set(squadIds);
  const xi = decision.starting_xi.map((r) => resolve(r, bs, owned));
  const bench = decision.bench.map((r) => resolve(r, bs, owned));
  const all = [...xi, ...bench];
  if (xi.length !== 11 || bench.length !== 4) throw new Error(`Need 11 starters and 4 bench, got ${xi.length} and ${bench.length}`);
  if (new Set(all.map((e) => e.id)).size !== 15) throw new Error('Line-up repeats a player');
  for (const e of all) if (!owned.has(e.id)) throw new Error(`${e.web_name} is not in the squad`);

  const count = {};
  for (const e of xi) count[e.element_type] = (count[e.element_type] || 0) + 1;
  for (const pos of [1, 2, 3, 4]) {
    const n = count[pos] || 0;
    if (n < RULES.xiMin[pos] || n > RULES.xiMax[pos]) throw new Error(`Starting XI has ${n} ${POS[pos]}`);
  }
  const benchGk = bench.filter((e) => e.element_type === 1);
  if (benchGk.length !== 1) throw new Error('Bench must hold exactly one goalkeeper');
  const outfieldBench = bench.filter((e) => e.element_type !== 1);

  const cap = resolve(decision.captain, bs, owned), vice = resolve(decision.vice, bs, owned);
  if (cap.id === vice.id) throw new Error('Captain and vice-captain are the same player');
  if (!xi.some((e) => e.id === cap.id) || !xi.some((e) => e.id === vice.id)) throw new Error('Captain and vice must start');

  const order = [...xi].sort((a, b) => a.element_type - b.element_type);
  const seq = [...order, benchGk[0], ...outfieldBench];
  return seq.map((e, i) => ({
    element: e.id,
    position: i + 1,
    is_captain: e.id === cap.id,
    is_vice_captain: e.id === vice.id,
  }));
}

// ---------- network ----------

function loadRefresh(file) {
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).refresh_token;
  const env = (process.env.FPL_REFRESH_TOKEN || '').replace(/\s+/g, '');
  if (env) return env;
  throw new Error('No FPL refresh token: set the FPL_REFRESH_TOKEN secret (run fpl-login.mjs)');
}

function saveRefresh(file, token) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ refresh_token: token }), { mode: 0o600 });
  renameSync(tmp, file);
}

async function accessToken(file) {
  const old = loadRefresh(file);
  let resp;
  for (let a = 0; a < 3; a++) {
    resp = await fetch(`${AUTHORITY}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: old }),
    });
    if (![429, 500, 502, 503, 504].includes(resp.status)) break;
    await sleep(5000 * 2 ** a);
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body.access_token) {
    throw new Error(`FPL sign-in refused (${resp.status} ${body.error || ''}): run fpl-login.mjs again and replace the FPL_REFRESH_TOKEN secret`);
  }
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::add-mask::${body.access_token}`);
    if (body.refresh_token) console.log(`::add-mask::${body.refresh_token}`);
  }
  // Save the rotated token before anything else can fail.
  if (body.refresh_token && body.refresh_token !== old) saveRefresh(file, body.refresh_token);
  return body.access_token;
}

class Client {
  constructor(token) { this.token = token; this.cookies = {}; }
  headers(extra = {}) {
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    return { 'User-Agent': UA, Accept: 'application/json', 'X-API-Authorization': `Bearer ${this.token}`, ...(cookie ? { Cookie: cookie } : {}), ...extra };
  }
  keepCookies(resp) {
    for (const c of resp.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      if (i > 0) this.cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
  }
  async get(path) {
    for (let a = 0; a < 4; a++) {
      const r = await fetch(`${SITE}/api/${path}`, { headers: this.headers() });
      this.keepCookies(r);
      if (r.ok) return r.json();
      if (![429, 500, 502, 503, 504].includes(r.status) || a === 3) throw new Error(`GET ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      await sleep(3000 * 2 ** a);
    }
  }
  async post(path, payload) {
    if (!this.cookies.csrftoken) await this.get('me/');
    for (let a = 0; a < 3; a++) {
      const r = await fetch(`${SITE}/api/${path}`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json', 'X-CSRFToken': this.cookies.csrftoken || '', Origin: SITE, Referer: `${SITE}/` }),
        body: JSON.stringify(payload),
      });
      this.keepCookies(r);
      const text = await r.text();
      if (r.ok) return text ? JSON.parse(text) : null;
      if (![429, 502, 503, 504].includes(r.status) || a === 2) throw new Error(`POST ${path}: ${r.status} ${text.slice(0, 400)}`);
      await sleep(5000 * 2 ** a);
    }
  }
}

// ---------- main ----------

function newestDecision() {
  const files = existsSync('decisions') ? readdirSync('decisions').filter((f) => /^gw\d+\.json$/.test(f)).sort() : [];
  if (!files.length) throw new Error('No decision files in decisions/');
  return `decisions/${files.at(-1)}`;
}

async function main() {
  const args = process.argv.slice(2);
  const tokenFile = process.env.FPL_TOKEN_FILE;
  const entry = +(process.env.FPL_ENTRY || 531300);
  const log = [];
  const say = (s) => { console.log(s); log.push(s); };

  const client = new Client(await accessToken(tokenFile));
  const me = await client.get('me/');
  const myEntry = me?.player?.entry;
  if (myEntry !== entry) throw new Error(`Signed in to entry ${myEntry}, expected ${entry}`);
  if (args.includes('--check')) { say(`Sign-in OK for entry ${entry}.`); return; }

  const path = args.find((a) => !a.startsWith('--')) || newestDecision();
  const decision = JSON.parse(readFileSync(path, 'utf8'));
  const apply = args.includes('--apply') && decision.apply === true;
  const bs = await client.get('bootstrap-static/');
  const ev = nextEvent(bs);
  const minsLeft = (new Date(ev.deadline_time) - Date.now()) / 60000;
  say(`${apply ? 'APPLY' : 'DRY RUN'} ${path}: GW${decision.gw}, deadline ${ev.deadline_time} (${Math.round(minsLeft)} min left)`);
  if (decision.entry !== entry) throw new Error(`Decision is for entry ${decision.entry}`);
  if (decision.gw !== ev.id) throw new Error(`Decision is for GW${decision.gw} but the next deadline is GW${ev.id}`);
  if (minsLeft < RULES.deadlineBufferMin) throw new Error(`Only ${Math.round(minsLeft)} min to the deadline; not starting`);
  if (decision.chip) throw new Error('The executor never plays chips; play it by hand');

  let team = await client.get(`my-team/${entry}/`);
  const active = (team.chips || []).find((c) => c.status_for_entry === 'active');
  if (active) throw new Error(`Chip ${active.name} is active on the account; leaving the team for you to manage`);

  const plan = planTransfers(decision, bs, team);
  const E = new Map(bs.elements.map((e) => [e.id, e]));
  const sell = new Map(team.picks.map((p) => [p.element, p.selling_price]));
  say(`Free transfers left ${plan.freeLeft === Infinity ? 'unlimited' : plan.freeLeft}, hits ${plan.hits}, bank after £${(plan.bankAfter / 10).toFixed(1)}m`);
  for (const p of plan.todo) say(`  OUT ${p.out.web_name} £${(sell.get(p.out.id) / 10).toFixed(1)}m  ->  IN ${p.in.web_name} £${(p.in.now_cost / 10).toFixed(1)}m`);
  if (!plan.todo.length) say('  No transfers left to make.');

  const lineupPreview = buildLineup(decision, bs, [...plan.squadAfter]);
  const label = (p) => `${E.get(p.element).web_name}${p.is_captain ? ' (C)' : p.is_vice_captain ? ' (V)' : ''}`;
  say(`XI: ${lineupPreview.slice(0, 11).map(label).join(', ')}`);
  say(`Bench: ${lineupPreview.slice(11).map(label).join(', ')}`);

  const result = { gw: decision.gw, decision: path, applied: apply, at: new Date().toISOString(), log };
  if (apply) {
    if (plan.todo.length) {
      await client.post('transfers/', {
        chip: null, entry, event: ev.id,
        transfers: plan.todo.map((p) => ({
          element_in: p.in.id, element_out: p.out.id,
          purchase_price: p.in.now_cost, selling_price: sell.get(p.out.id),
        })),
      });
      say('Transfers confirmed by FPL.');
      team = await client.get(`my-team/${entry}/`);
    }
    const lineup = buildLineup(decision, bs, team.picks.map((p) => p.element));
    await client.post(`my-team/${entry}/`, { chip: null, picks: lineup });
    const check = await client.get(`my-team/${entry}/`);
    const got = new Map(check.picks.map((p) => [p.element, p]));
    const bad = lineup.filter((p) => {
      const g = got.get(p.element);
      return !g || g.position !== p.position || g.is_captain !== p.is_captain || g.is_vice_captain !== p.is_vice_captain;
    });
    if (bad.length) throw new Error(`Line-up saved but FPL shows differences for: ${bad.map((p) => E.get(p.element).web_name).join(', ')}`);
    say(`Verified on FPL: squad, XI, bench order and armband match. Bank £${(check.transfers.bank / 10).toFixed(1)}m.`);
  } else {
    say(decision.apply === true ? 'Dry run only (no --apply flag).' : 'Dry run only (decision has "apply": false).');
  }
  mkdirSync('reports/executions', { recursive: true });
  writeFileSync(`reports/executions/gw${String(decision.gw).padStart(2, '0')}.json`, JSON.stringify(result, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`::error::${e.message}`); process.exit(1); });
}
