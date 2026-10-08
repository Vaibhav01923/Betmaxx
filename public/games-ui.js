'use strict';
// Game UIs. Each registers on B.games with { name, cat, rtp, bg, art, mount(panel, stage) -> cleanup }.
(() => {
  const { $, $$, usd, esc, wait } = B;
  const val = (id) => +$('#' + id).value;
  const mk = (id, name, cat, rtp, bg, art, mount) => (B.games[id] = { name, cat, rtp, bg, art, mount });
  const pushHist = (el, text, win) => { const sp = document.createElement('span'); sp.className = win ? 'w' : 'l'; sp.textContent = text; el.prepend(sp); while (el.children.length > 12) el.lastChild.remove(); };
  const done = (r) => { B.setBal(r.balance); B.refreshFeed(); };
  const syncMe = () => B.api('me').then((d) => { B.me = d.user; B.renderUser(); }).catch(() => {});
  const svg = (inner) => `<svg viewBox="0 0 100 100">${inner}</svg>`;
  const RANK = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'], SUIT = ['♠', '♥', '♦', '♣'];
  const cardHTML = (c, cls = '') => c ? `<div class="pc ${c.s === 1 || c.s === 2 ? 'r' : ''} ${cls}"><span>${RANK[c.r]}</span><i>${SUIT[c.s]}</i></div>` : `<div class="pc back ${cls}">.</div>`;
  const GEM = '<svg viewBox="0 0 100 100"><polygon points="50,8 88,36 50,92 12,36" fill="#19e07a"/><polygon points="50,8 69,36 50,92 31,36" fill="#7dffb8"/><polygon points="12,36 88,36 50,92" fill="none" stroke="#0a7a42" stroke-width="3"/></svg>';
  const BOMB = '<svg viewBox="0 0 100 100"><circle cx="46" cy="56" r="30" fill="#2b2f3a"/><circle cx="36" cy="46" r="8" fill="#555c6e"/><rect x="62" y="16" width="8" height="18" rx="3" fill="#aab" transform="rotate(35 66 25)"/><circle cx="80" cy="14" r="8" fill="#ffc83d"/></svg>';

  // ================= DICE =================
  mk('dice', 'Dice', 'instant', '99%', 'linear-gradient(160deg,#a855f7,#4c1d95)',
    svg('<rect x="14" y="14" width="72" height="72" rx="16" fill="#fff"/><g fill="#4c1d95"><circle cx="34" cy="34" r="7"/><circle cx="66" cy="34" r="7"/><circle cx="50" cy="50" r="7"/><circle cx="34" cy="66" r="7"/><circle cx="66" cy="66" r="7"/></g>'),
    (p, s) => {
      p.innerHTML = B.betBox('bet') + `<div class="seg" id="mode"><button class="on" data-o="0">Roll Under</button><button data-o="1">Roll Over</button></div>
        <label>Target<input id="tg" type="range" min="2" max="98" step="1" value="50"></label>
        <div class="stats"><div>Target<b id="tv">50</b></div><div>Win chance<b id="ch">50%</b></div><div>Multiplier<b id="mu">1.98×</b></div><div>Payout<b id="po">$1.98</b></div></div>
        <button class="play" id="go">Roll Dice</button>`;
      s.innerHTML = `<div class="resnum" id="res">50.00</div><div class="track"><div class="fill" id="fill"></div><div class="mark" id="mark" style="left:50%"></div></div>
        <div class="scale"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div><div class="msg" id="msg"></div><div class="hist" id="hist"></div>`;
      B.wireBet(p);
      let over = false, busy = false;
      const upd = () => {
        const t = val('tg'), ch = over ? 100 - t : t;
        $('#tv').textContent = t; $('#ch').textContent = ch + '%'; $('#mu').textContent = (99 / ch).toFixed(2) + '×'; $('#po').textContent = usd(Math.floor(val('bet') * 99 / ch * 100));
        const g = '#19e07a', r = '#ff4d5e';
        $('#fill').style.background = over ? `linear-gradient(to right,${r} ${t}%,${g} ${t}%)` : `linear-gradient(to right,${g} ${t}%,${r} ${t}%)`;
      };
      $('#tg').oninput = $('#bet').oninput = upd;
      $$('#mode button').forEach((b) => (b.onclick = () => { over = b.dataset.o === '1'; $$('#mode button').forEach((x) => x.classList.toggle('on', x === b)); upd(); }));
      $$('[data-act]', p).forEach((b) => b.addEventListener('click', upd));
      upd();
      $('#go').onclick = async () => {
        if (busy) return; busy = true;
        const r = await B.call('play/dice', { amount: val('bet'), target: val('tg'), over });
        if (r) {
          $('#mark').style.left = r.roll + '%'; await wait(500);
          $('#res').textContent = r.roll.toFixed(2); $('#res').className = 'resnum ' + (r.win ? 'w' : 'l');
          B.result($('#msg'), r); pushHist($('#hist'), r.roll.toFixed(2), r.win); done(r);
        }
        busy = false;
      };
      return null;
    });

  // ================= LIMBO =================
  mk('limbo', 'Limbo', 'instant', '99%', 'linear-gradient(160deg,#fbbf24,#d97706)',
    svg('<path d="M50 10 L84 58 H62 V90 H38 V58 H16 Z" fill="#fff"/><path d="M50 22 L72 52 H56 V80 H44 V52 H28 Z" fill="#d97706"/>'),
    (p, s) => {
      p.innerHTML = B.betBox('bet') + `<label>Target multiplier<input id="tg" type="number" min="1.01" max="1000" step="0.01" value="2.00"></label>
        <div class="stats"><div>Win chance<b id="ch">49.50%</b></div><div>Payout<b id="po">$2.00</b></div></div><button class="play" id="go">Bet</button>`;
      s.innerHTML = `<div class="big" id="num">1.00×</div><div class="msg" id="msg"></div><div class="hist" id="hist"></div>`;
      B.wireBet(p);
      const upd = () => { const t = Math.max(1.01, val('tg') || 1.01); $('#ch').textContent = Math.min(98, 99 / t).toFixed(2) + '%'; $('#po').textContent = usd(Math.floor(val('bet') * t * 100)); };
      $('#tg').oninput = $('#bet').oninput = upd; $$('[data-act]', p).forEach((b) => b.addEventListener('click', upd)); upd();
      let busy = false;
      $('#go').onclick = async () => {
        if (busy) return; busy = true;
        const r = await B.call('play/limbo', { amount: val('bet'), target: val('tg') });
        if (r) {
          const n = $('#num'), t0 = performance.now(), D = 700; n.style.color = '';
          await new Promise((res) => { const f = () => { const k = Math.min(1, (performance.now() - t0) / D); n.textContent = Math.exp(Math.log(r.result) * k).toFixed(2) + '×'; k < 1 ? requestAnimationFrame(f) : res(); }; f(); });
          n.style.color = r.win ? 'var(--green)' : 'var(--red)';
          B.result($('#msg'), r); pushHist($('#hist'), r.result.toFixed(2) + '×', r.win); done(r);
        }
        busy = false;
      };
      return null;
    });

  // ================= MINES =================
  mk('mines', 'Mines', 'strategy', '99%', 'linear-gradient(160deg,#22c55e,#1d4ed8)',
    svg('<polygon points="50,8 88,36 50,92 12,36" fill="#19e07a"/><polygon points="50,8 69,36 50,92 31,36" fill="#8dffc2"/>'),
    (p, s) => {
      p.innerHTML = B.betBox('bet') + `<label>Mines<select id="mc">${Array.from({ length: 24 }, (_, i) => `<option ${i === 2 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></label>
        <div class="stats"><div>Next tile<b id="nx">–</b></div><div>Cashout<b id="cu">–</b></div></div><button class="play" id="go">Bet</button>`;
      s.innerHTML = `<div class="mgrid">${Array.from({ length: 25 }, (_, i) => `<button class="tile2" data-i="${i}" disabled></button>`).join('')}</div><div class="msg" id="msg"></div>`;
      B.wireBet(p);
      let st = null, busy = false;
      const tiles = $$('.tile2', s);
      const paint = () => {
        tiles.forEach((t, i) => { t.className = 'tile2'; t.innerHTML = ''; t.disabled = !st || st.revealed.includes(i); if (st?.revealed.includes(i)) { t.classList.add('gem'); t.innerHTML = GEM; } });
        $('#bet').disabled = $('#mc').disabled = !!st;
        $('#go').textContent = st ? `Cashout ${usd(Math.floor(st.stake * st.mult))}` : 'Bet'; $('#go').className = 'play' + (st ? ' alt' : '');
        $('#go').disabled = !!st && !st.revealed.length;
        $('#nx').textContent = st ? st.next + '×' : '–'; $('#cu').textContent = st ? st.mult + '×' : '–';
      };
      const finish = (r) => {
        st = null; paint();
        tiles.forEach((t, i) => {
          const isMine = r.positions.includes(i), shown = t.classList.contains('gem');
          if (isMine) { t.classList.add('bomb'); t.innerHTML = BOMB; if (i !== r.hit) t.classList.add('dim'); }
          else if (!shown) { t.classList.add('gem', 'dim'); t.innerHTML = GEM; }
          t.disabled = true;
        });
        B.result($('#msg'), r); done(r);
      };
      $('#go').onclick = async () => {
        if (busy) return; busy = true;
        if (!st) { const r = await B.call('play/mines/start', { amount: val('bet'), mines: val('mc') }); if (r) { st = r; B.setBal(r.balance); $('#msg').textContent = ''; paint(); } }
        else { const r = await B.call('play/mines/cashout'); if (r) finish(r); }
        busy = false;
      };
      tiles.forEach((t) => (t.onclick = async () => {
        if (busy || !st) return; busy = true;
        const r = await B.call('play/mines/reveal', { index: +t.dataset.i });
        if (r) { if (r.over) { if (r.hit >= 0) { t.classList.add('bomb'); } finish(r); } else { st = r; paint(); } }
        busy = false;
      }));
      if (B.me) B.api('state').then((d) => { if (d.mines) { st = d.mines; $('#bet').value = (st.stake / 100).toFixed(2); $('#mc').value = st.count; paint(); } }).catch(() => {});
      return null;
    });

  // ================= PLINKO =================
  mk('plinko', 'Plinko', 'instant', '99%', 'linear-gradient(160deg,#a855f7,#db2777)',
    svg('<g fill="#fff"><circle cx="50" cy="18" r="6"/><circle cx="34" cy="42" r="6"/><circle cx="66" cy="42" r="6"/><circle cx="18" cy="66" r="6"/><circle cx="50" cy="66" r="6"/><circle cx="82" cy="66" r="6"/></g><circle cx="50" cy="90" r="8" fill="#ffc83d"/>'),
    (p, s) => {
      p.innerHTML = B.betBox('bet') + `<label>Risk<select id="risk"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select></label>
        <label>Rows<select id="rows"><option>8</option><option>12</option><option selected>16</option></select></label><button class="play" id="go">Drop Ball</button>`;
      s.innerHTML = `<canvas id="cv" width="680" height="560"></canvas><div class="hist" id="hist"></div>`;
      B.wireBet(p);
      const cv = $('#cv'), ctx = cv.getContext('2d'), W = 680, H = 560;
      const balls = []; let flash = {}, raf = 0, alive = true;
      const geo = () => { const rows = val('rows'); const dx = Math.min(40, (W - 70) / rows); const top = 50, dy = (H - top - 90) / rows; return { rows, dx, top, dy, cx: W / 2 }; };
      const pos = (g, i, j) => ({ x: g.cx + (2 * j - i) * g.dx / 2, y: g.top + i * g.dy });
      const col = (m) => (m >= 100 ? '#ff2d55' : m >= 10 ? '#ff5a3c' : m >= 3 ? '#ff8a3c' : m >= 1 ? '#ffc83d' : '#9bb04a');
      const D = 120;
      function frame(now) {
        const g = geo(), table = B.cfg.tables.plinko[g.rows][$('#risk').value];
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#ffffffcc';
        for (let i = 0; i < g.rows; i++) for (let m = 0; m <= i; m++) { const q = pos(g, i, m); ctx.beginPath(); ctx.arc(q.x, q.y, 3.5, 0, 7); ctx.fill(); }
        const bw = g.dx - 4;
        table.forEach((m, k) => {
          const q = pos(g, g.rows, k), f = flash[k] && now - flash[k] < 400 ? 1 - (now - flash[k]) / 400 : 0;
          ctx.fillStyle = col(m); ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.roundRect(q.x - bw / 2, q.y + 8 + f * 6, bw, 26, 5); ctx.fill(); ctx.globalAlpha = 1;
          ctx.fillStyle = '#10161d'; ctx.font = `700 ${g.rows > 12 ? 9 : 11}px system-ui`; ctx.textAlign = 'center'; ctx.fillText(m >= 100 ? Math.round(m) : m, q.x, q.y + 25 + f * 6);
        });
        for (let b = balls.length - 1; b >= 0; b--) {
          const ball = balls[b], t = (now - ball.t0) / D, seg = Math.floor(t);
          if (seg >= ball.wp.length - 1) { balls.splice(b, 1); flash[ball.r.bucket] = now; pushHist($('#hist'), ball.r.mult + '×', ball.r.mult >= 1); done(ball.r); continue; }
          const f = t - seg, a = ball.wp[seg], c = ball.wp[seg + 1], e = f * f * (3 - 2 * f);
          const x = a.x + (c.x - a.x) * e, y = a.y + (c.y - a.y) * f * (0.4 + 0.6 * f) - Math.sin(Math.PI * f) * 5;
          ctx.fillStyle = '#ffc83d'; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill(); ctx.strokeStyle = '#fff6'; ctx.lineWidth = 2; ctx.stroke();
        }
        if (alive) raf = requestAnimationFrame(frame);
      }
      raf = requestAnimationFrame(frame);
      $('#go').onclick = async () => {
        const g = geo(), r = await B.call('play/plinko', { amount: val('bet'), rows: g.rows, risk: $('#risk').value });
        if (!r) return;
        B.setBal(r.balance - r.payout); // stake leaves now, payout lands with the ball
        const wp = [{ x: g.cx, y: g.top - 26 }]; let j = 0;
        for (let i = 0; i < g.rows; i++) { wp.push(pos(g, i, j)); j += r.path[i]; }
        const end = pos(g, g.rows, r.bucket); wp.push({ x: end.x, y: end.y + 14 });
        balls.push({ wp, t0: performance.now(), r });
      };
      return () => { alive = false; cancelAnimationFrame(raf); if (balls.length) syncMe(); };
    });

  // ================= KENO =================
  mk('keno', 'Keno', 'instant', '≤99%', 'linear-gradient(160deg,#06b6d4,#1d4ed8)',
    svg('<g fill="#fff"><circle cx="24" cy="24" r="11"/><circle cx="50" cy="24" r="11"/><circle cx="76" cy="24" r="11"/><circle cx="24" cy="50" r="11"/><circle cx="76" cy="50" r="11"/><circle cx="50" cy="76" r="11"/></g><circle cx="50" cy="50" r="11" fill="#19e07a"/>'),
    (p, s) => {
      p.innerHTML = B.betBox('bet') + `<div class="stats"><div>Picked<b id="pk">0 / 10</b></div><div>Max payout<b id="mx">–</b></div></div>
        <div class="row" style="justify-content:stretch"><button class="mini" id="auto" style="flex:1">Auto pick</button><button class="mini" id="clr" style="flex:1">Clear</button></div><button class="play" id="go" disabled>Bet</button>`;
      s.innerHTML = `<div class="kgrid">${Array.from({ length: 40 }, (_, i) => `<button class="kn" data-n="${i + 1}">${i + 1}</button>`).join('')}</div><div class="kstrip" id="strip"></div><div class="msg" id="msg"></div>`;
      B.wireBet(p);
      const sel = new Set(), btns = $$('.kn', s); let busy = false;
      const upd = () => {
        const k = sel.size, t = B.cfg.tables.keno[k];
        $('#pk').textContent = k + ' / 10'; $('#go').disabled = !k; $('#mx').textContent = k ? t[k] + '×' : '–';
        $('#strip').innerHTML = k ? t.map((m, h) => `<div data-h="${h}"><small>${h} hit${h === 1 ? '' : 's'}</small><b>${m}×</b></div>`).join('') : '';
        btns.forEach((b) => { b.className = 'kn' + (sel.has(+b.dataset.n) ? ' sel' : ''); });
      };
      btns.forEach((b) => (b.onclick = () => { if (busy) return; const n = +b.dataset.n; sel.has(n) ? sel.delete(n) : sel.size < 10 && sel.add(n); $('#msg').textContent = ''; upd(); }));
      $('#clr').onclick = () => { if (!busy) { sel.clear(); upd(); } };
      $('#auto').onclick = () => { if (busy) return; sel.clear(); while (sel.size < 10) sel.add(1 + Math.floor(Math.random() * 40)); upd(); };
      $('#go').onclick = async () => {
        if (busy) return; busy = true; upd();
        const r = await B.call('play/keno', { amount: val('bet'), picks: [...sel] });
        if (r) {
          for (const n of r.drawn) { await wait(110); btns[n - 1].className = 'kn ' + (sel.has(n) ? 'hit' : 'drawn'); }
          $$('#strip div').forEach((d) => d.classList.toggle('on', +d.dataset.h === r.hits));
          B.result($('#msg'), r); done(r);
        }
        busy = false;
      };
      return null;
    });

  // ================= CRASH =================
  mk('crash', 'Crash', 'instant', '99%', 'linear-gradient(160deg,#f97316,#be123c)',
    svg('<polyline points="10,86 34,70 52,50 68,26 88,12" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="88" cy="12" r="8" fill="#ffc83d"/>'),
    (p, s) => {
      p.innerHTML = B.betBox('bet') + `<label>Auto cashout (optional)<input id="auto" type="number" min="1.01" step="0.01" placeholder="e.g. 2.00"></label><button class="play" id="go">Place Bet</button>`;
      s.innerHTML = `<canvas id="cv" width="680" height="400"></canvas><div class="msg" id="msg"></div><div class="hist" id="hist"></div>`;
      B.wireBet(p);
      const cv = $('#cv'), ctx = cv.getContext('2d'), W = 680, H = 400, rate = B.cfg.tables.crashRate;
      let run = null, end = null, raf = 0, pollT = 0, busy = false, alive = true;
      const m = (el) => Math.exp(rate * el);
      const ui = () => { $('#go').textContent = run ? 'Cash Out' : 'Place Bet'; $('#go').className = 'play' + (run ? ' alt' : ''); $('#bet').disabled = $('#auto').disabled = !!run; };
      function frame() {
        ctx.clearRect(0, 0, W, H);
        const el = run ? run.el0 + performance.now() - run.t0 : end ? end.el : 0, cur = m(el), pad = 40;
        const maxT = Math.max(5000, el * 1.1), maxM = Math.max(2, cur * 1.2);
        ctx.strokeStyle = '#ffffff14'; ctx.fillStyle = '#8da4b6'; ctx.font = '12px system-ui'; ctx.lineWidth = 1;
        for (let k = 0; k <= 4; k++) { const y = H - pad - (k / 4) * (H - 2 * pad); ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - 10, y); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText((1 + (maxM - 1) * k / 4).toFixed(2) + '×', pad - 6, y + 4); }
        const X = (t) => pad + (t / maxT) * (W - pad - 20), Y = (mm) => H - pad - ((mm - 1) / (maxM - 1)) * (H - 2 * pad);
        const color = end ? (end.cashed ? '#19e07a' : '#ff4d5e') : '#19e07a';
        ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.beginPath();
        for (let t = 0; t <= el; t += Math.max(20, el / 120)) { t === 0 ? ctx.moveTo(X(t), Y(1)) : ctx.lineTo(X(t), Y(m(t))); }
        ctx.lineTo(X(el), Y(cur)); ctx.stroke();
        ctx.textAlign = 'center'; ctx.font = '900 64px system-ui'; ctx.fillStyle = end ? color : '#fff';
        ctx.fillText((end?.cashed ? end.cashed : end ? end.point : Math.floor(cur * 100) / 100).toFixed(2) + '×', W / 2, H / 2 - 10);
        ctx.font = '700 18px system-ui'; if (end) ctx.fillText(end.cashed ? 'CASHED OUT' : 'CRASHED', W / 2, H / 2 + 24);
        if (alive) raf = requestAnimationFrame(frame);
      }
      raf = requestAnimationFrame(frame);
      const finishRound = (r) => {
        clearInterval(pollT); const t = Math.log(r.point) / rate;
        end = { point: r.point, cashed: r.cashedAt || null, el: r.cashedAt ? Math.log(r.cashedAt) / rate : t }; run = null; ui();
        B.result($('#msg'), r); pushHist($('#hist'), r.point.toFixed(2) + '×', !!r.cashedAt); done(r);
      };
      const startRun = (el0) => {
        run = { t0: performance.now(), el0 }; end = null; ui();
        pollT = setInterval(async () => { const d = await B.api('state').catch(() => null); if (d && d.crash?.over) finishRound(d.crash); }, 250);
      };
      $('#go').onclick = async () => {
        if (busy) return; busy = true;
        if (!run) {
          const r = await B.call('play/crash/start', { amount: val('bet'), auto: $('#auto').value || undefined });
          if (r) { B.setBal(r.balance); $('#msg').textContent = ''; startRun(0); }
        } else { const r = await B.call('play/crash/cashout'); if (r) finishRound(r); }
        busy = false;
      };
      if (B.me) B.api('state').then((d) => { if (d.crash?.running) { $('#bet').value = (d.crash.stake / 100).toFixed(2); startRun(d.crash.elapsed); } else if (d.crash?.over) { B.setBal(d.balance); } }).catch(() => {});
      return () => { alive = false; cancelAnimationFrame(raf); clearInterval(pollT); };
    });

  // ================= COIN FLIP =================
  mk('coin', 'Coin Flip', 'instant', '98%', 'linear-gradient(160deg,#fbbf24,#b45309)',
    svg('<circle cx="50" cy="50" r="38" fill="#ffd45a" stroke="#b7791f" stroke-width="6"/><polygon points="50,26 58,44 78,46 63,58 68,78 50,67 32,78 37,58 22,46 42,44" fill="#b7791f"/>'),
    (p, s) => {
      p.innerHTML = B.betBox('bet') + `<div class="seg" id="side"><button class="on" data-s="heads">Heads</button><button data-s="tails">Tails</button></div>
        <div class="stats"><div>Win chance<b>~50%</b></div><div>Multiplier<b>1.96×</b></div></div><button class="play" id="go">Flip</button>`;
      s.innerHTML = `<div class="coin" id="coin">👑</div><div class="msg" id="msg"></div><div class="hist" id="hist"></div>`;
      B.wireBet(p);
      let side = 'heads', busy = false;
      $$('#side button').forEach((b) => (b.onclick = () => { side = b.dataset.s; $$('#side button').forEach((x) => x.classList.toggle('on', x === b)); }));
      $('#go').onclick = async () => {
        if (busy) return; busy = true;
        const r = await B.call('play/coin', { amount: val('bet'), side });
        if (r) {
          const c = $('#coin'); c.classList.remove('flip'); void c.offsetWidth; c.classList.add('flip'); await wait(800);
          c.textContent = r.result === 'heads' ? '👑' : '🦅'; B.result($('#msg'), r); pushHist($('#hist'), r.result, r.win); done(r);
        }
        busy = false;
      };
      return null;
    });

  // ================= HILO =================
  mk('hilo', 'HiLo', 'strategy', '99%', 'linear-gradient(160deg,#10b981,#047857)',
    svg('<rect x="14" y="20" width="44" height="62" rx="8" fill="#fff" transform="rotate(-12 36 51)"/><rect x="42" y="18" width="44" height="62" rx="8" fill="#fff" transform="rotate(10 64 49)"/><path d="M64 32l10 14H54z" fill="#e11d48" transform="rotate(10 64 49)"/>'),
    (p, s) => {
      p.innerHTML = B.betBox('bet') + `<div class="hl"><button id="hi" disabled>▲ Higher or Same<small id="hiS">–</small></button><button id="lo" disabled>▼ Lower or Same<small id="loS">–</small></button></div>
        <div class="stats"><div>Multiplier<b id="mu">–</b></div><div>Cashout<b id="co">–</b></div></div><button class="play" id="go">Bet</button>`;
      s.innerHTML = `<div class="cards" id="cur">${cardHTML(null)}</div><div class="cards" id="trail" style="min-height:90px"></div><div class="msg" id="msg"></div>`;
      B.wireBet(p);
      let st = null, busy = false, trail = [];
      const paint = () => {
        const on = !!st;
        $('#hi').disabled = $('#lo').disabled = !on; $('#bet').disabled = on;
        $('#go').textContent = on ? `Cashout ${usd(Math.floor(st.stake * st.mult))}` : 'Bet'; $('#go').className = 'play' + (on ? ' alt' : ''); $('#go').disabled = on && !st.rounds;
        if (on) {
          $('#cur').innerHTML = cardHTML(st.card);
          $('#hiS').textContent = `${(st.hiP * 100).toFixed(1)}% · ${st.hiMult}×`; $('#loS').textContent = `${(st.loP * 100).toFixed(1)}% · ${st.loMult}×`;
          $('#mu').textContent = st.mult + '×'; $('#co').textContent = usd(Math.floor(st.stake * st.mult));
        } else { $('#hiS').textContent = $('#loS').textContent = $('#mu').textContent = $('#co').textContent = '–'; }
        $('#trail').innerHTML = trail.slice(-8).map((c) => cardHTML(c, 'sm old')).join('');
      };
      const end = (r) => { st = null; trail.push(r.card); paint(); $('#cur').innerHTML = cardHTML(r.card); B.result($('#msg'), r); done(r); };
      $('#go').onclick = async () => {
        if (busy) return; busy = true;
        if (!st) { const r = await B.call('play/hilo/start', { amount: val('bet') }); if (r) { st = r; trail = []; B.setBal(r.balance); $('#msg').textContent = ''; paint(); } }
        else { const r = await B.call('play/hilo/cashout'); if (r) end(r); }
        busy = false;
      };
      const guess = (dir) => async () => {
        if (busy || !st) return; busy = true;
        const prev = st.card, r = await B.call('play/hilo/guess', { dir });
        if (r) { if (r.over) { trail.push(prev); end(r); } else { trail.push(prev); st = r; paint(); } }
        busy = false;
      };
      $('#hi').onclick = guess('hi'); $('#lo').onclick = guess('lo');
      if (B.me) B.api('state').then((d) => { if (d.hilo) { st = d.hilo; $('#bet').value = (st.stake / 100).toFixed(2); paint(); } }).catch(() => {});
      return null;
    });

  // ================= BLACKJACK =================
  mk('blackjack', 'Blackjack', 'table', '~99%', 'linear-gradient(160deg,#2563eb,#1e3a8a)',
    svg('<rect x="22" y="10" width="56" height="80" rx="9" fill="#fff"/><text x="32" y="38" font-size="24" font-weight="900" fill="#1e3a8a" font-family="system-ui">A</text><text x="34" y="74" font-size="40" fill="#1e3a8a">♠</text>'),
    (p, s) => {
      p.innerHTML = B.betBox('bet') + `<div class="bjbtns"><button id="hit" disabled>Hit</button><button id="stand" disabled>Stand</button><button id="dbl" disabled>Double</button></div>
        <button class="play" id="go">Deal</button><p class="muted">Blackjack pays 3:2. Dealer stands on all 17s. No split or insurance.</p>`;
      s.innerHTML = `<div class="hand"><h4>Dealer <b id="dv"></b></h4><div class="cards" id="dh">${cardHTML(null, 'back')}</div></div><div class="msg" id="msg"></div><div class="hand"><h4>You <b id="pv"></b></h4><div class="cards" id="ph"></div></div>`;
      B.wireBet(p);
      let active = false, busy = false;
      const show = (v, fin) => {
        $('#dh').innerHTML = v.dealer.map((c) => cardHTML(c)).join(''); $('#ph').innerHTML = v.player.map((c) => cardHTML(c)).join('');
        $('#pv').textContent = v.pv; $('#dv').textContent = v.dv ?? '';
        active = !fin; $('#hit').disabled = $('#stand').disabled = fin; $('#dbl').disabled = fin || !v.canDouble; $('#go').disabled = !fin; $('#bet').disabled = !fin;
      };
      const MSG = { blackjack: 'Blackjack!', win: 'You win', push: 'Push', lose: 'Dealer wins', bust: 'Bust' };
      const handle = (r) => {
        if (!r) return;
        if (r.over) { show(r, true); B.result($('#msg'), r); if (r.outcome === 'push' ) { $('#msg').className = 'msg'; $('#msg').textContent = 'Push — bet returned'; } else $('#msg').textContent = MSG[r.outcome] + ' — ' + $('#msg').textContent; done(r); }
        else { show(r, false); B.setBal(r.balance); }
      };
      $('#go').onclick = async () => { if (busy) return; busy = true; $('#msg').textContent = ''; handle(await B.call('play/blackjack/start', { amount: val('bet') })); busy = false; };
      for (const [id, act] of [['hit', 'hit'], ['stand', 'stand'], ['dbl', 'double']]) $('#' + id).onclick = async () => { if (busy || !active) return; busy = true; handle(await B.call('play/blackjack/' + act)); busy = false; };
      if (B.me) B.api('state').then((d) => { if (d.bj) { $('#bet').value = (d.bj.stake / 100).toFixed(2); show(d.bj, false); } }).catch(() => {});
      return null;
    });

  // ================= ROULETTE =================
  const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  mk('roulette', 'Roulette', 'table', '97.3%', 'linear-gradient(160deg,#dc2626,#7f1d1d)',
    svg('<circle cx="50" cy="50" r="40" fill="#0a1118" stroke="#ffc83d" stroke-width="5"/><circle cx="50" cy="50" r="24" fill="#b3202f"/><circle cx="50" cy="50" r="10" fill="#ffc83d"/><circle cx="50" cy="16" r="5" fill="#fff"/>'),
    (p, s) => {
      p.innerHTML = B.betBox('chip', '1.00').replace('Bet Amount', 'Chip value') + `<div class="stats"><div>Total bet<b id="tot">$0.00</b></div><div>Chips<b id="cnt">0</b></div></div>
        <div class="row" style="justify-content:stretch"><button class="mini" id="undo" style="flex:1">Undo</button><button class="mini" id="clr" style="flex:1">Clear</button></div><button class="play" id="go" disabled>Spin</button>
        <p class="muted">Click the table to place chips. Single zero, 36/37 return.</p>`;
      const cell = (k, label, cls, style = '') => `<button class="rc ${cls}" data-k="${k}" style="${style}">${label}</button>`;
      let b = `<div class="rboard">${cell('n:0', '0', 'green', 'grid-column:1/13')}<span></span>`;
      for (let row = 0; row < 3; row++) {
        for (let c = 0; c < 12; c++) { const n = c * 3 + (3 - row); b += cell('n:' + n, n, REDS.has(n) ? 'red' : 'black'); }
        b += cell('col:' + (3 - row), '2:1', 'out');
      }
      b += [1, 2, 3].map((d) => cell('dozen:' + d, ['1st 12', '2nd 12', '3rd 12'][d - 1], 'out', 'grid-column:span 4')).join('') + '<span></span>';
      b += [['low:0', '1–18'], ['even:0', 'Even'], ['red:0', 'Red'], ['black:0', 'Black'], ['odd:0', 'Odd'], ['high:0', '19–36']].map(([k, l]) => cell(k, l, k.startsWith('red') ? 'red' : k.startsWith('black') ? 'black' : 'out', 'grid-column:span 2')).join('') + '<span></span></div>';
      s.innerHTML = b + `<div class="rball roll" id="ball">?</div><div class="msg" id="msg"></div><div class="hist" id="hist"></div>`;
      B.wireBet(p);
      const bets = {}, order = []; let busy = false;
      const paint = () => {
        let tot = 0, n = 0;
        $$('.rc', s).forEach((c) => { c.classList.remove('win'); c.querySelector('.chip')?.remove(); const a = bets[c.dataset.k]; if (a) { tot += a; n++; const ch = document.createElement('span'); ch.className = 'chip'; ch.textContent = (a / 100).toFixed(a % 100 ? 2 : 0); c.append(ch); } });
        $('#tot').textContent = usd(tot); $('#cnt').textContent = n; $('#go').disabled = !n || busy;
      };
      $$('.rc', s).forEach((c) => (c.onclick = () => { if (busy) return; const a = Math.round(val('chip') * 100); if (a < 10) return B.toast('Minimum chip is $0.10', true); bets[c.dataset.k] = (bets[c.dataset.k] || 0) + a; order.push([c.dataset.k, a]); paint(); }));
      $('#undo').onclick = () => { const l = order.pop(); if (l && !busy) { bets[l[0]] -= l[1]; if (bets[l[0]] <= 0) delete bets[l[0]]; paint(); } };
      $('#clr').onclick = () => { if (busy) return; for (const k in bets) delete bets[k]; order.length = 0; paint(); };
      $('#go').onclick = async () => {
        busy = true; paint(); $('#msg').textContent = '';
        const payload = Object.entries(bets).map(([k, a]) => { const [type, value] = k.split(':'); return { type, value: +value, amount: a / 100 }; });
        const r = await B.call('play/roulette', { bets: payload });
        if (r) {
          const ball = $('#ball'); ball.className = 'rball roll';
          for (let i = 0; i < 14; i++) { ball.textContent = Math.floor(Math.random() * 37); await wait(60 + i * 12); }
          ball.textContent = r.number; ball.className = 'rball ' + r.color;
          $(`.rc[data-k="n:${r.number}"]`, s)?.classList.add('win');
          B.result($('#msg'), r); pushHist($('#hist'), r.number, r.win); done(r);
        }
        busy = false; $('#go').disabled = false;
      };
      return null;
    });

  // ================= WHEEL =================
  const wcol = (m) => (m === 0 ? '#3b4c5b' : m < 1.3 ? '#3b82f6' : m < 2 ? '#19e07a' : m < 3.5 ? '#ffc83d' : m < 10 ? '#fb923c' : '#ff4d5e');
  mk('wheel', 'Wheel', 'instant', '99%', 'linear-gradient(160deg,#f59e0b,#be185d)',
    svg('<circle cx="50" cy="50" r="40" fill="#fff"/><path d="M50 50L50 10A40 40 0 0 1 90 50Z" fill="#19e07a"/><path d="M50 50L50 90A40 40 0 0 1 10 50Z" fill="#3b82f6"/><path d="M50 50L10 50A40 40 0 0 1 50 10Z" fill="#ffc83d"/><circle cx="50" cy="50" r="8" fill="#10161d"/>'),
    (p, s) => {
      p.innerHTML = B.betBox('bet') + `<label>Risk<select id="risk"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select></label><button class="play" id="go">Spin</button>`;
      s.innerHTML = `<div class="wheelwrap"><div class="ptr"></div><svg id="wh" viewBox="0 0 200 200"></svg></div><div class="wlegend" id="lg"></div><div class="msg" id="msg"></div><div class="hist" id="hist"></div>`;
      B.wireBet(p);
      let rot = 0, busy = false;
      const pt = (a, r) => [100 + r * Math.sin((a * Math.PI) / 180), 100 - r * Math.cos((a * Math.PI) / 180)];
      const build = () => {
        const t = B.cfg.tables.wheel[$('#risk').value], n = t.length, st = 360 / n;
        $('#wh').style.transition = 'none'; $('#wh').style.transform = 'rotate(0deg)'; rot = 0;
        $('#wh').innerHTML = t.map((m, i) => { const a = pt(i * st, 98), b = pt((i + 1) * st, 98), tx = pt(i * st + st / 2, 74); return `<path d="M100 100L${a}A98 98 0 0 1 ${b}Z" fill="${wcol(m)}" stroke="#0f1923" stroke-width="1.5"/><text x="${tx[0]}" y="${tx[1]}" font-size="9" font-weight="800" fill="#08121a" text-anchor="middle" dominant-baseline="middle" transform="rotate(${i * st + st / 2} ${tx[0]} ${tx[1]})">${m}×</text>`; }).join('') + '<circle cx="100" cy="100" r="14" fill="#0f1923"/>';
        $('#lg').innerHTML = [...new Set(t)].sort((a, b) => a - b).map((m) => `<span style="background:${wcol(m)}">${m}×</span>`).join('');
      };
      $('#risk').onchange = build; build();
      $('#go').onclick = async () => {
        if (busy) return; busy = true; $('#go').disabled = true; $('#risk').disabled = true;
        const r = await B.call('play/wheel', { amount: val('bet'), risk: $('#risk').value });
        if (r) {
          const st = 360 / B.cfg.tables.wheel[$('#risk').value].length;
          rot = Math.ceil(rot / 360) * 360 + 360 * 5 - (r.index * st + st / 2) + (Math.random() - 0.5) * st * 0.7;
          $('#wh').style.transition = ''; $('#wh').style.transform = `rotate(${rot}deg)`;
          B.setBal(r.balance - r.payout); // stake out now, payout on landing
          await wait(4300); B.result($('#msg'), r); pushHist($('#hist'), r.mult + '×', r.win); done(r);
        }
        busy = false; $('#go').disabled = false; $('#risk').disabled = false;
      };
      return () => syncMe();
    });

  // ================= SLOTS =================
  const SYM = ['🍒', '🍋', '🔔', '⭐', '💎', '7️⃣'];
  mk('slots', 'Slots', 'slots', '95.3%', 'linear-gradient(160deg,#ec4899,#7c3aed)',
    svg('<rect x="8" y="26" width="84" height="48" rx="10" fill="#fff"/><g font-size="30" font-weight="900" fill="#be185d" font-family="system-ui"><text x="16" y="60">7</text><text x="42" y="60">7</text><text x="68" y="60">7</text></g>'),
    (p, s) => {
      p.innerHTML = B.betBox('bet') + `<ul class="pay"><li>7️⃣7️⃣7️⃣ 120×</li><li>💎💎💎 70×</li><li>⭐⭐⭐ 36×</li><li>🔔🔔🔔 18×</li><li>🍋🍋🍋 10×</li><li>🍒🍒🍒 6×</li><li>Any two 🍒 2×</li></ul><button class="play" id="go">Spin</button>`;
      s.innerHTML = `<div class="reels" id="reels"><span>🎰</span><span>🎰</span><span>🎰</span></div><div class="msg" id="msg"></div><div class="hist" id="hist"></div>`;
      B.wireBet(p);
      let busy = false;
      $('#go').onclick = async () => {
        if (busy) return; busy = true;
        const r = await B.call('play/slots', { amount: val('bet') });
        if (r) {
          const reels = $('#reels'), sp = $$('span', reels); reels.classList.add('spin'); $('#msg').textContent = '';
          const t = setInterval(() => sp.forEach((x) => (x.textContent = SYM[Math.floor(Math.random() * 6)])), 80);
          await wait(1000); clearInterval(t); reels.classList.remove('spin');
          sp.forEach((x, i) => (x.textContent = SYM[r.reels[i]]));
          B.result($('#msg'), r); pushHist($('#hist'), r.mult ? r.mult + '×' : '0×', r.win); done(r);
        }
        busy = false;
      };
      return null;
    });
})();
