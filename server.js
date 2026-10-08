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
const PROVIDER = process.env.PAYMENT_MODE || 'demo'; // demo = fake addresses + simulate button; live = your real wallets, deposits detected on-chain and credited automatically
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MIN_DEPOSIT = Math.round((+process.env.MIN_DEPOSIT_USD || 10) * 100);
const MIN_WITHDRAW = Math.round((+process.env.MIN_WITHDRAW_USD || 10) * 100);
const MAX_BET = 50000;        // $500 per bet
const MAX_PAYOUT = 2500000;   // $25,000 max win per round
const chains = require('./chains');
const COINS = Object.fromEntries(Object.entries(chains.COINS).map(([k, v]) => [k, v.name]));
const EVM = /^0x[a-fA-F0-9]{40}$/;
const ADDR = { // withdrawal address sanity checks
  BTC: /^(bc1[a-z0-9]{25,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
  LTC: /^(ltc1[a-z0-9]{25,60}|[LM3][a-km-zA-HJ-NP-Z1-9]{26,33})$/,
  USDTTRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  USDTERC20: EVM, USDTBSC: EVM,
};
const QUOTE_TTL = 60 * 60e3; // a quoted deposit amount is reserved for 60 minutes
const DATA_DIR = process.env.DATA_DIR || __dirname; // point at a persistent disk in production
fs.mkdirSync(DATA_DIR, { recursive: true });
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SECURE = PUBLIC_URL.startsWith('https://');

// ---- storage: Supabase when SUPABASE_URL + SUPABASE_SERVICE_KEY are set, else a local file (see store.js) ----
const store = require('./store')({ dataDir: DATA_DIR });
let db = { users: {}, sessions: {}, deposits: {}, withdrawals: {}, unmatched: {}, bets: [] }; // replaced by store.load() at startup
const save = () => store.touch();      // debounced write-through, fine for game rounds
const persist = () => store.flush();   // awaited: use before replying on anything involving accounts or money
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex'); // only hashes of session tokens are stored

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
const clientIp = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
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
function userFrom(req) { const tok = cookie(req, 'sid'); const s = tok && db.sessions[sha(tok)]; return s ? db.users[s] : null; }
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
  const bet = { id: crypto.randomUUID(), user: u.username, game, stake, payout, at: Date.now() };
  db.bets.push(bet); store.queueBet(bet);
  if (db.bets.length > 5000) db.bets.splice(0, db.bets.length - 5000);
  save();
  return { balance: u.balance, stake, payout, win: payout > stake, ...detail };
}
const engine = require('./games')({ fail, amount, begin, finish });
engine.setSave(save);

// ---- crypto deposits (manual): players send to a wallet your team controls, then submit the transaction hash; the team verifies on-chain and credits ----
const WALLETS = Object.fromEntries(Object.keys(COINS).map((c) => [c, (process.env['DEPOSIT_ADDR_' + c] || '').trim()]).filter(([, a]) => a));
const depositCoins = () => (PROVIDER === 'demo' ? COINS : Object.fromEntries(Object.entries(COINS).filter(([c]) => WALLETS[c])));
// Credits the difference between what has arrived (usd cents) and what was already credited, so repeating it is harmless.
function creditDeposit(dep, arrivedUsd, final = true) {
  const target = Math.min(Math.max(0, Math.round(arrivedUsd)), dep.usd * 2);
  const delta = target - (dep.credited || 0);
  if (delta > 0) { const u = db.users[dep.user]; u.balance += delta; u.deposited = (u.deposited || 0) + delta; dep.credited = target; }
  if (final) { dep.status = 'confirmed'; dep.confirmedAt = Date.now(); } else if (delta > 0) dep.status = 'partial';
  save();
}
// ---- on-chain watcher (live mode): matches incoming payments to open deposit requests by exact amount ----
const doneKeys = new Set();
async function scanCoin(coin) {
  const c = chains.COINS[coin], now = Date.now();
  for (const d of Object.values(db.deposits)) if (d.coin === coin && d.status === 'pending' && d.expires && d.expires < now) d.status = 'expired';
  for (const tx of await chains.incoming(coin, WALLETS[coin])) {
    if (doneKeys.has(tx.key)) continue;
    const units = tx.units.toString();
    const dep = Object.values(db.deposits).find((d) => d.coin === coin && d.units === units && (d.status === 'pending' || (d.status === 'detected' && d.txid === tx.key)));
    if (dep) {
      if (tx.conf >= c.minConf) { dep.txid = tx.key; dep.confirmations = tx.conf; creditDeposit(dep, dep.usd); doneKeys.add(tx.key); await persist(); console.log(`[watch] credited ${dep.user} $${dep.usd / 100} (${coin} ${tx.key.slice(0, 12)}…)`); }
      else if (dep.status !== 'detected' || dep.confirmations !== tx.conf) { dep.status = 'detected'; dep.txid = tx.key; dep.confirmations = tx.conf; save(); }
    } else if (tx.conf >= c.minConf) {
      db.unmatched[tx.key] = { key: tx.key, coin, units, amount: chains.format(tx.units, c.dec, 2), seenAt: now, status: 'open', note: 'No open deposit request for this exact amount' };
      doneKeys.add(tx.key); await persist(); console.warn(`[watch] unmatched ${coin} payment ${chains.format(tx.units, c.dec, 2)} (${tx.key.slice(0, 12)}…)`);
    }
  }
}
async function watch() {
  for (const coin of Object.keys(WALLETS)) { try { await scanCoin(coin); } catch (e) { console.error(`[watch] ${coin} scan failed: ${e.message}`); } }
  save();
}
const adminOk = (req) => { if (ADMIN_TOKEN.length < 16) throw fail('Admin disabled: set ADMIN_TOKEN (16+ chars) in .env', 403); if (!safeEq(String(req.headers['x-admin-token'] || ''), ADMIN_TOKEN)) throw fail('Forbidden', 403); };

// ---- routes ----
const routes = {
  'POST /api/register': async (req, res, b) => {
    rateLimit('reg:' + clientIp(req), 10, 3600e3);
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
    rateLimit('login:' + clientIp(req), 20, 600e3);
    const u = db.users[String(b.username || '').toLowerCase()];
    if (!u || !safeEq(hashPw(String(b.password || ''), u.salt), u.hash)) throw fail('Wrong username or password', 401);
    return login(res, u);
  },
  'POST /api/logout': async (req, res) => {
    const h = sha(cookie(req, 'sid')); delete db.sessions[h]; store.dropSession(h); save();
    json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
  },
  'GET /api/me': async (req, res) => {
    const u = userFrom(req);
    json(res, 200, { user: u && publicUser(u), provider: PROVIDER, coins: depositCoins(), allCoins: COINS, minDeposit: MIN_DEPOSIT / 100, minWithdraw: MIN_WITHDRAW / 100, maxBet: MAX_BET / 100, maxPayout: MAX_PAYOUT / 100, tables: engine.config });
  },
  'GET /api/state': async (req, res) => json(res, 200, engine.state(needUser(req))),
  'GET /api/bets': async (req, res) => {
    const u = needUser(req);
    json(res, 200, db.bets.filter((x) => x.user === u.username).slice(-30).reverse());
  },
  'GET /api/feed': async (req, res) => json(res, 200, db.bets.slice(-14).reverse().map(({ user, game, stake, payout }) => ({ user, game, stake, payout }))),

  'POST /api/deposit': async (req, res, b) => {
    const u = needUser(req);
    rateLimit('dep:' + u.id, 15, 3600e3);
    if (!depositCoins()[b.coin]) throw fail('That coin is not available for deposits');
    const usd = Math.round(Number(b.usd) * 100);
    if (!(usd >= MIN_DEPOSIT) || usd > 1e7) throw fail('Minimum deposit is $' + MIN_DEPOSIT / 100);
    const now = Date.now(), dep = { id: crypto.randomUUID(), user: u.id, coin: b.coin, usd, status: 'pending', createdAt: now };
    if (PROVIDER === 'demo') {
      const pre = { BTC: 'bc1q', LTC: 'ltc1q', USDTTRC20: 'T' }[dep.coin] || '0x';
      Object.assign(dep, { address: pre + crypto.randomBytes(18).toString('hex').slice(0, 34), note: 'DEMO MODE — this address is fake. Do not send real funds.' });
    } else {
      const mine = Object.values(db.deposits).filter((d) => d.user === u.id && d.status === 'pending' && d.expires > now);
      if (mine.length >= 3) throw fail('You already have open deposits. Pay one of them or wait for it to expire.');
      // amounts reserved by open requests, and by recently expired ones (a late payment must not be credited to someone else)
      const taken = new Set(Object.values(db.deposits).filter((d) => d.coin === b.coin && d.units && d.expires > now - 864e5).map((d) => d.units));
      const q = await chains.quote(b.coin, usd, taken);
      Object.assign(dep, { usd: q.usd, address: WALLETS[b.coin], units: q.units.toString(), amount: q.display, expires: now + QUOTE_TTL,
        note: `Send exactly ${q.display} ${chains.COINS[b.coin].sym} to this address. The amount must match exactly or we can't tell the payment is yours.` });
    }
    db.deposits[dep.id] = dep; await persist();
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
    creditDeposit(dep, dep.usd); await persist();
    json(res, 200, { balance: u.balance });
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
    if (PROVIDER === 'demo' && !store.remote) { w.status = 'sent'; w.txid = 'demo-' + crypto.randomBytes(16).toString('hex'); w.note = 'DEMO — nothing was sent'; }
    db.withdrawals[w.id] = w; await persist();
    json(res, 200, { withdrawal: w, balance: u.balance });
  },
  'GET /api/withdrawals': async (req, res) => {
    const u = needUser(req);
    json(res, 200, Object.values(db.withdrawals).filter((w) => w.user === u.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20));
  },
  'GET /api/admin/unmatched': async (req, res) => {
    adminOk(req);
    json(res, 200, Object.values(db.unmatched).sort((a, b) => b.seenAt - a.seenAt).slice(0, 100));
  },
  'POST /api/admin/unmatched/resolve': async (req, res, b) => { // credit a stray payment to the right player after you identify it
    adminOk(req);
    const x = db.unmatched[b.key], u = db.users[String(b.username || '').toLowerCase()], cents = Math.round(Number(b.usd) * 100);
    if (!x || x.status !== 'open') throw fail('Not an open payment');
    if (!u) throw fail('No such player');
    if (!(cents >= 100 && cents <= 1e8)) throw fail('Enter the USD value of the payment');
    u.balance += cents; u.deposited = (u.deposited || 0) + cents;
    Object.assign(x, { status: 'resolved', resolvedUser: u.username, resolvedUsd: cents });
    await persist(); json(res, 200, x);
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
    await persist(); json(res, 200, w);
  },
};
for (const name of Object.keys(engine.play)) {
  routes[`POST /api/play/${name}`] = async (req, res, b) => {
    const u = needUser(req);
    rateLimit('play:' + u.id, 240, 60e3);
    json(res, 200, engine.play[name](u, b));
  };
}
async function login(res, u) {
  const tok = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(tok)] = u.id; await persist();
  json(res, 200, { user: publicUser(u) }, { 'Set-Cookie': `sid=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${SECURE ? '; Secure' : ''}` });
}

// ---- server ----
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) {
      if (req.method === 'POST') { // CSRF: same-origin only
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
});
(async () => {
  db = await store.load();
  for (const d of Object.values(db.deposits)) if (d.status === 'confirmed' && d.txid) doneKeys.add(d.txid);
  for (const k of Object.keys(db.unmatched || {})) doneKeys.add(k);
  if (PROVIDER === 'live') {
    if (!Object.keys(WALLETS).length) console.warn('[watch] PAYMENT_MODE=live but no DEPOSIT_ADDR_* is set; deposits are unavailable');
    const loop = () => watch().finally(() => setTimeout(loop, +process.env.WATCH_INTERVAL_MS || 20000));
    loop();
  }
  if (store.remote) { setInterval(() => store.pollWithdrawals().catch((e) => console.error('[store] poll failed:', e.message)), +process.env.WITHDRAW_POLL_MS || 20000); }
  server.listen(PORT, () => console.log(`BetMaxx running at http://localhost:${PORT}  (payments: ${PROVIDER}, storage: ${store.remote ? 'Supabase' : 'local file'})`));
})().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
process.on('SIGTERM', () => store.flush().finally(() => process.exit(0)));
