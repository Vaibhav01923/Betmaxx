'use strict';
// Postgres access. Production: `pg` over the Supabase transaction pooler (DATABASE_URL). Tests inject an in-process
// PGlite instance through setClient(). Every money-moving request runs inside one transaction with row locks.
const pg = require('pg');
pg.types.setTypeParser(20, (v) => Number(v)); // bigint -> number (all amounts are cents / epoch ms, well under 2^53)

let pool = null, override = null;
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw Object.assign(new Error('DATABASE_URL is not set'), { code: 500 });
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,                         // serverless: keep per-instance connections small; the pooler multiplexes them
      idleTimeoutMillis: 10000,
      ssl: process.env.DATABASE_SSL === 'off' ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

const query = (text, params) => (override || getPool()).query(text, params);

async function tx(fn) {
  if (override) return override.transaction((t) => fn({ query: (text, params) => t.query(text, params) }));
  const c = await getPool().connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    try { await c.query('rollback'); } catch {}
    throw e;
  } finally { c.release(); }
}

module.exports = { query, tx, setClient: (c) => { override = c; } };
