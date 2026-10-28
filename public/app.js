(() => {
'use strict';

// ------------------------------------------------------------------ constants and state

const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const SUIT_ORDER = ['S', 'H', 'C', 'D']; // black, red, black, red
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const RANK_WORD = { 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
const MODES = {
  solo4: { label: 'Standard', seats: 4, teams: false, blurb: '4 players, everyone for themselves.' },
  team4: { label: 'Partnership', seats: 4, teams: true, blurb: '4 players in 2 teams. Partners sit opposite and their calls add up.' },
  team8: { label: 'Partnership, 8 players', seats: 8, teams: true, blurb: '8 players in 4 teams of two, with two decks shuffled together.' },
};
const TEAM_LETTERS = ['A', 'B', 'C', 'D'];
const HUES = [340, 18, 44, 150, 186, 212, 266, 300];

const root = document.getElementById('app');
const fx = document.getElementById('fx');
const offlineBanner = document.getElementById('offline');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let session = loadSession();
let snap = null;
let ws = null;
let skew = 0;
let homeName = '';
let homeCode = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 5);
let meetDraft = null;
let muted = false;
try { muted = localStorage.getItem('callbreak.muted') === '1'; } catch { /* storage unavailable */ }

// game screen state
let gameBuilt = false;
let els = {};
let seatEls = {};
let bulbEls = [];
let seatPos = {};
let trickEls = new Map();
let lastHandSig = '';
let selectedCard = null;
let bidChoice = null;
let shownKey = null;
let finished = null; // a completed trick that is still on show: { lt, timer }
let scoresOpen = false;
let overlayHidden = null; // key of the round summary the player closed
let timerHandle = null;

// ------------------------------------------------------------------ helpers

function loadSession() { try { return JSON.parse(localStorage.getItem('callbreak.session')); } catch { return null; } }
function saveSession(s) {
  session = s;
  try { if (s) localStorage.setItem('callbreak.session', JSON.stringify(s)); else localStorage.removeItem('callbreak.session'); } catch { /* ignore */ }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const $ = (sel, scope = document) => scope.querySelector(sel);
const rankLabel = (r) => RANK_LABEL[r] || String(r);
const cardName = (c) => `${RANK_WORD[c.rank] || c.rank} of ${SUIT_NAME[c.suit]}`;
const isRed = (c) => c.suit === 'H' || c.suit === 'D';
const fmt = (p) => (Number.isInteger(p) ? String(p) : p.toFixed(1));

function hueFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

function toast(msg) {
  fx.querySelectorAll('.toast').forEach((old) => old.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  fx.appendChild(t);
  setTimeout(() => t.classList.add('out'), 2800);
  setTimeout(() => t.remove(), 3300);
}

async function post(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, error: 'Cannot reach the server.' }; }
}

const EMBLEM = '<svg class="emblem" viewBox="0 0 80 64" aria-hidden="true"><path d="M10 46C8 30 12 16 6 8c12 4 22 16 34 26z" fill="#6a30b8" stroke="#f6c744" stroke-width="2.5" stroke-linejoin="round"/><path d="M70 46c2-16-2-30 4-38-12 4-22 16-34 26z" fill="#6a30b8" stroke="#f6c744" stroke-width="2.5" stroke-linejoin="round"/><path d="M26 46C30 30 36 16 40 4c4 12 10 26 14 42z" fill="#1aa862" stroke="#f6c744" stroke-width="2.5" stroke-linejoin="round"/><rect x="8" y="44" width="64" height="12" rx="6" fill="#f6c744" stroke="#b87a14" stroke-width="2"/><path d="M20 50l4-4 4 4-4 4zM36 50l4-4 4 4-4 4zM52 50l4-4 4 4-4 4z" fill="#6a30b8"/><circle cx="6" cy="8" r="4.5" fill="#ffe9a0" stroke="#b87a14" stroke-width="1.5"/><circle cx="74" cy="8" r="4.5" fill="#ffe9a0" stroke="#b87a14" stroke-width="1.5"/><circle cx="40" cy="4" r="4.5" fill="#ffe9a0" stroke="#b87a14" stroke-width="1.5"/></svg>';
const wordmark = (cls = '') => `<div class="wordmark ${cls}">${EMBLEM}<div class="wm-text"><span class="wm-joker">Joker</span><span class="wm-call">Callbreak</span></div></div>`;

// ------------------------------------------------------------------ sound (synthesised, no files)

let actx = null;
function audio() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function tone(freq, dur = 0.12, type = 'sine', gain = 0.08, delay = 0, slide = 0) {
  if (muted) return;
  const c = audio();
  if (!c) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.03);
}
const sfx = {
  play() { tone(230, 0.08, 'triangle', 0.14, 0, -90); },
  call() { tone(520, 0.07, 'sine', 0.07); },
  turn() { tone(660, 0.14, 'sine', 0.09); tone(880, 0.22, 'sine', 0.09, 0.13); },
  win() { tone(523, 0.12, 'triangle', 0.09); tone(784, 0.2, 'triangle', 0.09, 0.1); },
  round() { tone(392, 0.16, 'triangle', 0.09); tone(523, 0.16, 'triangle', 0.09, 0.14); tone(659, 0.16, 'triangle', 0.09, 0.28); tone(784, 0.34, 'triangle', 0.1, 0.42); },
};
document.addEventListener('pointerdown', () => { audio(); }, { passive: true });

// ------------------------------------------------------------------ connection

function connect() {
  if (ws) { ws.onclose = null; ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(session.token)}`);
  ws.onopen = () => { offlineBanner.hidden = true; };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'snapshot') {
      const prev = snap;
      snap = m.snapshot;
      skew = snap.serverNow - Date.now();
      render(prev);
    } else if (m.t === 'kicked') leaveLocal(m.reason);
    else if (m.t === 'error') toast(m.error);
  };
  ws.onclose = () => {
    if (!session) return;
    offlineBanner.hidden = false;
    setTimeout(() => { if (session) connect(); }, 1500);
  };
}

function leaveLocal(msg) {
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  saveSession(null);
  snap = null;
  selectedCard = null;
  gameBuilt = false;
  finished = null;
  offlineBanner.hidden = true;
  document.title = 'JokerCallbreak';
  render(null);
  if (msg) toast(msg);
}

function send(action) {
  if (!ws || ws.readyState !== 1) { toast('Not connected. Trying to reconnect…'); return; }
  ws.send(JSON.stringify({ t: 'act', action }));
}

// ------------------------------------------------------------------ top-level render

function render(prev) {
  if (!session) { gameBuilt = false; renderHome(); return; }
  if (!snap) { gameBuilt = false; root.innerHTML = '<div class="home"><p class="lede">Connecting…</p></div>'; return; }
  if (snap.phase === 'lobby') {
    if (gameBuilt) { gameBuilt = false; selectedCard = null; finished = null; }
    renderLobby();
    return;
  }
  if (!gameBuilt) buildGame();
  updateGame(prev);
}

// ------------------------------------------------------------------ home

function renderHome() {
  const invited = homeCode.length === 5;
  root.innerHTML = `
  <div class="home">
    <div class="marquee">
      ${wordmark('big')}
      <div class="suits" aria-hidden="true">♠<span class="r">♥</span>♣<span class="r">♦</span></div>
      <p class="lede">Call your tricks, win them, and keep spades close. Four or eight players, solo or in teams.</p>
    </div>
    <label class="label">Your name
      <input class="field" id="name" maxlength="20" autocomplete="nickname" placeholder="What should we call you?" value="${esc(homeName)}">
    </label>
    ${invited ? `
      <div class="invite">You have been invited to room <b>${esc(homeCode)}</b>.</div>
      <button class="btn primary big" data-a="join">Join the room</button>
      <button class="linkish" data-a="own">Start my own room instead</button>
    ` : `
      <button class="btn primary big" data-a="create">Create a room</button>
      <div class="divider">or join a friend's room</div>
      <div class="joinrow">
        <input class="field" id="code" maxlength="5" autocomplete="off" placeholder="CODE" value="${esc(homeCode)}">
        <button class="btn" data-a="join">Join</button>
      </div>
    `}
  </div>`;
}

// ------------------------------------------------------------------ lobby

function seatRowHtml(i, p, isHost, mode, half, count) {
  const team = mode.teams ? `<span class="tbadge" data-team="${i % half}">${TEAM_LETTERS[i % half]}</span>` : '';
  if (!p) {
    return `<div class="seatrow empty"><span class="num">${i + 1}</span><div class="who"><b>${team}Empty seat</b><small>Waiting for a friend or a computer player</small></div><span></span></div>`;
  }
  const tags = [p.isHost ? 'Host' : '', p.id === snap.youId ? 'You' : '', p.bot ? 'Computer' : '', !p.bot && !p.connected ? 'Offline' : ''].filter(Boolean).join(', ');
  const ctl = isHost ? `<div class="ctl">
      <button class="mini-btn" data-a="moveSeat" data-id="${p.id}" data-dir="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="mini-btn" data-a="moveSeat" data-id="${p.id}" data-dir="1" aria-label="Move down" ${i === count - 1 ? 'disabled' : ''}>↓</button>
      ${p.id !== snap.youId ? `<button class="mini-btn rm" data-a="remove" data-id="${p.id}" aria-label="Remove">✕</button>` : ''}
    </div>` : '<span></span>';
  return `<div class="seatrow"><span class="num">${i + 1}</span><div class="who"><b>${team}${esc(p.name)}</b><small>${tags || '&nbsp;'}</small></div>${ctl}</div>`;
}

function meetPanelHtml(isHost) {
  const link = snap.meetLink;
  const join = link ? `<a class="btn primary" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Join video call</a>` : '';
  if (isHost) {
    const value = meetDraft !== null ? meetDraft : (link || '');
    return `<div class="meetrow"><input class="field" id="meetInput" autocomplete="off" placeholder="https://meet.google.com/abc-defg-hij" value="${esc(value)}"><button class="btn small" data-a="meet-save">Save</button></div>
      <div class="row">${join}<a class="linkish" href="https://meet.new" target="_blank" rel="noopener noreferrer">Create a new Meet</a></div>
      <p class="hint">Create a Meet, copy its link, paste it here, and everyone gets a join button. Meet opens in its own tab. On a phone, use the Meet app.</p>`;
  }
  return link
    ? `<div class="row">${join}</div><p class="hint">Meet opens in its own tab. On a phone, use the Meet app.</p>`
    : '<p class="hint">The host has not added a video link yet.</p>';
}

function renderLobby() {
  const isHost = snap.hostId === snap.youId;
  const o = snap.options;
  const mode = MODES[o.mode];
  const need = snap.required;
  const half = need / 2;
  const link = `${location.origin}/?room=${snap.code}`;
  const full = snap.players.length === need;
  const rows = Array.from({ length: need }, (_, i) => seatRowHtml(i, snap.players[i], isHost, mode, half, snap.players.length)).join('');
  const modeCards = Object.entries(MODES).map(([id, m]) =>
    `<button class="modecard ${o.mode === id ? 'on' : ''}" data-a="mode" data-v="${id}" ${isHost ? '' : 'disabled'}><b>${m.label}</b><span>${m.blurb}</span></button>`).join('');
  const timers = [[0, 'Off'], [15, '15 s'], [30, '30 s'], [60, '1 min'], [120, '2 min']];
  const timerSeg = `<div class="seg">${timers.map(([v, l]) => `<button data-a="timer" data-v="${v}" class="${o.turnTimerSec === v ? 'on' : ''}" ${isHost ? '' : 'disabled'}>${l}</button>`).join('')}</div>`;
  root.innerHTML = `
  <div class="lobby">
    ${wordmark('mini')}
    <h2>Waiting room</h2>
    <div class="codetiles" aria-label="Room code ${esc(snap.code)}">${[...snap.code].map((ch) => `<span>${esc(ch)}</span>`).join('')}</div>
    <div class="row"><button class="btn small" data-a="copy" data-text="${esc(link)}">Copy invite link</button></div>
    <div class="panel"><h3>Game mode</h3><div class="modes">${modeCards}</div></div>
    <div class="panel">
      <h3>Seats (${snap.players.length} of ${need})</h3>
      ${rows}
      ${mode.teams ? '<p class="hint">Partners sit opposite each other. Seats with the same letter are partners.</p>' : ''}
      ${isHost ? `<div class="row"><button class="btn small" data-a="addBot" ${full ? 'disabled' : ''}>Add computer player</button><button class="btn small" data-a="shuffle">Shuffle seats</button></div>` : ''}
    </div>
    <div class="panel"><h3>Video call</h3>${meetPanelHtml(isHost)}</div>
    <div class="panel"><h3>Turn timer</h3>${timerSeg}<p class="hint">${isHost ? 'If a player runs out of time, the computer plays for them.' : 'Only the host can change these.'}</p></div>
    <div class="row">
      ${isHost ? `<button class="btn primary" data-a="start" ${full ? '' : 'disabled'}>Start game</button>` : '<span class="hint">Waiting for the host to start…</span>'}
      <button class="btn" data-a="leave">Leave</button>
    </div>
    ${full ? '' : `<p class="hint" style="text-align:center">This mode needs exactly ${need} players. Invite friends or add computer players.</p>`}
  </div>`;
}

// ------------------------------------------------------------------ game: build

function buildGame() {
  gameBuilt = true;
  seatEls = {};
  bulbEls = [];
  trickEls = new Map();
  seatPos = {};
  lastHandSig = '';
  shownKey = null;
  finished = null;
  scoresOpen = false;
  root.innerHTML = `
  <div class="game">
    <header class="topbar">
      ${wordmark('mini')}
      <button class="code-chip" data-a="copy" id="codeChip" title="Copy invite link"><span>Room</span><b></b></button>
      <span class="roundtag" id="roundTag"></span>
      <span class="trumptag" title="Spades are always trump"><span style="color:#fff">♠</span> <span class="tt">Trump</span></span>
      <div class="grow"></div>
      <span id="meetSlot"></span>
      <button class="icon-btn" data-a="scores">Scores</button>
      <button class="icon-btn" data-a="sound" id="soundBtn"></button>
      <button class="icon-btn" data-a="leave">Leave</button>
    </header>
    <main class="stage">
      <div class="table-wrap" id="tableWrap">
        <div class="rim" id="rim"><div class="felt"></div><div class="bulbs" id="bulbs"></div></div>
        <div class="center" id="center"><div class="centertext" id="centerText"></div></div>
        <div id="trickLayer"></div>
        <div id="seats"></div>
      </div>
    </main>
    <section class="dock" id="dock">
      <div class="status" id="status"></div>
      <div class="chips" id="bidbox" hidden>${Array.from({ length: 13 }, (_, i) => `<button class="chip" data-a="bidpick" data-n="${i + 1}" aria-label="Call ${i + 1}">${i + 1}</button>`).join('')}</div>
      <div class="hand" id="hand"></div>
      <div class="actions" id="actions"><button class="btn primary" id="btnMain" data-a="main">Pick a card</button></div>
    </section>
    <div class="results" id="scoresPanel" hidden></div>
    <div class="results" id="results" hidden></div>
  </div>`;
  els = {
    wrap: $('#tableWrap'), rim: $('#rim'), seats: $('#seats'), center: $('#center'), centerText: $('#centerText'),
    layer: $('#trickLayer'), status: $('#status'), bidbox: $('#bidbox'), hand: $('#hand'), actions: $('#actions'),
    btnMain: $('#btnMain'), scores: $('#scoresPanel'), results: $('#results'), chip: $('#codeChip'),
    sound: $('#soundBtn'), roundTag: $('#roundTag'),
  };
  new ResizeObserver(() => { if (gameBuilt) { layoutSeats(); layoutHand(); } }).observe(els.wrap);
}

// ------------------------------------------------------------------ game: update

const nameOf = (id) => { const p = snap.players.find((x) => x.id === id); return p ? p.name : '?'; };

function updateGame(prev) {
  const g = snap.game;
  $('b', els.chip).textContent = snap.code;
  els.chip.dataset.text = `${location.origin}/?room=${snap.code}`;
  els.roundTag.textContent = `Round ${g.round} of ${g.rounds}`;
  els.sound.textContent = muted ? 'Muted' : 'Sound';
  updateMeetSlot();

  const lt = g.lastTrick;
  const key = lt ? `${g.round}:${lt.no}` : null;
  const live = !!(prev && prev.game);
  const newTrick = key && key !== shownKey;
  if (newTrick && live) holdFinishedTrick(lt);
  shownKey = key;

  updateSeats();
  updateCenter();
  updateStatus();
  updateHand();
  updateControls();
  renderTrickLayer();
  updateOverlays();
  if (live) detectEvents(prev, newTrick);

  document.title = g.turn === snap.youId && (g.phase === 'bidding' || g.phase === 'playing') ? 'Your turn - JokerCallbreak' : 'JokerCallbreak';
}

function updateMeetSlot() {
  const isHost = snap.hostId === snap.youId;
  const link = snap.meetLink;
  let html = '';
  if (link) {
    html = `<a class="icon-btn meet" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Video</a>`;
    if (isHost) html += ' <button class="icon-btn" data-a="meet-edit">Edit</button>';
  } else if (isHost) html = '<button class="icon-btn meet" data-a="meet-edit">Add video</button>';
  const slot = $('#meetSlot');
  if (slot.dataset.html !== html) { slot.innerHTML = html; slot.dataset.html = html; }
}

function seatTemplate(id) {
  const el = document.createElement('div');
  el.className = 'seat';
  el.dataset.id = id;
  el.style.setProperty('--h', hueFor(id));
  el.innerHTML = '<div class="tile"><div class="face"><span class="initial"></span></div><span class="tally"></span><span class="dealer" hidden>D</span><span class="badge" hidden></span></div><div class="plate"></div>';
  return el;
}

function updateSeats() {
  const g = snap.game;
  const info = Object.fromEntries(snap.players.map((p) => [p.id, p]));
  const teams = MODES[g.mode].teams;
  const seen = new Set();
  for (const p of g.players) {
    seen.add(p.id);
    let el = seatEls[p.id];
    if (!el) { el = seatEls[p.id] = seatTemplate(p.id); els.seats.appendChild(el); }
    const pi = info[p.id] || {};
    const computer = pi.bot || pi.gone;
    const away = !computer && pi.connected === false;
    let badge = '';
    if (pi.gone) badge = 'Auto'; // a player who left; the computer plays their seat
    else if (away) badge = 'Offline';

    // calls and tricks won
    let text;
    let cls = 'tally';
    if (g.phase === 'bidding') {
      if (p.bid !== null) { text = String(p.bid); cls += ' done'; } else { text = g.turn === p.id ? '…' : '–'; cls += ' wait'; }
    } else {
      text = `${p.tricks}/${p.bid}`;
      if (p.tricks > p.bid) cls += ' over';
      else if (p.tricks === p.bid) cls += ' done';
    }
    el.classList.toggle('turn', g.turn === p.id);
    el.classList.toggle('me', p.id === snap.youId);
    el.classList.toggle('away', away);
    if (teams) el.dataset.team = String(p.unit); else delete el.dataset.team;
    $('.initial', el).textContent = p.name.charAt(0).toUpperCase();
    $('.plate', el).textContent = p.name;
    const tally = $('.tally', el);
    tally.className = cls;
    tally.textContent = text;
    tally.title = p.bid === null ? 'No call yet' : `Called ${p.bid}, won ${p.tricks}`;
    $('.dealer', el).hidden = g.dealerId !== p.id;
    const b = $('.badge', el);
    b.hidden = !badge;
    b.textContent = badge;
    el.setAttribute('aria-label', `${p.name}${p.bid !== null ? `, called ${p.bid}, won ${p.tricks}` : ''}`);
  }
  for (const id of Object.keys(seatEls)) if (!seen.has(id)) { seatEls[id].remove(); delete seatEls[id]; }
  layoutSeats();
}

function layoutSeats() {
  if (!snap || !snap.game || !els.wrap) return;
  const w = els.wrap.clientWidth;
  const h = els.wrap.clientHeight;
  if (!w || !h) return;
  const ps = snap.game.players;
  const n = ps.length;
  const meIdx = Math.max(0, ps.findIndex((p) => p.id === snap.youId));
  const crowd = n > 6;
  let tileW = clamp(Math.floor(Math.min(w * (crowd ? 0.105 : 0.13), h * (crowd ? 0.19 : 0.23))), 40, 100);
  let seatH = tileW * 1.1 + 26;
  let rx = 0;
  let ry = 0;
  for (let i = 0; i < 4; i++) {
    rx = Math.max(60, w / 2 - tileW / 2 - 20);
    ry = Math.max(50, h / 2 - seatH / 2 - 4);
    const room = 2 * ry * Math.sin(Math.PI / n) * 0.94 - 26;
    const fit = clamp(Math.floor(room / 1.1), 40, tileW);
    if (fit >= tileW) break;
    tileW = fit;
    seatH = tileW * 1.1 + 26;
  }
  rx = Math.min(rx, ry * 2.7);
  els.wrap.style.setProperty('--tile-w', `${tileW}px`);
  els.wrap.style.setProperty('--tc', `${clamp(Math.floor(tileW * 0.62), 34, 64)}px`);
  Object.assign(els.rim.style, { left: `${w / 2 - rx}px`, top: `${h / 2 - ry}px`, width: `${rx * 2}px`, height: `${ry * 2}px` });
  layoutBulbs(rx, ry);
  seatPos = { cx: w / 2, cy: h / 2 };
  for (let k = 0; k < n; k++) {
    const p = ps[(meIdx + k) % n];
    const a = Math.PI / 2 - (k * 2 * Math.PI) / n; // counter-clockwise: the player to your right comes next
    const x = w / 2 + rx * Math.cos(a);
    const y = h / 2 + ry * Math.sin(a);
    seatPos[p.id] = { x, y };
    const el = seatEls[p.id];
    if (!el) continue;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.zIndex = String(10 + Math.round(Math.sin(a) * 5));
  }
  renderTrickLayer();
}

function layoutBulbs(rx, ry) {
  const holder = $('#bulbs');
  if (!holder) return;
  const ring = clamp(Math.round(Math.min(rx, ry) * 0.12), 16, 30);
  els.rim.style.setProperty('--ring', `${ring}px`);
  const a = rx - ring / 2;
  const b = ry - ring / 2;
  const perimeter = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  let n = Math.round(perimeter / (ring * 1.1));
  n = clamp(n - (n % 2), 24, 90);
  while (bulbEls.length < n) {
    const d = document.createElement('i');
    d.className = 'bulb';
    holder.appendChild(d);
    bulbEls.push(d);
  }
  while (bulbEls.length > n) bulbEls.pop().remove();
  holder.style.setProperty('--bulb', `${Math.max(6, Math.round(ring * 0.4))}px`);
  bulbEls.forEach((el, i) => {
    const t = (i / n) * 2 * Math.PI;
    el.style.left = `${rx + a * Math.cos(t)}px`;
    el.style.top = `${ry + b * Math.sin(t)}px`;
    el.classList.toggle('b', i % 2 === 1);
  });
}

function updateCenter() {
  const g = snap.game;
  const teams = MODES[g.mode].teams;
  let html = '';
  if (g.phase === 'bidding') {
    const made = g.players.filter((p) => p.bid !== null).length;
    html = `Round ${g.round}<small>${made} of ${g.players.length} calls made</small>`;
  } else if (g.phase === 'playing') {
    html = `Trick ${g.trickNo} of 13`;
    if (teams) {
      html += `<small>${g.units.map((u, i) => `<span style="color:var(--team${i})">${TEAM_LETTERS[i]}</span> ${u.won}/${u.call}`).join(' &nbsp; ')}</small>`;
    }
  } else if (g.phase === 'roundEnd') html = `Round ${g.round} complete`;
  els.centerText.innerHTML = html;
}

function updateStatus() {
  const g = snap.game;
  const you = g.you;
  let text;
  if (g.phase === 'ended') text = 'Game over';
  else if (g.phase === 'roundEnd') text = `Round ${g.round} is complete.`;
  else if (you && you.canBid) text = 'Your call: how many tricks will you win?';
  else if (you && you.canPlay) text = g.trick.length === 0 ? 'You lead. Play any card.' : 'Your turn. The cards you may play are lit.';
  else if (g.phase === 'bidding') text = `${nameOf(g.turn)} is calling…`;
  else text = `${nameOf(g.turn)} is playing…`;
  els.status.innerHTML = `${esc(text)}<span class="timer" id="timerText"></span>`;
  startTimer();
}

function startTimer() {
  clearInterval(timerHandle);
  const el = $('#timerText');
  if (!el || !snap.turnDeadline) return;
  const tick = () => {
    const left = Math.max(0, Math.ceil((snap.turnDeadline - (Date.now() + skew)) / 1000));
    el.textContent = `${left}s left`;
  };
  tick();
  timerHandle = setInterval(tick, 500);
}

// ------------------------------------------------------------------ hand

function cardInner(c) {
  const s = SUIT[c.suit];
  return `<span class="idx tl"><b>${rankLabel(c.rank)}</b><i>${s}</i></span><span class="pip">${s}</span><span class="idx br"><b>${rankLabel(c.rank)}</b><i>${s}</i></span>`;
}

function sortedHand(hand) {
  return [...hand].sort((a, b) => SUIT_ORDER.indexOf(a.suit) - SUIT_ORDER.indexOf(b.suit) || b.rank - a.rank);
}

function updateHand() {
  const g = snap.game;
  const you = g.you;
  const show = you && you.hand.length > 0 && (g.phase === 'bidding' || g.phase === 'playing');
  els.hand.hidden = !show;
  if (!show) { lastHandSig = ''; return; }
  const hand = sortedHand(you.hand);
  const legal = new Set(you.legalIds);
  if (selectedCard !== null && !legal.has(selectedCard)) selectedCard = null;
  const sig = `${hand.map((c) => c.id).join(',')}|${selectedCard}|${you.canPlay}|${[...legal].join(',')}`;
  if (sig === lastHandSig) return;
  lastHandSig = sig;
  const n = hand.length;
  els.hand.innerHTML = hand.map((c, i) => {
    const t = n > 1 ? (i - (n - 1) / 2) / ((n - 1) / 2) : 0;
    const rot = (t * Math.min(6, n * 0.5)).toFixed(1);
    const dy = (t * t * 7).toFixed(1);
    const state = you.canPlay ? (legal.has(c.id) ? 'ok' : 'dim') : '';
    const sel = c.id === selectedCard ? 'sel' : '';
    return `<button class="card ${isRed(c) ? 'red' : ''} ${state} ${sel}" data-a="card" data-id="${c.id}" style="--rot:${rot}deg;--dy:${dy}" aria-label="${cardName(c)}" aria-pressed="${!!sel}">${cardInner(c)}</button>`;
  }).join('');
  layoutHand();
}

function layoutHand() {
  if (!els.hand || els.hand.hidden) return;
  const cards = els.hand.querySelectorAll('.card');
  if (!cards.length) return;
  const cw = cards[0].offsetWidth;
  const avail = els.hand.clientWidth - 20;
  const n = cards.length;
  let step = n > 1 ? Math.min(cw + 8, (avail - cw) / (n - 1)) : cw;
  step = Math.max(step, 22);
  els.hand.style.setProperty('--step', step.toFixed(1));
}

function updateControls() {
  const g = snap.game;
  const you = g.you;
  if (!you) return;
  els.bidbox.hidden = !you.canBid;
  if (you.canBid) for (const chip of els.bidbox.children) chip.classList.toggle('on', Number(chip.dataset.n) === bidChoice);
  else if (!you.canBid && g.phase !== 'bidding') bidChoice = null;
  const btn = els.btnMain;
  if (you.canBid) {
    els.actions.hidden = false;
    btn.textContent = bidChoice ? `Call ${bidChoice}` : 'Pick your call';
    btn.disabled = !bidChoice;
  } else if (you.canPlay) {
    els.actions.hidden = false;
    const c = you.hand.find((x) => x.id === selectedCard);
    btn.textContent = c ? `Play ${rankLabel(c.rank)}${SUIT[c.suit]}` : 'Pick a card';
    btn.disabled = !c;
  } else els.actions.hidden = true;
}

// ------------------------------------------------------------------ cards on the table

function trickCardPos(playerId) {
  const sp = seatPos[playerId];
  if (!sp) return { x: seatPos.cx || 0, y: seatPos.cy || 0 };
  return { x: seatPos.cx + (sp.x - seatPos.cx) * 0.52, y: seatPos.cy + (sp.y - seatPos.cy) * 0.38 };
}

function renderTrickLayer() {
  if (!snap || !snap.game || !els.layer) return;
  const list = finished ? finished.lt.cards : snap.game.trick;
  const winnerId = finished ? finished.lt.winnerId : null;
  const keep = new Set();
  list.forEach((t, i) => {
    keep.add(t.card.id);
    let el = trickEls.get(t.card.id);
    if (!el) {
      el = document.createElement('div');
      el.className = `card tcard ${isRed(t.card) ? 'red' : ''}`;
      el.innerHTML = cardInner(t.card);
      el.style.setProperty('--r', `${((i * 37) % 13) - 6}deg`);
      els.layer.appendChild(el);
      trickEls.set(t.card.id, el);
    }
    const pos = trickCardPos(t.playerId);
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    el.classList.toggle('win', t.playerId === winnerId);
  });
  for (const [id, el] of trickEls) if (!keep.has(id)) { el.remove(); trickEls.delete(id); }
}

// A finished trick stays on the table for a moment, then sweeps to its winner.
function holdFinishedTrick(lt) {
  if (finished) clearTimeout(finished.timer);
  const hold = reduceMotion ? 700 : 1450;
  finished = { lt, timer: setTimeout(() => sweepFinishedTrick(), hold) };
}

function sweepFinishedTrick() {
  if (!finished) return;
  const winner = seatPos[finished.lt.winnerId];
  if (winner && !reduceMotion) {
    for (const el of trickEls.values()) {
      el.animate([{ opacity: 1 }, { left: `${winner.x}px`, top: `${winner.y}px`, opacity: 0, transform: 'translate(-50%, -50%) scale(0.35)' }], { duration: 380, easing: 'ease-in', fill: 'forwards' });
    }
    setTimeout(endFinished, 380);
  } else endFinished();
}

function endFinished() {
  finished = null;
  if (!snap || !gameBuilt) return;
  renderTrickLayer();
  updateOverlays();
}

// ------------------------------------------------------------------ sounds for what just happened

function detectEvents(prev, newTrick) {
  const g = snap.game;
  const pg = prev.game;
  if (g.round !== pg.round) { sfx.round(); return; }
  if (g.trick.length > pg.trick.length || newTrick) sfx.play();
  else if (g.players.filter((p) => p.bid !== null).length > pg.players.filter((p) => p.bid !== null).length) sfx.call();
  if (newTrick && g.lastTrick.winnerId === snap.youId) setTimeout(() => sfx.win(), 250);
  if (g.turn === snap.youId && pg.turn !== snap.youId && (g.phase === 'bidding' || g.phase === 'playing')) setTimeout(() => sfx.turn(), newTrick ? 600 : 0);
  if (g.phase === 'roundEnd' && pg.phase !== 'roundEnd') setTimeout(() => sfx.round(), 1500);
}

// ------------------------------------------------------------------ scores and results

function unitName(g, i) {
  const members = g.units[i].playerIds.map(nameOf);
  if (!MODES[g.mode].teams) return { html: esc(members[0]), plain: members[0], sub: '' };
  return { html: `<span class="dot" data-team="${i}"></span>Team ${TEAM_LETTERS[i]}`, plain: `Team ${TEAM_LETTERS[i]}`, sub: members.join(' + ') };
}
const nameCell = (g, i) => { const u = unitName(g, i); return `<td class="name">${u.html}${u.sub ? `<small>${esc(u.sub)}</small>` : ''}</td>`; };
const pts = (p) => `<span class="${p < 0 ? 'neg' : ''}">${fmt(p)}</span>`;
const myUnit = (g) => g.you ? g.you.unit : -1;

function scoresTableHtml(g) {
  const head = Array.from({ length: g.rounds }, (_, r) => `<th>R${r + 1}</th>`).join('');
  const rows = g.units.map((u, i) => {
    const cells = Array.from({ length: g.rounds }, (_, r) => {
      const done = g.history[r];
      if (done) return `<td>${pts(done.rows[i].points)}</td>`;
      if (g.phase !== 'ended' && r + 1 === g.round && u.call !== null) return `<td style="color:var(--muted)">${u.won}/${u.call}</td>`;
      return '<td style="color:var(--muted)">·</td>';
    }).join('');
    return `<tr class="${i === myUnit(g) ? 'me' : ''}">${nameCell(g, i)}${cells}<td class="total">${pts(u.score)}</td></tr>`;
  }).join('');
  return `<table class="stable"><thead><tr><th></th>${head}<th>Total</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function roundTableHtml(g, entry, winners) {
  const order = g.units.map((u, i) => i).sort((a, b) => g.units[b].score - g.units[a].score);
  const rows = order.map((i) => {
    const r = entry.rows[i];
    const win = winners && winners.includes(g.units[i].id);
    return `<tr class="${win ? 'win' : i === myUnit(g) ? 'me' : ''}">${nameCell(g, i)}<td>${r.call}</td><td>${r.won}</td><td>${pts(r.points)}</td><td class="total">${pts(r.total)}</td></tr>`;
  }).join('');
  return `<table class="stable"><thead><tr><th></th><th>Call</th><th>Won</th><th>Points</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function updateOverlays() {
  if (!snap || !snap.game || !gameBuilt) return;
  const g = snap.game;
  const isHost = snap.hostId === snap.youId;

  if (scoresOpen) {
    els.scores.innerHTML = `<div class="box"><h2>Scores</h2><p class="sub">${g.rounds} rounds. Highest total wins.</p>${scoresTableHtml(g)}<div class="row"><button class="btn" data-a="closeScores">Close</button></div></div>`;
    els.scores.hidden = false;
  } else els.scores.hidden = true;

  const key = `${g.round}:${g.phase}`;
  const wait = !!finished; // let the last trick finish its sweep first
  if (!wait && g.phase === 'roundEnd' && overlayHidden !== key) {
    const entry = g.history[g.history.length - 1];
    els.results.innerHTML = `<div class="box"><h2>Round ${g.round} complete</h2>${roundTableHtml(g, entry, null)}
      <p class="sub" id="countdown"></p>
      <div class="row">${isHost ? '<button class="btn primary" data-a="nextRound">Next round</button>' : ''}<button class="btn" data-a="hideRound">Look at the table</button></div></div>`;
    els.results.hidden = false;
    startCountdown();
  } else if (!wait && g.phase === 'ended' && overlayHidden !== key) {
    const entry = g.history[g.history.length - 1];
    const winners = g.winnerUnitIds;
    const names = winners.map((id) => { const i = g.units.findIndex((u) => u.id === id); const u = unitName(g, i); return MODES[g.mode].teams ? `${u.plain} (${u.sub})` : u.plain; });
    els.results.innerHTML = `<div class="box"><h2>Game over</h2><p class="sub">${winners.length > 1 ? 'Shared win' : 'Winner'}: ${esc(names.join(' and '))}</p>${roundTableHtml(g, entry, winners)}
      <p class="sub">Final scores after ${g.rounds} rounds.</p>
      <div class="row">${isHost ? '<button class="btn primary" data-a="back">Play again</button>' : '<span class="hint">Waiting for the host…</span>'}<button class="btn" data-a="hideRound">Look at the table</button><button class="btn" data-a="leave">Leave</button></div></div>`;
    els.results.hidden = false;
  } else els.results.hidden = true;
}

function startCountdown() {
  const el = $('#countdown');
  if (!el) return;
  const tick = () => {
    if (!snap || !snap.roundEndAt) { el.textContent = ''; return; }
    const left = Math.max(0, Math.ceil((snap.roundEndAt - (Date.now() + skew)) / 1000));
    el.textContent = `Next round starts in ${left}s`;
  };
  tick();
  clearInterval(startCountdown.h);
  startCountdown.h = setInterval(() => { if (!$('#countdown')) clearInterval(startCountdown.h); else tick(); }, 500);
}

// ------------------------------------------------------------------ events

document.addEventListener('input', (e) => {
  if (e.target.id === 'name') homeName = e.target.value;
  if (e.target.id === 'meetInput') meetDraft = e.target.value;
  if (e.target.id === 'code') { homeCode = e.target.value.toUpperCase(); e.target.value = homeCode; }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'meetInput') { send({ type: 'setMeet', link: e.target.value }); meetDraft = null; return; }
  if (e.target.id === 'name' || e.target.id === 'code') {
    const btn = document.querySelector('[data-a="join"], [data-a="create"]');
    if (btn) btn.click();
  }
});

async function enterRoom(r) {
  if (!r.ok) { toast(r.error); return; }
  saveSession({ code: r.code, token: r.token });
  history.replaceState(null, '', location.pathname);
  homeCode = '';
  connect();
  render(null);
}

function playSelected() {
  const g = snap && snap.game;
  if (!g || !g.you || !g.you.canPlay || selectedCard === null) return;
  send({ type: 'play', cardId: selectedCard });
  selectedCard = null;
  lastHandSig = '';
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const a = b.dataset.a;
  switch (a) {
    case 'create':
    case 'join': {
      const name = homeName.trim();
      if (!name) { toast('Enter your name first.'); const n = $('#name'); if (n) n.focus(); return; }
      if (a === 'join' && homeCode.length !== 5) { toast('Room codes have 5 letters.'); return; }
      b.disabled = true;
      const r = a === 'create' ? await post('/api/create', { name }) : await post('/api/join', { name, code: homeCode });
      b.disabled = false;
      await enterRoom(r);
      break;
    }
    case 'own': homeCode = ''; history.replaceState(null, '', location.pathname); renderHome(); break;
    case 'copy': {
      const text = b.dataset.text || `${location.origin}/?room=${snap.code}`;
      try { await navigator.clipboard.writeText(text); toast('Invite link copied.'); } catch { prompt('Copy this link:', text); }
      break;
    }
    case 'mode': send({ type: 'setOptions', mode: b.dataset.v }); break;
    case 'timer': send({ type: 'setOptions', turnTimerSec: Number(b.dataset.v) }); break;
    case 'addBot': send({ type: 'addBot' }); break;
    case 'shuffle': send({ type: 'shuffleSeats' }); break;
    case 'moveSeat': send({ type: 'moveSeat', playerId: b.dataset.id, dir: Number(b.dataset.dir) }); break;
    case 'remove': send({ type: 'remove', targetId: b.dataset.id }); break;
    case 'meet-save': {
      const inp = $('#meetInput');
      send({ type: 'setMeet', link: inp ? inp.value : '' });
      meetDraft = null;
      if (inp && !inp.value.trim()) toast('Video link removed.');
      break;
    }
    case 'meet-edit': {
      const next = prompt('Paste your Google Meet link (leave empty to remove it):', snap.meetLink || 'https://meet.google.com/');
      if (next !== null) send({ type: 'setMeet', link: next });
      break;
    }
    case 'start': send({ type: 'start' }); break;
    case 'nextRound': send({ type: 'nextRound' }); break;
    case 'back': send({ type: 'backToLobby' }); break;
    case 'hideRound': overlayHidden = `${snap.game.round}:${snap.game.phase}`; els.results.hidden = true; break;
    case 'scores': scoresOpen = true; updateOverlays(); break;
    case 'closeScores': scoresOpen = false; updateOverlays(); break;
    case 'leave': {
      if (snap && snap.phase === 'playing' && !confirm('Leave the game? A computer player will take your seat.')) return;
      send({ type: 'leave' });
      setTimeout(() => leaveLocal(''), 120);
      break;
    }
    case 'sound':
      muted = !muted;
      try { localStorage.setItem('callbreak.muted', muted ? '1' : '0'); } catch { /* ignore */ }
      els.sound.textContent = muted ? 'Muted' : 'Sound';
      break;
    case 'bidpick': bidChoice = Number(b.dataset.n); updateControls(); break;
    case 'card': {
      const you = snap.game.you;
      const id = Number(b.dataset.id);
      if (!you.canPlay) { toast(snap.game.phase === 'bidding' ? 'Make your calls first.' : 'Wait for your turn.'); return; }
      if (!you.legalIds.includes(id)) { toast('You cannot play that card now. Follow suit, beat the trick if you can, then spades, then anything.'); return; }
      if (selectedCard === id) { playSelected(); return; }
      selectedCard = id;
      updateHand();
      updateControls();
      break;
    }
    case 'main': {
      const you = snap.game.you;
      if (you.canBid && bidChoice) { send({ type: 'bid', amount: bidChoice }); bidChoice = null; }
      else if (you.canPlay) playSelected();
      break;
    }
    default: break;
  }
});

render(null);
if (session) connect();
})();
