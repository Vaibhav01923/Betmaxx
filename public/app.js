'use strict';
// Core: api, auth, router, lobby, wallet. Game UIs live in games-ui.js and register on B.games.
const B = { games: {}, me: null, cfg: {}, cleanup: null };
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const usd = (c) => '$' + (c / 100).toFixed(2);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
Object.assign(B, { $, $$, usd, esc, wait });

B.api = async (path, body) => {
  const r = await fetch('/api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Request failed'); e.status = r.status; throw e; }
  return d;
};
// call: POST that toasts errors and returns null on failure
B.call = async (path, body = {}) => {
  if (!B.me) { B.openAuth('login'); return null; }
  try { return await B.api(path, body); }
  catch (e) { if (e.status === 401) { B.me = null; B.renderUser(); B.openAuth('login'); } else B.toast(e.message, true); return null; }
};
B.toast = (msg, bad) => {
  const d = document.createElement('div'); d.textContent = msg; if (bad) d.className = 'bad';
  $('#toast').append(d); setTimeout(() => d.remove(), 3500);
};
B.setBal = (c) => { if (B.me) B.me.balance = c; $('#bal').textContent = usd(c); $('#wBal').textContent = usd(c); };
B.betBox = (id, val = '1.00') => `<label>Bet Amount<div class="betrow"><span class="cur">$</span><input id="${id}" type="number" min="0.1" step="0.01" value="${val}"><button type="button" class="mini" data-act="half">½</button><button type="button" class="mini" data-act="dbl">2×</button></div></label>`;
B.wireBet = (root) => $$('[data-act]', root).forEach((b) => (b.onclick = () => {
  const i = b.closest('.betrow').querySelector('input'), v = (+i.value || 0) * (b.dataset.act === 'half' ? 0.5 : 2);
  i.value = Math.max(0.1, Math.min(B.cfg.maxBet, v)).toFixed(2);
}));
B.result = (el, r) => { el.className = 'msg ' + (r.win ? 'win' : 'lose'); el.textContent = r.win ? `You won ${usd(r.payout)} (${(r.payout / r.stake).toFixed(2)}×)` : r.payout > 0 ? `Returned ${usd(r.payout)}` : `You lost ${usd(r.stake)}`; };

// ---- boot / user ----
B.renderUser = () => {
  const on = !!B.me;
  $('#loginBtn').hidden = $('#signupBtn').hidden = on;
  $('#userbox').hidden = $('#balpill').hidden = $('#walletBtn').hidden = !on;
  if (on) { $('#uname').textContent = B.me.username; B.setBal(B.me.balance); }
};
B.boot = async () => {
  const d = await B.api('me');
  B.me = d.user; B.cfg = d;
  if (d.provider === 'demo') { $('#banner').hidden = false; $('#banner').textContent = 'DEMO MODE — deposits and withdrawals are simulated, no real crypto moves.'; }
  $('#fMax').textContent = '$' + d.maxBet; $('#fWin').textContent = '$' + d.maxPayout.toLocaleString();
  B.renderUser();
  window.addEventListener('hashchange', route); route();
};

// ---- auth ----
let authMode = 'login';
B.openAuth = (mode) => {
  authMode = mode;
  $('#authTitle').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('#ageRow').hidden = mode === 'login'; $('#authErr').textContent = '';
  $('#authDlg').showModal();
};
$('#loginBtn').onclick = () => B.openAuth('login');
$('#signupBtn').onclick = () => B.openAuth('signup');
$('#authCancel').onclick = () => $('#authDlg').close();
$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const d = await B.api(authMode === 'login' ? 'login' : 'register', { username: f.get('username'), password: f.get('password'), age: f.get('age') === 'on' });
    B.me = d.user; B.renderUser(); $('#authDlg').close(); route();
    if (authMode === 'signup') openWallet('dep');
  } catch (err) { $('#authErr').textContent = err.message; }
};
$('#outBtn').onclick = async () => { await B.api('logout', {}); B.me = null; B.renderUser(); location.hash = '#/'; route(); };

// ---- router ----
function route() {
  if (B.cleanup) { try { B.cleanup(); } catch {} B.cleanup = null; }
  const h = location.hash.replace(/^#\/?/, '');
  $$('#rail a[data-r]').forEach((a) => a.classList.toggle('on', a.dataset.r === (h === 'bets' ? 'bets' : 'home')));
  const view = $('#view');
  window.scrollTo(0, 0);
  if (h.startsWith('game/') && B.games[h.slice(5)]) return gamePage(view, h.slice(5));
  if (h === 'bets') return betsPage(view);
  lobby(view);
}
function gamePage(view, id) {
  const g = B.games[id];
  view.innerHTML = `<div class="gamehead"><a href="#/">← Casino</a><h1>${g.name}</h1><span class="rtp">RTP ${g.rtp}</span></div>
    <div class="game"><div class="panel" id="gpanel"></div><div class="stage" id="gstage"></div></div>
    <h2 class="sec">Live bets</h2><table id="feed"><thead><tr><th>Player</th><th>Game</th><th>Stake</th><th>Payout</th></tr></thead><tbody></tbody></table>`;
  B.cleanup = g.mount($('#gpanel'), $('#gstage'), B);
  loadFeed();
}
const CATS = [['all', 'All Games'], ['instant', 'Instant'], ['strategy', 'Strategy'], ['table', 'Table'], ['slots', 'Slots']];
let cat = 'all', q = '';
function lobby(view) {
  const promos = [
    ['Instant crypto deposits', 'BTC, ETH, USDT, LTC and SOL — credited after network confirmation.', 'linear-gradient(135deg,#7c3aed,#2563eb)', 'dep'],
    ['99% RTP originals', 'Most games return 99% over time. House edge is shown on every game.', 'linear-gradient(135deg,#059669,#0d9488)', ''],
    ['Withdraw to your wallet', 'Request a payout to your own address once you have played through your deposit.', 'linear-gradient(135deg,#d97706,#dc2626)', 'wd'],
  ];
  view.innerHTML = `<div class="promos">${promos.map(([t, d, bg, w]) => `<div class="promo" data-w="${w}"><div class="pic" style="background:${bg}">${B.games.dice.art}</div><div><div class="tag">BetMaxx</div><b>${t}</b><span>${d}</span></div></div>`).join('')}</div>
    <label class="search"><svg viewBox="0 0 24 24"><path d="M10 2a8 8 0 1 0 5 14.3l5 5 1.4-1.4-5-5A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z"/></svg><input id="q" placeholder="Search games" value="${esc(q)}"></label>
    <div class="pills">${CATS.map(([k, n]) => `<button data-c="${k}" class="${k === cat ? 'on' : ''}">${n}</button>`).join('')}</div>
    <div class="grid" id="grid"></div>
    <h2 class="sec">Live bets</h2><table id="feed"><thead><tr><th>Player</th><th>Game</th><th>Stake</th><th>Payout</th></tr></thead><tbody></tbody></table>`;
  const draw = () => {
    const list = Object.entries(B.games).filter(([, g]) => (cat === 'all' || g.cat === cat) && g.name.toLowerCase().includes(q.toLowerCase()));
    $('#grid').innerHTML = list.map(([id, g]) => `<a class="tile" href="#/game/${id}"><div class="art" style="background:${g.bg}">${g.art}<h3>${g.name}</h3><small>BETMAXX ORIGINALS</small></div><div class="meta"><i></i>RTP ${g.rtp}</div></a>`).join('') || '<p class="muted">No games match.</p>';
  };
  draw();
  $('#q').oninput = (e) => { q = e.target.value; draw(); };
  $$('.pills button').forEach((b) => (b.onclick = () => { cat = b.dataset.c; $$('.pills button').forEach((x) => x.classList.toggle('on', x === b)); draw(); }));
  $$('.promo').forEach((p) => (p.onclick = () => p.dataset.w && (B.me ? openWallet(p.dataset.w) : B.openAuth('signup'))));
  loadFeed();
}
async function loadFeed() {
  const feed = await B.api('feed').catch(() => []), tb = $('#feed tbody');
  if (tb) tb.innerHTML = feed.map((b) => `<tr><td>${esc(b.user)}</td><td>${esc(b.game)}</td><td>${usd(b.stake)}</td><td class="${b.payout > b.stake ? 'win' : 'lose'}">${usd(b.payout)}</td></tr>`).join('') || '<tr><td colspan=4 class="muted">No bets yet</td></tr>';
}
B.refreshFeed = loadFeed;
async function betsPage(view) {
  if (!B.me) { view.innerHTML = '<p class="muted">Log in to see your bets.</p>'; return B.openAuth('login'); }
  const h = await B.api('bets');
  view.innerHTML = `<h2 class="sec">My bets</h2><table><thead><tr><th>Time</th><th>Game</th><th>Stake</th><th>Payout</th></tr></thead><tbody>${h.map((b) => `<tr><td>${new Date(b.at).toLocaleTimeString()}</td><td>${esc(b.game)}</td><td>${usd(b.stake)}</td><td class="${b.payout > b.stake ? 'win' : 'lose'}">${usd(b.payout)}</td></tr>`).join('') || '<tr><td colspan=4 class="muted">No bets yet</td></tr>'}</tbody></table>`;
}
