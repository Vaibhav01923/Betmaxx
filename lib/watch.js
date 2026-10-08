'use strict';
// On-chain deposit watcher. Stateless: safe to run from any serverless instance, concurrently.
// A payment is credited exactly once because the match, the status change and the balance credit happen in one
// transaction holding a row lock on the deposit request.
const { query, tx } = require('./db');
const { chains, wallets } = require('./core');

async function scanCoin(coin) {
  const addr = wallets()[coin], c = chains.COINS[coin], now = Date.now();
  if (!addr) return { coin, skipped: true };

  // housekeeping: expire unpaid quotes, and free amounts of old finished requests so tags can be reused
  await query("update deposits set status = 'expired' where coin = $1 and status = 'pending' and expires < $2", [coin, now]);
  await query("update deposits set units = null where coin = $1 and units is not null and status in ('confirmed','expired') and coalesce(confirmed_at, expires) < $2", [coin, now - 864e5]);

  const txs = await chains.incoming(coin, addr);
  if (!txs.length) return { coin, seen: 0, credited: 0, unmatched: 0 };

  // skip payments we have already handled
  const keys = txs.map((t) => t.key);
  const known = new Set([
    ...(await query("select txid from deposits where txid = any($1) and status = 'confirmed'", [keys])).rows.map((r) => r.txid),
    ...(await query('select key from unmatched_deposits where key = any($1)', [keys])).rows.map((r) => r.key),
  ]);
  let credited = 0, unmatched = 0;
  for (const t of txs) {
    if (known.has(t.key)) continue;
    const units = t.units.toString();
    await tx(async (q) => {
      const d = (await q.query("select * from deposits where coin = $1 and units = $2 and (status = 'pending' or (status = 'detected' and txid = $3)) for update", [coin, units, t.key])).rows[0];
      if (d) {
        if (t.conf >= c.minConf) {
          await q.query("update deposits set status = 'confirmed', txid = $2, confirmations = $3, credited = usd, confirmed_at = $4 where id = $1", [d.id, t.key, t.conf, now]);
          await q.query('update users set balance = balance + $2, deposited = deposited + $2 where id = $1', [d.user_id, d.usd]);
          credited++; console.log(`[watch] credited ${d.user_id} $${d.usd / 100} (${coin} ${t.key.slice(0, 12)}…)`);
        } else if (d.status !== 'detected' || d.confirmations !== t.conf) {
          await q.query("update deposits set status = 'detected', txid = $2, confirmations = $3 where id = $1", [d.id, t.key, t.conf]);
        }
        return;
      }
      if (t.conf >= c.minConf && !known.has(t.key)) {
        const r = await q.query("insert into unmatched_deposits(key, coin, units, amount, seen_at, status, note) values ($1,$2,$3,$4,$5,'open','No open deposit request for this exact amount') on conflict do nothing", [t.key, coin, units, chains.format(t.units, c.dec, 2), now]);
        if (r.rowCount) { unmatched++; console.warn(`[watch] unmatched ${coin} payment ${chains.format(t.units, c.dec, 2)} (${t.key.slice(0, 12)}…)`); }
      }
    });
  }
  return { coin, seen: txs.length, credited, unmatched };
}

// Called while a player is waiting on a deposit. At most one scan per coin every 8s across all instances.
async function scanIfDue(coin) {
  const now = Date.now();
  const r = await query("insert into kv(key, val) values ($1, $2) on conflict (key) do update set val = excluded.val where kv.val < $2 - 8000 returning val", ['scan:' + coin, now]);
  if (!r.rows.length) return null;
  try { return await scanCoin(coin); } catch (e) { console.error(`[watch] ${coin} scan failed: ${e.message}`); return null; }
}

async function scanAll() {
  const out = [];
  for (const coin of Object.keys(wallets())) {
    try { out.push(await scanCoin(coin)); } catch (e) { console.error(`[watch] ${coin} scan failed: ${e.message}`); out.push({ coin, error: e.message }); }
  }
  await query('delete from rate_limits where at < $1', [Date.now() - 2 * 3600e3]);
  await query('delete from sessions where created_at < $1', [Date.now() - 30 * 864e5]);
  return out;
}

module.exports = { scanCoin, scanIfDue, scanAll };
