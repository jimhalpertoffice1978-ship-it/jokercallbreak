// Room manager: lobbies, seating, bots, the game and its timers. No networking in here, so it is easy to test.
import { randomBytes, randomInt } from 'node:crypto';
import {
  MODES, createGame, nextRound, applyBid, applyPlay, autoBid, autoPlay, viewFor,
} from './callbreak.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O (look like 1 and 0)
const MAX_NAME = 20;
const ROUND_END_MS = 20_000; // how long the round summary stays before the next deal

const fail = (error) => ({ ok: false, error });

// Only genuine Google Meet links are accepted, and the stored link is rebuilt from the
// matched code, so nothing else a player types can ever be shown to the others.
export function normalizeMeetLink(raw) {
  if (raw === null || raw === undefined) return { ok: true, link: null };
  if (typeof raw !== 'string') return { ok: false };
  let s = raw.trim();
  if (!s) return { ok: true, link: null };
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false };
  }
  if (u.hostname !== 'meet.google.com') return { ok: false };
  const code = u.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i);
  if (code) return { ok: true, link: `https://meet.google.com/${code[1].toLowerCase()}` };
  const lookup = u.pathname.match(/^\/lookup\/([A-Za-z0-9_-]{4,64})\/?$/);
  if (lookup) return { ok: true, link: `https://meet.google.com/lookup/${lookup[1]}` };
  return { ok: false };
}

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return n.length ? n : null;
}

export class RoomManager {
  constructor(opts = {}) {
    this.now = opts.now || Date.now;
    this.gameRng = opts.gameRng; // optional seeded rng, for tests
    this.graceMs = opts.graceMs ?? 30_000; // how long a disconnected player may hold up the table
    this.botDelayMs = opts.botDelayMs ?? 700; // bots think for a moment so people can follow the game
    this.roundEndMs = opts.roundEndMs ?? ROUND_END_MS;
    this.trickHoldMs = opts.trickHoldMs ?? 1600; // a finished trick stays on the table this long
    this.idleMs = opts.idleMs ?? 2 * 60 * 60 * 1000; // empty rooms are deleted after this
    this.onChange = opts.onChange || (() => {});
    this.onRoomDeleted = opts.onRoomDeleted || (() => {});
    this.rooms = new Map(); // code -> room
    this.tokens = new Map(); // secret token -> { code, playerId }
  }

  // ------------------------------------------------------------ lookups

  _auth(token) {
    const t = this.tokens.get(token);
    if (!t) return null;
    const room = this.rooms.get(t.code);
    if (!room) {
      this.tokens.delete(token);
      return null;
    }
    const player = room.players.find((p) => p.id === t.playerId && !p.gone);
    return player ? { room, player } : null;
  }

  _touch(room) {
    room.rev += 1;
    room.lastActivity = this.now();
    this.onChange(room.code);
  }

  _newCode() {
    for (let i = 0; i < 200; i++) {
      let code = '';
      for (let k = 0; k < 5; k++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Could not allocate a room code.');
  }

  _required(room) {
    return MODES[room.options.mode].players;
  }

  _addPlayer(room, name, bot = false) {
    const player = {
      id: randomBytes(4).toString('hex'),
      name,
      connected: bot,
      disconnectedAt: this.now(),
      gone: false,
      bot,
    };
    room.players.push(player);
    if (bot) return { player, token: null };
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, { code: room.code, playerId: player.id });
    return { player, token };
  }

  // ------------------------------------------------------------ create / join

  createRoom(rawName) {
    const name = cleanName(rawName);
    if (!name) return fail('Enter a name (1 to 20 characters).');
    const room = {
      code: this._newCode(),
      hostId: null,
      players: [],
      options: { mode: 'solo4', turnTimerSec: 0 },
      meetLink: null,
      phase: 'lobby', // lobby | playing | ended
      game: null,
      turnStartedAt: null,
      roundEndAt: null,
      rev: 0,
      lastActivity: this.now(),
    };
    const { player, token } = this._addPlayer(room, name);
    room.hostId = player.id;
    this.rooms.set(room.code, room);
    return { ok: true, code: room.code, token, playerId: player.id };
  }

  joinRoom(rawCode, rawName) {
    const name = cleanName(rawName);
    if (!name) return fail('Enter a name (1 to 20 characters).');
    const code = String(rawCode || '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return fail('No room with that code.');
    if (room.phase !== 'lobby') return fail('That game has already started.');
    if (room.players.length >= this._required(room)) return fail(`The room is full (${this._required(room)} players for this mode).`);
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return fail('That name is taken in this room. Pick another.');
    }
    const { player, token } = this._addPlayer(room, name);
    this._touch(room);
    return { ok: true, code: room.code, token, playerId: player.id };
  }

  // ------------------------------------------------------------ connection state

  markConnected(token, connected) {
    const a = this._auth(token);
    if (!a) return false;
    a.player.connected = connected;
    if (!connected) a.player.disconnectedAt = this.now();
    this._touch(a.room);
    return true;
  }

  // ------------------------------------------------------------ snapshots

  snapshot(token) {
    const a = this._auth(token);
    if (!a) return fail('Session expired. Please join again.');
    const { room, player } = a;
    const timerMs = room.options.turnTimerSec * 1000;
    const g = room.game;
    const acting = room.phase === 'playing' && g && (g.phase === 'bidding' || g.phase === 'playing');
    return {
      ok: true,
      snapshot: {
        rev: room.rev,
        code: room.code,
        youId: player.id,
        hostId: room.hostId,
        phase: room.phase,
        options: room.options,
        required: this._required(room),
        meetLink: room.meetLink,
        players: room.players.map((p) => ({
          id: p.id, name: p.name, connected: p.connected, isHost: p.id === room.hostId, gone: p.gone, bot: p.bot,
        })),
        game: g ? viewFor(g, player.id) : null,
        serverNow: this.now(),
        turnDeadline: acting && timerMs > 0 ? room.turnStartedAt + timerMs : null,
        roundEndAt: g && g.phase === 'roundEnd' ? room.roundEndAt : null,
      },
    };
  }

  // ------------------------------------------------------------ actions

  act(token, msg) {
    const a = this._auth(token);
    if (!a) return fail('Session expired. Please join again.');
    if (!msg || typeof msg !== 'object') return fail('Invalid message.');
    const { room, player } = a;
    const isHost = room.hostId === player.id;

    switch (msg.type) {
      case 'setOptions': {
        if (!isHost) return fail('Only the host can change settings.');
        if (room.phase !== 'lobby') return fail('Settings are locked once the game starts.');
        const next = { ...room.options };
        if ('mode' in msg) {
          if (!MODES[msg.mode]) return fail('Unknown game mode.');
          if (room.players.length > MODES[msg.mode].players) {
            return fail(`That mode seats ${MODES[msg.mode].players} players. Remove some players first.`);
          }
          next.mode = msg.mode;
        }
        if ('turnTimerSec' in msg) {
          const t = msg.turnTimerSec;
          if (!(t === 0 || (Number.isInteger(t) && t >= 10 && t <= 300))) return fail('Turn timer must be off or 10 to 300 seconds.');
          next.turnTimerSec = t;
        }
        room.options = next;
        this._touch(room);
        return { ok: true };
      }

      case 'setMeet': {
        if (!isHost) return fail('Only the host can set the video link.');
        const m = normalizeMeetLink(msg.link);
        if (!m.ok) return fail('That is not a Google Meet link. It should look like https://meet.google.com/abc-defg-hij');
        room.meetLink = m.link;
        this._touch(room);
        return { ok: true };
      }

      case 'addBot': {
        if (!isHost) return fail('Only the host can add a computer player.');
        if (room.phase !== 'lobby') return fail('Computer players can only be added in the waiting room.');
        if (room.players.length >= this._required(room)) return fail('All seats are taken.');
        let n = 1;
        while (room.players.some((p) => p.name === `Bot ${n}`)) n += 1;
        this._addPlayer(room, `Bot ${n}`, true);
        this._touch(room);
        return { ok: true };
      }

      case 'moveSeat': {
        if (!isHost) return fail('Only the host can arrange seats.');
        if (room.phase !== 'lobby') return fail('Seats are locked once the game starts.');
        const i = room.players.findIndex((p) => p.id === msg.playerId);
        const j = i + (msg.dir === -1 ? -1 : 1);
        if (i < 0 || j < 0 || j >= room.players.length) return fail('Cannot move that player.');
        [room.players[i], room.players[j]] = [room.players[j], room.players[i]];
        this._touch(room);
        return { ok: true };
      }

      case 'shuffleSeats': {
        if (!isHost) return fail('Only the host can arrange seats.');
        if (room.phase !== 'lobby') return fail('Seats are locked once the game starts.');
        for (let i = room.players.length - 1; i > 0; i--) {
          const j = randomInt(i + 1);
          [room.players[i], room.players[j]] = [room.players[j], room.players[i]];
        }
        this._touch(room);
        return { ok: true };
      }

      case 'start': {
        if (!isHost) return fail('Only the host can start the game.');
        if (room.phase !== 'lobby') return fail('The game has already started.');
        const need = this._required(room);
        if (room.players.length !== need) return fail(`This mode needs exactly ${need} players. Add friends or computer players.`);
        room.game = createGame(
          room.players.map((p) => ({ id: p.id, name: p.name })),
          { mode: room.options.mode, rng: this.gameRng },
        );
        room.phase = 'playing';
        room.turnStartedAt = this.now();
        room.roundEndAt = null;
        this._touch(room);
        return { ok: true };
      }

      case 'bid': {
        if (room.phase !== 'playing') return fail('The game is not in progress.');
        const r = this._apply(room, () => applyBid(room.game, player.id, msg.amount));
        if (!r.ok) return r;
        this._touch(room);
        return { ok: true };
      }

      case 'play': {
        if (room.phase !== 'playing') return fail('The game is not in progress.');
        const r = this._apply(room, () => applyPlay(room.game, player.id, msg.cardId));
        if (!r.ok) return r;
        this._touch(room);
        return { ok: true };
      }

      case 'nextRound': {
        if (!isHost) return fail('Only the host can start the next round.');
        if (!room.game || room.game.phase !== 'roundEnd') return fail('The round is not finished yet.');
        this._advanceRound(room);
        this._touch(room);
        return { ok: true };
      }

      case 'remove': {
        if (!isHost) return fail('Only the host can remove players.');
        const target = room.players.find((p) => p.id === msg.targetId && !p.gone);
        if (!target) return fail('That player is not in the room.');
        if (target.id === player.id) return fail('Use Leave to leave the room yourself.');
        this._removeFromRoom(room, target);
        return { ok: true };
      }

      case 'leave': {
        this._removeFromRoom(room, player);
        return { ok: true };
      }

      case 'backToLobby': {
        if (!isHost) return fail('Only the host can do that.');
        if (room.phase !== 'ended') return fail('The game is not over yet.');
        room.players = room.players.filter((p) => !p.gone);
        room.game = null;
        room.phase = 'lobby';
        room.turnStartedAt = null;
        room.roundEndAt = null;
        this._touch(room);
        return { ok: true };
      }

      default:
        return fail('Unknown action.');
    }
  }

  // Runs an engine action and keeps the room's bookkeeping in step.
  _apply(room, fn) {
    const trickKey = (g) => (g && g.lastTrick ? `${g.round}:${g.lastTrick.no}` : null);
    const before = trickKey(room.game);
    const r = fn();
    if (!r.ok) return r;
    room.game = r.state;
    const finishedTrick = trickKey(room.game) !== before && trickKey(room.game) !== null;
    // After a trick, the next player's clock starts once the finished trick has been on show.
    room.turnStartedAt = this.now() + (finishedTrick ? this.trickHoldMs : 0);
    if (room.game.phase === 'roundEnd') room.roundEndAt = this.now() + this.roundEndMs;
    if (room.game.phase === 'ended') room.phase = 'ended';
    return r;
  }

  _advanceRound(room) {
    const r = nextRound(room.game, this.gameRng);
    if (!r.ok) return;
    room.game = r.state;
    room.turnStartedAt = this.now();
    room.roundEndAt = null;
  }

  // Leaving or being removed. Mid-game, a computer player takes over the seat.
  _removeFromRoom(room, target) {
    for (const [tok, t] of this.tokens) {
      if (t.code === room.code && t.playerId === target.id) this.tokens.delete(tok);
    }
    target.connected = false;
    if (room.phase === 'lobby') {
      room.players = room.players.filter((p) => p.id !== target.id);
    } else {
      target.gone = true; // the seat stays, played by the computer
    }
    const humans = room.players.filter((p) => !p.gone && !p.bot);
    if (humans.length === 0) {
      this._deleteRoom(room);
      return;
    }
    if (room.hostId === target.id) room.hostId = humans[0].id;
    this._touch(room);
  }

  _deleteRoom(room) {
    this.rooms.delete(room.code);
    for (const [tok, t] of this.tokens) if (t.code === room.code) this.tokens.delete(tok);
    this.onRoomDeleted(room.code);
  }

  // ------------------------------------------------------------ timers (call several times a second)

  tick() {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (room.phase === 'playing' && room.game) {
        const g = room.game;
        if (g.phase === 'roundEnd') {
          if (room.roundEndAt && now >= room.roundEndAt) {
            this._advanceRound(room);
            this._touch(room);
          }
        } else if (g.phase === 'bidding' || g.phase === 'playing') {
          const seat = g.players[g.turnIdx];
          const p = room.players.find((x) => x.id === seat.id);
          if (p) {
            const waited = now - room.turnStartedAt;
            const timerMs = room.options.turnTimerSec * 1000;
            const timedOut = timerMs > 0 && waited >= timerMs;
            const since = Math.max(room.turnStartedAt, p.disconnectedAt || 0);
            const absent = !p.connected && now - since >= this.graceMs;
            const computer = (p.bot || p.gone) && waited >= this.botDelayMs;
            if (timedOut || absent || computer) this._autoAct(room, p.id);
          }
        }
      }
      const anyoneOnline = room.players.some((p) => p.connected && !p.gone && !p.bot);
      if (!anyoneOnline && now - room.lastActivity > this.idleMs) this._deleteRoom(room);
    }
  }

  _autoAct(room, playerId) {
    const g = room.game;
    const r = g.phase === 'bidding'
      ? this._apply(room, () => applyBid(g, playerId, autoBid(g, playerId)))
      : this._apply(room, () => applyPlay(g, playerId, autoPlay(g, playerId)));
    if (r.ok) this._touch(room);
  }
}
