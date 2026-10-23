// Offline tests for execute.mjs rule checks. Run: node test-execute.mjs
import assert from 'node:assert/strict';
import { planTransfers, buildLineup, resolve } from './execute.mjs';

let id = 0;
const teams = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, short_name: `T${i + 1}` }));
const P = (name, type, team, cost, extra = {}) => ({ id: ++id, web_name: name, element_type: type, team, now_cost: cost, status: 'a', chance_of_playing_next_round: null, news: '', ...extra });
const squad = [
  P('GK1', 1, 1, 45), P('GK2', 1, 2, 45),
  P('D1', 2, 3, 50), P('D2', 2, 4, 50), P('D3', 2, 5, 50), P('D4', 2, 6, 50), P('D5', 2, 7, 47),
  P('M1', 3, 8, 70), P('M2', 3, 9, 70), P('M3', 3, 10, 60), P('M4', 3, 11, 55), P('M5', 3, 12, 68),
  P('F1', 4, 13, 150), P('F2', 4, 14, 75), P('F3', 4, 15, 60),
];
const pool = [
  P('NewD', 2, 16, 51), P('NewM', 3, 17, 79), P('Hurt', 3, 18, 50, { status: 'i', chance_of_playing_next_round: 0, news: 'Knee' }),
  P('Twin', 3, 19, 50), P('Twin', 3, 20, 50), P('Pricey', 3, 16, 200), P('ClubX', 2, 8, 45),
];
const bs = { elements: [...squad, ...pool], teams, events: [] };
const myTeam = (made = 0, limit = 2, bank = 5) => ({
  picks: squad.map((e) => ({ element: e.id, selling_price: e.now_cost })),
  transfers: { bank, limit, made }, chips: [],
});
const base = { gw: 8, entry: 1, max_hits: 0 };

// Two free transfers within budget.
let r = planTransfers({ ...base, transfers: [{ out: 'D5', in: 'NewD' }, { out: 'M5', in: 'NewM' }] }, bs, myTeam(0, 2, 15));
assert.equal(r.todo.length, 2); assert.equal(r.hits, 0); assert.equal(r.bankAfter, 15 + 47 - 51 + 68 - 79);

// Third transfer would be a hit: refused at max_hits 0, allowed at 1.
const three = [{ out: 'D5', in: 'NewD' }, { out: 'M5', in: 'NewM' }, { out: 'M4', in: 'Twin|T19' }];
assert.throws(() => planTransfers({ ...base, transfers: three }, bs, myTeam(0, 2, 30)), /hit/);
assert.equal(planTransfers({ ...base, max_hits: 1, transfers: three }, bs, myTeam(0, 2, 30)).hits, 1);
// max_hits above the hard cap of 1 is clamped.
assert.throws(() => planTransfers({ ...base, max_hits: 3, transfers: three }, bs, myTeam(0, 1, 30)), /allowed 1/);

// Injured incoming, over budget, wrong position, ambiguous name, club limit.
assert.throws(() => planTransfers({ ...base, transfers: [{ out: 'M5', in: 'Hurt' }] }, bs, myTeam()), /flagged/);
assert.throws(() => planTransfers({ ...base, transfers: [{ out: 'M5', in: 'Pricey' }] }, bs, myTeam()), /Over budget/);
assert.throws(() => planTransfers({ ...base, transfers: [{ out: 'D5', in: 'NewM' }] }, bs, myTeam()), /cannot be replaced/);
assert.throws(() => planTransfers({ ...base, transfers: [{ out: 'M5', in: 'Twin' }] }, bs, myTeam()), /matches 2/);
assert.equal(resolve('Twin|T20', bs).team, 20);

// Re-run after transfers were made: nothing left to do.
const done = myTeam(2, 2, 0);
done.picks = done.picks.map((p) => (p.element === squad[6].id ? { element: pool[0].id, selling_price: 51 } : p));
r = planTransfers({ ...base, transfers: [{ out: 'D5', in: 'NewD' }] }, bs, done);
assert.equal(r.todo.length, 0);

// Line-up: ordering, bench GK at 12, armband.
const lineup = buildLineup({
  starting_xi: ['F1', 'D1', 'GK1', 'D2', 'D3', 'M1', 'M2', 'M3', 'M4', 'F2', 'D4'],
  bench: ['GK2', 'M5', 'F3', 'D5'], captain: 'F1', vice: 'M1',
}, bs, squad.map((e) => e.id));
const name = (p) => bs.elements.find((e) => e.id === p.element).web_name;
assert.deepEqual(lineup.map(name), ['GK1', 'D1', 'D2', 'D3', 'D4', 'M1', 'M2', 'M3', 'M4', 'F1', 'F2', 'GK2', 'M5', 'F3', 'D5']);
assert.ok(lineup[9].is_captain && lineup[5].is_vice_captain);
assert.equal(lineup.filter((p) => p.is_captain).length, 1);

// Invalid formation and benched captain are refused.
assert.throws(() => buildLineup({
  starting_xi: ['GK1', 'D1', 'D2', 'M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3'],
  bench: ['GK2', 'D3', 'D4', 'D5'], captain: 'F1', vice: 'M1',
}, bs, squad.map((e) => e.id)), /2 DEF/);
assert.throws(() => buildLineup({
  starting_xi: ['F1', 'D1', 'GK1', 'D2', 'D3', 'M1', 'M2', 'M3', 'M4', 'F2', 'D4'],
  bench: ['GK2', 'M5', 'F3', 'D5'], captain: 'F3', vice: 'M1',
}, bs, squad.map((e) => e.id)), /must start/);

console.log('All executor tests passed.');
