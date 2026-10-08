'use strict';
// EVM scanning logic against a fake JSON-RPC node.  `node test/chains.test.js`
const chains = require('../lib/chains');
let pass = 0, failN = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : failN++; console.log(`${cond ? '  ✔' : '  ✘ FAIL'} ${name}${cond ? '' : ' ' + extra}`); };

const ADDR = '0xD086e89099fe699B81FAEB24CCeBbBB813BbCd70';
let latest = 100000, logs = [], calls = [], failOnCall = -1, maxRange = 5000; // fake node state
globalThis.fetch = async (url, opts) => {
  const { method, params } = JSON.parse(opts.body);
  const reply = (result, error) => ({ ok: true, status: 200, json: async () => (error ? { error: { message: error } } : { result }) });
  if (method === 'eth_blockNumber') return reply('0x' + latest.toString(16));
  const f = parseInt(params[0].fromBlock, 16), t = params[0].toBlock === 'latest' ? latest : parseInt(params[0].toBlock, 16);
  calls.push([f, t]);
  if (calls.length - 1 === failOnCall) return reply(null, 'boom');
  if (t - f + 1 > maxRange) return reply(null, 'Archive requests require a personal token'); // what publicnode does for big ranges
  return reply(logs.filter((l) => l.block >= f && l.block <= t).map((l) => ({ transactionHash: l.tx, logIndex: '0x0', blockNumber: '0x' + l.block.toString(16), data: '0x' + l.units.toString(16) })));
};

(async () => {
  let cursor = null;
  const ctx = { getCursor: async () => cursor, setCursor: async (v) => { cursor = v; } };
  logs = [{ block: 99990, tx: '0xaaa', units: 50000000000000000000n }];

  console.log('first scan (no cursor)');
  let r = await chains.incoming('USDTBSC', ADDR, ctx);
  ok('finds the payment, 10 confirmations deep', r.length === 1 && r[0].key === '0xaaa:0' && r[0].conf === 11 && r[0].units === 50000000000000000000n, JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  ok('no query spans more than the node allows', calls.every(([f, t]) => t - f + 1 <= 5000), JSON.stringify(calls));
  ok('cursor saved at the latest block', cursor === latest, String(cursor));

  console.log('next scan, a few blocks later');
  calls = []; latest += 30;
  r = await chains.incoming('USDTBSC', ADDR, ctx);
  ok('re-reads a small overlap (so unconfirmed payments get confirmed)', calls.length === 1 && calls[0][0] === 100000 - (12 + 40) && calls[0][1] === latest, JSON.stringify(calls));
  ok('payment still visible, now with more confirmations', r.length === 1 && r[0].conf === 41, JSON.stringify(r.map((x) => x.conf)));

  console.log('server was idle for ~30,000 blocks');
  calls = []; latest += 30000; logs.push({ block: 110000, tx: '0xbbb', units: 7n });
  r = await chains.incoming('USDTBSC', ADDR, ctx);
  ok('catches up in chunks and finds the payment made during the gap', r.some((x) => x.key === '0xbbb:0'), JSON.stringify(r.map((x) => x.key)));
  ok('every chunk is within the node limit', calls.length > 1 && calls.every(([f, t]) => t - f + 1 <= 4000), JSON.stringify(calls));
  ok('chunks are contiguous (no blocks skipped)', calls.every((c, i) => i === 0 || c[0] === calls[i - 1][1] + 1), JSON.stringify(calls));
  ok('cursor ends at the latest block', cursor === latest);

  console.log('node fails part-way');
  const before = cursor; calls = []; latest += 9000; failOnCall = 1;
  let threw = false; try { await chains.incoming('USDTBSC', ADDR, ctx); } catch { threw = true; }
  ok('error is surfaced', threw);
  ok('cursor does NOT advance past blocks that were not read', cursor === before, `${cursor} vs ${before}`);

  console.log('huge backlog is read over several runs');
  failOnCall = -1; calls = []; latest += 200000;
  await chains.incoming('USDTBSC', ADDR, ctx);
  ok('one run reads at most 12 chunks and saves progress', calls.length === 12 && cursor < latest && cursor === calls[11][1], `${calls.length} chunks, cursor ${cursor}`);

  console.log(`\n${pass} passed, ${failN} failed`);
  process.exit(failN ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });
