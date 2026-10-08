'use strict';
// Persistence. With SUPABASE_URL + SUPABASE_SERVICE_KEY set, every account, balance, deposit, withdrawal and bet is
// written through to Supabase (Postgres). Otherwise it falls back to a local JSON file for development.
// The server keeps the live state in memory; this module persists only the records that changed since the last flush.
const fs = require('fs');
const path = require('path');

module.exports = function createStore({ dataDir }) {
  const URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const KEY = process.env.SUPABASE_SERVICE_KEY || '';
  const remote = !!(URL && KEY);
  const file = path.join(dataDir, 'data.json');
  let db = null, timer = null, chain = Promise.resolve(), dirty = false;
  const snap = new Map();          // "table:id" -> JSON of last persisted row
  const betQueue = [], delSessions = new Set();

  // ---- row mappers (memory camelCase <-> database snake_case) ----
  const T = {
    users: {
      pk: 'id',
      to: (u) => ({ id: u.id, username: u.username, salt: u.salt, hash: u.hash, balance: u.balance, deposited: u.deposited || 0, wagered: u.wagered || 0, created_at: u.createdAt || 0, state: { mines: u.mines || null, hilo: u.hilo || null, bj: u.bj || null, crash: u.crash || null } }),
      from: (r) => ({ id: r.id, username: r.username, salt: r.salt, hash: r.hash, balance: +r.balance, deposited: +r.deposited, wagered: +r.wagered, createdAt: +r.created_at, mines: r.state?.mines || null, hilo: r.state?.hilo || null, bj: r.state?.bj || null, crash: r.state?.crash || null }),
    },
    deposits: {
      pk: 'id',
      to: (d) => ({ id: d.id, user_id: d.user, coin: d.coin, usd: d.usd, status: d.status, credited: d.credited || 0, address: d.address || null, txid: d.txid || null, units: d.units || null, amount: d.amount || null, expires: d.expires || null, confirmations: d.confirmations || 0, note: d.note || null, created_at: d.createdAt, confirmed_at: d.confirmedAt || null }),
      from: (r) => ({ id: r.id, user: r.user_id, coin: r.coin, usd: +r.usd, status: r.status, credited: +r.credited, address: r.address, txid: r.txid || undefined, units: r.units || undefined, amount: r.amount || undefined, expires: r.expires ? +r.expires : undefined, confirmations: +r.confirmations || 0, note: r.note, createdAt: +r.created_at, confirmedAt: r.confirmed_at ? +r.confirmed_at : undefined }),
    },
    withdrawals: {
      pk: 'id',
      to: (w) => ({ id: w.id, user_id: w.user, coin: w.coin, address: w.address, usd: w.usd, status: w.status, txid: w.txid || null, note: w.note || null, created_at: w.createdAt, decided_at: w.decidedAt || null }),
      from: (r) => ({ id: r.id, user: r.user_id, coin: r.coin, address: r.address, usd: +r.usd, status: r.status, txid: r.txid || undefined, note: r.note || undefined, createdAt: +r.created_at, decidedAt: r.decided_at ? +r.decided_at : undefined }),
    },
    unmatched: {
      table: 'unmatched_deposits', pk: 'key',
      to: (x) => ({ key: x.key, coin: x.coin, units: x.units, amount: x.amount, seen_at: x.seenAt, status: x.status, note: x.note || null, resolved_user: x.resolvedUser || null, resolved_usd: x.resolvedUsd || null }),
      from: (r) => ({ key: r.key, coin: r.coin, units: r.units, amount: r.amount, seenAt: +r.seen_at, status: r.status, note: r.note || undefined, resolvedUser: r.resolved_user || undefined, resolvedUsd: r.resolved_usd ? +r.resolved_usd : undefined }),
    },
    sessions: {
      pk: 'token_hash',
      to: (userId, hash) => ({ token_hash: hash, user_id: userId, created_at: Date.now() }),
    },
  };

  // ---- Supabase REST helper ----
  async function rest(method, pathq, body, headers = {}) {
    const r = await fetch(`${URL}/rest/v1/${pathq}`, { method, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`Supabase ${method} ${pathq.split('?')[0]} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.status === 204 ? null : r.json().catch(() => null);
  }
  const upsert = (name, rows) => rows.length ? rest('POST', `${T[name].table || name}?on_conflict=${T[name].pk}`, rows, { Prefer: 'resolution=merge-duplicates,return=minimal' }) : null;
  async function fetchAll(table, order) {
    const out = [];
    for (let off = 0; ; off += 1000) {
      const page = await rest('GET', `${table}?select=*&order=${order}&limit=1000&offset=${off}`);
      out.push(...page); if (page.length < 1000) return out;
    }
  }

  // ---- load ----
  async function load() {
    const fresh = { users: {}, sessions: {}, deposits: {}, withdrawals: {}, unmatched: {}, bets: [] };
    if (!remote) {
      try { db = { ...fresh, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { db = fresh; }
      return db;
    }
    db = fresh;
    for (const r of await fetchAll('users', 'id')) { db.users[r.id] = T.users.from(r); snap.set('users:' + r.id, JSON.stringify(T.users.to(db.users[r.id]))); }
    for (const r of await fetchAll('deposits', 'id')) { db.deposits[r.id] = T.deposits.from(r); snap.set('deposits:' + r.id, JSON.stringify(T.deposits.to(db.deposits[r.id]))); }
    for (const r of await fetchAll('withdrawals', 'id')) { db.withdrawals[r.id] = T.withdrawals.from(r); snap.set('withdrawals:' + r.id, JSON.stringify(T.withdrawals.to(db.withdrawals[r.id]))); }
    for (const r of await fetchAll('unmatched_deposits', 'key')) { db.unmatched[r.key] = T.unmatched.from(r); snap.set('unmatched:' + r.key, JSON.stringify(T.unmatched.to(db.unmatched[r.key]))); }
    for (const r of await fetchAll('sessions', 'token_hash')) { db.sessions[r.token_hash] = r.user_id; snap.set('sessions:' + r.token_hash, JSON.stringify(T.sessions.to(r.user_id, r.token_hash)).replace(/"created_at":\d+/, '')); }
    const recent = await rest('GET', 'bets?select=*&order=at.desc&limit=500');
    db.bets = recent.reverse().map((r) => ({ id: r.id, user: r.username, game: r.game, stake: +r.stake, payout: +r.payout, at: +r.at }));
    return db;
  }

  // ---- flush: persist only what changed ----
  async function doFlush() {
    if (!remote) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, file); return; }
    const changed = { users: [], deposits: [], withdrawals: [], unmatched: [] }, marks = [];
    for (const table of ['users', 'deposits', 'withdrawals', 'unmatched']) {
      for (const [id, rec] of Object.entries(db[table] || {})) {
        const row = T[table].to(rec), s = JSON.stringify(row), k = table + ':' + id;
        if (snap.get(k) !== s) { changed[table].push(row); marks.push([k, s]); }
      }
    }
    const sess = [];
    for (const [h, uid] of Object.entries(db.sessions)) { const k = 'sessions:' + h; if (!snap.has(k)) { sess.push(T.sessions.to(uid, h)); marks.push([k, JSON.stringify(T.sessions.to(uid, h)).replace(/"created_at":\d+/, '')]); } }
    const bets = betQueue.splice(0);
    const dels = [...delSessions]; delSessions.clear();
    try {
      // users first so foreign keys on the others resolve
      for (let i = 0; i < changed.users.length; i += 500) await upsert('users', changed.users.slice(i, i + 500));
      for (const t of ['deposits', 'withdrawals', 'unmatched']) for (let i = 0; i < changed[t].length; i += 500) await upsert(t, changed[t].slice(i, i + 500));
      if (sess.length) await upsert('sessions', sess);
      for (const h of dels) await rest('DELETE', `sessions?token_hash=eq.${encodeURIComponent(h)}`);
      if (bets.length) await rest('POST', 'bets', bets.map((b) => ({ id: b.id, username: b.user, game: b.game, stake: b.stake, payout: b.payout, at: b.at })), { Prefer: 'resolution=ignore-duplicates,return=minimal' });
      for (const [k, s] of marks) snap.set(k, s);
      for (const h of dels) snap.delete('sessions:' + h);
    } catch (e) { betQueue.unshift(...bets); for (const h of dels) delSessions.add(h); throw e; }
  }

  const runFlush = () => (chain = chain.then(doFlush));
  // flush(): awaited for money-critical writes. touch(): debounced for everything else.
  const flush = () => { clearTimeout(timer); timer = null; dirty = false; return runFlush().catch((e) => { dirty = true; schedule(2000); throw e; }); };
  function schedule(ms) { if (!timer) timer = setTimeout(() => { timer = null; flush().catch((e) => console.error('[store] flush failed, will retry:', e.message)); }, ms); }
  const touch = () => { dirty = true; schedule(150); };

  return {
    remote, load, flush, touch,
    queueBet: (b) => { betQueue.push(b); },
    dropSession: (hash) => { delSessions.add(hash); },
    // Team can mark a withdrawal 'sent' (+ txid) directly in the Supabase dashboard; mirror that into memory.
    async pollWithdrawals() {
      if (!remote) return;
      const rows = await rest('GET', 'withdrawals?select=id,status,txid,note&status=eq.sent');
      let n = 0;
      for (const r of rows) { const w = db.withdrawals[r.id]; if (w && w.status === 'pending') { w.status = 'sent'; w.txid = r.txid || undefined; w.decidedAt = Date.now(); n++; } }
      if (n) touch();
    },
  };
};
