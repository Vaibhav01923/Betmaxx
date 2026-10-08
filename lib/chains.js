'use strict';
// Blockchain watcher helpers. Read-only: uses free public explorer / RPC endpoints, no API keys, no private keys.
// A shared deposit address can't say who paid, so every deposit request gets an exact amount with a tiny unique "tag"
// (e.g. 50.37 USDT). A payment of exactly that amount to the address is matched to that request and credited automatically.

const COINS = {
  BTC:       { name: 'Bitcoin',       asset: 'BTC',  network: 'Bitcoin',  sym: 'BTC',  dec: 8,  kind: 'esplora', api: 'https://blockstream.info/api',  minConf: 1,  price: 'BTC' },
  LTC:       { name: 'Litecoin',      asset: 'LTC',  network: 'Litecoin', sym: 'LTC',  dec: 8,  kind: 'esplora', api: 'https://litecoinspace.org/api', minConf: 1,  price: 'LTC' },
  USDTTRC20: { name: 'USDT (TRC20)',  asset: 'USDT', network: 'TRON (TRC20)',             sym: 'USDT', dec: 6,  kind: 'tron',    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', minConf: 1, stable: true },
  USDTERC20: { name: 'USDT (ERC20)',  asset: 'USDT', network: 'Ethereum (ERC20)',         sym: 'USDT', dec: 6,  kind: 'evm',     rpc: 'https://ethereum-rpc.publicnode.com', rpcEnv: 'ETH_RPC_URL', contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', minConf: 6,  initial: 2500, chunk: 2000, stable: true },
  USDTBSC:   { name: 'USDT (BEP20)',  asset: 'USDT', network: 'BNB Smart Chain (BEP20)',  sym: 'USDT', dec: 18, kind: 'evm',     rpc: 'https://bsc-rpc.publicnode.com',      rpcEnv: 'BSC_RPC_URL', contract: '0x55d398326f99059fF775485246999027B3197955', minConf: 12, initial: 4000, chunk: 4000, stable: true },
};
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function get(url, opts) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), ...opts });
  if (!r.ok) throw new Error(`${url.split('?')[0]} -> ${r.status}`);
  return r.json();
}
const rpc = (url, method, params) => get(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  .then((j) => { if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; });

// ---- incoming payments to `addr`: [{ key, units: BigInt (smallest unit), conf: number }] ----
// `ctx` (optional, EVM only) = { getCursor(), setCursor(block) }: remembers how far the chain has been scanned so no payment can be
// missed between scans. Public nodes cap how far back one query may look, so history is read in small chunks.
async function incoming(coin, addr, ctx) {
  const c = COINS[coin];
  if (c.kind === 'esplora') {
    const [txs, tip] = await Promise.all([get(`${c.api}/address/${addr}/txs`), get(`${c.api}/blocks/tip/height`)]);
    const out = [];
    for (const tx of txs) tx.vout.forEach((o, i) => {
      if (o.scriptpubkey_address === addr) out.push({ key: `${tx.txid}:${i}`, units: BigInt(o.value), conf: tx.status.confirmed ? tip - tx.status.block_height + 1 : 0 });
    });
    return out;
  }
  if (c.kind === 'tron') {
    const q = `https://api.trongrid.io/v1/accounts/${addr}/transactions/trc20?only_to=true&limit=50&contract_address=${c.contract}`;
    const all = await get(q);
    await new Promise((r) => setTimeout(r, 400));
    const done = await get(q + '&only_confirmed=true');
    const confirmed = new Set(done.data.map((t) => t.transaction_id));
    return all.data.filter((t) => t.to === addr && t.token_info?.address === c.contract)
      .map((t) => ({ key: t.transaction_id, units: BigInt(t.value), conf: confirmed.has(t.transaction_id) ? 1 : 0 }));
  }
  // evm: ERC-20 Transfer logs to addr. Set ETH_RPC_URL / BSC_RPC_URL to your own node (free Alchemy/Infura/QuickNode tier) for reliability.
  const url = process.env[c.rpcEnv] || c.rpc, hex = (n) => '0x' + n.toString(16);
  const latest = parseInt(await rpc(url, 'eth_blockNumber', []), 16);
  const cursor = ctx ? await ctx.getCursor() : null;
  let from = cursor ? Math.max(0, cursor - (c.minConf + 40)) : latest - c.initial; // overlap so unconfirmed payments are re-read until confirmed
  const topics = [TRANSFER_TOPIC, null, '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')], out = [];
  let scannedTo = from - 1;
  for (let n = 0; from + n * c.chunk <= latest && n < 12; n++) {
    const start = from + n * c.chunk, end = Math.min(latest, start + c.chunk - 1);
    const logs = await rpc(url, 'eth_getLogs', [{ fromBlock: hex(start), toBlock: hex(end), address: c.contract, topics }]);
    for (const l of logs) out.push({ key: `${l.transactionHash}:${parseInt(l.logIndex, 16)}`, units: BigInt(l.data), conf: latest - parseInt(l.blockNumber, 16) + 1 });
    scannedTo = end;
  }
  if (ctx && scannedTo >= 0) await ctx.setCursor(scannedTo); // only advances over blocks that were really read
  return out;
}

// ---- prices (USD) for BTC / LTC, cached 30s ----
const cache = {};
async function usdPrice(sym) {
  const hit = cache[sym];
  if (hit && Date.now() - hit.at < 30000) return hit.p;
  const j = await get(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`);
  const p = Number(j.data.amount);
  if (!(p > 0)) throw new Error('bad price for ' + sym);
  cache[sym] = { p, at: Date.now() };
  return p;
}

function format(units, dec, minDecimals) {
  const s = units.toString().padStart(dec + 1, '0');
  let [i, f] = [s.slice(0, -dec), s.slice(-dec)];
  f = f.replace(/0+$/, '').padEnd(minDecimals, '0');
  return f ? `${i}.${f}` : i;
}

// Builds the exact amount a player must send. The unique "tag" is a tiny reduction in the far decimals, so a $50 request
// becomes e.g. 49.99983 USDT (always a hair UNDER the request, never over), and the player is credited the full $50.00 they asked for.
// `taken` = Set of expected-unit strings reserved by open (or recently expired) requests.
async function quote(coin, usdCents, taken) {
  const c = COINS[coin], rnd = (n) => 1 + Math.floor(Math.random() * n);
  let base, tagUnit, tagMax, minDecimals;
  if (c.stable) { // tag = 1..499 x 0.00001 USDT below the request (under half a cent)
    base = BigInt(usdCents) * 10n ** BigInt(c.dec - 2); tagUnit = 10n ** BigInt(c.dec - 5); tagMax = 499; minDecimals = 2;
  } else {        // tag spans up to about 3 cents of the coin's value
    const price = await usdPrice(c.price), perUnit = price / 10 ** c.dec;
    base = BigInt(Math.round((usdCents / 100 / price) * 10 ** c.dec)); tagUnit = 1n; tagMax = Math.max(20, Math.floor(0.03 / perUnit)); minDecimals = 0;
  }
  for (let n = 0; n < 300; n++) {
    const units = base - BigInt(rnd(tagMax)) * tagUnit;
    if (units > 0n && !taken.has(units.toString())) return { units, usd: usdCents, display: format(units, c.dec, minDecimals) };
  }
  throw Object.assign(new Error('Too many open deposits for this coin right now, please try again in a few minutes'), { code: 503 });
}

module.exports = { COINS, incoming, quote, format };
