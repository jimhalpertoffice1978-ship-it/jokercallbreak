import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODES, ROUNDS, buildDeck, createGame, nextRound, applyBid, applyPlay, legalCards, legalCardIds,
  winningIndex, beats, scoreCall, autoBid, autoPlay, viewFor, countCards,
} from '../src/callbreak.js';

// ---------- helpers

const RANK = { A: 14, K: 13, Q: 12, J: 11 };
let nextId = 5000;
// 'SA' = ace of spades, 'H9' = nine of hearts, 'D10' = ten of diamonds
const c = (spec) => ({ id: nextId++, suit: spec[0], rank: RANK[spec.slice(1)] ?? Number(spec.slice(1)) });
const hand = (...specs) => specs.map(c);
const plays = (...pairs) => pairs.map(([playerId, spec]) => ({ playerId, card: c(spec) }));

function seeded(seed) {
  let a = seed >>> 0;
  return (max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}
const people = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
const game = (mode = 'solo4', seed = 1, dealerIdx) =>
  createGame(people(MODES[mode].players), { mode, rng: seeded(seed), dealerIdx });

function act(r) {
  assert.ok(r.ok, r.error);
  return r.state;
}
function bidAll(s, amounts) {
  let st = s;
  for (let i = 0; i < amounts.length; i++) st = act(applyBid(st, st.players[st.turnIdx].id, amounts[i]));
  return st;
}

// ---------- deck and deal

test('one deck has 52 cards with no Jokers; two decks have 104', () => {
  const d = buildDeck(1);
  assert.equal(d.length, 52);
  assert.equal(new Set(d.map((x) => x.id)).size, 52);
  assert.equal(d.filter((x) => x.suit === 'S').length, 13);
  assert.equal(buildDeck(2).length, 104);
});

test('every player gets 13 cards in all three modes', () => {
  for (const mode of Object.keys(MODES)) {
    const s = game(mode);
    assert.equal(s.players.length, MODES[mode].players);
    for (const p of s.players) assert.equal(p.hand.length, 13);
    const total = s.players.length * 13;
    assert.deepEqual(countCards(s), { total, unique: total });
  }
});

test('player count must match the mode', () => {
  assert.throws(() => createGame(people(3), { mode: 'solo4' }));
  assert.throws(() => createGame(people(4), { mode: 'team8' }));
  assert.doesNotThrow(() => createGame(people(8), { mode: 'team8' }));
});

test('partners sit opposite each other', () => {
  const t4 = game('team4');
  assert.deepEqual(t4.units.map((u) => u.playerIds), [['p0', 'p2'], ['p1', 'p3']]);
  const t8 = game('team8');
  assert.equal(t8.units.length, 4);
  assert.deepEqual(t8.units.map((u) => u.playerIds), [['p0', 'p4'], ['p1', 'p5'], ['p2', 'p6'], ['p3', 'p7']]);
  assert.equal(game('solo4').units.length, 4);
});

// ---------- bidding

test('bidding starts at the dealer\'s right, the dealer calls last, and the same player leads', () => {
  let s = game('solo4', 1, 2); // dealer is seat 2
  assert.equal(s.players[s.turnIdx].id, 'p3');
  const order = [];
  for (let i = 0; i < 4; i++) {
    order.push(s.players[s.turnIdx].id);
    s = act(applyBid(s, s.players[s.turnIdx].id, 2));
  }
  assert.deepEqual(order, ['p3', 'p0', 'p1', 'p2']);
  assert.equal(s.phase, 'playing');
  assert.equal(s.players[s.turnIdx].id, 'p3');
  assert.equal(s.trickNo, 1);
});

test('a call must be a whole number from 1 to 13, and in turn', () => {
  const s = game('solo4', 1, 0);
  const first = s.players[s.turnIdx].id;
  for (const bad of [0, 14, -1, 2.5, '3', null]) assert.equal(applyBid(s, first, bad).ok, false, String(bad));
  assert.equal(applyBid(s, 'p0', 3).ok, false); // p0 is the dealer, p1 calls first
  assert.equal(applyBid(s, first, 1).ok, true);
  assert.equal(applyBid(s, first, 13).ok, true);
});

test('cannot play cards while bidding, or bid while playing', () => {
  const s = game('solo4', 1, 0);
  assert.equal(applyPlay(s, s.players[s.turnIdx].id, s.players[s.turnIdx].hand[0].id).ok, false);
  const p = bidAll(s, [1, 1, 1, 1]);
  assert.equal(applyBid(p, p.players[p.turnIdx].id, 2).ok, false);
});

// ---------- the strict playing hierarchy

test('leading: any card is allowed', () => {
  const h = hand('H5', 'S3', 'D9');
  assert.equal(legalCards(h, []).length, 3);
});

test('follow suit and win: you must play a higher card of the led suit if you have one', () => {
  const h = hand('H5', 'H9', 'S3');
  const legal = legalCards(h, plays(['a', 'H7']));
  assert.deepEqual(legal.map((x) => `${x.suit}${x.rank}`), ['H9']);
});

test('follow suit (lose): if you cannot beat the winning card you still must follow suit', () => {
  const h = hand('H5', 'H6', 'S3');
  const legal = legalCards(h, plays(['a', 'H7']));
  assert.deepEqual(legal.map((x) => x.rank).sort(), [5, 6]);
});

test('beating takes the highest card played so far, not just the led card', () => {
  const h = hand('H9', 'H12');
  const legal = legalCards(h, plays(['a', 'H7'], ['b', 'H10']));
  assert.deepEqual(legal.map((x) => x.rank), [12]);
});

test('no cards of the led suit: you must play a spade', () => {
  const h = hand('S3', 'D4', 'C9');
  const legal = legalCards(h, plays(['a', 'H7']));
  assert.deepEqual(legal.map((x) => `${x.suit}${x.rank}`), ['S3']);
});

test('a spade is already winning: you must play a higher spade if you can', () => {
  const h = hand('S12', 'S3', 'D4');
  const legal = legalCards(h, plays(['a', 'H7'], ['b', 'S9']));
  assert.deepEqual(legal.map((x) => `${x.suit}${x.rank}`), ['S12']);
});

test('a spade is winning and none of yours are high enough: play anything', () => {
  const h = hand('S3', 'S5', 'D4');
  const legal = legalCards(h, plays(['a', 'H7'], ['b', 'S9']));
  assert.equal(legal.length, 3);
});

test('no led suit and no spades: discard anything', () => {
  const h = hand('D4', 'C9', 'D2');
  assert.equal(legalCards(h, plays(['a', 'H7'])).length, 3);
});

test('you hold the led suit but a spade is winning: any card of the led suit', () => {
  const h = hand('H5', 'H2', 'D4', 'S13');
  const legal = legalCards(h, plays(['a', 'H7'], ['b', 'S2']));
  assert.deepEqual(legal.map((x) => x.rank).sort((x, y) => x - y), [2, 5]);
});

test('spades led: follow with a higher spade if you can, otherwise any spade, otherwise anything', () => {
  assert.deepEqual(legalCards(hand('S5', 'S10', 'H3'), plays(['a', 'S7'])).map((x) => x.rank), [10]);
  assert.deepEqual(legalCards(hand('S5', 'S6', 'H3'), plays(['a', 'S9'])).map((x) => x.rank).sort(), [5, 6]);
  assert.equal(legalCards(hand('H3', 'D4'), plays(['a', 'S7'])).length, 2);
});

// ---------- who wins a trick

test('highest card of the led suit wins when nobody trumps', () => {
  const t = plays(['a', 'H7'], ['b', 'H12'], ['c', 'D14'], ['d', 'H3']);
  assert.equal(winningIndex(t), 1);
});

test('a spade beats the led suit, and the highest spade wins', () => {
  assert.equal(winningIndex(plays(['a', 'H14'], ['b', 'S2'], ['c', 'H13'], ['d', 'D5'])), 1);
  assert.equal(winningIndex(plays(['a', 'H14'], ['b', 'S2'], ['c', 'S9'], ['d', 'S5'])), 2);
});

test('discarding another suit never wins', () => {
  assert.equal(winningIndex(plays(['a', 'H3'], ['b', 'D14'], ['c', 'C14'], ['d', 'H4'])), 3);
});

test('identical cards: the first one played wins (8-player double deck rule)', () => {
  assert.equal(winningIndex(plays(['a', 'SA'], ['b', 'H5'], ['c', 'SA'], ['d', 'D3'])), 0);
  assert.equal(winningIndex(plays(['a', 'H14'], ['b', 'D5'], ['c', 'H14'])), 0);
  assert.equal(beats(c('SA'), c('SA'), 'S'), false);
});

test('an identical card does not count as beating the trick, so it is not forced', () => {
  const h = hand('HA', 'H3');
  const legal = legalCards(h, plays(['a', 'HA']));
  assert.equal(legal.length, 2); // the ace cannot beat the ace, so any heart is fine
});

// ---------- scoring

test('met, exceeded and missed calls', () => {
  assert.equal(scoreCall(3, 3), 3);
  assert.equal(scoreCall(3, 5), 3.2);
  assert.equal(scoreCall(5, 8), 5.3);
  assert.equal(scoreCall(4, 6), 4.2);
  assert.equal(scoreCall(1, 13), 2.2);
  assert.equal(scoreCall(3, 2), -3);
  assert.equal(scoreCall(6, 0), -6);
});

// ---------- playing a whole trick and round

function finalTrickState(mode, bids, tricks) {
  // Build a state in which every player holds one card and it is the 13th trick.
  const s = game(mode, 3, 0);
  const n = s.players.length;
  s.phase = 'playing';
  s.trickNo = 13;
  s.trick = [];
  s.turnIdx = 1 % n;
  s.players.forEach((p, i) => {
    p.hand = hand('D2');
    p.bid = bids[i];
    p.tricks = tricks[i];
  });
  s.players[0].hand = hand('DA'); // seat 0 will win the last trick
  return s;
}
function playOut(s) {
  let st = s;
  for (let k = 0; k < st.players.length; k++) {
    const p = st.players[st.turnIdx];
    st = act(applyPlay(st, p.id, p.hand[0].id));
  }
  return st;
}

test('the winner of a trick leads the next one and the trick count goes up', () => {
  let s = bidAll(game('solo4', 2, 0), [1, 1, 1, 1]);
  const lead = s.players[s.turnIdx];
  s.players[s.turnIdx].hand = hand('H5', 'H6');
  s.players[(s.turnIdx + 1) % 4].hand = hand('H9', 'C2');
  s.players[(s.turnIdx + 2) % 4].hand = hand('H3', 'C3');
  s.players[(s.turnIdx + 3) % 4].hand = hand('H4', 'C4');
  const order = [0, 1, 2, 3].map((k) => s.players[(s.turnIdx + k) % 4]);
  s = act(applyPlay(s, order[0].id, order[0].hand[0].id)); // H5
  s = act(applyPlay(s, order[1].id, order[1].hand[0].id)); // H9
  s = act(applyPlay(s, order[2].id, order[2].hand[0].id)); // H3
  s = act(applyPlay(s, order[3].id, order[3].hand[0].id)); // H4
  assert.equal(s.lastTrick.winnerId, order[1].id);
  assert.equal(s.players.find((p) => p.id === order[1].id).tricks, 1);
  assert.equal(s.players[s.turnIdx].id, order[1].id);
  assert.equal(s.trickNo, 2);
  assert.equal(s.trick.length, 0);
  assert.ok(lead);
});

test('illegal plays are refused with a reason', () => {
  let s = bidAll(game('solo4', 2, 0), [1, 1, 1, 1]);
  const a = s.players[s.turnIdx];
  const b = s.players[(s.turnIdx + 1) % 4];
  a.hand = hand('H5');
  b.hand = hand('H9', 'H3', 'S2');
  s = act(applyPlay(s, a.id, a.hand[0].id));
  const r = applyPlay(s, b.id, b.hand.find((x) => x.rank === 3).id); // must beat the 5 with the 9
  assert.equal(r.ok, false);
  assert.match(r.error, /not allowed/);
  assert.equal(applyPlay(s, a.id, 99999).ok, false); // not your turn
  assert.equal(applyPlay(s, b.id, 99999).ok, false); // not your card
  assert.deepEqual(legalCardIds(s, b.id), [b.hand.find((x) => x.rank === 9).id]);
});

test('standard mode: every player is scored on their own call', () => {
  // bids 3, 2, 4, 1; tricks before the last one: 3, 3, 4, 2 (12 in total), seat 0 wins the 13th
  const s = finalTrickState('solo4', [3, 2, 4, 1], [3, 3, 4, 2 - 1]);
  const end = playOut(s);
  assert.equal(end.phase, 'roundEnd');
  const rows = end.history[0].rows;
  assert.deepEqual(rows.map((r) => r.won), [4, 3, 4, 1]);
  assert.deepEqual(rows.map((r) => r.points), [3.1, 2.1, 4, 1]);
  assert.deepEqual(end.units.map((u) => u.score), [3.1, 2.1, 4, 1]);
});

test('standard mode: a missed call loses points equal to the call', () => {
  const s = finalTrickState('solo4', [5, 2, 4, 1], [3, 3, 4, 2 - 1]);
  const end = playOut(s);
  assert.equal(end.history[0].rows[0].points, -5); // called 5, won 4
});

test('partnership mode: partners\' calls and tricks are added together', () => {
  // seats 0 and 2 are partners (calls 3 + 1 = 4); seats 1 and 3 (calls 2 + 4 = 6)
  // tricks before the last trick: seat0 2, seat1 3, seat2 3, seat3 4; seat 0 wins the 13th
  const s = finalTrickState('team4', [3, 2, 1, 4], [2, 3, 3, 4]);
  const end = playOut(s);
  const rows = end.history[0].rows;
  assert.deepEqual(rows.map((r) => [r.call, r.won]), [[4, 6], [6, 7]]);
  assert.deepEqual(rows.map((r) => r.points), [4.2, 6.1]);
});

test('partnership mode: a missed team call loses the combined call', () => {
  const s = finalTrickState('team4', [5, 2, 5, 4], [2, 3, 3, 4]);
  const end = playOut(s);
  assert.equal(end.history[0].rows[0].points, -10); // team call 10, won 6
});

test('8-player mode: four teams, calls add up per team', () => {
  const bids = [2, 1, 3, 2, 1, 4, 2, 3]; // team 0 = seats 0 and 4 -> 3, team 1 = 1 + 4 = 5, ...
  const s = finalTrickState('team8', bids, [1, 2, 3, 1, 1, 2, 1, 1]);
  const end = playOut(s);
  const rows = end.history[0].rows;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.call), [3, 5, 5, 5]);
  assert.equal(rows.reduce((n, r) => n + r.won, 0), 12 + 1); // 13 tricks in the round
});

// ---------- rounds and the end of the game

test('the next round moves the dealer one seat to the right and deals new hands', () => {
  const s = finalTrickState('solo4', [3, 2, 4, 1], [3, 3, 4, 1]);
  const end = playOut(s);
  const dealer = end.dealerIdx;
  const r2 = act(nextRound(end, seeded(9)));
  assert.equal(r2.round, 2);
  assert.equal(r2.dealerIdx, (dealer + 1) % 4);
  assert.equal(r2.phase, 'bidding');
  assert.equal(r2.players[r2.turnIdx].id, r2.players[(r2.dealerIdx + 1) % 4].id);
  for (const p of r2.players) { assert.equal(p.hand.length, 13); assert.equal(p.bid, null); assert.equal(p.tricks, 0); }
  assert.equal(nextRound(r2).ok, false); // only valid between rounds
  assert.deepEqual(r2.units.map((u) => u.score), end.units.map((u) => u.score)); // scores carry over
});

test('after 5 rounds the game ends, and tied leaders share the win', () => {
  let s = finalTrickState('solo4', [3, 3, 3, 3], [2, 3, 3, 3]);
  s.round = ROUNDS;
  s.units[0].score = 10;
  s.units[1].score = 13.3;
  s.units[2].score = 3;
  s.units[3].score = 0;
  s = playOut(s);
  assert.equal(s.phase, 'ended');
  assert.equal(s.history.length, 1);
  assert.deepEqual(s.winnerUnitIds, ['u1']); // 13.3 beats seat 0 on 13
  let t = finalTrickState('solo4', [3, 3, 3, 3], [2, 3, 3, 3]);
  t.round = ROUNDS;
  t.units.forEach((u, i) => { u.score = [10, 13, 13, 4][i]; });
  t = playOut(t);
  assert.deepEqual(t.units.map((u) => u.score), [13, 16, 16, 7]);
  assert.deepEqual(t.winnerUnitIds, ['u1', 'u2']); // a tie: both win
});

// ---------- what each player may see

test('views never include another player\'s cards', () => {
  const s = bidAll(game('solo4', 5, 0), [2, 2, 2, 2]);
  const v = viewFor(s, 'p0');
  const text = JSON.stringify(v);
  assert.equal((text.match(/"hand"/g) || []).length, 1);
  assert.equal(v.players.find((p) => p.id === 'p1').cardCount, 13);
  assert.equal(v.players.find((p) => p.id === 'p1').hand, undefined);
  assert.equal(v.you.hand.length, 13);
});

test('only the player to act gets legal cards and bid rights', () => {
  const s = game('solo4', 5, 0);
  const bidder = s.players[s.turnIdx].id;
  assert.equal(viewFor(s, bidder).you.canBid, true);
  assert.equal(viewFor(s, 'p0').you.canBid, false);
  const p = bidAll(s, [1, 1, 1, 1]);
  const leader = p.players[p.turnIdx].id;
  const lv = viewFor(p, leader).you;
  assert.equal(lv.canPlay, true);
  assert.equal(lv.legalIds.length, 13);
  const other = viewFor(p, p.players[(p.turnIdx + 1) % 4].id).you;
  assert.equal(other.canPlay, false);
  assert.deepEqual(other.legalIds, []);
});

test('team calls are shown only once everyone has called', () => {
  let s = game('team4', 5, 0);
  s = act(applyBid(s, s.players[s.turnIdx].id, 3));
  assert.equal(viewFor(s, 'p0').units[0].call, null);
  s = bidAll(s, [2, 2, 2]);
  assert.ok(viewFor(s, 'p0').units.every((u) => u.call > 0));
});

// ---------- simulations: whole games with random legal moves

test('simulation: 150 random games in each mode always finish cleanly', () => {
  for (const mode of Object.keys(MODES)) {
    for (let g = 0; g < 150; g++) {
      const rng = seeded(mode.length * 1000 + g);
      const n = MODES[mode].players;
      let s = createGame(people(n), { mode, rng });
      let steps = 0;
      while (s.phase !== 'ended') {
        assert.ok(++steps < 20000, 'game did not finish');
        if (s.phase === 'roundEnd') {
          const sumTricks = s.players.reduce((t, p) => t + p.tricks, 0);
          assert.equal(sumTricks, 13, 'a round has exactly 13 tricks');
          s = act(nextRound(s, rng));
          continue;
        }
        const p = s.players[s.turnIdx];
        if (s.phase === 'bidding') {
          const amount = rng(3) === 0 ? 1 + rng(13) : autoBid(s, p.id);
          s = act(applyBid(s, p.id, amount));
        } else {
          const legal = legalCards(p.hand, s.trick);
          assert.ok(legal.length > 0, 'there is always a legal card');
          const pick = rng(4) === 0 ? legal[rng(legal.length)].id : autoPlay(s, p.id);
          s = act(applyPlay(s, p.id, pick));
          const cc = countCards(s);
          assert.equal(cc.total, cc.unique, 'no duplicate card ids');
        }
      }
      assert.equal(s.history.length, ROUNDS);
      const sum = s.units.map((u, i) => Math.round(s.history.reduce((t, h) => t + h.rows[i].points, 0) * 10) / 10 + 0);
      assert.deepEqual(s.units.map((u) => u.score), sum, 'scores equal the sum of the rounds');
      assert.ok(s.winnerUnitIds.length >= 1);
    }
  }
});
