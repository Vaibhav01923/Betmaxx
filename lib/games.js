'use strict';
// Game engine. All randomness is server-side CSPRNG. Stake is deducted at start (begin) and paid out at the end (finish).
const crypto = require('crypto');
const rand = (n) => crypto.randomInt(n);
const unif = () => crypto.randomInt(1, 2 ** 31) / 2 ** 31; // (0,1)
const r2 = (x) => Math.round(x * 100) / 100;
const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
const card = () => ({ r: 1 + rand(13), s: rand(4) });

// ---- payout tables (computed so each has ~99% RTP) ----
const PLINKO = {};
for (const rows of [8, 12, 16]) {
  PLINKO[rows] = {};
  for (const [risk, [c0, c1, pw]] of Object.entries({ low: [0.5, 6, 3], medium: [0.3, 20, 3.5], high: [0.2, 100, 4.5] })) {
    const raw = [], p = [];
    for (let k = 0; k <= rows; k++) { raw.push(c0 + c1 * (Math.abs(k - rows / 2) / (rows / 2)) ** pw); p.push(binom(rows, k) / 2 ** rows); }
    const scale = 0.99 / raw.reduce((s, x, i) => s + x * p[i], 0);
    PLINKO[rows][risk] = raw.map((x) => r2(x * scale));
  }
}
const KENO = {};
for (let k = 1; k <= 10; k++) {
  const minHit = Math.ceil(k / 2), levels = k - minHit + 1;
  KENO[k] = [];
  for (let h = 0; h <= k; h++) {
    const P = (binom(k, h) * binom(40 - k, 10 - h)) / binom(40, 10);
    KENO[k].push(h >= minHit ? Math.min(1000, Math.floor((0.99 / (P * levels)) * 100) / 100) : 0);
  }
}
const spread = (a) => { const o = []; a.forEach((x, i) => (o[(i * 7) % a.length] = x)); return o; };
const rep = (v, n) => Array(n).fill(v);
const WHEEL = {
  low: spread([...rep(1.2, 10), ...rep(0, 5), ...rep(1.5, 4), 1.8]),
  medium: spread([...rep(0, 8), ...rep(1.5, 6), ...rep(2, 3), 3, 3, 0.8]),
  high: spread([...rep(0, 19), 19.8]),
};
const SLOT_W = [30, 25, 20, 12, 8, 5], SLOT_T = [6, 10, 18, 36, 70, 120];
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const CRASH_RATE = 0.00012; // multiplier = e^(rate * ms)

module.exports = function makeGames({ fail, amount, begin, finish }) {
  const need = (u, k) => { if (u[k]) throw fail('Finish your current game first'); };
  const int = (v, lo, hi, msg) => { v = Number(v); if (!Number.isInteger(v) || v < lo || v > hi) throw fail(msg); return v; };

  // ---- mines ----
  const minesMult = (m, k) => { let x = 0.99; for (let i = 0; i < k; i++) x *= (25 - i) / (25 - m - i); return x; };
  const minesView = (g) => { const mult = r2(minesMult(g.count, g.revealed.length)); return { stake: g.stake, count: g.count, revealed: g.revealed, mult, next: r2(minesMult(g.count, g.revealed.length + 1)) }; };
  const minesEnd = (u, payout, extra) => {
    const g = u.mines; u.mines = null;
    return finish(u, 'mines', g.stake, payout, { positions: g.positions, ...extra });
  };

  // ---- hilo ----
  const hiloView = (g) => {
    const hiP = (14 - g.card.r) / 13, loP = g.card.r / 13;
    return { stake: g.stake, card: g.card, mult: r2(g.mult), rounds: g.rounds, hiP, loP, hiMult: r2((g.mult * 0.99) / hiP), loMult: r2((g.mult * 0.99) / loP) };
  };

  // ---- blackjack ----
  const hv = (h) => { let t = 0, ace = false; for (const c of h) { t += Math.min(c.r, 10); if (c.r === 1) ace = true; } return ace && t + 10 <= 21 ? t + 10 : t; };
  const isBJ = (h) => h.length === 2 && hv(h) === 21;
  const bjView = (g, reveal) => ({ stake: g.stake, player: g.player, dealer: reveal ? g.dealer : [g.dealer[0], null], pv: hv(g.player), dv: reveal ? hv(g.dealer) : null, canDouble: g.player.length === 2 });
  const bjEnd = (u, outcome, payout) => {
    const g = u.bj; u.bj = null;
    return finish(u, 'blackjack', g.stake, payout, { ...bjView(g, true), over: true, outcome });
  };
  const bjDealer = (u) => {
    const g = u.bj, pv = hv(g.player);
    if (pv <= 21) while (hv(g.dealer) < 17) g.dealer.push(card());
    const dv = hv(g.dealer);
    if (pv > 21) return bjEnd(u, 'bust', 0);
    if (dv > 21 || pv > dv) return bjEnd(u, 'win', g.stake * 2);
    if (pv === dv) return bjEnd(u, 'push', g.stake);
    return bjEnd(u, 'lose', 0);
  };

  // ---- crash ----
  const crashT = (m) => Math.log(m) / CRASH_RATE;
  function crashResolve(u) {
    const c = u.crash; if (!c) return null;
    const el = Date.now() - c.start;
    if (c.auto && c.auto <= c.point && el >= crashT(c.auto)) { u.crash = null; return finish(u, 'crash', c.stake, Math.floor(c.stake * c.auto), { point: c.point, cashedAt: c.auto, over: true }); }
    if (el >= crashT(c.point)) { u.crash = null; return finish(u, 'crash', c.stake, 0, { point: c.point, over: true }); }
    return null;
  }

  const play = {
    dice(u, b) {
      const stake = amount(b.amount), target = Number(b.target), over = !!b.over;
      if (!(target >= 2 && target <= 98)) throw fail('Target must be between 2 and 98');
      const chance = over ? 100 - target : target;
      begin(u, 'dice', stake);
      const roll = rand(10000) / 100;
      const win = over ? roll > target : roll < target;
      return finish(u, 'dice', stake, win ? Math.floor((stake * 99) / chance) : 0, { roll, target, over, mult: r2(99 / chance) });
    },
    limbo(u, b) {
      const stake = amount(b.amount), target = r2(Number(b.target));
      if (!(target >= 1.01 && target <= 1000)) throw fail('Target must be between 1.01 and 1000');
      begin(u, 'limbo', stake);
      const result = Math.max(1, Math.floor((99 / unif())) / 100);
      return finish(u, 'limbo', stake, result >= target ? Math.floor(stake * target) : 0, { result: Math.min(result, 1e6), target });
    },
    coin(u, b) {
      const stake = amount(b.amount), pick = b.side === 'tails' ? 'tails' : 'heads';
      begin(u, 'coin', stake);
      const result = rand(2) ? 'heads' : 'tails';
      return finish(u, 'coin', stake, result === pick ? Math.floor(stake * 1.96) : 0, { result, pick });
    },
    slots(u, b) {
      const stake = amount(b.amount);
      begin(u, 'slots', stake);
      const spin = () => { let r = rand(100); for (let i = 0; i < 6; i++) { if (r < SLOT_W[i]) return i; r -= SLOT_W[i]; } };
      const reels = [spin(), spin(), spin()];
      const mult = reels[0] === reels[1] && reels[1] === reels[2] ? SLOT_T[reels[0]] : reels.filter((x) => x === 0).length === 2 ? 2 : 0;
      return finish(u, 'slots', stake, Math.floor(stake * mult), { reels, mult });
    },
    plinko(u, b) {
      const stake = amount(b.amount), rows = int(b.rows, 8, 16, 'Rows must be 8, 12 or 16');
      if (!PLINKO[rows] || !PLINKO[rows][b.risk]) throw fail('Invalid rows or risk');
      begin(u, 'plinko', stake);
      const path = Array.from({ length: rows }, () => rand(2));
      const bucket = path.reduce((a, x) => a + x, 0), mult = PLINKO[rows][b.risk][bucket];
      return finish(u, 'plinko', stake, Math.floor(stake * mult), { path, bucket, mult });
    },
    keno(u, b) {
      const stake = amount(b.amount);
      const picks = [...new Set((b.picks || []).map(Number))];
      if (!picks.length || picks.length > 10 || picks.some((n) => !Number.isInteger(n) || n < 1 || n > 40)) throw fail('Pick 1–10 numbers between 1 and 40');
      begin(u, 'keno', stake);
      const pool = Array.from({ length: 40 }, (_, i) => i + 1), drawn = [];
      for (let i = 0; i < 10; i++) drawn.push(pool.splice(rand(pool.length), 1)[0]);
      const hits = picks.filter((n) => drawn.includes(n)).length, mult = KENO[picks.length][hits];
      return finish(u, 'keno', stake, Math.floor(stake * mult), { drawn, picks, hits, mult });
    },
    roulette(u, b) {
      if (!Array.isArray(b.bets) || !b.bets.length || b.bets.length > 60) throw fail('Place at least one bet');
      const bets = b.bets.map((x) => ({ type: String(x.type), value: Number(x.value), amt: amount(x.amount) }));
      let total = 0;
      for (const x of bets) {
        const ok = (x.type === 'n' && Number.isInteger(x.value) && x.value >= 0 && x.value <= 36)
          || (['dozen', 'col'].includes(x.type) && [1, 2, 3].includes(x.value))
          || ['red', 'black', 'odd', 'even', 'low', 'high'].includes(x.type);
        if (!ok) throw fail('Invalid bet');
        total += x.amt;
      }
      if (total > 500000) throw fail('Total bet too large');
      begin(u, 'roulette', total);
      const n = rand(37);
      let payout = 0;
      for (const x of bets) {
        let win = false, m = 1;
        switch (x.type) {
          case 'n': win = n === x.value; m = 35; break;
          case 'red': win = n > 0 && RED.has(n); break;
          case 'black': win = n > 0 && !RED.has(n); break;
          case 'odd': win = n > 0 && n % 2 === 1; break;
          case 'even': win = n > 0 && n % 2 === 0; break;
          case 'low': win = n >= 1 && n <= 18; break;
          case 'high': win = n >= 19; break;
          case 'dozen': win = n > 0 && Math.ceil(n / 12) === x.value; m = 2; break;
          case 'col': win = n > 0 && ((n - 1) % 3) + 1 === x.value; m = 2; break;
        }
        if (win) payout += x.amt * (m + 1);
      }
      return finish(u, 'roulette', total, payout, { number: n, color: n === 0 ? 'green' : RED.has(n) ? 'red' : 'black' });
    },
    wheel(u, b) {
      const stake = amount(b.amount), t = WHEEL[b.risk];
      if (!t) throw fail('Invalid risk');
      begin(u, 'wheel', stake);
      const index = rand(t.length), mult = t[index];
      return finish(u, 'wheel', stake, Math.floor(stake * mult), { index, mult });
    },

    // ---- stateful games ----
    'mines/start'(u, b) {
      need(u, 'mines');
      const stake = amount(b.amount), count = int(b.mines, 1, 24, 'Mines must be 1–24');
      begin(u, 'mines', stake);
      const pool = Array.from({ length: 25 }, (_, i) => i), positions = [];
      for (let i = 0; i < count; i++) positions.push(pool.splice(rand(pool.length), 1)[0]);
      u.mines = { stake, count, positions, revealed: [] };
      return { balance: u.balance, ...minesView(u.mines) };
    },
    'mines/reveal'(u, b) {
      const g = u.mines; if (!g) throw fail('No active game');
      const i = int(b.index, 0, 24, 'Bad tile');
      if (g.revealed.includes(i)) throw fail('Already revealed');
      if (g.positions.includes(i)) return { ...minesEnd(u, 0, { hit: i }), over: true };
      g.revealed.push(i);
      if (g.revealed.length === 25 - g.count) return { ...minesEnd(u, Math.floor(g.stake * minesMult(g.count, g.revealed.length)), { hit: -1 }), over: true };
      return { balance: u.balance, over: false, ...minesView(g) };
    },
    'mines/cashout'(u) {
      const g = u.mines; if (!g || !g.revealed.length) throw fail('Reveal at least one tile first');
      return { ...minesEnd(u, Math.floor(g.stake * minesMult(g.count, g.revealed.length)), { hit: -1 }), over: true };
    },

    'hilo/start'(u, b) {
      need(u, 'hilo');
      const stake = amount(b.amount);
      begin(u, 'hilo', stake);
      u.hilo = { stake, card: card(), mult: 1, rounds: 0 };
      return { balance: u.balance, ...hiloView(u.hilo) };
    },
    'hilo/guess'(u, b) {
      const g = u.hilo; if (!g) throw fail('No active game');
      const hi = b.dir === 'hi', p = hi ? (14 - g.card.r) / 13 : g.card.r / 13, next = card();
      const win = hi ? next.r >= g.card.r : next.r <= g.card.r;
      if (!win) { u.hilo = null; return { ...finish(u, 'hilo', g.stake, 0, { card: next, over: true }) }; }
      g.mult *= 0.99 / p; g.card = next; g.rounds++; save_();
      return { balance: u.balance, over: false, ...hiloView(g) };
    },
    'hilo/cashout'(u) {
      const g = u.hilo; if (!g || !g.rounds) throw fail('Make at least one guess first');
      u.hilo = null;
      return finish(u, 'hilo', g.stake, Math.floor(g.stake * g.mult), { card: g.card, mult: r2(g.mult), over: true });
    },

    'blackjack/start'(u, b) {
      need(u, 'bj');
      const stake = amount(b.amount);
      begin(u, 'blackjack', stake);
      u.bj = { stake, player: [card(), card()], dealer: [card(), card()] };
      const pb = isBJ(u.bj.player), db = isBJ(u.bj.dealer);
      if (pb && db) return bjEnd(u, 'push', stake);
      if (pb) return bjEnd(u, 'blackjack', Math.floor(stake * 2.5));
      if (db) return bjEnd(u, 'lose', 0);
      return { balance: u.balance, over: false, ...bjView(u.bj, false) };
    },
    'blackjack/hit'(u) {
      const g = u.bj; if (!g) throw fail('No active game');
      g.player.push(card());
      const v = hv(g.player);
      if (v > 21) return bjEnd(u, 'bust', 0);
      if (v === 21) return bjDealer(u);
      save_();
      return { balance: u.balance, over: false, ...bjView(g, false) };
    },
    'blackjack/stand'(u) { if (!u.bj) throw fail('No active game'); return bjDealer(u); },
    'blackjack/double'(u) {
      const g = u.bj; if (!g) throw fail('No active game');
      if (g.player.length !== 2) throw fail('Can only double on first two cards');
      begin(u, 'blackjack', g.stake);
      g.stake *= 2; g.player.push(card());
      return bjDealer(u);
    },

    'crash/start'(u, b) {
      if (u.crash && !crashResolve(u)) throw fail('Round in progress');
      const stake = amount(b.amount);
      const auto = b.auto ? r2(Number(b.auto)) : null;
      if (auto !== null && !(auto >= 1.01 && auto <= 1000)) throw fail('Auto cashout must be 1.01–1000');
      begin(u, 'crash', stake);
      u.crash = { stake, point: Math.max(1, Math.floor(99 / unif()) / 100), start: Date.now(), auto };
      save_();
      return { balance: u.balance, running: true, elapsed: 0, rate: CRASH_RATE };
    },
    'crash/cashout'(u) {
      if (!u.crash) throw fail('No active round');
      const done = crashResolve(u); if (done) return done;
      const c = u.crash, mult = Math.floor(100 * Math.exp(CRASH_RATE * (Date.now() - c.start))) / 100;
      u.crash = null;
      return finish(u, 'crash', c.stake, Math.floor(c.stake * mult), { point: c.point, cashedAt: mult, over: true });
    },
  };
  let save_ = () => {};

  return {
    play,
    setSave(f) { save_ = f; },
    config: { plinko: PLINKO, keno: KENO, wheel: WHEEL, crashRate: CRASH_RATE },
    state(u) {
      const crash = u.crash ? crashResolve(u) || { running: true, elapsed: Date.now() - u.crash.start, stake: u.crash.stake, auto: u.crash.auto, rate: CRASH_RATE } : null;
      return {
        mines: u.mines && minesView(u.mines),
        hilo: u.hilo && hiloView(u.hilo),
        bj: u.bj && bjView(u.bj, false),
        crash, balance: u.balance,
      };
    },
  };
};
