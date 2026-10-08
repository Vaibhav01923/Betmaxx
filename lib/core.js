'use strict';
// Config + small helpers shared by the API handlers. Amounts are integer US cents.
const crypto = require('crypto');
const { query } = require('./db');
const chains = require('./chains');

const env = (k, d = '') => (process.env[k] ?? d);
const MODE = env('PAYMENT_MODE', 'demo').trim().toLowerCase();
if (MODE !== 'demo' && MODE !== 'live') throw new Error(`PAYMENT_MODE must be "demo" or "live", got "${env('PAYMENT_MODE')}"`); // a typo must never silently disable deposit detection
const cfg = {
  PROVIDER: MODE,                                        // demo | live
  ADMIN_TOKEN: env('ADMIN_TOKEN'),
  CRON_SECRET: env('CRON_SECRET'),
  MIN_DEPOSIT: Math.round((+env('MIN_DEPOSIT_USD') || 10) * 100),
  MIN_WITHDRAW: Math.round((+env('MIN_WITHDRAW_USD') || 10) * 100),
  MAX_BET: 50000,                                        // $500 per bet
  MAX_PAYOUT: 2500000,                                   // $25,000 max win per round
  QUOTE_TTL: 60 * 60e3,                                  // a quoted deposit amount is reserved for 60 minutes
  SECURE: env('PUBLIC_URL').startsWith('https://') || !!process.env.VERCEL,
};
const COINS = Object.fromEntries(Object.entries(chains.COINS).map(([k, v]) => [k, v.name]));
const EVM = /^0x[a-fA-F0-9]{40}$/;
const ADDR = { // withdrawal address sanity checks
  BTC: /^(bc1[a-z0-9]{25,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
  LTC: /^(ltc1[a-z0-9]{25,60}|[LM3][a-km-zA-HJ-NP-Z1-9]{26,33})$/,
  USDTTRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  USDTERC20: EVM, USDTBSC: EVM,
};
// your wallets that receive deposits (live mode)
const wallets = () => Object.fromEntries(Object.keys(COINS).map((c) => [c, env('DEPOSIT_ADDR_' + c).trim()]).filter(([, a]) => a));
const depositCoins = () => (cfg.PROVIDER === 'demo' ? COINS : Object.fromEntries(Object.entries(COINS).filter(([c]) => wallets()[c])));

const fail = (msg, code = 400) => Object.assign(new Error(msg), { code });
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieOf = (req, name) => (req.headers.get('cookie') || '').split(/;\s*/).map((c) => c.split('=')).find((c) => c[0] === name)?.[1];
const clientIp = (req) => (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

// fixed-window rate limit kept in Postgres so it holds across serverless instances
async function rateLimit(key, max, windowMs) {
  const win = Math.floor(Date.now() / windowMs);
  const r = await query('insert into rate_limits(key, win, n) values ($1, $2, 1) on conflict (key, win) do update set n = rate_limits.n + 1 returning n', [key, win]);
  if (r.rows[0].n > max) throw fail('Too many requests, slow down', 429);
}

function amount(v) {
  const n = Math.round(Number(v) * 100);
  if (!Number.isFinite(n) || n < 10) throw fail('Minimum bet is $0.10');
  if (n > cfg.MAX_BET) throw fail('Maximum bet is $' + cfg.MAX_BET / 100);
  return n;
}

// ---- user rows <-> the plain objects the game engine works on ----
const rowToUser = (r) => ({
  id: r.id, username: r.username, salt: r.salt, hash: r.hash, balance: r.balance, deposited: r.deposited, wagered: r.wagered, createdAt: r.created_at,
  mines: r.state?.mines || null, hilo: r.state?.hilo || null, bj: r.state?.bj || null, crash: r.state?.crash || null,
});
const saveUser = (c, u) => c.query('update users set balance = $2, deposited = $3, wagered = $4, state = $5::jsonb where id = $1',
  [u.id, u.balance, u.deposited || 0, u.wagered || 0, JSON.stringify({ mines: u.mines || null, hilo: u.hilo || null, bj: u.bj || null, crash: u.crash || null })]);
const wagerNeeded = (u) => Math.max(0, (u.deposited || 0) - (u.wagered || 0));
const publicUser = (u) => ({ username: u.username, balance: u.balance, wagered: u.wagered || 0, deposited: u.deposited || 0, wagerNeeded: wagerNeeded(u) });

module.exports = { cfg, COINS, ADDR, wallets, depositCoins, fail, sha, hashPw, safeEq, cookieOf, clientIp, rateLimit, amount, rowToUser, saveUser, wagerNeeded, publicUser, chains };
