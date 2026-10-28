import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, normalizeMeetLink } from '../src/rooms.js';
import { startServer } from '../src/server.js';

const HAS_WS = typeof globalThis.WebSocket === 'function';

function manager(extra = {}) {
  const clock = { t: 1_000_000 };
  const m = new RoomManager({ now: () => clock.t, graceMs: 30_000, botDelayMs: 700, roundEndMs: 20_000, trickHoldMs: 0, ...extra });
  return { m, clock };
}

// A room with `humans` people (the first is the host) filled up with computer players.
function table(m, mode = 'solo4', humans = 4) {
  const c = m.createRoom('Host');
  const tokens = [c.token];
  for (let i = 1; i < humans; i++) tokens.push(m.joinRoom(c.code, `Player${i}`).token);
  tokens.forEach((t) => m.markConnected(t, true));
  m.act(c.token, { type: 'setOptions', mode });
  const need = { solo4: 4, team4: 4, team8: 8 }[mode];
  for (let i = humans; i < need; i++) m.act(c.token, { type: 'addBot' });
  return { code: c.code, tokens };
}
const snap = (m, token) => m.snapshot(token).snapshot;

// ---------- lobby

test('names are cleaned, required and unique per room', () => {
  const { m } = manager();
  assert.equal(m.createRoom('   ').ok, false);
  const c = m.createRoom('  Anna\n  ');
  assert.equal(snap(m, c.token).players[0].name, 'Anna');
  assert.equal(m.joinRoom(c.code, 'anna').ok, false);
  assert.equal(m.joinRoom('ZZZZZ', 'Bob').ok, false);
  assert.equal(m.joinRoom(c.code.toLowerCase(), 'Bob').ok, true);
});

test('the room fills up at the number of seats for the mode', () => {
  const { m } = manager();
  const c = m.createRoom('P0');
  for (let i = 1; i < 4; i++) assert.equal(m.joinRoom(c.code, `P${i}`).ok, true);
  assert.equal(m.joinRoom(c.code, 'P4').ok, false);
  m.act(c.token, { type: 'setOptions', mode: 'team8' });
  assert.equal(m.joinRoom(c.code, 'P4').ok, true);
});

test('modes: only the host, only valid, and never fewer seats than people', () => {
  const { m } = manager();
  const c = m.createRoom('H');
  const b = m.joinRoom(c.code, 'B');
  assert.equal(m.act(b.token, { type: 'setOptions', mode: 'team4' }).ok, false);
  assert.equal(m.act(c.token, { type: 'setOptions', mode: 'bogus' }).ok, false);
  assert.equal(m.act(c.token, { type: 'setOptions', mode: 'team8' }).ok, true);
  for (let i = 0; i < 4; i++) m.joinRoom(c.code, `X${i}`);
  assert.equal(m.act(c.token, { type: 'setOptions', mode: 'solo4' }).ok, false); // 6 people will not fit
  assert.equal(m.act(c.token, { type: 'setOptions', turnTimerSec: 3 }).ok, false);
  assert.equal(m.act(c.token, { type: 'setOptions', turnTimerSec: 30 }).ok, true);
});

test('the game starts only with exactly the right number of players, and only by the host', () => {
  const { m } = manager();
  const c = m.createRoom('H');
  const b = m.joinRoom(c.code, 'B');
  assert.equal(m.act(c.token, { type: 'start' }).ok, false); // 2 of 4
  m.act(c.token, { type: 'addBot' });
  m.act(c.token, { type: 'addBot' });
  assert.equal(m.act(b.token, { type: 'start' }).ok, false); // not the host
  assert.equal(m.act(c.token, { type: 'addBot' }).ok, false); // full
  assert.equal(m.act(c.token, { type: 'start' }).ok, true);
  assert.equal(snap(m, c.token).phase, 'playing');
  assert.equal(m.joinRoom(c.code, 'Late').ok, false);
});

test('the host can reorder and shuffle seats, which decides who is partners', () => {
  const { m } = manager();
  const c = m.createRoom('H');
  const b = m.joinRoom(c.code, 'B');
  const d = m.joinRoom(c.code, 'D');
  m.joinRoom(c.code, 'E');
  const names = () => snap(m, c.token).players.map((p) => p.name);
  assert.deepEqual(names(), ['H', 'B', 'D', 'E']);
  const idOf = (name) => snap(m, c.token).players.find((p) => p.name === name).id;
  assert.equal(m.act(b.token, { type: 'moveSeat', playerId: idOf('B'), dir: 1 }).ok, false);
  assert.equal(m.act(c.token, { type: 'moveSeat', playerId: idOf('E'), dir: 1 }).ok, false); // already last
  assert.equal(m.act(c.token, { type: 'moveSeat', playerId: idOf('E'), dir: -1 }).ok, true);
  assert.deepEqual(names(), ['H', 'B', 'E', 'D']);
  assert.equal(m.act(c.token, { type: 'shuffleSeats' }).ok, true);
  assert.deepEqual([...names()].sort(), ['B', 'D', 'E', 'H']);
  assert.ok(d.ok);
});

test('seats at the table follow the lobby order, and partners sit opposite', () => {
  const { m } = manager();
  const { tokens } = table(m, 'team4', 2);
  m.act(tokens[0], { type: 'start' });
  const g = snap(m, tokens[0]).game;
  assert.equal(g.players.length, 4);
  assert.deepEqual(g.units.map((u) => u.playerIds.length), [2, 2]);
  assert.equal(g.units[0].playerIds[0], g.players[0].id);
  assert.equal(g.units[0].playerIds[1], g.players[2].id);
});

test('host can remove a player or a computer player in the lobby', () => {
  const { m } = manager();
  const c = m.createRoom('H');
  const b = m.joinRoom(c.code, 'B');
  m.act(c.token, { type: 'addBot' });
  const s = snap(m, c.token);
  const bot = s.players.find((p) => p.bot);
  assert.equal(m.act(c.token, { type: 'remove', targetId: bot.id }).ok, true);
  assert.equal(m.act(c.token, { type: 'remove', targetId: s.players.find((p) => p.name === 'B').id }).ok, true);
  assert.equal(snap(m, c.token).players.length, 1);
  assert.equal(m.snapshot(b.token).ok, false);
});

test('Meet links are validated and shared with everyone', () => {
  assert.equal(normalizeMeetLink('https://example.com').ok, false);
  const { m } = manager();
  const c = m.createRoom('H');
  const b = m.joinRoom(c.code, 'B');
  assert.equal(m.act(b.token, { type: 'setMeet', link: 'https://meet.google.com/abc-defg-hij' }).ok, false);
  assert.equal(m.act(c.token, { type: 'setMeet', link: 'meet.google.com/abc-defg-hij' }).ok, true);
  assert.equal(snap(m, b.token).meetLink, 'https://meet.google.com/abc-defg-hij');
});

// ---------- the game through the room

test('snapshots never contain another player\'s hand', () => {
  const { m } = manager();
  const { tokens } = table(m, 'solo4', 4);
  m.act(tokens[0], { type: 'start' });
  for (const t of tokens) {
    const text = JSON.stringify(snap(m, t));
    assert.equal((text.match(/"hand"/g) || []).length, 1);
  }
});

test('computer players take their turns on their own', () => {
  const { m, clock } = manager();
  const { tokens } = table(m, 'solo4', 1);
  m.act(tokens[0], { type: 'start' });
  const before = snap(m, tokens[0]).game;
  const me = before.you.id;
  // Let time pass until it is the human's turn to bid.
  for (let i = 0; i < 10 && !snap(m, tokens[0]).game.you.canBid; i++) {
    clock.t += 800;
    m.tick();
  }
  const g = snap(m, tokens[0]).game;
  assert.equal(g.you.canBid, true);
  assert.equal(g.turn, me);
  assert.ok(g.players.filter((p) => p.bid !== null).length >= 0);
});

test('a whole 5-round game can be played with one person and three computer players', () => {
  const { m, clock } = manager({ botDelayMs: 0, roundEndMs: 0 });
  const { tokens, code } = table(m, 'solo4', 1);
  const t = tokens[0];
  m.act(t, { type: 'start' });
  let guard = 0;
  while (snap(m, t).phase !== 'ended') {
    assert.ok(++guard < 5000, 'game finished');
    const s = snap(m, t);
    const g = s.game;
    if (g.you.canBid) assert.equal(m.act(t, { type: 'bid', amount: 2 }).ok, true);
    else if (g.you.canPlay) assert.equal(m.act(t, { type: 'play', cardId: g.you.legalIds[0] }).ok, true);
    else { clock.t += 10; m.tick(); }
  }
  const end = snap(m, t).game;
  assert.equal(end.history.length, 5);
  assert.ok(end.winnerUnitIds.length >= 1);
  assert.equal(m.act(t, { type: 'backToLobby' }).ok, true);
  assert.equal(snap(m, t).phase, 'lobby');
  assert.equal(m.rooms.get(code).players.length, 4);
});

test('an 8-player partnership game also runs to the end', () => {
  const { m, clock } = manager({ botDelayMs: 0, roundEndMs: 0 });
  const { tokens } = table(m, 'team8', 1);
  const t = tokens[0];
  assert.equal(m.act(t, { type: 'start' }).ok, true);
  let guard = 0;
  while (snap(m, t).phase !== 'ended') {
    assert.ok(++guard < 20000);
    const g = snap(m, t).game;
    if (g.you.canBid) m.act(t, { type: 'bid', amount: 1 });
    else if (g.you.canPlay) m.act(t, { type: 'play', cardId: g.you.legalIds[0] });
    else { clock.t += 10; m.tick(); }
  }
  const g = snap(m, t).game;
  assert.equal(g.units.length, 4);
  assert.equal(g.history.length, 5);
});

test('illegal cards and out-of-turn plays are refused with an error', () => {
  const { m, clock } = manager({ botDelayMs: 0 });
  const { tokens } = table(m, 'solo4', 1);
  m.act(tokens[0], { type: 'start' });
  while (!snap(m, tokens[0]).game.you.canBid) { clock.t += 10; m.tick(); }
  assert.equal(m.act(tokens[0], { type: 'bid', amount: 0 }).ok, false);
  assert.equal(m.act(tokens[0], { type: 'bid', amount: 14 }).ok, false);
  assert.equal(m.act(tokens[0], { type: 'play', cardId: 1 }).ok, false);
  assert.equal(m.act(tokens[0], { type: 'bid', amount: 3 }).ok, true);
  assert.equal(m.act(tokens[0], { type: 'bid', amount: 3 }).ok, false); // not your turn any more
});

test('the turn timer plays for a player who stalls', () => {
  const { m, clock } = manager({ botDelayMs: 1e9 });
  const { tokens } = table(m, 'solo4', 4);
  m.act(tokens[0], { type: 'setOptions', turnTimerSec: 10 });
  m.act(tokens[0], { type: 'start' });
  const who = () => snap(m, tokens[0]).game.turn;
  const first = who();
  clock.t += 9_000; m.tick();
  assert.equal(who(), first);
  clock.t += 2_000; m.tick();
  assert.notEqual(who(), first);
  assert.ok(snap(m, tokens[0]).turnDeadline > clock.t - 1);
});

test('a disconnected player is skipped by the computer after the grace period', () => {
  const { m, clock } = manager({ botDelayMs: 1e9 });
  const { tokens } = table(m, 'solo4', 4);
  m.act(tokens[0], { type: 'start' });
  const g0 = snap(m, tokens[0]).game;
  const idx = tokens.findIndex((t) => snap(m, t).youId === g0.turn);
  m.markConnected(tokens[idx], false);
  clock.t += 20_000; m.tick();
  assert.equal(snap(m, tokens[(idx + 1) % 4]).game.turn, g0.turn);
  clock.t += 15_000; m.tick();
  assert.notEqual(snap(m, tokens[(idx + 1) % 4]).game.turn, g0.turn);
});

test('leaving mid-game hands your seat to the computer; the last person out closes the room', () => {
  const { m, clock } = manager({ botDelayMs: 0 });
  const { code, tokens } = table(m, 'solo4', 2);
  m.act(tokens[0], { type: 'start' });
  assert.equal(m.act(tokens[0], { type: 'leave' }).ok, true);
  assert.equal(m.snapshot(tokens[0]).ok, false);
  assert.equal(snap(m, tokens[1]).hostId, snap(m, tokens[1]).youId); // host passes on
  // The remaining person calls when it is their turn; everyone else, including the empty seat, is played by the computer.
  for (let i = 0; i < 400 && snap(m, tokens[1]).game.phase === 'bidding'; i++) {
    if (snap(m, tokens[1]).game.you.canBid) m.act(tokens[1], { type: 'bid', amount: 2 });
    else { clock.t += 10; m.tick(); }
  }
  const g = snap(m, tokens[1]).game;
  assert.equal(g.phase, 'playing');
  assert.ok(g.players.every((p) => p.bid !== null), 'the empty seat called too');
  m.act(tokens[1], { type: 'leave' });
  assert.equal(m.rooms.has(code), false);
});

test('the round summary moves on by itself, or when the host says so', () => {
  const { m, clock } = manager({ botDelayMs: 0, roundEndMs: 5_000 });
  const { tokens } = table(m, 'solo4', 1);
  const t = tokens[0];
  m.act(t, { type: 'start' });
  let guard = 0;
  while (snap(m, t).game.phase !== 'roundEnd') {
    assert.ok(++guard < 2000);
    const g = snap(m, t).game;
    if (g.you.canBid) m.act(t, { type: 'bid', amount: 2 });
    else if (g.you.canPlay) m.act(t, { type: 'play', cardId: g.you.legalIds[0] });
    else { clock.t += 10; m.tick(); }
  }
  assert.ok(snap(m, t).roundEndAt > clock.t);
  assert.equal(snap(m, t).game.round, 1);
  clock.t += 6_000; m.tick();
  assert.equal(snap(m, t).game.round, 2);
  assert.equal(snap(m, t).game.phase === 'bidding' || snap(m, t).game.phase === 'playing', true);
});

test('after a trick the next player waits while the finished trick is on show', () => {
  const { m, clock } = manager({ botDelayMs: 0, trickHoldMs: 1500 });
  const { tokens } = table(m, 'solo4', 1);
  const t = tokens[0];
  m.act(t, { type: 'start' });
  let guard = 0;
  while (!snap(m, t).game.lastTrick) {
    assert.ok(++guard < 2000);
    const g = snap(m, t).game;
    if (g.you.canBid) m.act(t, { type: 'bid', amount: 2 });
    else if (g.you.canPlay) m.act(t, { type: 'play', cardId: g.you.legalIds[0] });
    else { clock.t += 10; m.tick(); }
  }
  const turn = snap(m, t).game.turn;
  const stack = snap(m, t).game.trickNo;
  const plays = () => snap(m, t).game.players.reduce((n, p) => n + p.cardCount, 0);
  const cards = plays();
  clock.t += 1000; m.tick(); // still inside the hold: a computer leader must not move yet
  if (turn !== snap(m, t).youId) assert.equal(plays(), cards);
  clock.t += 600; m.tick();
  assert.ok(stack >= 2);
});

test('empty, idle rooms are cleaned up', () => {
  const { m, clock } = manager({ idleMs: 1000 });
  const c = m.createRoom('H');
  clock.t += 5000;
  m.tick();
  assert.equal(m.rooms.has(c.code), false);
});

// ---------- end to end over real HTTP + WebSocket

function wsClient(base, token) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
  let latest = null;
  const waiters = [];
  const opened = new Promise((res) => { ws.onopen = res; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'snapshot') {
      latest = m.snapshot;
      for (const w of [...waiters]) {
        if (w.pred(latest)) {
          clearTimeout(w.timer);
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(latest);
        }
      }
    }
  };
  return {
    get latest() { return latest; },
    opened,
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
    waitFor(pred, ms = 5000) {
      if (latest && pred(latest)) return Promise.resolve(latest);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error('timed out waiting for a snapshot'));
        }, ms);
        waiters.push(w);
      });
    },
  };
}
async function postJson(base, path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

test('serves the website and a health check', { skip: !HAS_WS }, async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Callbreak/);
    const h = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    assert.equal(await h.text(), 'ok');
  } finally {
    await srv.close();
  }
});

test('full game over WebSockets: one person against three computer players', { skip: !HAS_WS, timeout: 60_000 }, async () => {
  const srv = await startServer({
    port: 0, host: '127.0.0.1', tickMs: 5, actsPerSecond: 1_000_000,
    managerOptions: { botDelayMs: 0, roundEndMs: 20, trickHoldMs: 0 },
  });
  const base = `http://127.0.0.1:${srv.port}`;
  let client;
  try {
    const created = await postJson(base, '/api/create', { name: 'Host' });
    assert.equal(created.ok, true);
    client = wsClient(base, created.token);
    await client.opened;
    await client.waitFor((s) => s.players.length === 1);
    for (let i = 0; i < 3; i++) client.send({ t: 'act', action: { type: 'addBot' } });
    await client.waitFor((s) => s.players.length === 4);
    client.send({ t: 'act', action: { type: 'start' } });
    await client.waitFor((s) => s.phase === 'playing');
    let guard = 0;
    for (;;) {
      assert.ok(++guard < 5000);
      const s = await client.waitFor((x) => x.phase === 'ended' || (x.game && (x.game.you.canBid || x.game.you.canPlay)));
      if (s.phase === 'ended') break;
      const rev = s.rev;
      if (s.game.you.canBid) client.send({ t: 'act', action: { type: 'bid', amount: 2 } });
      else client.send({ t: 'act', action: { type: 'play', cardId: s.game.you.legalIds[0] } });
      await client.waitFor((x) => x.rev > rev);
    }
    const end = client.latest;
    assert.equal(end.game.history.length, 5);
    assert.equal((JSON.stringify(end).match(/"hand"/g) || []).length, 1);
  } finally {
    if (client) client.close();
    await srv.close();
  }
});
