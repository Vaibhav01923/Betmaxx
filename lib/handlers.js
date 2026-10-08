'use strict';
// All API routes. One entry point (`handle`) is mounted by app/api/[...path]/route.js.
const crypto = require('crypto');
const { query, tx } = require('./db');
const C = require('./core');
const { cfg, COINS, ADDR, fail, sha, hashPw, safeEq, rateLimit, rowToUser, saveUser, publicUser, wagerNeeded, chains } = C;
const watch = require('./watch');

// ---- game engine glue: the engine is synchronous and mutates a plain user object; we persist it afterwards in the same transaction ----
let curBets = null;
function begin(u, game, stake) {
  if (stake > u.balance) throw fail('Insufficient balance');
  u.balance -= stake; u.wagered = (u.wagered || 0) + stake;
}
function finish(u, game, stake, payout, detail) {
  payout = Math.min(payout, cfg.MAX_PAYOUT);
  u.balance += payout;
  curBets.push({ id: crypto.randomUUID(), user: u.username, game, stake, payout, at: Date.now() });
  return { balance: u.balance, stake, payout, win: payout > stake, ...detail };
}
const engine = require('./games')({ fail, amount: C.amount, begin, finish });
const engineCall = (bets, f) => { curBets = bets; try { return f(); } finally { curBets = null; } }; // sync only, so no interleaving

// ---- auth helpers ----
const sessionToken = (x) => C.cookieOf(x.req, 'sid');
async function getUser(x) { // read-only, no lock
  const tok = sessionToken(x);
  if (!tok) return null;
  const r = await query('select u.* from sessions s join users u on u.id = s.user_id where s.token_hash = $1', [sha(tok)]);
  return r.rows[0] ? rowToUser(r.rows[0]) : null;
}
// Runs fn(user, conn, bets) in one transaction holding a row lock on the user, then saves the user and any bets.
async function withUser(x, fn) {
  const tok = sessionToken(x);
  if (!tok) throw fail('Please log in', 401);
  return tx(async (c) => {
    const r = await c.query('select u.* from sessions s join users u on u.id = s.user_id where s.token_hash = $1 for update of u', [sha(tok)]);
    if (!r.rows[0]) throw fail('Please log in', 401);
    const u = rowToUser(r.rows[0]), bets = [];
    const out = await fn(u, c, bets);
    await saveUser(c, u);
    for (const b of bets) await c.query('insert into bets(id, username, game, stake, payout, at) values ($1,$2,$3,$4,$5,$6)', [b.id, b.user, b.game, b.stake, b.payout, b.at]);
    return out;
  });
}
const needUser = async (x) => { const u = await getUser(x); if (!u) throw fail('Please log in', 401); return u; };
function adminOk(x) {
  if (cfg.ADMIN_TOKEN.length < 16) throw fail('Admin disabled: set ADMIN_TOKEN (16+ chars)', 403);
  if (!safeEq(String(x.req.headers.get('x-admin-token') || ''), cfg.ADMIN_TOKEN)) throw fail('Forbidden', 403);
}
async function startSession(x, u) {
  const tok = crypto.randomBytes(32).toString('hex');
  await query('insert into sessions(token_hash, user_id, created_at) values ($1,$2,$3)', [sha(tok), u.id, Date.now()]);
  x.cookies.push(`sid=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${cfg.SECURE ? '; Secure' : ''}`);
  return { user: publicUser(u) };
}

const depView = (r) => ({ id: r.id, user: r.user_id, coin: r.coin, usd: r.usd, status: r.status, credited: r.credited, address: r.address, txid: r.txid || undefined, amount: r.amount || undefined, expires: r.expires || undefined, confirmations: r.confirmations, note: r.note || undefined, createdAt: r.created_at, confirmedAt: r.confirmed_at || undefined });
const wdView = (r) => ({ id: r.id, user: r.user_id, coin: r.coin, address: r.address, usd: r.usd, status: r.status, txid: r.txid || undefined, note: r.note || undefined, createdAt: r.created_at, decidedAt: r.decided_at || undefined });

const routes = {};
const R = (method, path, fn) => { routes[`${method} /api/${path}`] = fn; };

// ================= accounts =================
R('POST', 'register', async (x) => {
  await rateLimit('reg:' + x.ip, 10, 3600e3);
  const name = String(x.b.username || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) throw fail('Username: 3–20 letters, numbers or _');
  if (String(x.b.password || '').length < 8) throw fail('Password must be at least 8 characters');
  if (x.b.age !== true) throw fail('You must confirm you are 18 or older');
  const id = name.toLowerCase(), salt = crypto.randomBytes(16).toString('hex'), hash = hashPw(x.b.password, salt);
  try { await query("insert into users(id, username, salt, hash, balance, deposited, wagered, created_at, state) values ($1,$2,$3,$4,0,0,0,$5,'{}')", [id, name, salt, hash, Date.now()]); }
  catch (e) { if (e.code === '23505') throw fail('Username taken'); throw e; }
  return startSession(x, { id, username: name, balance: 0, deposited: 0, wagered: 0 });
});
R('POST', 'login', async (x) => {
  await rateLimit('login:' + x.ip, 20, 600e3);
  const r = await query('select * from users where id = $1', [String(x.b.username || '').toLowerCase()]);
  const row = r.rows[0];
  if (!row || !safeEq(hashPw(String(x.b.password || ''), row.salt), row.hash)) throw fail('Wrong username or password', 401);
  return startSession(x, rowToUser(row));
});
R('POST', 'logout', async (x) => {
  const tok = sessionToken(x);
  if (tok) await query('delete from sessions where token_hash = $1', [sha(tok)]);
  x.cookies.push('sid=; Path=/; Max-Age=0');
  return { ok: true };
});
R('GET', 'me', async (x) => {
  const u = await getUser(x);
  return { user: u && publicUser(u), provider: cfg.PROVIDER, coins: C.depositCoins(), allCoins: COINS, minDeposit: cfg.MIN_DEPOSIT / 100, minWithdraw: cfg.MIN_WITHDRAW / 100, maxBet: cfg.MAX_BET / 100, maxPayout: cfg.MAX_PAYOUT / 100, tables: engine.config };
});
R('GET', 'state', (x) => withUser(x, (u, c, bets) => engineCall(bets, () => engine.state(u))));
R('GET', 'bets', async (x) => {
  const u = await needUser(x);
  const r = await query('select username as "user", game, stake, payout, at from bets where username = $1 order by at desc limit 30', [u.username]);
  return r.rows;
});
R('GET', 'feed', async () => (await query('select username as "user", game, stake, payout from bets order by at desc limit 14')).rows);

// ================= games =================
for (const name of Object.keys(engine.play)) {
  R('POST', `play/${name}`, (x) => withUser(x, (u, c, bets) => engineCall(bets, () => engine.play[name](u, x.b))));
}

// ================= deposits =================
R('POST', 'deposit', async (x) => {
  const u = await needUser(x);
  await rateLimit('dep:' + u.id, 15, 3600e3);
  if (!C.depositCoins()[x.b.coin]) throw fail('That coin is not available for deposits');
  const usd = Math.round(Number(x.b.usd) * 100);
  if (!(usd >= cfg.MIN_DEPOSIT) || usd > 1e7) throw fail('Minimum deposit is $' + cfg.MIN_DEPOSIT / 100);
  const now = Date.now(), coin = x.b.coin, id = crypto.randomUUID();
  if (cfg.PROVIDER === 'demo') {
    const pre = { BTC: 'bc1q', LTC: 'ltc1q', USDTTRC20: 'T' }[coin] || '0x';
    const address = pre + crypto.randomBytes(18).toString('hex').slice(0, 34), note = 'DEMO MODE — this address is fake. Do not send real funds.';
    await query("insert into deposits(id, user_id, coin, usd, status, credited, address, note, created_at) values ($1,$2,$3,$4,'pending',0,$5,$6,$7)", [id, u.id, coin, usd, address, note, now]);
    return depView((await query('select * from deposits where id = $1', [id])).rows[0]);
  }
  const mine = (await query("select count(*)::int as n from deposits where user_id = $1 and status = 'pending' and expires > $2", [u.id, now])).rows[0].n;
  if (mine >= 3) throw fail('You already have open deposits. Pay one of them or wait for it to expire.');
  for (let attempt = 0; attempt < 5; attempt++) {
    // amounts reserved by open requests (and recently expired ones: a late payment must not be credited to someone else)
    const taken = new Set((await query('select units from deposits where coin = $1 and units is not null', [coin])).rows.map((r) => r.units));
    const q = await chains.quote(coin, usd, taken);
    const note = `Send exactly ${q.display} ${chains.COINS[coin].sym} to this address. The amount must match exactly or we can't tell the payment is yours.`;
    try {
      await query("insert into deposits(id, user_id, coin, usd, status, credited, address, units, amount, expires, note, created_at) values ($1,$2,$3,$4,'pending',0,$5,$6,$7,$8,$9,$10)",
        [id, u.id, coin, q.usd, C.wallets()[coin], q.units.toString(), q.display, now + cfg.QUOTE_TTL, note, now]);
      return depView((await query('select * from deposits where id = $1', [id])).rows[0]);
    } catch (e) { if (e.code !== '23505') throw e; } // another request grabbed the same tag first; pick another
  }
  throw fail('Please try again in a moment', 503);
});
R('GET', 'deposits', async (x) => {
  const u = await needUser(x);
  if (cfg.PROVIDER === 'live') { // a player is waiting: check the chain now (throttled to one scan per coin per 8s)
    const open = (await query("select distinct coin from deposits where user_id = $1 and status in ('pending','detected')", [u.id])).rows;
    for (const r of open) await watch.scanIfDue(r.coin);
  }
  return (await query('select * from deposits where user_id = $1 order by created_at desc limit 20', [u.id])).rows.map(depView);
});
R('POST', 'demo/confirm', async (x) => { // demo only: pretend the payment arrived
  if (cfg.PROVIDER !== 'demo') throw fail('Not available', 404);
  const u = await needUser(x);
  return tx(async (c) => {
    const d = (await c.query("select * from deposits where id = $1 and user_id = $2 and status = 'pending' for update", [x.b.id, u.id])).rows[0];
    if (!d) throw fail('Not found', 404);
    await c.query("update deposits set status = 'confirmed', credited = usd, confirmed_at = $2 where id = $1", [d.id, Date.now()]);
    const r = await c.query('update users set balance = balance + $2, deposited = deposited + $2 where id = $1 returning balance', [u.id, d.usd]);
    return { balance: r.rows[0].balance };
  });
});

// ================= withdrawals (paid by hand by your team) =================
R('POST', 'withdraw', async (x) => {
  const u0 = await needUser(x);
  await rateLimit('wd:' + u0.id, 5, 3600e3);
  return withUser(x, async (u, c) => {
    if (!COINS[x.b.coin]) throw fail('Unsupported coin');
    const address = String(x.b.address || '').trim();
    if (!ADDR[x.b.coin].test(address)) throw fail('That does not look like a valid ' + COINS[x.b.coin] + ' address');
    const usd = Math.round(Number(x.b.usd) * 100);
    if (!(usd >= cfg.MIN_WITHDRAW)) throw fail('Minimum withdrawal is $' + cfg.MIN_WITHDRAW / 100);
    if (usd > u.balance) throw fail('Insufficient balance');
    if (u.crash || u.mines || u.hilo || u.bj) throw fail('Finish your active game before withdrawing');
    const need = wagerNeeded(u);
    if (need > 0) throw fail(`Wager $${(need / 100).toFixed(2)} more before withdrawing (you must play through your deposits once)`);
    u.balance -= usd;
    const w = { id: crypto.randomUUID(), user_id: u.id, coin: x.b.coin, address, usd, status: 'pending', txid: null, note: null, created_at: Date.now(), decided_at: null };
    if (cfg.PROVIDER === 'demo') { w.status = 'sent'; w.txid = 'demo-' + crypto.randomBytes(16).toString('hex'); w.note = 'DEMO — nothing was sent'; }
    await c.query('insert into withdrawals(id, user_id, coin, address, usd, status, txid, note, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [w.id, w.user_id, w.coin, w.address, w.usd, w.status, w.txid, w.note, w.created_at]);
    return { withdrawal: wdView(w), balance: u.balance };
  });
});
R('GET', 'withdrawals', async (x) => {
  const u = await needUser(x);
  return (await query('select * from withdrawals where user_id = $1 order by created_at desc limit 20', [u.id])).rows.map(wdView);
});

// ================= admin =================
R('GET', 'admin/withdrawals', async (x) => {
  adminOk(x);
  const r = await query('select w.*, u.username, u.wagered, u.deposited from withdrawals w join users u on u.id = w.user_id order by w.created_at desc limit 100');
  return r.rows.map((w) => ({ ...wdView(w), username: w.username, wagered: w.wagered, deposited: w.deposited }));
});
R('POST', 'admin/withdrawals/decide', async (x) => {
  adminOk(x);
  return tx(async (c) => {
    const w = (await c.query('select * from withdrawals where id = $1 for update', [x.b.id])).rows[0];
    if (!w || w.status !== 'pending') throw fail('Not a pending withdrawal');
    const now = Date.now();
    if (x.b.action === 'approve') await c.query("update withdrawals set status = 'sent', txid = $2, decided_at = $3 where id = $1", [w.id, String(x.b.txid || '').slice(0, 120), now]);
    else if (x.b.action === 'reject') {
      await c.query("update withdrawals set status = 'rejected', note = $2, decided_at = $3 where id = $1", [w.id, String(x.b.reason || '').slice(0, 200), now]);
      await c.query('update users set balance = balance + $2 where id = $1', [w.user_id, w.usd]); // refund
    } else throw fail('Bad action');
    return wdView((await c.query('select * from withdrawals where id = $1', [w.id])).rows[0]);
  });
});
const unView = (r) => ({ key: r.key, coin: r.coin, units: r.units, amount: r.amount, seenAt: r.seen_at, status: r.status, note: r.note || undefined, resolvedUser: r.resolved_user || undefined, resolvedUsd: r.resolved_usd || undefined });
R('GET', 'admin/unmatched', async (x) => { adminOk(x); return (await query('select * from unmatched_deposits order by seen_at desc limit 100')).rows.map(unView); });
R('POST', 'admin/unmatched/resolve', async (x) => { // credit a stray payment to the right player after you identify it
  adminOk(x);
  return tx(async (c) => {
    const p = (await c.query('select * from unmatched_deposits where key = $1 for update', [x.b.key])).rows[0];
    const cents = Math.round(Number(x.b.usd) * 100);
    if (!p || p.status !== 'open') throw fail('Not an open payment');
    if (!(cents >= 100 && cents <= 1e8)) throw fail('Enter the USD value of the payment');
    const u = (await c.query('update users set balance = balance + $2, deposited = deposited + $2 where id = $1 returning username', [String(x.b.username || '').toLowerCase(), cents])).rows[0];
    if (!u) throw fail('No such player');
    await c.query("update unmatched_deposits set status = 'resolved', resolved_user = $2, resolved_usd = $3 where key = $1", [p.key, u.username, cents]);
    return unView((await c.query('select * from unmatched_deposits where key = $1', [p.key])).rows[0]);
  });
});

// ================= scheduled scan (Supabase pg_cron / any pinger; also covers players who closed the tab) =================
const cron = async (x) => {
  const bearer = (x.req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (cfg.CRON_SECRET.length < 16 || !safeEq(bearer, cfg.CRON_SECRET)) throw fail('Forbidden', 403);
  return { results: await watch.scanAll() };
};
R('GET', 'cron/scan', cron);
R('POST', 'cron/scan', cron);

// ================= entry point =================
async function handle(req) {
  const url = new URL(req.url);
  const x = { req, url, ip: C.clientIp(req), b: {}, cookies: [] };
  const send = (code, body) => {
    const h = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
    for (const c of x.cookies) h.append('Set-Cookie', c);
    return new Response(JSON.stringify(body), { status: code, headers: h });
  };
  try {
    const fn = routes[`${req.method} ${url.pathname}`];
    if (!fn) throw fail('Not found', 404);
    if (req.method === 'POST' && !url.pathname.startsWith('/api/cron/')) { // CSRF: same-origin only
      const o = req.headers.get('origin');
      if (o && new URL(o).host !== req.headers.get('host')) throw fail('Bad origin', 403);
    }
    if (req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 1e5) throw fail('Body too large', 413);
      if (raw) { try { x.b = JSON.parse(raw); } catch { throw fail('Invalid JSON'); } }
    }
    return send(200, await fn(x));
  } catch (e) {
    if (!e.code || typeof e.code !== 'number') { console.error(e); return send(500, { error: 'Server error' }); }
    return send(e.code, { error: e.message });
  }
}

module.exports = { handle, routes };
