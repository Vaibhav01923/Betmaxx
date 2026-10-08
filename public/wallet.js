'use strict';
// Wallet dialog: deposit (currency + network, exact-amount payment screen with QR), withdraw, history.
const ASSETS = { BTC: { name: 'Bitcoin', glyph: '₿' }, LTC: { name: 'Litecoin', glyph: 'Ł' }, USDT: { name: 'Tether USD', glyph: '₮' } };
let depCoin = null, wdCoin = null, curDep = null, pollTok = 0, timerId = 0;
const info = (k) => B.cfg.coinInfo[k];
const dlg = $('#walletDlg');

// Currency + Network dropdowns. `coins` is { coinKey: name }; onChange(coinKey) fires whenever the selection changes.
function fillSelects(p, coins, current, onChange) {
  const assetSel = $('#' + p + 'Asset'), netSel = $('#' + p + 'Net'), ci = $('#' + p + 'Ci'), byAsset = {};
  for (const k of Object.keys(coins)) (byAsset[info(k).asset] ||= []).push(k);
  assetSel.innerHTML = Object.keys(byAsset).map((a) => `<option value="${a}">${esc(ASSETS[a].name)}</option>`).join('');
  assetSel.value = current && coins[current] ? info(current).asset : Object.keys(byAsset)[0];
  const sync = (keep) => {
    const list = byAsset[assetSel.value] || [];
    netSel.innerHTML = list.map((k) => `<option value="${k}">${esc(info(k).network)}</option>`).join('');
    if (keep && list.includes(keep)) netSel.value = keep;
    netSel.disabled = list.length < 2;
    ci.className = 'ci ' + assetSel.value; ci.textContent = ASSETS[assetSel.value].glyph;
    onChange(netSel.value);
  };
  assetSel.onchange = () => sync();
  netSel.onchange = () => onChange(netSel.value);
  sync(current);
}

function openWallet(tab = 'dep') {
  if (!B.me) return B.openAuth('login');
  $('#wBal').textContent = usd(B.me.balance);
  const canDeposit = Object.keys(B.cfg.coins).length > 0;
  if (canDeposit) fillSelects('dep', B.cfg.coins, depCoin, (c) => { depCoin = c; depHint(); });
  $('#depCreate').disabled = !canDeposit;
  $('#depErr').textContent = canDeposit ? '' : 'Deposits are not available right now.';
  fillSelects('wd', B.cfg.allCoins, wdCoin, (c) => { wdCoin = c; });
  $('#wdErr').textContent = '';
  showForm(); tab_(tab); wdInfo(); lists();
  if (!dlg.open) dlg.showModal();
}
B.openWallet = openWallet;
function depHint() {
  if (!depCoin) return;
  const n = info(depCoin).minConf;
  $('#depHint').textContent = `Minimum $${B.cfg.minDeposit}. Credited automatically after ${n} network confirmation${n > 1 ? 's' : ''}.`;
}
function tab_(t) {
  $$('#wTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  $('#wDep').hidden = t !== 'dep'; $('#wWd').hidden = t !== 'wd'; $('#wHist').hidden = t !== 'hist';
  if (t === 'hist') lists();
}
$$('#wTabs button').forEach((b) => (b.onclick = () => tab_(b.dataset.t)));
$('#walletBtn').onclick = $('#railWallet').onclick = (e) => { e.preventDefault(); openWallet('dep'); };
$('#wClose').onclick = () => dlg.close();
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // clicking the dimmed backdrop closes it
dlg.addEventListener('close', () => { pollTok++; clearInterval(timerId); });
$$('.quick button').forEach((b) => (b.onclick = () => ($('#depUsd').value = b.dataset.v)));
async function refreshMe() { const d = await B.api('me'); B.me = d.user; B.renderUser(); wdInfo(); return d; }
function wdInfo() {
  const u = B.me; if (!u) return;
  $('#wdInfo').innerHTML = `Minimum $${B.cfg.minWithdraw}. ` + (u.wagerNeeded > 0 ? `<b class="lose">Wager ${usd(u.wagerNeeded)} more</b> to unlock withdrawals (play through your deposits once).` : '<b class="win">Wagering requirement met.</b>') + ' Payouts are reviewed and sent by our team.';
}
const copy = (text, btn, label = 'Copy') => navigator.clipboard.writeText(text).then(() => { btn.textContent = 'Copied ✓'; setTimeout(() => (btn.textContent = label), 1500); });

// ---- deposit: form -> payment screen ----
function showForm() { clearInterval(timerId); pollTok++; $('#depForm').hidden = false; $('#depResult').hidden = true; depHint(); }
$('#depBack').onclick = showForm;
$('#depCreate').onclick = async (e) => {
  e.target.disabled = true; $('#depErr').textContent = '';
  try { showPayment(await B.api('deposit', { coin: depCoin, usd: $('#depUsd').value })); lists(); }
  catch (err) { $('#depErr').textContent = err.message; await lists(); $('#openDeps').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  e.target.disabled = false;
};
function qrPayload(d) { // BTC/LTC wallets understand a payment URI that carries the amount; for USDT we show the plain address
  const scheme = { BTC: 'bitcoin', LTC: 'litecoin' }[d.coin];
  return scheme && d.amount ? `${scheme}:${d.address}?amount=${d.amount}` : d.address;
}
function showPayment(d) {
  curDep = d; const i = info(d.coin), demo = B.cfg.provider === 'demo';
  $('#depForm').hidden = true; $('#depResult').hidden = false;
  $('#rLabel').textContent = demo ? 'Demo deposit' : 'Send exactly';
  $('#rAmtNum').textContent = demo ? (d.usd / 100).toFixed(2) : d.amount;
  $('#rSym').textContent = demo ? 'USD' : i.sym;
  $('#rCopyAmt').hidden = demo; $('#rCopyAmt').onclick = (e) => copy(d.amount, e.target);
  $('#rCredit').textContent = demo ? 'Nothing real is sent in demo mode.' : `You will be credited ${usd(d.usd)}`;
  $('#rAddr').textContent = d.address; $('#rCopy').onclick = (e) => copy(d.address, e.target);
  try { const q = qrcode(0, 'M'); q.addData(qrPayload(d)); q.make(); $('#qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); } catch { $('#qr').textContent = ''; }
  $('#rNote').innerHTML = demo ? esc(d.note || '') : `Send only <b>${esc(i.sym)}</b> on the <b>${esc(i.network)}</b> network. Other coins or networks will be lost, and the amount must match exactly.`;
  $('#rNote').className = 'note' + (demo ? ' warn' : '');
  $('#simBtn').hidden = !demo;
  setStatus(d); startTimer(d.expires); poll(d.id);
}
function setStatus(d) {
  const i = info(d.coin), st = $('#rStatus'), txt = { pending: 'Waiting for payment…', detected: 'Payment detected', confirmed: '✓ Credited', expired: 'Request expired' }[d.status] || d.status;
  st.className = d.status; st.innerHTML = (d.status === 'pending' || d.status === 'detected' ? '<i class="pulse"></i>' : '') + esc(txt);
  $('#rConf').textContent = B.cfg.provider === 'demo' ? '' : d.status === 'confirmed' ? usd(d.credited || d.usd) + ' added' : `${Math.min(d.confirmations || 0, i.minConf)} / ${i.minConf} confirmations`;
}
function startTimer(exp) {
  clearInterval(timerId); const el = $('#rTimer');
  if (!exp) { el.textContent = ''; return; }
  const tick = () => {
    const s = Math.max(0, Math.floor((exp - Date.now()) / 1000));
    el.textContent = s ? `This amount is reserved for you for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'This request expired. Go back to create a new one.';
    if (!s) clearInterval(timerId);
  };
  tick(); timerId = setInterval(tick, 1000);
}
async function poll(id) { // follow one deposit until it is credited or expires
  const my = ++pollTok;
  for (let n = 0; n < 900 && my === pollTok; n++) {
    await wait(4000);
    if (my !== pollTok || !B.me) return;
    const d = (await B.api('deposits').catch(() => [])).find((x) => x.id === id);
    if (!d) return;
    setStatus(d);
    if (d.status === 'confirmed') {
      clearInterval(timerId); $('#rTimer').textContent = ''; $('#rLabel').textContent = 'Deposit complete';
      await refreshMe(); $('#wBal').textContent = usd(B.me.balance); lists(); B.toast('Deposit credited ' + usd(d.credited));
      return;
    }
    if (d.status === 'expired') { lists(); return; }
  }
}
$('#simBtn').onclick = async () => {
  const r = await B.api('demo/confirm', { id: curDep.id });
  B.setBal(r.balance); await refreshMe(); lists(); dlg.close(); B.toast('Demo deposit credited');
};

// ---- history ----
async function lists() {
  const [d, w] = await Promise.all([B.api('deposits').catch(() => []), B.api('withdrawals').catch(() => [])]);
  renderOpen(d);
  const rows = [...d.map((x) => ({ ...x, kind: 'Deposit' })), ...w.map((x) => ({ ...x, kind: 'Withdrawal' }))].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
  $('#hlist').innerHTML = rows.map((x, n) => {
    const i = info(x.coin), open = x.kind === 'Deposit' && ['pending', 'detected'].includes(x.status) && x.expires > Date.now();
    return `<div class="hrow${open ? ' open' : ''}" data-n="${n}"><span class="ci ${i.asset}">${ASSETS[i.asset].glyph}</span><div class="hm"><b>${x.kind} · ${esc(i.sym)} <small>${esc(i.network)}</small></b><small>${new Date(x.createdAt).toLocaleString()}</small></div><div class="hr"><b>${x.kind === 'Withdrawal' ? '−' : '+'}${usd(x.usd)}</b><span class="badge ${esc(x.status)}">${esc(x.status)}</span></div></div>`;
  }).join('') || '<p class="muted">No transactions yet.</p>';
  $$('#hlist .hrow.open').forEach((el) => (el.onclick = () => { tab_('dep'); showPayment(rows[+el.dataset.n]); })); // tap an unpaid deposit to reopen its payment screen
}

// ---- open deposits: let the player come back to an unpaid request (or cancel it) instead of waiting for it to expire ----
function renderOpen(deps) {
  const box = $('#openDeps'), open = deps.filter((x) => ['pending', 'detected'].includes(x.status) && x.expires > Date.now());
  box.hidden = !open.length;
  if (!open.length) return;
  box.innerHTML = `<span class="fl">Your open deposits</span>` + open.map((x) => {
    const i = info(x.coin), mins = Math.max(1, Math.round((x.expires - Date.now()) / 60000));
    return `<div class="orow" data-id="${x.id}"><span class="ci ${i.asset}">${ASSETS[i.asset].glyph}</span><div class="hm"><b>${usd(x.usd)} · ${esc(i.sym)} <small>${esc(i.network)}</small></b><small>${x.status === 'detected' ? 'Payment detected, confirming…' : 'Waiting for payment · ' + mins + ' min left'}</small></div><button class="pay" data-act="pay">${x.status === 'detected' ? 'View' : 'Pay'}</button>${x.status === 'pending' ? '<button class="ghost sm" data-act="cancel">Cancel</button>' : ''}</div>`;
  }).join('');
  $$('.orow', box).forEach((row) => {
    const dep = open.find((x) => x.id === row.dataset.id);
    row.querySelector('[data-act="pay"]').onclick = () => showPayment(dep);
    const c = row.querySelector('[data-act="cancel"]');
    if (c) c.onclick = async () => {
      c.disabled = true;
      try { await B.api('deposit/cancel', { id: dep.id }); row.remove(); if (!box.querySelector('.orow')) box.hidden = true; B.toast('Deposit cancelled'); }
      catch (err) { c.disabled = false; B.toast(err.message, true); }
      lists();
    };
  });
}

// ---- withdraw ----
$('#wdMax').onclick = () => ($('#wdUsd').value = Math.floor(B.me.balance / 100));
$('#wdGo').onclick = async (e) => {
  e.target.disabled = true; $('#wdErr').textContent = '';
  try {
    const r = await B.api('withdraw', { coin: wdCoin, address: $('#wdAddr').value, usd: $('#wdUsd').value });
    B.setBal(r.balance); await refreshMe(); lists();
    B.toast(r.withdrawal.status === 'sent' ? 'Withdrawal sent (demo)' : 'Withdrawal requested. Our team will send it shortly');
    tab_('hist');
  } catch (err) { $('#wdErr').textContent = err.message; }
  e.target.disabled = false;
};
