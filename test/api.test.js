'use strict';
// Runs the real API handlers against an in-process Postgres (PGlite) using supabase/schema.sql.  `node test/api.test.js`
process.env.ADMIN_TOKEN = 'adm-0123456789abcdef0123';
process.env.CRON_SECRET = 'cron-0123456789abcdef0123';
process.env.DEPOSIT_ADDR_USDTTRC20 = 'TVxPugFz8a78sskp7J8o1J5SffimdgFyjJ';
process.env.DEPOSIT_ADDR_LTC = 'ltc1qsg0aqxtfy5yaclcrzmqw7jrp8chl7ha8pguljc';
const fs = require('fs'), path = require('path');
let pass = 0, failN = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : failN++; console.log(`${cond ? '  ✔' : '  ✘ FAIL'} ${name}${cond ? '' : ' ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite({ parsers: { 20: (v) => Number(v) } });
  await pg.exec(fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8'));
  const db = require('../lib/db'); db.setClient(pg);
  const core = require('../lib/core'), { handle } = require('../lib/handlers'), watch = require('../lib/watch'), chains = core.chains;
  const ADMIN = { 'x-admin-token': process.env.ADMIN_TOKEN };

  const mkClient = () => {
    let cookie = '';
    return async (method, p, body, headers = {}) => {
      const req = new Request('http://localhost:3000' + p, { method, headers: { host: 'localhost:3000', 'content-type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const res = await handle(req);
      for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); cookie = kv.endsWith('=') ? '' : kv; }
      const out = await res.json();
      return Array.isArray(out) ? Object.assign(out, { s: res.status }) : { s: res.status, ...out };
    };
  };
  const deposit = async (c, usd) => { const d = await c('POST', '/api/deposit', { coin: 'BTC', usd }); await c('POST', '/api/demo/confirm', { id: d.id }); };
  const LTC_ADDR = 'ltc1q' + 'a'.repeat(38);

  console.log('accounts');
  const a = mkClient();
  ok('register', (await a('POST', '/api/register', { username: 'alice', password: 'password123', age: true })).s === 200);
  ok('duplicate username rejected', (await mkClient()('POST', '/api/register', { username: 'ALICE', password: 'password123', age: true })).error === 'Username taken');
  ok('short password rejected', (await mkClient()('POST', '/api/register', { username: 'bob', password: 'short', age: true })).s === 400);
  ok('must confirm 18+', (await mkClient()('POST', '/api/register', { username: 'bob', password: 'password123' })).s === 400);
  ok('wrong password rejected', (await mkClient()('POST', '/api/login', { username: 'alice', password: 'nope-nope-1' })).s === 401);
  ok('me returns user', (await a('GET', '/api/me')).user.username === 'alice');
  ok('not logged in -> 401 on play', (await mkClient()('POST', '/api/play/dice', { amount: 1, target: 50, over: false })).s === 401);
  ok('cross-origin POST blocked', (await a('POST', '/api/logout', {}, { origin: 'http://evil.com' })).s === 403);
  ok('session stored as hash (64 hex)', /^[0-9a-f]{64}$/.test((await pg.query('select token_hash from sessions')).rows[0].token_hash));

  console.log('demo deposit + every game');
  await deposit(a, 500);
  let me = (await a('GET', '/api/me')).user;
  ok('deposit credited $500', me.balance === 50000 && me.deposited === 50000, JSON.stringify(me));
  const plays = [['dice', { amount: 1, target: 50, over: false }], ['limbo', { amount: 1, target: 2 }], ['coin', { amount: 1, side: 'heads' }], ['slots', { amount: 1 }], ['plinko', { amount: 1, rows: 12, risk: 'high' }], ['keno', { amount: 1, picks: [1, 2, 3, 4, 5] }], ['roulette', { bets: [{ type: 'red', amount: 1 }, { type: 'n', value: 7, amount: 1 }] }], ['wheel', { amount: 1, risk: 'medium' }]];
  for (const [g, b] of plays) { const r = await a('POST', '/api/play/' + g, b); ok(`play ${g}`, r.s === 200 && Number.isInteger(r.balance), JSON.stringify(r)); }
  let r = await a('POST', '/api/play/mines/start', { amount: 1, mines: 3 }); ok('mines start', r.s === 200);
  ok('cannot start a second mines game', (await a('POST', '/api/play/mines/start', { amount: 1, mines: 3 })).s === 400);
  r = await a('POST', '/api/play/mines/reveal', { index: 0 }); if (!r.over) r = await a('POST', '/api/play/mines/cashout'); ok('mines reveal/cashout', r.s === 200 && r.over);
  r = await a('POST', '/api/play/hilo/start', { amount: 1 }); ok('hilo start', r.s === 200);
  r = await a('POST', '/api/play/hilo/guess', { dir: 'hi' }); if (!r.over) r = await a('POST', '/api/play/hilo/cashout'); ok('hilo guess/cashout', r.s === 200 && r.over);
  r = await a('POST', '/api/play/blackjack/start', { amount: 1 }); if (!r.over) r = await a('POST', '/api/play/blackjack/stand'); ok('blackjack deal/stand', r.s === 200 && r.over);
  r = await a('POST', '/api/play/crash/start', { amount: 1, auto: 1.5 }); ok('crash start', r.s === 200);
  await sleep(3500);
  const st = await a('GET', '/api/state'); ok('crash auto-resolves via /state', st.crash === null || st.crash.over === true, JSON.stringify(st.crash));
  ok('feed lists bets', (await a('GET', '/api/feed')).length > 5);

  console.log('money integrity under parallel requests');
  const b = mkClient(); await b('POST', '/api/register', { username: 'racer', password: 'password123', age: true });
  await deposit(b, 10); // exactly $10.00
  const results = await Promise.all(Array.from({ length: 25 }, () => b('POST', '/api/play/dice', { amount: 1, target: 98, over: false })));
  const accepted = results.filter((x) => x.s === 200), refused = results.filter((x) => x.error === 'Insufficient balance');
  const finalBal = (await b('GET', '/api/me')).user.balance;
  const ledger = (await pg.query("select coalesce(sum(payout - stake),0)::int as net, count(*)::int as n from bets where username = 'racer'")).rows[0];
  ok('balance never negative', finalBal >= 0, String(finalBal));
  ok('balance == deposit + sum(payout-stake) from the bets ledger', finalBal === 1000 + ledger.net, `${finalBal} vs ${1000 + ledger.net}`);
  ok('every accepted bet was recorded exactly once', ledger.n === accepted.length, `${ledger.n} vs ${accepted.length}`);
  ok('every request was either accepted or refused for funds', accepted.length + refused.length === 25, `accepted=${accepted.length} refused=${refused.length}`);
  const rr = mkClient(); await rr('POST', '/api/register', { username: 'racer2', password: 'password123', age: true }); await deposit(rr, 10);
  await pg.query("update users set wagered = deposited where id = 'racer2'");
  const wds = await Promise.all(Array.from({ length: 4 }, () => rr('POST', '/api/withdraw', { coin: 'LTC', address: LTC_ADDR, usd: 10 })));
  ok('parallel withdrawals cannot overdraw', wds.filter((x) => x.s === 200).length === 1 && (await rr('GET', '/api/me')).user.balance === 0, JSON.stringify(wds.map((x) => x.s)));

  console.log('withdrawals');
  const w1 = await a('POST', '/api/withdraw', { coin: 'LTC', address: LTC_ADDR, usd: 10 });
  ok('wagering requirement enforced', w1.s === 400 && /Wager/.test(w1.error), JSON.stringify(w1));
  ok('bad address rejected', (await a('POST', '/api/withdraw', { coin: 'BTC', address: 'nope', usd: 10 })).s === 400);
  core.cfg.PROVIDER = 'live';
  await pg.query("update users set wagered = deposited where id = 'alice'"); // pretend they played through
  const bal0 = (await a('GET', '/api/me')).user.balance;
  const w2 = await a('POST', '/api/withdraw', { coin: 'LTC', address: LTC_ADDR, usd: 20 });
  ok('withdrawal pending, balance locked', w2.s === 200 && w2.withdrawal.status === 'pending' && w2.balance === bal0 - 2000, JSON.stringify(w2));
  ok('admin needs token', (await a('GET', '/api/admin/withdrawals')).s === 403);
  ok('admin sees it', (await a('GET', '/api/admin/withdrawals', undefined, ADMIN)).some((w) => w.id === w2.withdrawal.id));
  const rej = await a('POST', '/api/admin/withdrawals/decide', { id: w2.withdrawal.id, action: 'reject', reason: 'test' }, ADMIN);
  ok('reject refunds the player', rej.status === 'rejected' && (await a('GET', '/api/me')).user.balance === bal0);
  ok('cannot decide twice', (await a('POST', '/api/admin/withdrawals/decide', { id: w2.withdrawal.id, action: 'approve', txid: 'x' }, ADMIN)).s === 400);
  const w3 = await a('POST', '/api/withdraw', { coin: 'USDTBSC', address: '0x' + 'ab'.repeat(20), usd: 15 });
  const app = await a('POST', '/api/admin/withdrawals/decide', { id: w3.withdrawal.id, action: 'approve', txid: '0xabc123' }, ADMIN);
  ok('approve marks sent with tx hash', app.status === 'sent' && app.txid === '0xabc123', JSON.stringify(app));

  console.log('live on-chain deposits');
  let chain = [];
  chains.incoming = async (coin) => chain.filter((t) => t.coin === coin).map((t) => ({ ...t }));
  const c1 = mkClient(), c2 = mkClient();
  await c1('POST', '/api/register', { username: 'carol', password: 'password123', age: true });
  await c2('POST', '/api/register', { username: 'dave', password: 'password123', age: true });
  ok('only configured coins offered', Object.keys((await c1('GET', '/api/me')).coins).sort().join() === 'LTC,USDTTRC20');
  ok('BTC (no wallet) refused', (await c1('POST', '/api/deposit', { coin: 'BTC', usd: 50 })).s === 400);
  const q1 = await c1('POST', '/api/deposit', { coin: 'USDTTRC20', usd: 50 }), q2 = await c2('POST', '/api/deposit', { coin: 'USDTTRC20', usd: 50 });
  ok('quotes are just UNDER the request', Number(q1.amount) < 50 && Number(q1.amount) > 49.99 && q1.usd === 5000, q1.amount);
  ok('two players asking $50 get different amounts', q1.amount !== q2.amount, `${q1.amount} ${q2.amount}`);
  ok('quote shows our wallet', q1.address === process.env.DEPOSIT_ADDR_USDTTRC20);
  const units1 = (await pg.query('select units from deposits where id = $1', [q1.id])).rows[0].units;
  chain = [{ coin: 'USDTTRC20', key: 'tx1', units: BigInt(units1), conf: 0 }];
  let dl = await c1('GET', '/api/deposits'); ok('seen in mempool -> detected', dl[0].status === 'detected' && dl[0].txid === 'tx1', JSON.stringify(dl[0]));
  ok('not credited before confirmation', (await c1('GET', '/api/me')).user.balance === 0);
  chain = [{ coin: 'USDTTRC20', key: 'tx1', units: BigInt(units1), conf: 1 }];
  await sleep(8200); // scan throttle window
  dl = await c1('GET', '/api/deposits'); ok('confirmed -> credited exactly $50.00', dl[0].status === 'confirmed' && (await c1('GET', '/api/me')).user.balance === 5000, JSON.stringify(dl[0]));
  ok("the other player's request is untouched", (await c2('GET', '/api/me')).user.balance === 0);
  await Promise.all([watch.scanCoin('USDTTRC20'), watch.scanCoin('USDTTRC20'), watch.scanCoin('USDTTRC20')]);
  ok('replay + 3 parallel scans never double-credit', (await c1('GET', '/api/me')).user.balance === 5000);
  const units2 = (await pg.query('select units from deposits where id = $1', [q2.id])).rows[0].units;
  chain = [{ coin: 'USDTTRC20', key: 'tx1', units: BigInt(units1), conf: 9 }, { coin: 'USDTTRC20', key: 'txWrong', units: BigInt(units2) + 5n, conf: 3 }];
  await watch.scanCoin('USDTTRC20');
  const un = await c1('GET', '/api/admin/unmatched', undefined, ADMIN);
  ok('wrong-amount payment lands in unmatched', un.length === 1 && un[0].key === 'txWrong' && (await c2('GET', '/api/me')).user.balance === 0, JSON.stringify(un));
  const res1 = await c1('POST', '/api/admin/unmatched/resolve', { key: 'txWrong', username: 'dave', usd: 12.5 }, ADMIN);
  ok('admin can credit a stray payment once', res1.status === 'resolved' && (await c2('GET', '/api/me')).user.balance === 1250, JSON.stringify(res1));
  ok('...but not twice', (await c1('POST', '/api/admin/unmatched/resolve', { key: 'txWrong', username: 'dave', usd: 12.5 }, ADMIN)).s === 400);
  await pg.query('update deposits set expires = 1 where id = $1', [q2.id]);
  await watch.scanCoin('USDTTRC20');
  ok('unpaid quote expires', (await c2('GET', '/api/deposits'))[0].status === 'expired');
  const ltc = await c1('POST', '/api/deposit', { coin: 'LTC', usd: 50 });
  ok('LTC quote is a valid 8-decimal amount', ltc.s === 200 && Number(ltc.amount) > 0 && (ltc.amount.split('.')[1] || '').length <= 8, JSON.stringify(ltc));

  console.log('open deposits: view, reuse, cancel');
  const c3 = mkClient(); await c3('POST', '/api/register', { username: 'erin', password: 'password123', age: true });
  const dep3 = (usd) => c3('POST', '/api/deposit', { coin: 'USDTTRC20', usd });
  const o1 = await dep3(10), o1b = await dep3(10);
  ok('asking for the same coin + amount again reopens the same request', o1b.id === o1.id && o1b.amount === o1.amount, JSON.stringify([o1.id, o1b.id]));
  const o2 = await dep3(11), o3 = await dep3(12), o4 = await dep3(13);
  ok('a 4th open deposit is refused with guidance', o4.s === 400 && /Pay one of them below/.test(o4.error), JSON.stringify(o4));
  ok('the open deposits are listed, still payable', (await c3('GET', '/api/deposits')).filter((d) => d.status === 'pending').length === 3);
  ok("can't cancel another player's deposit", (await c1('POST', '/api/deposit/cancel', { id: o1.id })).s === 400);
  ok("can't cancel a deposit that was already paid", (await c1('POST', '/api/deposit/cancel', { id: q1.id })).s === 400);
  ok('cancelling works', (await c3('POST', '/api/deposit/cancel', { id: o2.id })).ok === true);
  ok('cancelling frees a slot', (await dep3(13)).s === 200);
  ok('cancelled shows as cancelled', (await c3('GET', '/api/deposits')).find((d) => d.id === o2.id).status === 'cancelled');
  const u2 = (await pg.query('select units from deposits where id = $1', [o2.id])).rows[0].units;
  chain = [{ coin: 'USDTTRC20', key: 'txCancelled', units: BigInt(u2), conf: 1 }];
  await watch.scanCoin('USDTTRC20');
  ok('a payment for a cancelled request is NOT auto-credited (goes to unmatched for review)', (await c3('GET', '/api/me')).user.balance === 0 && (await c1('GET', '/api/admin/unmatched', undefined, ADMIN)).some((x) => x.key === 'txCancelled'));

  console.log('cron endpoint');
  ok('cron without secret refused', (await mkClient()('GET', '/api/cron/scan')).s === 403);
  ok('cron with secret runs', (await mkClient()('GET', '/api/cron/scan', undefined, { authorization: 'Bearer ' + process.env.CRON_SECRET })).results?.length === 2);

  console.log(`\n${pass} passed, ${failN} failed`);
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });
