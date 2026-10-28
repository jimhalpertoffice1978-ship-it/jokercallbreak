// JokerCallbreak rules engine. Pure logic: state in, state out. No network, no browser.
//
// Seats are stored in play order, which is counter-clockwise: the player to your RIGHT is
// the next seat in the list. The dealer moves one seat to the right each round, bidding
// starts with the player to the dealer's right, and that player also leads the first trick.
import { randomInt } from 'node:crypto';

export const SUITS = ['S', 'H', 'D', 'C']; // S = spades, the permanent trump
export const TRUMP = 'S';
export const ROUNDS = 5;
export const HAND_SIZE = 13;

export const MODES = {
  solo4: { id: 'solo4', players: 4, teams: false, decks: 1, label: 'Standard (4 players)' },
  team4: { id: 'team4', players: 4, teams: true, decks: 1, label: 'Partnership (4 players)' },
  team8: { id: 'team8', players: 8, teams: true, decks: 2, label: 'Partnership (8 players, 2 decks)' },
};

const defaultRng = (max) => randomInt(max);
const round1 = (x) => Math.round(x * 10) / 10 + 0; // + 0 turns -0 into 0
const fail = (error) => ({ ok: false, error });
const clone = (s) => structuredClone(s);

// ---------------------------------------------------------------- deck

export function buildDeck(decks) {
  const cards = [];
  let id = 0;
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) {
      for (let rank = 2; rank <= 14; rank++) cards.push({ id: id++, suit, rank }); // 11 J, 12 Q, 13 K, 14 A
    }
  }
  return cards;
}

export function shuffle(cards, rng = defaultRng) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Deals 13 cards to every player. A deal in which any player has no spade is thrown away and
// the cards are shuffled and dealt again, until every player holds at least one spade.
const MAX_REDEALS = 10000;
function dealRound(s, rng) {
  for (let attempt = 0; attempt < MAX_REDEALS; attempt++) {
    const deck = shuffle(buildDeck(MODES[s.mode].decks), rng);
    const hands = s.players.map((_, i) => deck.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE));
    if (hands.every((h) => h.some((c) => c.suit === TRUMP))) {
      s.players.forEach((p, i) => {
        p.hand = hands[i];
        p.bid = null;
        p.tricks = 0;
      });
      return;
    }
  }
  throw new Error('Could not deal a hand with a spade for every player.');
}

// ---------------------------------------------------------------- playing rules

// Does card a beat card b in this trick? Identical cards never beat each other,
// so the first one played keeps the trick (the Identical Card Rule of the 8-player mode).
export function beats(a, b, ledSuit) {
  if (a.suit === TRUMP && b.suit !== TRUMP) return true;
  if (a.suit !== TRUMP && b.suit === TRUMP) return false;
  if (a.suit === b.suit && (a.suit === TRUMP || a.suit === ledSuit)) return a.rank > b.rank;
  return false;
}

export function winningIndex(trick) {
  const led = trick[0].card.suit;
  let best = 0;
  for (let i = 1; i < trick.length; i++) {
    if (beats(trick[i].card, trick[best].card, led)) best = i;
  }
  return best;
}

// The strict hierarchy: follow suit and win, follow suit, play a spade, discard.
// opts.partnerId (team modes only): the id of your partner. When your partner is currently winning
// the trick with a spade, you are not forced to beat it: any spade, higher or lower, is allowed.
export function legalCards(hand, trick, opts = {}) {
  if (trick.length === 0) return hand.slice();
  const led = trick[0].card.suit;
  const winIdx = winningIndex(trick);
  const winning = trick[winIdx].card;
  const partnerWinsWithSpade = !!opts.partnerId && trick[winIdx].playerId === opts.partnerId && winning.suit === TRUMP;
  const ofLed = hand.filter((c) => c.suit === led);
  if (ofLed.length) {
    if (winning.suit === led) {
      if (partnerWinsWithSpade) return ofLed; // spades were led and my partner is winning: any spade
      const higher = ofLed.filter((c) => c.rank > winning.rank);
      return higher.length ? higher : ofLed;
    }
    return ofLed; // a spade is winning and you cannot beat it by following suit
  }
  const spades = hand.filter((c) => c.suit === TRUMP);
  if (!spades.length) return hand.slice(); // discard anything
  if (winning.suit === TRUMP) {
    const higher = spades.filter((c) => c.rank > winning.rank);
    if (!higher.length) return hand.slice(); // no spade high enough: play anything
    return partnerWinsWithSpade ? spades : higher; // never forced to overtrump my own partner
  }
  return spades; // must trump
}

// The id of a player's partner, or null in the standard (no teams) mode.
export function partnerOf(state, player) {
  if (!MODES[state.mode].teams) return null;
  return state.units[player.unit].playerIds.find((id) => id !== player.id) || null;
}
const rulesFor = (state, player) => ({ partnerId: partnerOf(state, player) });

// ---------------------------------------------------------------- scoring

export function scoreCall(call, won) {
  if (won >= call) return round1(call + 0.1 * (won - call));
  return -call;
}

// ---------------------------------------------------------------- setup

export function createGame(players, options = {}) {
  const rng = options.rng || defaultRng;
  const mode = MODES[options.mode || 'solo4'];
  if (!mode) throw new Error('Unknown mode.');
  if (players.length !== mode.players) throw new Error(`${mode.label} needs exactly ${mode.players} players.`);
  if (new Set(players.map((p) => p.id)).size !== players.length) throw new Error('Player ids must be unique.');

  const n = players.length;
  const half = n / 2;
  const seated = players.map((p, i) => ({
    id: p.id,
    name: p.name,
    hand: [],
    bid: null,
    tricks: 0,
    unit: mode.teams ? i % half : i, // partners sit opposite each other
  }));
  const unitCount = mode.teams ? half : n;
  const units = Array.from({ length: unitCount }, (_, u) => ({
    id: `u${u}`,
    playerIds: seated.filter((p) => p.unit === u).map((p) => p.id),
    score: 0,
  }));

  const s = {
    mode: mode.id,
    phase: 'bidding', // bidding | playing | roundEnd | ended
    round: 1,
    rounds: ROUNDS,
    players: seated,
    units,
    dealerIdx: options.dealerIdx ?? rng(n),
    turnIdx: 0,
    trick: [], // [{ playerId, card }] in play order
    trickNo: 0,
    lastTrick: null, // the most recently finished trick, kept so screens can show it
    history: [], // one entry per finished round
    winnerUnitIds: [],
  };
  dealRound(s, rng);
  s.turnIdx = (s.dealerIdx + 1) % n;
  return s;
}

export function nextRound(state, rng = defaultRng) {
  if (state.phase !== 'roundEnd') return fail('The round is not finished yet.');
  const s = clone(state);
  const n = s.players.length;
  s.round += 1;
  s.dealerIdx = (s.dealerIdx + 1) % n; // the dealer moves one seat to the right
  dealRound(s, rng);
  s.phase = 'bidding';
  s.turnIdx = (s.dealerIdx + 1) % n;
  s.trick = [];
  s.trickNo = 0;
  s.lastTrick = null;
  return { ok: true, state: s };
}

// ---------------------------------------------------------------- actions

export function applyBid(state, playerId, amount) {
  if (state.phase !== 'bidding') return fail('It is not the bidding stage.');
  const cur = state.players[state.turnIdx];
  if (cur.id !== playerId) return fail('It is not your turn to call.');
  if (!Number.isInteger(amount) || amount < 1 || amount > HAND_SIZE) return fail('Call a number from 1 to 13.');

  const s = clone(state);
  const n = s.players.length;
  s.players[s.turnIdx].bid = amount;
  if (s.players.every((p) => p.bid !== null)) {
    s.phase = 'playing';
    s.turnIdx = (s.dealerIdx + 1) % n; // the first bidder also leads
    s.trickNo = 1;
    s.trick = [];
  } else {
    s.turnIdx = (s.turnIdx + 1) % n;
  }
  return { ok: true, state: s };
}

export function legalCardIds(state, playerId) {
  if (state.phase !== 'playing') return [];
  const p = state.players[state.turnIdx];
  if (p.id !== playerId) return [];
  return legalCards(p.hand, state.trick, rulesFor(state, p)).map((c) => c.id);
}

export function applyPlay(state, playerId, cardId) {
  if (state.phase !== 'playing') return fail('Cards cannot be played right now.');
  const cur = state.players[state.turnIdx];
  if (cur.id !== playerId) return fail('It is not your turn.');
  const card = cur.hand.find((c) => c.id === cardId);
  if (!card) return fail('You do not hold that card.');
  if (!legalCards(cur.hand, state.trick, rulesFor(state, cur)).some((c) => c.id === cardId)) {
    return fail('That card is not allowed. Follow suit, beat the trick if you can, play a spade, or discard.');
  }

  const s = clone(state);
  const n = s.players.length;
  const me = s.players[s.turnIdx];
  me.hand = me.hand.filter((c) => c.id !== cardId);
  s.trick.push({ playerId, card });

  if (s.trick.length < n) {
    s.turnIdx = (s.turnIdx + 1) % n;
    return { ok: true, state: s };
  }

  // The trick is complete.
  const w = winningIndex(s.trick);
  const winnerId = s.trick[w].playerId;
  const winnerIdx = s.players.findIndex((p) => p.id === winnerId);
  s.players[winnerIdx].tricks += 1;
  s.lastTrick = { no: s.trickNo, cards: s.trick, winnerId };
  s.trick = [];

  if (s.trickNo >= HAND_SIZE) {
    finishRound(s);
  } else {
    s.trickNo += 1;
    s.turnIdx = winnerIdx; // the winner leads the next trick
  }
  return { ok: true, state: s };
}

function finishRound(s) {
  const rows = s.units.map((u) => {
    const members = s.players.filter((p) => p.unit === s.units.indexOf(u));
    const call = members.reduce((n, p) => n + p.bid, 0);
    const won = members.reduce((n, p) => n + p.tricks, 0);
    const points = scoreCall(call, won);
    u.score = round1(u.score + points);
    return { unitId: u.id, call, won, points, total: u.score };
  });
  s.history.push({ round: s.round, rows });
  if (s.round >= s.rounds) {
    s.phase = 'ended';
    const top = Math.max(...s.units.map((u) => u.score));
    s.winnerUnitIds = s.units.filter((u) => u.score === top).map((u) => u.id); // ties share the win
  } else {
    s.phase = 'roundEnd';
  }
  s.turnIdx = -1;
}

// ---------------------------------------------------------------- automatic play (bots, timeouts, absent players)

export function autoBid(state, playerId) {
  const p = state.players.find((x) => x.id === playerId);
  let pts = 0;
  for (const c of p.hand) {
    if (c.rank === 14) pts += 1;
    else if (c.rank === 13) pts += c.suit === TRUMP ? 1 : 0.6;
    else if (c.suit === TRUMP && c.rank === 12) pts += 0.5;
    else if (c.suit === TRUMP && c.rank >= 8) pts += 0.3;
  }
  return Math.max(1, Math.min(HAND_SIZE, Math.round(pts)));
}

// Lowest legal card, keeping spades for later.
export function autoPlay(state, playerId) {
  const p = state.players.find((x) => x.id === playerId);
  const legal = legalCards(p.hand, state.trick, rulesFor(state, p));
  const weight = (c) => (c.suit === TRUMP ? 100 : 0) + c.rank;
  return legal.slice().sort((a, b) => weight(a) - weight(b))[0].id;
}

// ---------------------------------------------------------------- what each player may see

export function viewFor(state, viewerId) {
  const n = state.players.length;
  const me = state.players.find((p) => p.id === viewerId);
  const turnPlayer = state.turnIdx >= 0 ? state.players[state.turnIdx] : null;
  const allBid = state.players.every((p) => p.bid !== null);
  const myTurn = !!(me && turnPlayer && turnPlayer.id === viewerId);
  return {
    mode: state.mode,
    phase: state.phase,
    round: state.round,
    rounds: state.rounds,
    trump: TRUMP,
    dealerId: state.players[state.dealerIdx].id,
    turn: turnPlayer ? turnPlayer.id : null,
    trickNo: state.trickNo,
    trick: state.trick.map((t) => ({ playerId: t.playerId, card: t.card })),
    trickWinnerId: state.trick.length ? state.trick[winningIndex(state.trick)].playerId : null, // who is winning the open trick
    lastTrick: state.lastTrick,
    players: state.players.map((p, seat) => ({
      id: p.id,
      name: p.name,
      seat,
      unit: p.unit,
      cardCount: p.hand.length,
      bid: p.bid,
      tricks: p.tricks,
    })),
    units: state.units.map((u, i) => {
      const members = state.players.filter((p) => p.unit === i);
      return {
        id: u.id,
        playerIds: u.playerIds,
        score: u.score,
        call: allBid ? members.reduce((t, p) => t + p.bid, 0) : null,
        won: members.reduce((t, p) => t + p.tricks, 0),
      };
    }),
    history: state.history,
    winnerUnitIds: state.winnerUnitIds,
    seats: n,
    you: me
      ? {
          id: me.id,
          unit: me.unit,
          hand: me.hand,
          canBid: state.phase === 'bidding' && myTurn,
          canPlay: state.phase === 'playing' && myTurn,
          partnerId: partnerOf(state, me),
          legalIds: state.phase === 'playing' && myTurn ? legalCards(me.hand, state.trick, rulesFor(state, me)).map((c) => c.id) : [],
        }
      : null,
  };
}

// For tests: every card is somewhere exactly once.
export function countCards(state) {
  const ids = [];
  for (const p of state.players) for (const c of p.hand) ids.push(c.id);
  for (const t of state.trick) ids.push(t.card.id);
  return { total: ids.length, unique: new Set(ids).size };
}
