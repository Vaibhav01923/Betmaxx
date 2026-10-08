'use strict';
// BetMaxx — zero-dependency casino server. Balances are stored in integer cents (USD).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- config (.env loader, no dependency) ----
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}
const PORT = +process.env.PORT || 3000;
const PROVIDER = process.env.PAYMENT_PROVIDER || 'demo';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MIN_DEPOSIT = Math.round((+process.env.MIN_DEPOSIT_USD || 10) * 100);
const MIN_WITHDRAW = Math.round((+process.env.MIN_WITHDRAW_USD || 10) * 100);
const MAX_BET = 50000;        // $500 per bet
const MAX_PAYOUT = 2500000;   // $25,000 max win per round
const COINS = { BTC: 'Bitcoin', ETH: 'Ethereum', USDTTRC20: 'USDT (TRC20)', LTC: 'Litecoin', SOL: 'Solana' };
const ADDR = {
  BTC: /^(bc1[a-z0-9]{25,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
  ETH: /^0x[a-fA-F0-9]{40}$/,
  USDTTRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  LTC: /^(ltc1[a-z0-9]{25,60}|[LM3][a-km-zA-HJ-NP-Z1-9]{26,33})$/,
  SOL: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};
const DB_FILE = path.join(__dirname, 'data.json');

// ---- storage ----
let db = { users: {}, sessions: {}, deposits: {}, withdrawals: {}, bets: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

// ---- helpers ----
const json = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const fail = (msg, code = 400) => Object.assign(new Error(msg), { code });
function readBody(req, limit = 1e5) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(fail('Body too large', 413)); req.destroy(); } });
    req.on('end', () => resolve(data));
  });
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const cookie = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find((c) => c[0] === name)?.[1];
const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw fail('Too many requests, slow down', 429);
  arr.push(now); rateBuckets.set(key, arr);
}
const wagerNeeded = (u) => Math.max(0, (u.deposited || 0) - (u.wagered || 0));
const publicUser = (u) => ({ username: u.username, balance: u.balance, wagered: u.wagered || 0, deposited: u.deposited || 0, wagerNeeded: wagerNeeded(u) });
function userFrom(req) { const tok = cookie(req, 'sid'); const s = tok && db.sessions[tok]; return s ? db.users[s] : null; }
function needUser(req) { const u = userFrom(req); if (!u) throw fail('Please log in', 401); return u; }
function amount(v) {
  const n = Math.round(Number(v) * 100);
  if (!Number.isFinite(n) || n < 10) throw fail('Minimum bet is $0.10');
  if (n > MAX_BET) throw fail('Maximum bet is $' + MAX_BET / 100);
  return n;
}
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---- games ----
function begin(u, game, stake) {
  if (stake > u.balance) throw fail('Insufficient balance');
  u.balance -= stake; u.wagered = (u.wagered || 0) + stake; save();
}
function finish(u, game, stake, payout, detail) {
  payout = Math.min(payout, MAX_PAYOUT);
  u.balance += payout;
  db.bets.push({ id: crypto.randomUUID(), user: u.username, game, stake, payout, at: Date.now() });
  if (db.bets.length > 5000) db.bets.splice(0, db.bets.length - 5000);
  save();
  return { balance: u.balance, stake, payout, win: payout > stake, ...detail };
}
const engine = require('./games')({ fail, amount, begin, finish });
engine.setSave(save);

// ---- crypto deposits ----
const providers = {
  demo: { // fake addresses; credit only via the simulate endpoint
    async create(dep) {
      const pre = { BTC: 'bc1q', ETH: '0x', USDTTRC20: 'T', LTC: 'ltc1q', SOL: '' }[dep.coin];
      return { address: pre + crypto.randomBytes(18).toString('hex').slice(0, 34), payAmount: null, note: 'DEMO MODE — this address is fake. Do not send real funds.' };
    },
  },
  nowpayments: {
    async create(dep) {
      const r = await fetch('https://api.nowpayments.io/v1/payment', {
        method: 'POST',
        headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ price_amount: dep.usd / 100, price_currency: 'usd', pay_currency: dep.coin.toLowerCase(), order_id: dep.id, ipn_callback_url: PUBLIC_URL + '/api/webhook/nowpayments' }),
      });
      const d = await r.json();
      if (!r.ok || !d.pay_address) throw fail('Payment provider error: ' + (d.message || r.status), 502);
      return { address: d.pay_address, payAmount: d.pay_amount, providerId: String(d.payment_id) };
    },
  },
};
function creditDeposit(dep) {
  if (dep.status === 'confirmed') return;
  const u = db.users[dep.user];
  dep.status = 'confirmed'; dep.confirmedAt = Date.now();
  u.balance += dep.usd; u.deposited = (u.deposited || 0) + dep.usd;
  save();
}
const sortObj = (o) => Array.isArray(o) ? o.map(sortObj) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortObj(o[k])])) : o;
const adminOk = (req) => { if (ADMIN_TOKEN.length < 16) throw fail('Admin disabled: set ADMIN_TOKEN (16+ chars) in .env', 403); if (!safeEq(String(req.headers['x-admin-token'] || ''), ADMIN_TOKEN)) throw fail('Forbidden', 403); };

// ---- routes ----
const routes = {
  'POST /api/register': async (req, res, b) => {
    rateLimit('reg:' + req.socket.remoteAddress, 10, 3600e3);
    const name = String(b.username || '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) throw fail('Username: 3–20 letters, numbers or _');
    if (String(b.password || '').length < 8) throw fail('Password must be at least 8 characters');
    if (b.age !== true) throw fail('You must confirm you are 18 or older');
    const id = name.toLowerCase();
    if (db.users[id]) throw fail('Username taken');
    const salt = crypto.randomBytes(16).toString('hex');
    db.users[id] = { id, username: name, salt, hash: hashPw(b.password, salt), balance: 0, deposited: 0, wagered: 0, createdAt: Date.now() };
    return login(res, db.users[id]);
  },
  'POST /api/login': async (req, res, b) => {
    rateLimit('login:' + req.socket.remoteAddress, 20, 600e3);
    const u = db.users[String(b.username || '').toLowerCase()];
    if (!u || !safeEq(hashPw(String(b.password || ''), u.salt), u.hash)) throw fail('Wrong username or password', 401);
    return login(res, u);
  },
  'POST /api/logout': async (req, res) => {
    delete db.sessions[cookie(req, 'sid')]; save();
    json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
  },
  'GET /api/me': async (req, res) => {
    const u = userFrom(req);
    json(res, 200, { user: u && publicUser(u), provider: PROVIDER, coins: COINS, minDeposit: MIN_DEPOSIT / 100, minWithdraw: MIN_WITHDRAW / 100, maxBet: MAX_BET / 100, maxPayout: MAX_PAYOUT / 100, tables: engine.config });
  },
  'GET /api/state': async (req, res) => json(res, 200, engine.state(needUser(req))),
  'GET /api/bets': async (req, res) => {
    const u = needUser(req);
    json(res, 200, db.bets.filter((x) => x.user === u.username).slice(-30).reverse());
  },
  'GET /api/feed': async (req, res) => json(res, 200, db.bets.slice(-14).reverse().map(({ user, game, stake, payout }) => ({ user, game, stake, payout }))),

  'POST /api/deposit': async (req, res, b) => {
    const u = needUser(req);
    rateLimit('dep:' + u.id, 10, 3600e3);
    if (!COINS[b.coin]) throw fail('Unsupported coin');
    const usd = Math.round(Number(b.usd) * 100);
    if (!(usd >= MIN_DEPOSIT) || usd > 1e7) throw fail('Minimum deposit is $' + MIN_DEPOSIT / 100);
    const dep = { id: crypto.randomUUID(), user: u.id, coin: b.coin, usd, status: 'pending', createdAt: Date.now() };
    Object.assign(dep, await providers[PROVIDER].create(dep));
    db.deposits[dep.id] = dep; save();
    json(res, 200, dep);
  },
  'GET /api/deposits': async (req, res) => {
    const u = needUser(req);
    json(res, 200, Object.values(db.deposits).filter((d) => d.user === u.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20));
  },
  'POST /api/demo/confirm': async (req, res, b) => { // demo only: pretend the payment arrived
    if (PROVIDER !== 'demo') throw fail('Not available', 404);
    const u = needUser(req), dep = db.deposits[b.id];
    if (!dep || dep.user !== u.id) throw fail('Not found', 404);
    creditDeposit(dep);
    json(res, 200, { balance: u.balance });
  },
  'POST /api/webhook/nowpayments': async (req, res, b) => {
    const secret = process.env.NOWPAYMENTS_IPN_SECRET;
    if (PROVIDER !== 'nowpayments' || !secret) throw fail('Not available', 404);
    const expect = crypto.createHmac('sha512', secret).update(JSON.stringify(sortObj(b))).digest('hex');
    if (!safeEq(String(req.headers['x-nowpayments-sig'] || ''), expect)) throw fail('Bad signature', 401);
    const dep = db.deposits[b.order_id];
    if (dep && b.payment_status === 'finished') creditDeposit(dep);
    else if (dep && ['failed', 'expired'].includes(b.payment_status) && dep.status === 'pending') { dep.status = b.payment_status; save(); }
    json(res, 200, { ok: true });
  },

  // ---- withdrawals: balance is locked at request time, released to the user or refunded on review ----
  'POST /api/withdraw': async (req, res, b) => {
    const u = needUser(req);
    rateLimit('wd:' + u.id, 5, 3600e3);
    if (!COINS[b.coin]) throw fail('Unsupported coin');
    const address = String(b.address || '').trim();
    if (!ADDR[b.coin].test(address)) throw fail('That does not look like a valid ' + COINS[b.coin] + ' address');
    const usd = Math.round(Number(b.usd) * 100);
    if (!(usd >= MIN_WITHDRAW)) throw fail('Minimum withdrawal is $' + MIN_WITHDRAW / 100);
    if (usd > u.balance) throw fail('Insufficient balance');
    if (u.crash || u.mines || u.hilo || u.bj) throw fail('Finish your active game before withdrawing');
    const need = wagerNeeded(u);
    if (need > 0) throw fail(`Wager $${(need / 100).toFixed(2)} more before withdrawing (you must play through your deposits once)`);
    u.balance -= usd;
    const w = { id: crypto.randomUUID(), user: u.id, coin: b.coin, address, usd, status: 'pending', createdAt: Date.now() };
    if (PROVIDER === 'demo') { w.status = 'sent'; w.txid = 'demo-' + crypto.randomBytes(16).toString('hex'); w.note = 'DEMO — nothing was sent'; }
    db.withdrawals[w.id] = w; save();
    json(res, 200, { withdrawal: w, balance: u.balance });
  },
  'GET /api/withdrawals': async (req, res) => {
    const u = needUser(req);
    json(res, 200, Object.values(db.withdrawals).filter((w) => w.user === u.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20));
  },
  'GET /api/admin/withdrawals': async (req, res) => {
    adminOk(req);
    json(res, 200, Object.values(db.withdrawals).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map((w) => ({ ...w, username: db.users[w.user]?.username, wagered: db.users[w.user]?.wagered, deposited: db.users[w.user]?.deposited })));
  },
  'POST /api/admin/withdrawals/decide': async (req, res, b) => {
    adminOk(req);
    const w = db.withdrawals[b.id];
    if (!w || w.status !== 'pending') throw fail('Not a pending withdrawal');
    if (b.action === 'approve') { w.status = 'sent'; w.txid = String(b.txid || '').slice(0, 120); w.decidedAt = Date.now(); }
    else if (b.action === 'reject') { w.status = 'rejected'; w.note = String(b.reason || '').slice(0, 200); w.decidedAt = Date.now(); db.users[w.user].balance += w.usd; }
    else throw fail('Bad action');
    save(); json(res, 200, w);
  },
};
for (const name of Object.keys(engine.play)) {
  routes[`POST /api/play/${name}`] = async (req, res, b) => {
    const u = needUser(req);
    rateLimit('play:' + u.id, 240, 60e3);
    json(res, 200, engine.play[name](u, b));
  };
}
function login(res, u) {
  const tok = crypto.randomBytes(32).toString('hex');
  db.sessions[tok] = u.id; save();
  json(res, 200, { user: publicUser(u) }, { 'Set-Cookie': `sid=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000` });
}

// ---- server ----
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) {
      if (req.method === 'POST' && !url.pathname.includes('/webhook/')) { // CSRF: same-origin only
        const o = req.headers.origin;
        if (o && new URL(o).host !== req.headers.host) throw fail('Bad origin', 403);
      }
      const raw = req.method === 'POST' ? await readBody(req) : '';
      let body = {};
      if (raw) { try { body = JSON.parse(raw); } catch { throw fail('Invalid JSON'); } }
      return await handler(req, res, body);
    }
    if (req.method !== 'GET') throw fail('Not found', 404);
    const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw fail('Not found', 404);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, e.code || 500, { error: e.code ? e.message : 'Server error' });
    if (!e.code) console.error(e);
  }
}).listen(PORT, () => console.log(`BetMaxx running at http://localhost:${PORT}  (payments: ${PROVIDER})`));
