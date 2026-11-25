/* PokitBio business app — front end (no build step) */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let KEY = '';
try { KEY = localStorage.getItem('pb_key') || ''; } catch {}
const S = { cfg: null, fin: null, leads: [], current: null, view: 'dashboard', month: null, charts: [] };

// ------------------------------------------------------------ helpers
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400); }
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'x-admin-key': KEY, ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
  if (r.status === 401) { showLogin(true); throw new Error('Please log in'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  const ct = r.headers.get('content-type') || '';
  if (opts.blob) return r.blob();
  return ct.includes('json') ? r.json() : r.text();
}
async function download(path, filename) {
  try {
    const blob = await api(path, { blob: true });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  } catch (e) { toast(e.message); }
}
const todayStr = () => new Date().toLocaleDateString('en-CA');
const thisMonth = () => todayStr().slice(0, 7);
const dayOf = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA') : '');
const fmtDate = (v) => { if (!v) return ''; const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T12:00:00') : new Date(v); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const fmtShort = (v) => { if (!v) return ''; const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T12:00:00') : new Date(v); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
const fmtDT = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const monthLabel = (m) => new Date(m + '-15T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const monthShort = (m) => new Date(m + '-15T12:00:00').toLocaleDateString('en-GB', { month: 'short' });
const rs = (n) => 'Rs ' + Math.round(n || 0).toLocaleString('en-PK');
const rsK = (n) => { const a = Math.abs(n || 0); const s = n < 0 ? '-' : ''; return a >= 1e6 ? `${s}Rs ${(a / 1e6).toFixed(2)}M` : a >= 1e5 ? `${s}Rs ${(a / 1e3).toFixed(0)}k` : rs(n); };
const cur = (amount, c) => (c === 'PKR' ? rs(amount) : `${{ USD: '$', EUR: '€', GBP: '£', AUD: 'A$', AED: 'AED ' }[c] || c + ' '}${Number(amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
function rel(iso) {
  if (!iso) return '';
  const d = Math.round((new Date(iso) - Date.now()) / 6e4), a = Math.abs(d);
  if (a < 60) return d <= 0 ? `${a}m ago` : `in ${a}m`;
  if (a < 1440) return d <= 0 ? `${Math.round(a / 60)}h ago` : `in ${Math.round(a / 60)}h`;
  return d <= 0 ? `${Math.round(a / 1440)}d ago` : `in ${Math.round(a / 1440)}d`;
}
const fuClass = (iso) => { if (!iso) return ''; const d = dayOf(iso), t = todayStr(); return d < t ? 'over' : d === t ? 'today' : ''; };
const dateToIso = (v) => (v ? new Date(v + 'T12:00:00').toISOString() : null);
const monthShift = (m, n) => { const d = new Date(m + '-15T12:00:00'); d.setMonth(d.getMonth() + n); return d.toLocaleDateString('en-CA').slice(0, 7); };
const statusLabel = (s) => S.cfg?.statuses.find((x) => x.id === s)?.label || s;
const badge = (s) => `<span class="badge s-${s}">${esc(statusLabel(s))}</span>`;
const platLabel = { messenger: 'Messenger', instagram: 'Instagram', manual: 'Manual' };
const displayName = (l) => esc(l.name || (l.username ? '@' + l.username : 'Unknown user'));
function avatar(l) {
  const init = (l.name || l.username || '?').trim()[0]?.toUpperCase() || '?';
  return `<div class="avatar">${l.profile_pic ? `<img src="${esc(l.profile_pic)}" onerror="this.parentNode.textContent='${esc(init)}'" alt="">` : esc(init)}</div>`;
}
function destroyCharts() { S.charts.forEach((c) => c.destroy()); S.charts = []; }
function chart(canvas, cfg) { if (!window.Chart || !canvas) return; S.charts.push(new Chart(canvas, cfg)); }
const BLUE = '#004AAD', RED = '#FF7878';

// ------------------------------------------------------------ modal form builder
function closeModal() { $('#modalRoot').innerHTML = ''; }
function openForm({ title, fields, submit = 'Save', onSubmit, onDelete, extra = '' }) {
  const fieldHtml = (f) => {
    const v = f.value ?? '';
    const req = f.required ? 'required' : '';
    const cls = `f${f.full ? ' full' : ''}`;
    if (f.type === 'select') return `<label class="${cls}">${esc(f.label)}<select name="${f.name}" ${req}>${f.options.map((o) => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`; }).join('')}</select></label>`;
    if (f.type === 'textarea') return `<label class="${cls} full">${esc(f.label)}<textarea name="${f.name}" rows="${f.rows || 3}" ${req} placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea></label>`;
    if (f.type === 'checkbox') return `<label class="chk ${f.full ? 'full' : ''}" style="grid-column:1/-1"><input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}/> ${esc(f.label)}</label>`;
    return `<label class="${cls}">${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" ${req} ${f.step ? `step="${f.step}"` : f.type === 'number' ? 'step="any"' : ''} placeholder="${esc(f.placeholder || '')}" ${f.list ? `list="dl-${f.name}"` : ''} inputmode="${f.type === 'number' ? 'decimal' : 'text'}"/>${f.list ? `<datalist id="dl-${f.name}">${f.list.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>` : ''}</label>`;
  };
  $('#modalRoot').innerHTML = `<div class="modal"><form class="box" id="mForm">
    <h2>${esc(title)}</h2>${extra}
    <div class="grid2">${fields.map(fieldHtml).join('')}</div>
    <div class="mact">${onDelete ? '<button type="button" class="btn danger left" id="mDel">Delete</button>' : ''}
      <button type="button" class="btn light" id="mCancel">Cancel</button><button class="btn main" id="mSave">${esc(submit)}</button></div>
  </form></div>`;
  const form = $('#mForm');
  $('#mCancel').onclick = closeModal;
  $('.modal').onclick = (e) => { if (e.target.classList.contains('modal')) closeModal(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const vals = {};
    for (const f of fields) {
      const el = form.elements[f.name];
      vals[f.name] = f.type === 'checkbox' ? el.checked : el.value.trim();
    }
    $('#mSave').disabled = true;
    try { await onSubmit(vals); closeModal(); } catch (err) { toast(err.message); $('#mSave').disabled = false; }
  };
  if (onDelete) $('#mDel').onclick = async () => {
    const b = $('#mDel');
    if (b.dataset.c !== '1') { b.dataset.c = '1'; b.textContent = 'Tap again to delete'; return; }
    try { await onDelete(); closeModal(); } catch (err) { toast(err.message); }
  };
  setTimeout(() => form.querySelector('input:not([type=hidden]),select,textarea')?.focus(), 50);
  return form;
}
function sheet(title, links) {
  $('#modalRoot').innerHTML = `<div class="modal"><div class="box sheet"><h2>${esc(title)}</h2>
    ${links.map((l, i) => `<a href="${l.href || '#'}" data-i="${i}"><span class="ic">${l.ic}</span>${esc(l.label)}</a>`).join('')}
    <div class="mact"><button class="btn light" id="mCancel">Close</button></div></div></div>`;
  $('#mCancel').onclick = closeModal;
  $('.modal').onclick = (e) => { if (e.target.classList.contains('modal')) closeModal(); };
  $$('.sheet a').forEach((a) => (a.onclick = (e) => { const l = links[+a.dataset.i]; if (l.fn) { e.preventDefault(); closeModal(); l.fn(); } else closeModal(); }));
}

// ------------------------------------------------------------ navigation
const NAV = [
  { id: 'dashboard', label: 'Dashboard', ic: '🏠' },
  { id: 'leads', label: 'Leads', ic: '💬' },
  { id: 'projects', label: 'Projects', ic: '📁' },
  { id: 'upwork', label: 'Upwork', ic: '🟢' },
  { id: 'income', label: 'Income', ic: '💰' },
  { id: 'expenses', label: 'Expenses', ic: '🧾' },
  { id: 'subs', label: 'Subscriptions', ic: '🔁' },
  { id: 'staff', label: 'Staff', ic: '👥' },
  { id: 'accounts', label: 'Accounts & reports', ic: '📊' },
  { id: 'apps', label: 'Apps on Render', ic: '🖥️' },
  { id: 'settings', label: 'Settings', ic: '⚙️' },
];
const BOTTOM = [
  { id: 'dashboard', label: 'Home', ic: '🏠' }, { id: 'leads', label: 'Leads', ic: '💬' },
  { id: 'money', label: 'Money', ic: '💰' }, { id: 'accounts', label: 'Reports', ic: '📊' }, { id: 'more', label: 'More', ic: '☰' },
];
function buildNav() {
  $('#sideNav').innerHTML = NAV.map((n) => `<a class="nav" href="#${n.id}" data-v="${n.id}"><span class="ic">${n.ic}</span>${n.label}</a>`).join('');
  $('#bottomNav').innerHTML = BOTTOM.map((n) => `<a href="#${n.id === 'money' || n.id === 'more' ? '' : n.id}" data-b="${n.id}"><span class="ic">${n.ic}</span>${n.label}</a>`).join('');
  $$('#bottomNav a').forEach((a) => (a.onclick = (e) => {
    const b = a.dataset.b;
    if (b === 'money') { e.preventDefault(); sheet('Money', [{ ic: '💰', label: 'Income', href: '#income' }, { ic: '🧾', label: 'Expenses', href: '#expenses' }, { ic: '📣', label: 'Add today\'s Meta ads spend', fn: () => quickAds() }, { ic: '🔁', label: 'Subscriptions', href: '#subs' }, { ic: '🟢', label: 'Upwork', href: '#upwork' }]); }
    if (b === 'more') { e.preventDefault(); sheet('More', [{ ic: '📁', label: 'Projects', href: '#projects' }, { ic: '🟢', label: 'Upwork — Connects, proposals, earnings', href: '#upwork' }, { ic: '👥', label: 'Staff', href: '#staff' }, { ic: '🖥️', label: 'Apps on Render', href: '#apps' }, { ic: '⚙️', label: 'Settings', href: '#settings' }]); }
  }));
  $('#quickBtn').onclick = quickAdd;
}
function quickAdd() {
  sheet('Quick add', [
    { ic: '📣', label: 'Meta ads spend (today)', fn: quickAds },
    { ic: '🧾', label: 'Expense', fn: () => expenseForm() },
    { ic: '💰', label: 'Income / payment received', fn: () => incomeForm() },
    { ic: '💬', label: 'Lead (manual)', fn: () => leadForm() },
    { ic: '📨', label: 'Upwork proposal sent', fn: () => proposalForm() },
    { ic: '🟢', label: 'Bought Upwork Connects', fn: () => buyConnects() },
    { ic: '📁', label: 'Project', fn: () => projectForm() },
  ]);
}
window.addEventListener('hashchange', route);
async function route() {
  const v = (location.hash.slice(1) || 'dashboard').split('?')[0];
  S.view = NAV.some((n) => n.id === v) ? v : 'dashboard';
  $$('#sideNav a').forEach((a) => a.classList.toggle('active', a.dataset.v === S.view));
  const bmap = { income: 'money', expenses: 'money', subs: 'money', upwork: 'more', projects: 'more', staff: 'more', apps: 'more', settings: 'more' };
  $$('#bottomNav a').forEach((a) => a.classList.toggle('active', a.dataset.b === (bmap[S.view] || S.view)));
  closeDrawer(); destroyCharts();
  $('#pageTitle').textContent = NAV.find((n) => n.id === S.view).label;
  $('#pageActions').innerHTML = '';
  $('#view').innerHTML = '<div class="empty">Loading…</div>';
  try { await VIEWS[S.view](); } catch (e) { $('#view').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}
const actions = (html) => { $('#pageActions').innerHTML = html; };
function monthPicker(id = 'mPick') {
  return `<div style="display:flex;gap:4px;align-items:center"><button class="btn light sm" data-mshift="-1">‹</button>
    <input type="month" class="inp" id="${id}" value="${S.month}" style="padding:5px 8px"/><button class="btn light sm" data-mshift="1">›</button></div>`;
}
function bindMonth(rerender) {
  $$('[data-mshift]').forEach((b) => (b.onclick = () => { S.month = monthShift(S.month, +b.dataset.mshift); rerender(); }));
  const p = $('#mPick'); if (p) p.onchange = () => { if (p.value) { S.month = p.value; rerender(); } };
}

// ------------------------------------------------------------ login / boot
function showLogin(err) { $('#login').classList.remove('hidden'); $('#loginErr').classList.toggle('hidden', !err); }
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault(); KEY = $('#pw').value;
  try { await api('/api/config'); try { localStorage.setItem('pb_key', KEY); } catch {} boot(); }
  catch { $('#loginErr').classList.remove('hidden'); }
};
async function boot() {
  [S.cfg, S.fin] = await Promise.all([api('/api/config'), api('/api/finance/config')]);
  S.month = S.fin.month;
  $('#login').classList.add('hidden');
  buildNav();
  route();
  setInterval(() => { if (!document.hidden && S.view === 'leads' && !S.current) VIEWS.leads(true); }, 30000);
}

// ------------------------------------------------------------ DASHBOARD
const VIEWS = {};
VIEWS.dashboard = async () => {
  actions(`<button class="btn main" id="adsBtn">📣 Today's Meta ads</button><button class="btn light" id="qaBtn">＋ Add</button>`);
  $('#adsBtn').onclick = quickAds; $('#qaBtn').onclick = quickAdd;
  const [sum, st, fu, mon, projs, cn] = await Promise.all([
    api('/api/accounts/summary?month=' + thisMonth()), api('/api/stats'), api('/api/followups'), api('/api/monitors').catch(() => ({ monitors: [] })),
    api('/api/projects?status=ongoing').catch(() => []), api('/api/upwork/connects').catch(() => null),
  ]);
  const projDue = projs.filter((p) => p.deadline && p.deadline <= new Date(Date.now() + 3 * 864e5).toLocaleDateString('en-CA'));
  const projRemaining = projs.reduce((s, p) => s + (p.remaining_pkr || 0), 0);
  const c = sum.current, p = sum.previous;
  const delta = (a, b) => (b ? `${a >= b ? '▲' : '▼'} ${Math.abs(Math.round(((a - b) / Math.abs(b)) * 100))}% vs ${monthShort(p.month)}` : '');
  const down = mon.monitors.filter((m) => m.last_checked && !(m.last_status && m.last_status < 500));
  const t = todayStr();
  const overdueFu = fu.filter((f) => dayOf(f.due_at) < t), todayFu = fu.filter((f) => dayOf(f.due_at) === t);
  const alerts = [
    ...overdueFu.slice(0, 5).map((f) => ({ ic: '⏰', html: `<b>Overdue follow-up:</b> ${esc(f.name || 'Unknown')} <span class="sub">${fmtShort(f.due_at)}${f.note ? ' — ' + esc(f.note) : ''}</span>`, fn: () => openLead(f.lead_id) })),
    ...todayFu.slice(0, 5).map((f) => ({ ic: '📞', html: `<b>Follow up today:</b> ${esc(f.name || 'Unknown')} <span class="sub">${f.note ? esc(f.note) : ''}</span>`, fn: () => openLead(f.lead_id) })),
    ...sum.subscriptions.upcoming.map((s) => ({ ic: '🔁', html: `<b>${s.overdue ? 'Overdue' : 'Due'}:</b> ${esc(s.name)} — ${cur(s.amount, s.currency)} <span class="sub">${fmtShort(s.next_due)}</span>`, fn: () => (location.hash = 'subs') })),
    ...sum.staff.unpaid.map((s) => ({ ic: '👥', html: `<b>Salary not paid yet:</b> ${esc(s.name)} — ${cur(s.monthly_salary, s.salary_currency)}`, fn: () => (location.hash = 'staff') })),
    ...(down.length ? [{ ic: '🔴', html: `<b>${down.length} app${down.length > 1 ? 's' : ''} not responding:</b> <span class="sub">${down.slice(0, 4).map((m) => esc(m.name)).join(', ')}${down.length > 4 ? '…' : ''}</span>`, fn: () => (location.hash = 'apps') }] : []),
    ...projDue.map((p) => ({ ic: '📁', html: `<b>${p.deadline < todayStr() ? 'Project overdue' : 'Deadline soon'}:</b> ${esc(p.name)} <span class="sub">${fmtShort(p.deadline)}</span>`, fn: () => (location.hash = 'projects') })),
    ...(cn && cn.isSet && cn.balance < 30 ? [{ ic: '🟢', html: `<b>Low Upwork Connects:</b> ${cn.balance} left`, fn: () => (location.hash = 'upwork') }] : []),
    ...(sum.pending.n ? [{ ic: '💸', html: `<b>Pending payments:</b> ${rs(sum.pending.total)} from ${sum.pending.n} client(s)`, fn: () => (location.hash = 'income') }] : []),
  ];
  const ads = sum.ads;
  $('#view').innerHTML = `
    <div class="tiles four five">
      <div class="tile click" data-go="income"><div class="l">Income · ${monthLabel(c.month)}</div><div class="n">${rsK(c.income)}</div><div class="s">${delta(c.income, p.income)}</div></div>
      <div class="tile red click" data-go="expenses"><div class="l">Expenses</div><div class="n">${rsK(c.expenses)}</div><div class="s">${delta(c.expenses, p.expenses)}</div></div>
      <div class="tile ${c.profit >= 0 ? 'green' : 'red'} click" data-go="accounts"><div class="l">${c.profit >= 0 ? 'Profit' : 'Loss'}</div><div class="n">${rsK(c.profit)}</div><div class="s">${c.income ? Math.round((c.profit / c.income) * 100) + '% margin' : ''}</div></div>
      <div class="tile ${ads.total && ads.earned >= ads.total ? 'green' : 'red'} click" data-go="income?meta"><div class="l">Meta ads: spent → earned</div><div class="n">${rsK(ads.total)} → ${rsK(ads.earned)}</div><div class="s">${ads.roas != null ? `${ads.roas.toFixed(1)}x return` : 'log ad spend to see return'}${ads.costPerLead ? ` · ${rs(ads.costPerLead)}/lead` : ''}</div></div>
      <div class="tile click" data-go="leads"><div class="l">New leads this month</div><div class="n">${sum.leads.new_leads}</div><div class="s">${st.notContacted} not contacted · ${sum.leads.demos} demos</div></div>
      <div class="tile click" data-go="income"><div class="l">Pending payments</div><div class="n">${rsK(sum.pending.total)}</div><div class="s">${sum.pending.n} unpaid</div></div>
      <div class="tile click" data-go="subs"><div class="l">Subscriptions / month</div><div class="n">${rsK(sum.subscriptions.monthlyBurn)}</div><div class="s">${sum.subscriptions.count} active</div></div>
      <div class="tile click" data-go="staff"><div class="l">Staff payroll / month</div><div class="n">${rsK(sum.staff.payroll)}</div><div class="s">${sum.staff.active} on salary</div></div>
      <div class="tile click" data-go="projects"><div class="l">Ongoing projects</div><div class="n">${projs.length}</div><div class="s">${projRemaining ? rsK(projRemaining) + ' still to receive' : ''}${projDue.length ? ` · ${projDue.length} due soon` : ''}</div></div>
      <div class="tile ${cn && cn.isSet && cn.balance < 30 ? 'red' : ''} click" data-go="upwork"><div class="l">Upwork Connects</div><div class="n">${cn && cn.isSet ? cn.balance : '—'}</div><div class="s">${cn && cn.isSet ? 'available' : 'tap to set balance'}</div></div>
    </div>
    <div class="cols3">
      <div class="card"><div class="ch">Income vs expenses — last 12 months</div><div class="cb"><div class="chartbox"><canvas id="cMonths"></canvas></div></div></div>
      <div class="card"><div class="ch">Needs attention <span class="r badge ${alerts.length ? 'b-bad' : 'b-good'}">${alerts.length}</span></div>
        <div id="alerts">${alerts.length ? alerts.map((a, i) => `<div class="alert" data-i="${i}"><span class="ic">${a.ic}</span><div>${a.html}</div></div>`).join('') : '<div class="empty">All clear ✅</div>'}</div></div>
    </div>
    <div class="cols2" style="margin-top:12px">
      <div class="card"><div class="ch">Meta ads — ${monthLabel(c.month)} <button class="btn sm main r" id="adsBtn2">＋ Today</button></div><div class="cb">
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px;text-align:center">
          <div><div class="sub">Spent</div><div class="bad" style="font-size:16px">${rs(ads.total)}</div></div>
          <div><div class="sub">Earned from Meta clients</div><div class="good" style="font-size:16px">${rs(ads.earned)}</div></div>
          <div><div class="sub">Return</div><div class="${ads.roas >= 1 ? 'good' : 'bad'}" style="font-size:16px">${ads.roas != null ? ads.roas.toFixed(1) + 'x' : '—'}</div></div></div>
        <div class="chartbox" style="height:200px"><canvas id="cAds"></canvas></div></div></div>
      <div class="card"><div class="ch">Where the money went (${monthShort(c.month)})</div><div class="cb">${sum.byCategory.length ? sum.byCategory.map((x) => `
        <div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between"><span>${esc(x.category)}</span><b>${rs(x.total)}</b></div>
        <div class="bar"><div style="width:${Math.max(3, (x.total / sum.byCategory[0].total) * 100)}%;background:${x.category === 'Meta Ads' ? RED : BLUE}"></div></div></div>`).join('') : '<div class="empty">No expenses yet this month.</div>'}</div></div>
    </div>`;
  $$('[data-go]').forEach((el) => (el.onclick = () => { const [v, q] = el.dataset.go.split('?'); if (q === 'meta') S.incStatus = 'meta'; else if (q) S.expCat = q.split('=')[1]; location.hash = v; }));
  $$('#alerts .alert').forEach((el) => (el.onclick = () => alerts[+el.dataset.i].fn()));
  $('#adsBtn2').onclick = quickAds;
  const draw = () => {
    chart($('#cMonths'), { type: 'bar', data: { labels: sum.months.map((m) => monthShort(m.month)), datasets: [
      { label: 'Income', data: sum.months.map((m) => m.income), backgroundColor: BLUE, borderRadius: 4 },
      { label: 'Expenses', data: sum.months.map((m) => m.expenses), backgroundColor: RED, borderRadius: 4 },
      { label: 'Profit', type: 'line', data: sum.months.map((m) => m.profit), borderColor: '#137a3a', backgroundColor: '#137a3a', tension: .3, pointRadius: 2 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (x) => `${x.dataset.label}: ${rs(x.raw)}` } } }, scales: { y: { ticks: { callback: (v) => rsK(v) } } } } });
    chart($('#cAds'), { type: 'bar', data: { labels: ads.daily.map((d) => +d.date.slice(8)), datasets: [{ label: 'Meta ads', data: ads.daily.map((d) => d.pkr), backgroundColor: RED, borderRadius: 3 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { title: (x) => fmtDate(ads.daily[x[0].dataIndex].date), label: (x) => rs(x.raw) + (ads.daily[x.dataIndex].usd ? ` ($${ads.daily[x.dataIndex].usd})` : '') } } }, scales: { y: { ticks: { callback: (v) => rsK(v) } } } } });
  };
  if (window.Chart) draw(); else window.addEventListener('load', draw, { once: true });
};

// ------------------------------------------------------------ quick Meta ads
function quickAds() {
  openForm({
    title: '📣 Meta ads spend', submit: 'Save spend',
    fields: [
      { name: 'date', label: 'Date', type: 'date', value: todayStr(), required: true },
      { name: 'amount', label: 'Amount spent', type: 'number', required: true, placeholder: 'e.g. 5' },
      { name: 'currency', label: 'Currency', type: 'select', options: S.fin.currencies, value: 'USD' },
      { name: 'description', label: 'Campaign (optional)', placeholder: 'e.g. Leads – Faisalabad textile' },
    ],
    onSubmit: async (v) => { await api('/api/expenses', { method: 'POST', body: { ...v, category: 'Meta Ads', vendor: 'Meta' } }); toast('Ad spend saved'); route(); },
  });
}

// ------------------------------------------------------------ LEADS
S.leadTab = 'list';
VIEWS.leads = async (silent) => {
  if (!silent) {
    actions(`<button class="btn light" id="syncBtn">⟳ Sync inbox</button><button class="btn main" id="addLead">＋ Lead</button>`);
    $('#addLead').onclick = () => leadForm();
    $('#syncBtn').onclick = syncInbox;
    $('#view').innerHTML = `
      <div class="tabs"><button class="tab" data-lt="list">All leads</button><button class="tab" data-lt="followups">Follow-ups</button><button class="tab" data-lt="pipeline">Pipeline</button></div>
      <div id="lt-list"><div class="toolbar">
        <input type="search" id="lSearch" placeholder="Search name, phone, business, message…" value="${esc(S.lq || '')}" />
        <select id="lStatus"><option value="all">All stages</option>${S.cfg.statuses.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}</select>
        <select id="lPlat"><option value="all">All sources</option><option value="messenger">Messenger</option><option value="instagram">Instagram</option><option value="manual">Manual</option></select>
        <select id="lQuick"><option value="">Any</option><option value="notcontacted">Not contacted yet</option><option value="nodemo">Contacted, no demo</option><option value="overdue">Follow-up overdue</option></select>
        <button class="btn light" id="lExport">CSV</button></div>
        <div class="card"><div class="tscroll leads-table"><table><thead><tr><th>Lead</th><th>Source</th><th>Stage</th><th>Contacted</th><th>Demo sent</th><th>Next follow-up</th><th>Last message</th></tr></thead><tbody id="lRows"></tbody></table></div>
        <div class="leads-cards" id="lCards"></div></div></div>
      <div id="lt-followups" class="hidden"><div class="card" id="fuList"></div></div>
      <div id="lt-pipeline" class="hidden"><div class="board" id="board"></div></div>`;
    $$('[data-lt]').forEach((b) => (b.onclick = () => { S.leadTab = b.dataset.lt; showLeadTab(); }));
    let st; $('#lSearch').oninput = () => { clearTimeout(st); st = setTimeout(() => { S.lq = $('#lSearch').value; loadLeads(); }, 250); };
    $('#lStatus').onchange = loadLeads; $('#lPlat').onchange = loadLeads; $('#lQuick').onchange = renderLeads;
    if (S.lQuick) { $('#lQuick').value = S.lQuick; S.lQuick = null; }
    $('#lExport').onclick = () => download('/api/export.csv', `pokitbio-leads-${todayStr()}.csv`);
  }
  await loadLeads();
  showLeadTab();
};
function showLeadTab() {
  $$('[data-lt]').forEach((b) => b.classList.toggle('active', b.dataset.lt === S.leadTab));
  ['list', 'followups', 'pipeline'].forEach((x) => $('#lt-' + x)?.classList.toggle('hidden', x !== S.leadTab));
  if (S.leadTab === 'followups') loadFollowups();
  if (S.leadTab === 'pipeline') renderBoard();
}
async function loadLeads() {
  if (!$('#lRows')) return;
  const p = new URLSearchParams({ status: $('#lStatus').value, platform: $('#lPlat').value, q: ($('#lSearch').value || '').trim() });
  S.leads = await api('/api/leads?' + p);
  renderLeads();
  if (S.leadTab === 'pipeline') renderBoard();
}
function quickFilter(list) {
  const qf = $('#lQuick')?.value, t = todayStr();
  if (qf === 'notcontacted') return list.filter((l) => !l.contacted_at && !['won', 'lost'].includes(l.status));
  if (qf === 'nodemo') return list.filter((l) => l.contacted_at && !l.demo_sent_at && !['won', 'lost'].includes(l.status));
  if (qf === 'overdue') return list.filter((l) => l.next_followup_at && dayOf(l.next_followup_at) < t);
  return list;
}
const leadSubs = (l) => `${l.phone ? `<div class="sub">📞 ${esc(l.phone)}</div>` : ''}${l.business ? `<div class="sub">🏢 ${esc(l.business)}</div>` : ''}${!l.phone && !l.business ? `<div class="sub">${esc(l.username ? '@' + l.username : 'No phone / business yet')}</div>` : ''}`;
function renderLeads() {
  const list = quickFilter(S.leads);
  const stageSel = (l) => `<select class="st s-${l.status}" data-cell="status" data-id="${l.id}">${S.cfg.statuses.map((s) => `<option value="${s.id}" ${s.id === l.status ? 'selected' : ''}>${s.label}</option>`).join('')}</select>`;
  const mark = (l, k) => `<label class="chk"><input type="checkbox" data-mark="${k}" data-id="${l.id}" ${l[k] ? 'checked' : ''}/> <span class="sub">${l[k] ? fmtShort(l[k]) : 'No'}</span></label>`;
  const mark2 = (l, k, lab) => `<label class="chk"><input type="checkbox" data-mark="${k}" data-id="${l.id}" ${l[k] ? 'checked' : ''}/> <span class="sub">${lab}${l[k] ? ' · ' + fmtShort(l[k]) : ''}</span></label>`;
  const fuCell = (l) => (l.next_followup_at ? `<span class="${fuClass(l.next_followup_at)}">${fmtShort(l.next_followup_at)}</span>` : '<span class="no">—</span>');
  $('#lRows').innerHTML = list.length ? list.map((l) => `
    <tr class="row" data-id="${l.id}">
      <td><div class="who">${avatar(l)}<div style="min-width:0"><div class="name">${displayName(l)}${l.unread ? `<span class="unread">${l.unread}</span>` : ''}</div>${leadSubs(l)}</div></div></td>
      <td><span class="plat ${l.platform}">${platLabel[l.platform] || l.platform}</span></td>
      <td class="ed">${stageSel(l)}</td><td class="ed">${mark(l, 'contacted_at')}</td><td class="ed">${mark(l, 'demo_sent_at')}</td>
      <td>${fuCell(l)}${l.next_followup_note ? `<div class="sub snip">${esc(l.next_followup_note)}</div>` : ''}</td>
      <td><div class="snip">${l.last_direction === 'out' ? 'You: ' : ''}${esc(l.last_message || '')}</div><div class="sub">${rel(l.last_message_at)}</div></td>
    </tr>`).join('') : `<tr><td colspan="7" class="empty">No leads here yet. Messages to your page and Instagram appear automatically.</td></tr>`;
  $('#lCards').innerHTML = list.length ? list.map((l) => `
    <div class="lc" data-id="${l.id}">
      <div class="top">${avatar(l)}<div style="flex:1;min-width:0"><div class="name">${displayName(l)}${l.unread ? `<span class="unread">${l.unread}</span>` : ''}</div>${leadSubs(l)}</div>
        <div style="text-align:right"><span class="ed">${stageSel(l)}</span><div class="sub plat ${l.platform}" style="margin-top:4px">${platLabel[l.platform]}</div></div></div>
      <div class="meta"><span class="ed">${mark2(l, 'contacted_at', 'Contacted')}</span><span class="ed">${mark2(l, 'demo_sent_at', 'Demo')}</span>
        ${l.next_followup_at ? `<span>⏰ ${fuCell(l)}</span>` : ''}</div>
    </div>`).join('') : '<div class="empty">No leads here yet.</div>';
  $$('#lRows tr.row, #lCards .lc').forEach((el) => (el.onclick = () => openLead(+el.dataset.id)));
  $$('.ed').forEach((td) => (td.onclick = (e) => e.stopPropagation()));
  $$('[data-cell]').forEach((el) => (el.onchange = async () => { await api('/api/leads/' + el.dataset.id, { method: 'PATCH', body: { [el.dataset.cell]: el.value } }); toast('Saved'); loadLeads(); }));
  $$('[data-mark]').forEach((cb) => (cb.onchange = async () => {
    await api('/api/leads/' + cb.dataset.id, { method: 'PATCH', body: { [cb.dataset.mark]: cb.checked ? new Date().toISOString() : null } });
    toast(cb.checked ? (cb.dataset.mark === 'contacted_at' ? 'Marked contacted' : 'Marked demo sent') : 'Cleared'); loadLeads();
  }));
}
function renderBoard() {
  const b = $('#board'); if (!b) return;
  b.innerHTML = S.cfg.statuses.map((s) => {
    const items = S.leads.filter((l) => l.status === s.id);
    return `<div class="col" data-status="${s.id}"><h4>${s.label}<span class="sub">${items.length}</span></h4>${items.map((l) => `
      <div class="kcard" draggable="true" data-id="${l.id}"><div class="who">${avatar(l)}<div style="min-width:0"><div class="name">${displayName(l)}</div>${leadSubs(l)}</div></div>
      ${l.next_followup_at ? `<div class="sub" style="margin-top:6px">Follow-up: <span class="${fuClass(l.next_followup_at)}">${fmtShort(l.next_followup_at)}</span></div>` : ''}</div>`).join('')}</div>`;
  }).join('');
  $$('.kcard', b).forEach((c) => { c.onclick = () => openLead(+c.dataset.id); c.ondragstart = (e) => e.dataTransfer.setData('id', c.dataset.id); });
  $$('.col', b).forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('drop'); };
    col.ondragleave = () => col.classList.remove('drop');
    col.ondrop = async (e) => { e.preventDefault(); col.classList.remove('drop'); await api('/api/leads/' + e.dataTransfer.getData('id'), { method: 'PATCH', body: { status: col.dataset.status } }); toast('Moved to ' + statusLabel(col.dataset.status)); loadLeads(); };
  });
}
async function loadFollowups() {
  const list = await api('/api/followups'), t = todayStr();
  const groups = { Overdue: [], Today: [], Upcoming: [] };
  list.forEach((f) => { const d = dayOf(f.due_at); (d < t ? groups.Overdue : d === t ? groups.Today : groups.Upcoming).push(f); });
  $('#fuList').innerHTML = list.length ? Object.entries(groups).filter(([, v]) => v.length).map(([g, v]) => `
    <div style="padding:12px 14px;border-bottom:1px solid var(--line);font-weight:700;color:${g === 'Overdue' ? 'var(--main)' : 'var(--sec)'}">${g} (${v.length})</div>
    ${v.map((f) => `<div class="li" data-open="${f.lead_id}"><div class="grow"><div class="t">${esc(f.name || 'Unknown')} <span class="plat ${f.platform}">${platLabel[f.platform]}</span></div>
      <div class="sub">${fmtDate(f.due_at)}${f.note ? ' — ' + esc(f.note) : ''}</div></div><button class="btn sm" data-done="${f.id}">✓ Done</button></div>`).join('')}`).join('')
    : '<div class="empty">No pending follow-ups 🎉</div>';
  $$('[data-open]').forEach((el) => (el.onclick = () => openLead(+el.dataset.open)));
  $$('[data-done]').forEach((el) => (el.onclick = async (e) => { e.stopPropagation(); await api('/api/followups/' + el.dataset.done, { method: 'PATCH', body: { done: true } }); toast('Done'); loadFollowups(); }));
}
async function syncInbox() {
  const b = $('#syncBtn'); b.disabled = true; b.textContent = 'Syncing…';
  try {
    const res = await api('/api/sync', { method: 'POST' });
    toast(res.map((r) => `${platLabel[r.platform]}: ${r.error ? 'error — ' + r.error : r.skipped ? r.skipped : `+${r.newLeads} leads, +${r.newMessages} msgs`}`).join(' | '));
    loadLeads();
  } catch (e) { toast(e.message); }
  b.disabled = false; b.textContent = '⟳ Sync inbox';
}
function leadForm() {
  openForm({ title: 'Add lead', submit: 'Save lead', fields: [
    { name: 'name', label: 'Name', required: true }, { name: 'phone', label: 'Phone / WhatsApp', type: 'tel' },
    { name: 'business', label: 'Business' }, { name: 'email', label: 'Email', type: 'email' },
    { name: 'platform', label: 'Source', type: 'select', options: [['manual', 'Manual / referral'], ['messenger', 'Messenger'], ['instagram', 'Instagram']] },
    { name: 'interest', label: 'Interested in', placeholder: 'CRM, chatbot, POS…' },
  ], onSubmit: async (v) => { const { id } = await api('/api/leads', { method: 'POST', body: v }); toast('Lead added'); if (S.view === 'leads') loadLeads(); openLead(id); } });
}

// ---------- lead drawer
function closeDrawer() { S.current = null; $('#drawer').classList.add('hidden'); $('#scrim').classList.add('hidden'); }
$('#scrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if ($('#modalRoot').innerHTML) closeModal(); else closeDrawer(); } });
async function openLead(id) {
  S.current = id;
  const [l, catalog] = await Promise.all([api('/api/leads/' + id), S.catalog ? Promise.resolve(S.catalog) : api('/api/demo-catalog')]);
  S.catalog = catalog;
  const d = $('#drawer');
  const ms = (label, key) => `<div class="milestone ${l[key] ? 'done' : ''}"><div class="tick">${l[key] ? '✓' : ''}</div>
    <div><div class="name">${label}</div><div class="sub">${l[key] ? fmtDate(l[key]) : 'Not yet'}</div></div>
    <input type="date" data-ms="${key}" value="${dayOf(l[key])}" />${l[key] ? `<button class="btn sm light" data-clear="${key}">Clear</button>` : `<button class="btn sm" data-today="${key}">Today</button>`}</div>`;
  const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  d.innerHTML = `
    <div class="dhead">${avatar(l)}<div style="min-width:0"><div class="name" style="font-size:16px">${displayName(l)}</div>
      <div class="sub"><span class="plat ${l.platform}">${platLabel[l.platform]}</span>${l.phone ? ' · 📞 ' + esc(l.phone) : ''}${l.business ? ' · 🏢 ' + esc(l.business) : ''}</div></div>
      <button class="x" id="closeD">×</button></div>
    <div class="dbody">
      <div class="sec"><h3>Stage</h3>
        <div class="stepper">${S.cfg.statuses.map((s) => `<button class="step ${s.id} ${l.status === s.id ? 'active' : ''}" data-status="${s.id}">${s.label}</button>`).join('')}</div>
        <div class="grid2" style="margin-top:12px">${ms('Contacted', 'contacted_at')}${ms('Demo sent', 'demo_sent_at')}</div></div>

      <div class="sec"><h3>🎬 Demos sent <span class="sub r">${l.demos.length}</span></h3>
        <div class="items">${l.demos.length ? l.demos.map((x) => `<div class="item demo"><div class="grow"><div class="name">${esc(x.demo_name)}</div>
          <div class="sub">${fmtDT(x.sent_at)}${x.note ? ' — ' + esc(x.note) : ''}</div>${x.link ? `<a class="sub" href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.link)}</a>` : ''}</div>
          <button class="del" data-deldemo="${x.id}">🗑</button></div>`).join('') : '<div class="sub">No demo sent yet.</div>'}</div>
        <div class="addrow"><select id="demoSel"><option value="">Choose demo…</option>${catalog.filter((c) => c.active).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}<option value="custom">Other (type below)…</option></select>
          <input type="text" id="demoCustom" class="hidden" placeholder="Demo name or link" /></div>
        <div class="addrow"><input type="date" id="demoDate" value="${todayStr()}" /><input type="text" id="demoNote" placeholder="Note (e.g. sent on WhatsApp, showed on call)" /><button class="btn main sm" id="demoAdd">Add demo</button></div>
      </div>

      <div class="sec"><h3>📞 Calls — what we discussed <span class="sub r">${l.calls.length}</span></h3>
        <div class="items">${l.calls.map((c) => `<div class="item call"><div class="grow"><div class="sub">${fmtDT(c.call_at)}${c.duration_min ? ` · ${c.duration_min} min` : ''}${c.outcome ? ` · <b>${esc(c.outcome)}</b>` : ''}</div>
          <div style="white-space:pre-wrap">${esc(c.summary)}</div>${c.next_step ? `<div class="sub">➡ Next: ${esc(c.next_step)}</div>` : ''}</div><button class="del" data-delcall="${c.id}">🗑</button></div>`).join('') || '<div class="sub">No calls logged.</div>'}</div>
        <div class="addrow"><input type="datetime-local" id="callAt" value="${nowLocal}" /><input type="number" id="callMin" placeholder="Minutes" style="width:90px;flex:none" inputmode="numeric"/>
          <select id="callOut" style="flex:none;min-width:130px"><option value="">Outcome…</option>${['Interested', 'Needs time', 'Wants quotation', 'Not interested', 'No answer', 'Closed / won'].map((o) => `<option>${o}</option>`).join('')}</select></div>
        <div class="addrow"><textarea id="callSum" rows="3" placeholder="What did we discuss? Requirements, budget, objections…"></textarea></div>
        <div class="addrow"><input type="text" id="callNext" placeholder="Next step (optional)" /><input type="date" id="callFu" title="Also create a follow-up on this date" /><button class="btn main sm" id="callAdd">Save call</button></div>
        <div class="sub" style="margin-top:4px">Pick a date next to "Next step" to also add it as a follow-up.</div>
      </div>

      <div class="sec"><h3>⏰ Follow-ups</h3>
        <div class="items">${l.followups.length ? l.followups.map((f) => `<div class="item ${f.done_at ? 'done' : ''}"><input type="checkbox" data-fu="${f.id}" ${f.done_at ? 'checked' : ''} style="margin-top:3px"/>
          <div class="grow"><div class="${f.done_at ? '' : fuClass(f.due_at)}">${fmtDate(f.due_at)}</div>${f.note ? `<div class="sub">${esc(f.note)}</div>` : ''}</div><button class="del" data-delfu="${f.id}">🗑</button></div>`).join('') : '<div class="sub">No follow-ups scheduled.</div>'}</div>
        <div class="addrow"><input type="date" id="fuDate" value="${new Date(Date.now() + 2 * 864e5).toLocaleDateString('en-CA')}" /><input type="text" id="fuNote" placeholder="What to follow up on" /><button class="btn main sm" id="fuAdd">Add</button></div>
        <div class="addrow">${[1, 3, 7, 14].map((n) => `<button class="btn light sm" data-plus="${n}">+${n}d</button>`).join('')}</div></div>

      <div class="sec"><h3>📝 Notes & activity</h3>
        <div class="addrow" style="margin:0 0 8px"><textarea id="noteText" rows="2" placeholder="Add a note…"></textarea></div>
        <div class="addrow" style="margin:0 0 12px"><input type="date" id="noteDate" value="${todayStr()}" /><button class="btn sm" id="noteAdd" style="margin-left:auto">Save note</button></div>
        <div class="items">${l.notes.map((n) => `<div class="item ${n.kind}"><div class="grow"><div class="sub">${n.kind === 'activity' ? '⚙ ' : '📝 '}${fmtDT(n.created_at)}</div><div style="white-space:pre-wrap">${esc(n.text)}</div></div>
          ${n.kind === 'note' ? `<button class="del" data-delnote="${n.id}">🗑</button>` : ''}</div>`).join('')}</div></div>

      <div class="sec"><h3>Details</h3>
        <div class="grid2">${[['name', 'Name'], ['phone', 'Phone / WhatsApp'], ['business', 'Business'], ['email', 'Email'], ['interest', 'Interested in'], ['tags', 'Tags']]
          .map(([k, lab]) => `<label class="f">${lab}<input data-field="${k}" value="${esc(l[k] || '')}" /></label>`).join('')}</div>
        <div class="addrow" style="justify-content:space-between"><span style="display:flex;gap:6px"><button class="btn danger sm" id="delLead">Delete lead</button><button class="btn main sm" id="leadPay">💰 Add payment</button></span>
          <span style="display:flex;gap:6px;flex-wrap:wrap">${l.phone ? `<a class="btn light sm" style="text-decoration:none" target="_blank" href="https://wa.me/${esc(l.phone.replace(/\D/g, '').replace(/^0/, '92'))}">WhatsApp</a>` : ''}
          <a class="btn sm" style="text-decoration:none" target="_blank" href="https://business.facebook.com/latest/inbox">Meta inbox ↗</a></span></div></div>

      <div class="sec"><h3>💬 Conversation (${l.messages.length})</h3>
        <div class="chat" id="chat">${l.messages.length ? l.messages.map((m) => `<div class="bubble ${m.direction}">${esc(m.text)}<div class="t">${fmtDT(m.created_at)}</div></div>`).join('') : '<div class="sub">No messages stored.</div>'}</div></div>
    </div>`;
  d.classList.remove('hidden'); $('#scrim').classList.remove('hidden');
  const chatEl = $('#chat'); chatEl.scrollTop = chatEl.scrollHeight;
  const again = async (msg) => { if (msg) toast(msg); if (S.view === 'leads') loadLeads(); openLead(id); };
  const patch = async (body, msg) => { await api('/api/leads/' + id, { method: 'PATCH', body }); again(msg); };
  $('#closeD').onclick = closeDrawer;
  $$('[data-status]', d).forEach((b) => (b.onclick = () => patch({ status: b.dataset.status }, 'Stage: ' + statusLabel(b.dataset.status))));
  $$('[data-today]', d).forEach((b) => (b.onclick = () => patch({ [b.dataset.today]: new Date().toISOString() }, 'Saved')));
  $$('[data-clear]', d).forEach((b) => (b.onclick = () => patch({ [b.dataset.clear]: null }, 'Cleared')));
  $$('[data-ms]', d).forEach((inp) => (inp.onchange = () => patch({ [inp.dataset.ms]: dateToIso(inp.value) }, 'Date saved')));
  $$('[data-field]', d).forEach((inp) => (inp.onchange = () => patch({ [inp.dataset.field]: inp.value.trim() }, 'Saved')));
  // demos
  $('#demoSel').onchange = () => $('#demoCustom').classList.toggle('hidden', $('#demoSel').value !== 'custom');
  $('#demoAdd').onclick = async () => {
    const sel = $('#demoSel').value; let name, link = null;
    if (sel === 'custom') { name = $('#demoCustom').value.trim(); if (/^https?:\/\//.test(name)) link = name; }
    else if (sel) { const c = catalog.find((x) => String(x.id) === sel); name = c.name; link = c.link; }
    if (!name) return toast('Choose a demo');
    const dv = $('#demoDate').value;
    await api(`/api/leads/${id}/demos`, { method: 'POST', body: { demo_name: name, link, note: $('#demoNote').value.trim(), sent_at: dv && dv !== todayStr() ? dateToIso(dv) : new Date().toISOString() } });
    again('Demo recorded');
  };
  $$('[data-deldemo]', d).forEach((b) => (b.onclick = async () => { await api('/api/lead-demos/' + b.dataset.deldemo, { method: 'DELETE' }); again(); }));
  // calls
  $('#callAdd').onclick = async () => {
    const summary = $('#callSum').value.trim(); if (!summary) return toast('Write what you discussed');
    const next = $('#callNext').value.trim(), fu = $('#callFu').value;
    await api(`/api/leads/${id}/calls`, { method: 'POST', body: { call_at: $('#callAt').value ? new Date($('#callAt').value).toISOString() : null, duration_min: $('#callMin').value, outcome: $('#callOut').value, summary, next_step: next } });
    if (fu) await api(`/api/leads/${id}/followups`, { method: 'POST', body: { due_at: dateToIso(fu), note: next || 'Follow up after call' } });
    again('Call saved');
  };
  $$('[data-delcall]', d).forEach((b) => (b.onclick = async () => { await api('/api/calls/' + b.dataset.delcall, { method: 'DELETE' }); again(); }));
  // follow-ups
  $$('[data-plus]', d).forEach((b) => (b.onclick = () => { $('#fuDate').value = new Date(Date.now() + b.dataset.plus * 864e5).toLocaleDateString('en-CA'); $('#fuNote').focus(); }));
  $('#fuAdd').onclick = async () => { if (!$('#fuDate').value) return toast('Pick a date'); await api(`/api/leads/${id}/followups`, { method: 'POST', body: { due_at: dateToIso($('#fuDate').value), note: $('#fuNote').value.trim() } }); again('Follow-up added'); };
  $$('[data-fu]', d).forEach((cb) => (cb.onchange = async () => { await api('/api/followups/' + cb.dataset.fu, { method: 'PATCH', body: { done: cb.checked } }); again(); }));
  $$('[data-delfu]', d).forEach((b) => (b.onclick = async () => { await api('/api/followups/' + b.dataset.delfu, { method: 'DELETE' }); again(); }));
  // notes
  $('#noteAdd').onclick = async () => {
    const text = $('#noteText').value.trim(); if (!text) return;
    const dv = $('#noteDate').value;
    await api(`/api/leads/${id}/notes`, { method: 'POST', body: { text, created_at: dv && dv !== todayStr() ? dateToIso(dv) : new Date().toISOString() } }); again('Note saved');
  };
  $$('[data-delnote]', d).forEach((b) => (b.onclick = async () => { await api('/api/notes/' + b.dataset.delnote, { method: 'DELETE' }); again(); }));
  $('#leadPay').onclick = () => incomeForm(null, { client: l.name || l.username || '', lead_id: l.id, from_meta: isMetaLead(l), source: isMetaLead(l) ? 'Meta ads' : '', afterSave: () => again() });
  $('#delLead').onclick = async () => {
    const b = $('#delLead'); if (b.dataset.c !== '1') { b.dataset.c = '1'; b.textContent = 'Tap again to delete'; return; }
    await api('/api/leads/' + id, { method: 'DELETE' }); closeDrawer(); toast('Lead deleted'); if (S.view === 'leads') loadLeads();
  };
}


// ------------------------------------------------------------ PROJECTS
S.projStatus = 'ongoing';
const projBadge = (s) => `<span class="badge ${{ ongoing: 'b-info', paused: 'b-warn', completed: 'b-good', cancelled: 'b-mute' }[s] || 'b-mute'}">${s}</span>`;
const platBadge = (p) => `<span class="badge ${p === 'Upwork' ? 'b-good' : p === 'Local' ? 'b-info' : 'b-mute'}" style="font-size:11px">${esc(p)}</span>`;
VIEWS.projects = async () => {
  actions(`<button class="btn main" id="addProj">＋ Project</button>`);
  $('#addProj').onclick = () => projectForm();
  const st = S.projStatus, plat = S.projPlat || 'all';
  const [rows, allRows] = await Promise.all([api(`/api/projects?status=${st}&platform=${plat}`), api('/api/projects')]);
  const ongoing = allRows.filter((p) => p.status === 'ongoing');
  const t = todayStr();
  $('#view').innerHTML = `
    <div class="tiles four">
      <div class="tile"><div class="l">Ongoing</div><div class="n">${ongoing.length}</div><div class="s">${ongoing.filter((p) => p.platform === 'Upwork').length} on Upwork · ${ongoing.filter((p) => p.platform === 'Local').length} local</div></div>
      <div class="tile red"><div class="l">Still to receive (ongoing)</div><div class="n">${rsK(ongoing.reduce((s, p) => s + (p.remaining_pkr || 0), 0))}</div><div class="s">${rsK(allRows.reduce((s, p) => s + p.pending_pkr, 0))} invoiced & pending</div></div>
      <div class="tile green"><div class="l">Received from all projects</div><div class="n">${rsK(allRows.reduce((s, p) => s + p.received_pkr, 0))}</div></div>
      <div class="tile"><div class="l">Completed</div><div class="n">${allRows.filter((p) => p.status === 'completed').length}</div></div>
    </div>
    <div class="toolbar"><div class="chips">${[['ongoing', 'Ongoing'], ['paused', 'Paused'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([k, l]) => `<button class="chip ${st === k ? 'active' : ''}" data-ps="${k}">${l}</button>`).join('')}</div>
      <select id="pPlat" class="inp"><option value="all">All platforms</option>${['Upwork', 'Local', 'Direct', 'Other'].map((p) => `<option ${plat === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">${rows.length ? rows.map((p, i) => {
      const pct = p.budget_pkr ? Math.min(100, Math.round((p.received_pkr / p.budget_pkr) * 100)) : null;
      const due = p.deadline ? (p.status === 'ongoing' && p.deadline < t ? `<span class="bad">overdue · ${fmtShort(p.deadline)}</span>` : `due ${fmtShort(p.deadline)}`) : '';
      return `<div class="card" style="cursor:pointer" data-pi="${i}"><div class="cb">
        <div style="display:flex;gap:8px;align-items:flex-start"><div style="flex:1;min-width:0"><div class="name" style="white-space:normal">${esc(p.name)}</div>
          <div class="sub">${esc(p.client || '')}${p.contract_type ? ' · ' + p.contract_type : ''}${due ? ' · ' + due : ''}</div></div>${platBadge(p.platform)} ${projBadge(p.status)}</div>
        <div style="display:flex;justify-content:space-between;margin:10px 0 4px"><span class="sub">Received</span><b>${rs(p.received_pkr)}${p.budget ? ` <span class="sub">of ${cur(p.budget, p.currency)}</span>` : ''}</b></div>
        ${pct != null ? `<div class="bar"><div style="width:${pct}%;background:${pct >= 100 ? '#137a3a' : BLUE}"></div></div>` : ''}
        <div class="sub" style="margin-top:6px">${p.pending_pkr ? `<span class="today">${rs(p.pending_pkr)} pending</span> · ` : ''}${p.payments} payment(s)${p.costs_pkr ? ` · fees/costs ${rs(p.costs_pkr)}` : ''}${p.completed_date ? ' · done ' + fmtShort(p.completed_date) : ''}</div>
        ${p.live_url ? `<a class="sub" href="${esc(p.live_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">🔗 ${esc(p.live_url.replace(/^https?:\/\//, ''))}</a>` : ''}
        <div class="addrow" style="margin-top:10px">
          <button class="btn sm main" data-ppay="${i}">💰 Payment</button>
          ${p.status === 'ongoing' ? `<button class="btn sm light" data-pdone="${i}">✓ Completed</button>` : ''}
          ${p.status === 'completed' ? `<button class="btn sm light" data-pdemo="${i}">🎬 Add to demos</button>` : ''}
        </div></div></div>`;
    }).join('') : '<div class="card empty">No projects here. Add your Upwork contracts and local client work.</div>'}</div>`;
  $$('[data-ps]').forEach((b) => (b.onclick = () => { S.projStatus = b.dataset.ps; VIEWS.projects(); }));
  $('#pPlat').onchange = () => { S.projPlat = $('#pPlat').value; VIEWS.projects(); };
  $$('[data-pi]').forEach((el) => (el.onclick = () => projectForm(rows[+el.dataset.pi])));
  $$('[data-ppay]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); projectPayment(rows[+b.dataset.ppay]); }));
  $$('[data-pdone]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation(); const p = rows[+b.dataset.pdone];
    openForm({ title: `Complete: ${p.name}`, submit: 'Mark completed', fields: [
      { name: 'completed_date', label: 'Completed on', type: 'date', value: todayStr() },
      { name: 'live_url', label: 'Live link (for demos & monitoring)', type: 'url', value: p.live_url || '', placeholder: 'https://…' },
      { name: 'to_demo', label: '🎬 Add to my demo list (to send to leads)', type: 'checkbox', value: !!p.live_url }],
      onSubmit: async (v) => {
        await api('/api/projects/' + p.id, { method: 'PATCH', body: { status: 'completed', completed_date: v.completed_date, live_url: v.live_url } });
        if (v.to_demo) { await api(`/api/projects/${p.id}/to-demo`, { method: 'POST', body: { link: v.live_url } }); S.catalog = null; }
        toast(v.to_demo ? 'Completed · added to demos' : 'Completed 🎉'); route();
      } });
  }));
  $$('[data-pdemo]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation(); const p = rows[+b.dataset.pdemo];
    const r = await api(`/api/projects/${p.id}/to-demo`, { method: 'POST', body: {} }); S.catalog = null;
    toast(r.added ? 'Added to demo list' + (p.live_url ? ' + uptime checks' : '') : 'Already in demo list');
  }));
};
function projectForm(p) {
  openForm({
    title: p ? 'Edit project' : 'New project', submit: p ? 'Save' : 'Add project',
    fields: [
      { name: 'name', label: 'Project name', required: true, value: p?.name },
      { name: 'client', label: 'Client', value: p?.client },
      { name: 'platform', label: 'Platform', type: 'select', options: [['Upwork', 'Upwork'], ['Local', 'Local (Pakistan)'], ['Direct', 'Direct international'], ['Other', 'Other']], value: p?.platform || 'Upwork' },
      { name: 'contract_type', label: 'Contract', type: 'select', options: [['fixed', 'Fixed price'], ['hourly', 'Hourly'], ['monthly', 'Monthly retainer']], value: p?.contract_type || 'fixed' },
      { name: 'budget', label: 'Budget / contract value', type: 'number', value: p?.budget || '' },
      { name: 'currency', label: 'Currency', type: 'select', options: S.fin.currencies, value: p?.currency || 'USD' },
      { name: 'start_date', label: 'Started', type: 'date', value: p?.start_date || todayStr() },
      { name: 'deadline', label: 'Deadline', type: 'date', value: p?.deadline || '' },
      { name: 'status', label: 'Status', type: 'select', options: ['ongoing', 'paused', 'completed', 'cancelled'], value: p?.status || 'ongoing' },
      { name: 'contract_url', label: 'Upwork contract / brief link', type: 'url', value: p?.contract_url || '' },
      { name: 'live_url', label: 'Live link', type: 'url', value: p?.live_url || '' },
      { name: 'repo_url', label: 'GitHub repo', type: 'url', value: p?.repo_url || '' },
      { name: 'tech', label: 'Tech used', value: p?.tech, placeholder: 'Node, Neon, Render, RAG…' },
      { name: 'from_meta', label: '📣 Client came from Meta ads', type: 'checkbox', value: p?.from_meta },
      { name: 'description', label: 'Notes / scope', type: 'textarea', rows: 3, value: p?.description },
    ],
    onSubmit: async (v) => { if (p) await api('/api/projects/' + p.id, { method: 'PATCH', body: v }); else await api('/api/projects', { method: 'POST', body: v }); toast('Saved'); route(); },
    onDelete: p && (async () => { await api('/api/projects/' + p.id, { method: 'DELETE' }); toast('Deleted'); route(); }),
  });
}
function projectPayment(p) {
  const up = p.platform === 'Upwork';
  openForm({
    title: `Payment: ${p.name}`, submit: 'Save payment',
    extra: up ? '<div class="sub">Enter the <b>gross</b> amount the client paid. The Upwork fee is saved as an Upwork expense, so you see gross, fee and net.</div>' : '',
    fields: [
      { name: 'amount', label: up ? 'Gross amount (before fee)' : 'Amount', type: 'number', required: true },
      { name: 'currency', label: 'Currency', type: 'select', options: S.fin.currencies, value: p.currency },
      { name: 'date', label: 'Date', type: 'date', value: todayStr() },
      { name: 'milestone', label: 'Milestone / period', placeholder: up ? 'e.g. Milestone 2, Week 47' : 'e.g. Advance 50%' },
      { name: 'fee_percent', label: up ? 'Upwork fee %' : 'Platform fee % (if any)', type: 'number', value: up ? 10 : '' },
      { name: 'status', label: 'Status', type: 'select', options: [['received', 'Received'], ['pending', 'Pending / in review']] },
      { name: 'method', label: 'Received via', value: up ? 'Upwork' : '', list: ['Upwork', 'Bank transfer', 'Cash', 'JazzCash', 'Easypaisa', 'Payoneer', 'Wise'] },
      { name: 'rate', label: 'Rate to PKR', type: 'number', placeholder: 'auto from Settings' },
    ],
    onSubmit: async (v) => { await api(`/api/projects/${p.id}/payment`, { method: 'POST', body: v }); toast('Payment saved'); route(); },
  });
}

// ------------------------------------------------------------ UPWORK
VIEWS.upwork = async () => {
  actions(`<button class="btn light" id="uImp">⬆ Import Upwork file</button><button class="btn light" id="uSet">Set Connects</button><button class="btn light" id="uBuy">＋ Buy Connects</button><button class="btn main" id="uProp">＋ Proposal</button>
    <input type="file" id="uFile" accept=".json,application/json" class="hidden" />`);
  $('#uSet').onclick = setConnects; $('#uBuy').onclick = buyConnects; $('#uProp').onclick = () => proposalForm();
  $('#uImp').onclick = () => $('#uFile').click();
  $('#uFile').onchange = async () => {
    const f = $('#uFile').files[0]; if (!f) return;
    try {
      const r = await api('/api/upwork/import', { method: 'POST', body: await f.text() });
      const c = r.counts; toast(`Imported: ${c.income} payments, ${c.fees} fees, ${c.connects} Connects buys, ${c.proposals} proposals, ${c.projects} contracts`); route();
    } catch (e) { toast('Import failed: ' + e.message); }
  };
  const [d, imp] = await Promise.all([api('/api/upwork/summary?month=' + S.month), api('/api/upwork/import').catch(() => null)]);
  const c = d.connects, pr = d.proposals;
  const statuses = ['sent', 'viewed', 'interview', 'hired', 'declined', 'archived'];
  const stBadge = { sent: 'b-mute', viewed: 'b-info', interview: 'b-warn', hired: 'b-good', declined: 'b-bad', archived: 'b-mute' };
  $('#view').innerHTML = `
    <div class="toolbar">${monthPicker()}<span class="sub">${imp ? `Synced from Upwork on ${fmtDT(imp.fetched_at)} · ask Claude "sync my Upwork" for a fresh file` : 'Tip: ask Claude "sync my Upwork" and import the file it gives you'}</span></div>
    <div class="tiles four">
      <div class="tile ${c.isSet && c.balance < 30 ? 'red' : ''} click" id="cnTile"><div class="l">🟢 Connects available</div><div class="n">${c.isSet ? c.balance : '—'}</div>
        <div class="s">${c.isSet ? `set ${c.setBalance} on ${fmtShort(c.setAt)} · +${c.boughtSince} bought · −${c.usedSince} used` : 'tap to enter your balance'}</div></div>
      <div class="tile green"><div class="l">Earned on Upwork · ${monthShort(S.month)}</div><div class="n">${rsK(d.earned.pkr)}</div><div class="s">${d.earned.usd ? '$' + d.earned.usd.toLocaleString() + ' · ' : ''}${d.earned.n} payment(s)${d.pending.n ? ` · ${rsK(d.pending.pkr)} pending` : ''}</div></div>
      <div class="tile red"><div class="l">Spent on Upwork · ${monthShort(S.month)}</div><div class="n">${rsK(d.spent.pkr)}</div><div class="s">${d.spent.usd ? '$' + d.spent.usd.toFixed(2) + ' · ' : ''}Connects, fees, membership</div></div>
      <div class="tile ${d.net >= 0 ? 'green' : 'red'}"><div class="l">Net · ${monthShort(S.month)}</div><div class="n">${rsK(d.net)}</div><div class="s">${d.roi != null ? d.roi.toFixed(1) + 'x return' : ''}</div></div>
      <div class="tile"><div class="l">Proposals · ${monthShort(S.month)}</div><div class="n">${pr.sent}</div><div class="s">${pr.connects} Connects · ${pr.viewed} viewed · ${pr.interviews} interviews · ${pr.hired} hired</div></div>
      <div class="tile"><div class="l">Win rate</div><div class="n">${pr.winRate != null ? Math.round(pr.winRate * 100) + '%' : '—'}</div><div class="s">all time ${pr.allHired}/${pr.allSent}${pr.costPerProposal ? ` · ${rs(pr.costPerProposal)} per proposal` : ''}</div></div>
      <div class="tile"><div class="l">All time on Upwork</div><div class="n">${rsK(d.allTime.net)}</div><div class="s">${rsK(d.allTime.earned.pkr)} earned − ${rsK(d.allTime.spent.pkr)} spent${d.allTime.roi ? ` · ${d.allTime.roi.toFixed(1)}x` : ''}</div></div>
      <div class="tile click" data-go2="projects"><div class="l">Ongoing Upwork projects</div><div class="n">${d.projects.length}</div><div class="s">${rsK(d.projects.reduce((s, p) => s + p.received_pkr, 0))} received so far</div></div>
    </div>
    <div class="cols3">
      <div class="card"><div class="ch">Earned vs spent — last 12 months</div><div class="cb"><div class="chartbox"><canvas id="cUp"></canvas></div></div></div>
      <div class="card"><div class="ch">Spending · ${monthShort(S.month)}</div><div class="cb">
        ${d.byType.length ? d.byType.map((x) => `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line)"><span>${esc(x.t)} <span class="sub">(${x.n})</span></span><b>${rs(x.pkr)}</b></div>`).join('') : '<div class="sub">Nothing spent this month.</div>'}
        <div class="sub" style="margin:12px 0 6px">Quick add</div>
        <div class="chips" style="flex-wrap:wrap">${['Connects', 'Freelancer Plus membership', 'Service fee', 'Withdrawal fee', 'Boosted proposals'].map((t) => `<button class="chip" data-us="${t}">＋ ${t}</button>`).join('')}</div>
      </div></div>
    </div>
    <div class="card" style="margin-top:12px"><div class="ch">📨 Proposals <span class="r"><button class="btn sm main" id="uProp2">＋ Proposal</button></span></div>
      <div class="list">${d.recentProposals.length ? d.recentProposals.map((p, i) => `
        <div class="li" data-pr="${i}"><div class="grow"><div class="t">${esc(p.job_title)}</div>
          <div class="sub">${fmtDate(p.date)} · ${p.connects + p.boost} Connects${p.boost ? ` (${p.boost} boost)` : ''}${p.bid ? ` · bid ${cur(p.bid, 'USD')}${p.bid_type === 'hourly' ? '/hr' : ''}` : ''}${p.sent_by ? ' · by ' + esc(p.sent_by) : ''}</div></div>
          <select class="st ${stBadge[p.status]}" data-prs="${p.id}" onclick="event.stopPropagation()">${statuses.map((s) => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
          ${p.status === 'hired' && !p.project_id ? `<button class="btn sm main" data-prp="${p.id}">→ Project</button>` : ''}
          ${p.job_url ? `<a class="btn sm ghost" href="${esc(p.job_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗</a>` : ''}</div>`).join('')
        : '<div class="empty">Log each proposal you send. Its Connects come off your balance and you can see your win rate.</div>'}</div></div>
    <div class="cols2" style="margin-top:12px">
      <div class="card"><div class="ch">Recent Upwork payments</div><div class="list">${d.recent.length ? d.recent.map((x) => `<div class="li"><div class="grow"><div class="t">${esc(x.client)}</div><div class="sub">${fmtDate(x.date)}${x.project ? ' · ' + esc(x.project) : ''}</div></div>
        <div class="amt ${x.status === 'pending' ? 'today' : 'good'}">${cur(x.amount, x.currency)}</div></div>`).join('') : '<div class="empty">No Upwork income yet.</div>'}</div></div>
      <div class="card"><div class="ch">Top Upwork clients (all time)</div><div class="cb">${d.clients.length ? d.clients.map((x) => `
        <div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between"><span>${esc(x.client)}</span><b>${rs(x.total)}</b></div>
        <div class="bar"><div style="width:${(x.total / d.clients[0].total) * 100}%;background:#14a800"></div></div></div>`).join('') : '<div class="sub">No clients yet.</div>'}</div></div>
    </div>`;
  bindMonth(VIEWS.upwork);
  $('#cnTile').onclick = setConnects; $('#uProp2').onclick = () => proposalForm();
  $$('[data-go2]').forEach((el) => (el.onclick = () => { S.projStatus = 'ongoing'; S.projPlat = 'Upwork'; location.hash = 'projects'; }));
  $$('[data-us]').forEach((b) => (b.onclick = () => (b.dataset.us === 'Connects' ? buyConnects() : upworkSpend(b.dataset.us))));
  $$('[data-pr]').forEach((el) => (el.onclick = () => proposalForm(d.recentProposals[+el.dataset.pr])));
  $$('[data-prs]').forEach((s) => (s.onchange = async () => {
    await api('/api/proposals/' + s.dataset.prs, { method: 'PATCH', body: { status: s.value } });
    toast('Status: ' + s.value + (s.value === 'hired' ? ' 🎉 — tap "→ Project" to start tracking it' : '')); VIEWS.upwork();
  }));
  $$('[data-prp]').forEach((b) => (b.onclick = async (e) => { e.stopPropagation(); await api(`/api/proposals/${b.dataset.prp}/to-project`, { method: 'POST' }); toast('Project created'); S.projStatus = 'ongoing'; location.hash = 'projects'; }));
  const draw = () => chart($('#cUp'), { type: 'bar', data: { labels: d.months.map((m) => monthShort(m.month)), datasets: [
    { label: 'Earned', data: d.months.map((m) => m.earned), backgroundColor: '#14a800', borderRadius: 4 },
    { label: 'Spent', data: d.months.map((m) => m.spent), backgroundColor: RED, borderRadius: 4 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (x) => `${x.dataset.label}: ${rs(x.raw)}` } } }, scales: { y: { ticks: { callback: (v) => rsK(v) } } } } });
  if (window.Chart) draw(); else window.addEventListener('load', draw, { once: true });
};
function setConnects() {
  openForm({ title: '🟢 Connects balance', submit: 'Save balance',
    extra: '<div class="sub">Open Upwork → Connects and type the number you see. From now on, Connects you buy are added and proposals you log are subtracted. Update it anytime (e.g. after your monthly free Connects).</div>',
    fields: [{ name: 'balance', label: 'Available Connects right now', type: 'number', required: true }],
    onSubmit: async (v) => { await api('/api/upwork/connects', { method: 'PUT', body: v }); toast('Connects balance saved'); route(); } });
}
function buyConnects() {
  const f = openForm({ title: '🟢 Bought Connects', submit: 'Save',
    fields: [
      { name: 'qty', label: 'How many Connects', type: 'number', required: true, value: 80 },
      { name: 'amount', label: 'Paid', type: 'number', required: true, value: 12 },
      { name: 'currency', label: 'Currency', type: 'select', options: S.fin.currencies, value: 'USD' },
      { name: 'date', label: 'Date', type: 'date', value: todayStr() },
    ],
    onSubmit: async (v) => {
      await api('/api/expenses', { method: 'POST', body: { ...v, category: 'Upwork', subcategory: 'Connects', vendor: 'Upwork', description: `${v.qty} connects` } });
      toast(`+${v.qty} Connects`); route();
    } });
  f.elements.qty.addEventListener('input', () => { const n = +f.elements.qty.value; if (n > 0 && f.elements.currency.value === 'USD') f.elements.amount.value = (n * 0.15).toFixed(2); });
}
function upworkSpend(type) {
  openForm({ title: `Upwork: ${type}`, submit: 'Save',
    fields: [
      { name: 'amount', label: 'Amount', type: 'number', required: true, value: type === 'Freelancer Plus membership' ? 19.99 : type === 'Withdrawal fee' ? 2 : '' },
      { name: 'currency', label: 'Currency', type: 'select', options: S.fin.currencies, value: 'USD' },
      { name: 'date', label: 'Date', type: 'date', value: todayStr() },
      { name: 'description', label: 'Details', placeholder: type === 'Service fee' ? 'which contract' : '' },
    ],
    onSubmit: async (v) => { await api('/api/expenses', { method: 'POST', body: { ...v, category: 'Upwork', subcategory: type, vendor: 'Upwork', description: v.description || type } }); toast('Saved'); route(); } });
}
async function proposalForm(p) {
  const staff = await api('/api/staff').catch(() => []);
  openForm({
    title: p ? 'Edit proposal' : '📨 Proposal sent', submit: p ? 'Save' : 'Save proposal',
    extra: p ? '' : '<div class="sub">The Connects you enter are subtracted from your balance.</div>',
    fields: [
      { name: 'job_title', label: 'Job title', required: true, value: p?.job_title },
      { name: 'job_url', label: 'Job link', type: 'url', value: p?.job_url || '' },
      { name: 'connects', label: 'Connects used', type: 'number', value: p?.connects ?? 16, required: true },
      { name: 'boost', label: 'Boost Connects (if boosted)', type: 'number', value: p?.boost || 0 },
      { name: 'bid', label: 'Your bid (USD)', type: 'number', value: p?.bid || '' },
      { name: 'bid_type', label: 'Bid type', type: 'select', options: [['fixed', 'Fixed'], ['hourly', 'Hourly']], value: p?.bid_type || 'fixed' },
      { name: 'client', label: 'Client (if known)', value: p?.client },
      { name: 'date', label: 'Date', type: 'date', value: p?.date || todayStr() },
      { name: 'status', label: 'Status', type: 'select', options: ['sent', 'viewed', 'interview', 'hired', 'declined', 'archived'], value: p?.status || 'sent' },
      { name: 'sent_by', label: 'Sent by', value: p?.sent_by || '', list: ['Me', ...staff.filter((s) => s.status === 'active').map((s) => s.name)] },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: p?.notes },
    ],
    onSubmit: async (v) => {
      if (p) await api('/api/proposals/' + p.id, { method: 'PATCH', body: v });
      else { const r = await api('/api/proposals', { method: 'POST', body: v }); if (r.connects?.isSet) toast(`Saved · ${r.connects.balance} Connects left`); }
      if (p) toast('Saved'); route();
    },
    onDelete: p && (async () => { await api('/api/proposals/' + p.id, { method: 'DELETE' }); toast('Deleted'); route(); }),
  });
}

// ------------------------------------------------------------ INCOME
VIEWS.income = async () => {
  actions(`<button class="btn main" id="addInc">＋ Payment received</button>`);
  $('#addInc').onclick = () => incomeForm();
  const status = S.incStatus || 'all';
  const rows = await api(`/api/income?month=${S.month}&status=${status}`);
  const rec = rows.filter((r) => r.status === 'received').reduce((s, r) => s + r.amount_pkr, 0);
  const pend = rows.filter((r) => r.status === 'pending').reduce((s, r) => s + r.amount_pkr, 0);
  const metaRec = rows.filter((r) => r.from_meta && r.status === 'received').reduce((s, r) => s + r.amount_pkr, 0);
  $('#view').innerHTML = `
    <div class="toolbar">${monthPicker()}<div class="chips">${[['all', 'All'], ['received', 'Received'], ['pending', 'Pending'], ['meta', '📣 From Meta ads']].map(([k, l]) => `<button class="chip ${status === k ? 'active' : ''}" data-st="${k}">${l}</button>`).join('')}</div></div>
    <div class="tiles"><div class="tile green"><div class="l">Received · ${monthLabel(S.month)}</div><div class="n">${rs(rec)}</div></div>
      <div class="tile red"><div class="l">Pending (this month)</div><div class="n">${rs(pend)}</div></div>
      <div class="tile click" id="metaTile"><div class="l">📣 From Meta ads customers</div><div class="n">${rs(metaRec)}</div><div class="s">${rec ? Math.round((metaRec / rec) * 100) + '% of income' : ''}</div></div></div>
    <div class="card list">${rows.length ? rows.map((r, i) => `<div class="li" data-i="${i}">
      <div class="grow"><div class="t">${esc(r.client)} ${r.from_meta ? '<span class="badge b-bad" style="font-size:11px">📣 Meta</span>' : ''}</div><div class="sub">${fmtDate(r.date)}${r.project ? ' · ' + esc(r.project) : ''}${r.source ? ' · ' + esc(r.source) : ''}${r.method ? ' · ' + esc(r.method) : ''}</div></div>
      <div><div class="amt ${r.status === 'pending' ? 'bad' : 'good'}">${cur(r.amount, r.currency)}</div><div class="sub" style="text-align:right">${r.currency !== 'PKR' ? rs(r.amount_pkr) + ' · ' : ''}<span class="badge ${r.status === 'pending' ? 'b-warn' : 'b-good'}">${r.status}</span></div></div></div>`).join('')
      : '<div class="empty">No income recorded for this month.</div>'}</div>`;
  bindMonth(VIEWS.income);
  $$('[data-st]').forEach((b) => (b.onclick = () => { S.incStatus = b.dataset.st; VIEWS.income(); }));
  $('#metaTile').onclick = () => { S.incStatus = 'meta'; VIEWS.income(); };
  $$('.li[data-i]').forEach((el) => (el.onclick = () => incomeForm(rows[+el.dataset.i])));
};
const isMetaLead = (l) => l && (l.platform === 'messenger' || l.platform === 'instagram');
async function incomeForm(r, preset = {}) {
  const leads = S.leadsAll || (S.leadsAll = await api('/api/leads').catch(() => []));
  const projects = await api('/api/projects').catch(() => []);
  const findLead = (name) => leads.find((l) => l.name && l.name.trim().toLowerCase() === String(name || '').trim().toLowerCase());
  const pre = { ...preset };
  const form = openForm({
    title: r ? 'Edit payment' : 'Payment received', submit: r ? 'Save' : 'Add income',
    extra: `<div class="sub" id="metaHint" style="margin-top:-4px"></div>`,
    fields: [
      { name: 'client', label: 'Client', required: true, value: r?.client ?? pre.client, list: [...new Set(leads.filter((l) => l.name).map((l) => l.name))] },
      { name: 'date', label: 'Date', type: 'date', value: r?.date || todayStr(), required: true },
      { name: 'amount', label: 'Amount', type: 'number', required: true, value: r?.amount },
      { name: 'currency', label: 'Currency', type: 'select', options: S.fin.currencies, value: r?.currency || 'PKR' },
      { name: 'from_meta', label: '📣 This customer came from Meta ads (Facebook / Instagram)', type: 'checkbox', value: r ? r.from_meta : !!pre.from_meta },
      { name: 'project_id', label: 'Project (optional)', type: 'select', value: r?.project_id || pre.project_id || '', options: [['', '— not linked —'], ...projects.map((p) => [p.id, `${p.name}${p.client ? ' · ' + p.client : ''}${p.status !== 'ongoing' ? ' (' + p.status + ')' : ''}`])] },
      { name: 'project', label: 'Project name / work', value: r?.project, placeholder: 'e.g. Water delivery app' },
      { name: 'source', label: 'Source', value: r?.source ?? pre.source, list: ['Meta ads', 'Upwork', 'Local client', 'International client', 'Referral', 'Website'] },
      { name: 'method', label: 'Received via', value: r?.method, list: ['Bank transfer', 'Cash', 'JazzCash', 'Easypaisa', 'Payoneer', 'Upwork', 'Wise'] },
      { name: 'status', label: 'Status', type: 'select', options: [['received', 'Received'], ['pending', 'Pending (invoice sent)']], value: r?.status || 'received' },
      { name: 'rate', label: 'Rate to PKR (if not PKR)', type: 'number', value: r && r.currency !== 'PKR' ? r.rate : '', placeholder: 'auto from Settings' },
      { name: 'description', label: 'Note', type: 'textarea', rows: 2, value: r?.description },
    ],
    onSubmit: async (v) => {
      const lead = pre.lead_id ? { id: pre.lead_id } : findLead(v.client);
      v.lead_id = r?.lead_id || lead?.id || '';
      if (r) await api('/api/income/' + r.id, { method: 'PATCH', body: v }); else await api('/api/income', { method: 'POST', body: v });
      toast(v.from_meta ? 'Saved · counted as Meta ads earning' : 'Saved'); if (pre.afterSave) pre.afterSave(); else route();
    },
    onDelete: r && (async () => { await api('/api/income/' + r.id, { method: 'DELETE' }); toast('Deleted'); route(); }),
  });
  // auto-tick when the client is a Messenger/Instagram lead, or source says Meta
  const cb = form.elements.from_meta, hint = $('#metaHint');
  let touched = !!r;
  cb.addEventListener('change', () => (touched = true));
  const check = () => {
    const l = findLead(form.elements.client.value);
    const viaSource = /meta|facebook|instagram/i.test(form.elements.source.value);
    if (!touched && (isMetaLead(l) || viaSource)) cb.checked = true;
    hint.innerHTML = l ? `Linked to lead <b>${esc(l.name)}</b> (${platLabel[l.platform] || l.platform}${l.platform !== 'manual' ? ' — came in through Meta' : ''})` : '';
  };
  form.elements.project_id.addEventListener('change', () => {
    const p = projects.find((x) => String(x.id) === form.elements.project_id.value); if (!p) return;
    if (!form.elements.client.value) form.elements.client.value = p.client || p.name;
    form.elements.project.value = p.name;
    if (!form.elements.source.value) form.elements.source.value = p.platform === 'Upwork' ? 'Upwork' : p.platform === 'Local' ? 'Local client' : p.platform;
    form.elements.currency.value = p.currency; check();
  });
  form.elements.client.addEventListener('input', check);
  form.elements.source.addEventListener('input', check);
  check();
}

// ------------------------------------------------------------ EXPENSES
VIEWS.expenses = async () => {
  actions(`<button class="btn light" id="adsQ">📣 Meta ads</button><button class="btn main" id="addExp">＋ Expense</button>`);
  $('#addExp').onclick = () => expenseForm(); $('#adsQ').onclick = quickAds;
  const cat = S.expCat || 'all';
  const [rows, all] = await Promise.all([api(`/api/expenses?month=${S.month}&category=${encodeURIComponent(cat)}`), cat === 'all' ? null : api(`/api/expenses?month=${S.month}`)]);
  const allRows = all || rows;
  const total = rows.reduce((s, r) => s + r.amount_pkr, 0);
  const byCat = {}; allRows.forEach((r) => (byCat[r.category] = (byCat[r.category] || 0) + r.amount_pkr));
  $('#view').innerHTML = `
    <div class="toolbar">${monthPicker()}</div>
    <div class="chips" style="margin-bottom:12px"><button class="chip ${cat === 'all' ? 'active' : ''}" data-cat="all">All · ${rsK(allRows.reduce((s, r) => s + r.amount_pkr, 0))}</button>
      ${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<button class="chip ${cat === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)} · ${rsK(v)}</button>`).join('')}
      ${cat !== 'all' && !byCat[cat] ? `<button class="chip active" data-cat="${esc(cat)}">${esc(cat)}</button>` : ''}</div>
    <div class="tiles"><div class="tile red"><div class="l">${cat === 'all' ? 'Total spent' : esc(cat)} · ${monthLabel(S.month)}</div><div class="n">${rs(total)}</div></div>
      <div class="tile"><div class="l">Entries</div><div class="n">${rows.length}</div></div>
      ${cat === 'Meta Ads' ? `<div class="tile"><div class="l">Avg per ad day</div><div class="n">${rs(total / Math.max(1, new Set(rows.map((r) => r.date)).size))}</div></div>` : ''}</div>
    <div class="card list">${rows.length ? rows.map((r, i) => `<div class="li" data-i="${i}">
      <div class="grow"><div class="t">${esc(r.vendor || r.category)}${r.description ? ` <span class="sub">— ${esc(r.description)}</span>` : ''}</div>
      <div class="sub">${fmtDate(r.date)} · ${esc(r.category)}${r.method ? ' · ' + esc(r.method) : ''}</div></div>
      <div><div class="amt">${cur(r.amount, r.currency)}</div>${r.currency !== 'PKR' ? `<div class="sub" style="text-align:right">${rs(r.amount_pkr)}</div>` : ''}</div></div>`).join('')
      : '<div class="empty">No expenses here for this month.</div>'}</div>`;
  bindMonth(VIEWS.expenses);
  $$('[data-cat]').forEach((b) => (b.onclick = () => { S.expCat = b.dataset.cat; VIEWS.expenses(); }));
  $$('.li[data-i]').forEach((el) => (el.onclick = () => expenseForm(rows[+el.dataset.i])));
};
function expenseForm(r) {
  openForm({
    title: r ? 'Edit expense' : 'Add expense', submit: r ? 'Save' : 'Add expense',
    fields: [
      { name: 'category', label: 'Category', type: 'select', options: S.fin.categories, value: r?.category || (S.expCat && S.expCat !== 'all' ? S.expCat : 'Marketing'), required: true },
      { name: 'date', label: 'Date', type: 'date', value: r?.date || todayStr(), required: true },
      { name: 'amount', label: 'Amount', type: 'number', required: true, value: r?.amount },
      { name: 'currency', label: 'Currency', type: 'select', options: S.fin.currencies, value: r?.currency || 'PKR' },
      { name: 'vendor', label: 'Paid to', value: r?.vendor, placeholder: 'e.g. GuaranteedCRM, Hostinger' },
      { name: 'subcategory', label: 'Type (optional)', value: r?.subcategory, list: ['Connects', 'Freelancer Plus membership', 'Service fee', 'Withdrawal fee', 'Boosted proposals'], placeholder: 'e.g. Connects (for Upwork)' },
      { name: 'qty', label: 'Connects bought (if Connects)', type: 'number', value: r?.qty || '' },
      { name: 'method', label: 'Paid via', value: r?.method, list: ['Card', 'Bank transfer', 'Cash', 'JazzCash', 'Easypaisa', 'Payoneer'] },
      { name: 'rate', label: 'Rate to PKR (if not PKR)', type: 'number', value: r && r.currency !== 'PKR' ? r.rate : '', placeholder: 'auto from Settings' },
      { name: 'description', label: 'Details', type: 'textarea', rows: 2, value: r?.description },
    ],
    onSubmit: async (v) => { if (r) await api('/api/expenses/' + r.id, { method: 'PATCH', body: v }); else await api('/api/expenses', { method: 'POST', body: v }); toast('Saved'); route(); },
    onDelete: r && (async () => { await api('/api/expenses/' + r.id, { method: 'DELETE' }); toast('Deleted'); route(); }),
  });
}

// ------------------------------------------------------------ SUBSCRIPTIONS
VIEWS.subs = async () => {
  actions(`<button class="btn main" id="addSub">＋ Subscription</button>`);
  $('#addSub').onclick = () => subForm();
  const rows = await api('/api/subscriptions');
  const active = rows.filter((r) => r.active);
  const monthly = active.reduce((s, r) => s + r.monthly_pkr, 0);
  const t = todayStr();
  $('#view').innerHTML = `
    <div class="tiles"><div class="tile red"><div class="l">Monthly cost (all active)</div><div class="n">${rs(monthly)}</div><div class="s">${rs(monthly * 12)} / year</div></div>
      <div class="tile"><div class="l">Active subscriptions</div><div class="n">${active.length}</div></div>
      <div class="tile ${active.some((r) => r.next_due && r.next_due < t) ? 'red' : ''}"><div class="l">Overdue</div><div class="n">${active.filter((r) => r.next_due && r.next_due < t).length}</div></div></div>
    <div class="card list">${rows.length ? rows.map((r, i) => {
      const due = r.next_due ? (r.next_due < t ? `<span class="bad">overdue ${fmtShort(r.next_due)}</span>` : r.next_due === t ? '<span class="today">due today</span>' : `due ${fmtShort(r.next_due)}`) : 'no due date';
      return `<div class="li" data-i="${i}" style="${r.active ? '' : 'opacity:.55'}"><div class="grow"><div class="t">${esc(r.name)} ${r.active ? '' : '<span class="badge b-mute">paused</span>'}</div>
        <div class="sub">${esc(r.category)} · ${r.cycle} · ${due}${r.last_paid ? ` · last paid ${fmtShort(r.last_paid)}` : ''}</div></div>
        <div style="text-align:right"><div class="amt">${cur(r.amount, r.currency)}</div><div class="sub">${rs(r.monthly_pkr)}/mo</div></div>
        ${r.active ? `<button class="btn sm main" data-pay="${i}">Paid</button>` : ''}</div>`;
    }).join('') : `<div class="empty">Add the tools you pay for — Claude, hosting (Hostinger, Render), Google Workspace / email, domains, Canva…</div>`}</div>
    <div class="sub" style="margin-top:8px">Tap <b>Paid</b> when a bill is charged: it's added to Expenses and the next due date moves forward automatically.</div>`;
  $$('.li[data-i]').forEach((el) => (el.onclick = () => subForm(rows[+el.dataset.i])));
  $$('[data-pay]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation(); const r = rows[+b.dataset.pay];
    openForm({ title: `Paid: ${r.name}`, submit: 'Record payment', fields: [
      { name: 'date', label: 'Date', type: 'date', value: todayStr() }, { name: 'amount', label: 'Amount', type: 'number', value: r.amount },
      { name: 'currency', label: 'Currency', type: 'select', options: S.fin.currencies, value: r.currency },
      { name: 'rate', label: 'Rate to PKR', type: 'number', placeholder: 'auto from Settings' }, { name: 'method', label: 'Paid via', list: ['Card', 'Bank transfer', 'Payoneer'] }],
      onSubmit: async (v) => { const x = await api(`/api/subscriptions/${r.id}/pay`, { method: 'POST', body: v }); toast('Recorded · next due ' + fmtShort(x.next_due)); route(); } });
  }));
};
function subForm(r) {
  openForm({
    title: r ? 'Edit subscription' : 'Add subscription',
    fields: [
      { name: 'name', label: 'Name', required: true, value: r?.name, list: ['Claude Max', 'Claude Pro', 'ChatGPT Plus', 'Render', 'Hostinger', 'Neon', 'Google Workspace', 'Zoho Mail', 'Canva Pro', 'GoDaddy domain', 'Namecheap domain', 'GitHub Copilot'] },
      { name: 'category', label: 'Category', type: 'select', options: S.fin.categories, value: r?.category || 'Software & AI tools' },
      { name: 'amount', label: 'Amount per cycle', type: 'number', required: true, value: r?.amount },
      { name: 'currency', label: 'Currency', type: 'select', options: S.fin.currencies, value: r?.currency || 'USD' },
      { name: 'cycle', label: 'Billing', type: 'select', options: [['monthly', 'Monthly'], ['yearly', 'Yearly']], value: r?.cycle || 'monthly' },
      { name: 'next_due', label: 'Next due date', type: 'date', value: r?.next_due || '' },
      { name: 'vendor', label: 'Vendor', value: r?.vendor, placeholder: 'e.g. Anthropic' },
      { name: 'active', label: 'Active', type: 'checkbox', value: r ? r.active : true },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: r?.notes },
    ],
    onSubmit: async (v) => { if (r) await api('/api/subscriptions/' + r.id, { method: 'PATCH', body: v }); else await api('/api/subscriptions', { method: 'POST', body: v }); toast('Saved'); route(); },
    onDelete: r && (async () => { await api('/api/subscriptions/' + r.id, { method: 'DELETE' }); toast('Deleted'); route(); }),
  });
}

// ------------------------------------------------------------ STAFF
VIEWS.staff = async () => {
  actions(`<button class="btn main" id="addStaff">＋ Staff member</button>`);
  $('#addStaff').onclick = () => staffForm();
  const rows = await api('/api/staff?month=' + S.month);
  const active = rows.filter((r) => r.status === 'active');
  const payroll = active.filter((r) => r.pay_type === 'salary').reduce((s, r) => s + r.monthly_salary * (S.fin.rates[r.salary_currency] || 1), 0);
  const paid = rows.reduce((s, r) => s + r.paid_this_month, 0);
  $('#view').innerHTML = `
    <div class="toolbar">${monthPicker()}</div>
    <div class="tiles"><div class="tile"><div class="l">Active staff</div><div class="n">${active.length}</div></div>
      <div class="tile"><div class="l">Monthly payroll</div><div class="n">${rs(payroll)}</div></div>
      <div class="tile red"><div class="l">Paid · ${monthLabel(S.month)}</div><div class="n">${rs(paid)}</div></div></div>
    <div class="card list">${rows.length ? rows.map((r, i) => {
      const due = r.pay_type === 'salary' && r.monthly_salary > 0 && r.status === 'active';
      const state = r.paid_this_month > 0 ? `<span class="badge b-good">paid ${rs(r.paid_this_month)}</span>` : due ? '<span class="badge b-warn">not paid</span>' : '';
      return `<div class="li" data-i="${i}" style="${r.status === 'active' ? '' : 'opacity:.55'}">${avatar({ name: r.name })}
        <div class="grow"><div class="t">${esc(r.name)} <span class="sub">${esc(r.role || '')}</span></div>
        <div class="sub">${r.pay_type === 'salary' ? cur(r.monthly_salary, r.salary_currency) + '/month' : r.pay_type === 'commission' ? 'Commission basis' : 'Freelance / per task'}${r.phone ? ' · ' + esc(r.phone) : ''}${r.join_date ? ' · since ' + fmtShort(r.join_date) : ''}${r.status !== 'active' ? ' · left' : ''}</div></div>
        <div style="text-align:right">${state}<div class="sub">total ${rsK(r.paid_total)}</div></div>
        ${r.status === 'active' ? `<button class="btn sm main" data-pay="${i}">Pay</button>` : ''}</div>`;
    }).join('') : '<div class="empty">Add your team — developers, interns, bidders, country reps.</div>'}</div>`;
  bindMonth(VIEWS.staff);
  $$('.li[data-i]').forEach((el) => (el.onclick = () => staffForm(rows[+el.dataset.i])));
  $$('[data-pay]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation(); const r = rows[+b.dataset.pay];
    openForm({ title: `Pay ${r.name}`, submit: 'Record payment', fields: [
      { name: 'month', label: 'For month', type: 'month', value: S.month }, { name: 'date', label: 'Paid on', type: 'date', value: todayStr() },
      { name: 'amount', label: 'Amount', type: 'number', value: r.pay_type === 'salary' ? r.monthly_salary : '', required: true },
      { name: 'currency', label: 'Currency', type: 'select', options: S.fin.currencies, value: r.salary_currency },
      { name: 'method', label: 'Paid via', list: ['Bank transfer', 'Cash', 'JazzCash', 'Easypaisa'] }, { name: 'description', label: 'Note', placeholder: 'e.g. Salary + bonus' }],
      onSubmit: async (v) => { if (!v.description) delete v.description; await api(`/api/staff/${r.id}/pay`, { method: 'POST', body: v }); toast('Payment recorded'); route(); } });
  }));
};
function staffForm(r) {
  openForm({
    title: r ? 'Edit staff member' : 'Add staff member',
    fields: [
      { name: 'name', label: 'Name', required: true, value: r?.name }, { name: 'role', label: 'Role', value: r?.role, list: ['Developer', 'Intern', 'Upwork bidder', 'Country rep', 'Designer', 'Marketing', 'Sales'] },
      { name: 'pay_type', label: 'Pay type', type: 'select', options: [['salary', 'Monthly salary'], ['commission', 'Commission'], ['freelance', 'Freelance / per task']], value: r?.pay_type || 'salary' },
      { name: 'monthly_salary', label: 'Monthly salary', type: 'number', value: r?.monthly_salary || '' },
      { name: 'salary_currency', label: 'Currency', type: 'select', options: S.fin.currencies, value: r?.salary_currency || 'PKR' },
      { name: 'join_date', label: 'Joined', type: 'date', value: r?.join_date || '' },
      { name: 'phone', label: 'Phone', type: 'tel', value: r?.phone }, { name: 'email', label: 'Email', type: 'email', value: r?.email },
      { name: 'status', label: 'Status', type: 'select', options: [['active', 'Active'], ['left', 'Left']], value: r?.status || 'active' },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: r?.notes },
    ],
    onSubmit: async (v) => { if (r) await api('/api/staff/' + r.id, { method: 'PATCH', body: v }); else await api('/api/staff', { method: 'POST', body: v }); toast('Saved'); route(); },
    onDelete: r && (async () => { await api('/api/staff/' + r.id, { method: 'DELETE' }); toast('Deleted'); route(); }),
  });
}

// ------------------------------------------------------------ ACCOUNTS & REPORTS
VIEWS.accounts = async () => {
  actions(`<button class="btn light" id="ledgerBtn">⬇ Ledger CSV</button>`);
  $('#ledgerBtn').onclick = () => download(`/api/accounts/ledger.csv?month=${S.month}`, `pokitbio-ledger-${S.month}.csv`);
  const sum = await api('/api/accounts/summary?month=' + S.month);
  const c = sum.current;
  const yr = sum.months.reduce((a, m) => ({ i: a.i + m.income, e: a.e + m.expenses }), { i: 0, e: 0 });
  $('#view').innerHTML = `
    <div class="card" style="margin-bottom:12px"><div class="ch">📄 PDF reports</div><div class="cb">
      <div class="toolbar" style="margin:0"><select id="rPeriod" class="inp"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly" selected>Monthly</option></select>
        <input type="date" id="rDate" class="inp" value="${todayStr()}" /><button class="btn main" id="rPdf">⬇ Download PDF</button></div>
      <div class="sub" style="margin-top:8px">Covers income, expenses, profit, Meta ads per day, new leads, demos sent, call notes, follow-ups, staff payments, subscriptions and the status of your apps on Render. Weekly runs Monday–Sunday around the date you pick.</div>
      <div class="chips" style="margin-top:10px"><button class="chip" data-rq="daily">Today</button><button class="chip" data-rq="weekly">This week</button><button class="chip" data-rq="monthly">This month</button><button class="chip" data-rq="lastmonth">Last month</button></div>
    </div></div>
    <div class="toolbar">${monthPicker()}</div>
    <div class="tiles">
      <div class="tile green"><div class="l">Income · ${monthLabel(c.month)}</div><div class="n">${rs(c.income)}</div></div>
      <div class="tile red"><div class="l">Expenses</div><div class="n">${rs(c.expenses)}</div></div>
      <div class="tile ${c.profit >= 0 ? 'green' : 'red'}"><div class="l">${c.profit >= 0 ? 'Net profit' : 'Net loss'}</div><div class="n">${rs(c.profit)}</div></div>
      <div class="tile"><div class="l">Last 12 months profit</div><div class="n">${rsK(yr.i - yr.e)}</div><div class="s">${rsK(yr.i)} in · ${rsK(yr.e)} out</div></div>
    </div>
    <div class="cols2">
      <div class="card"><div class="ch">Profit & loss — ${monthLabel(c.month)}</div><div class="tscroll"><table>
        <tr><th colspan="2">Income</th></tr>
        ${sum.bySource.map((s) => `<tr><td>${esc(s.source)}</td><td class="num">${rs(s.total)}</td></tr>`).join('') || '<tr><td colspan="2" class="sub">No income</td></tr>'}
        <tr><td><b>Total income</b></td><td class="num good">${rs(c.income)}</td></tr>
        <tr><th colspan="2">Expenses</th></tr>
        ${sum.byCategory.map((s) => `<tr><td>${esc(s.category)} <span class="sub">(${s.n})</span></td><td class="num">${rs(s.total)}</td></tr>`).join('') || '<tr><td colspan="2" class="sub">No expenses</td></tr>'}
        <tr><td><b>Total expenses</b></td><td class="num bad">${rs(c.expenses)}</td></tr>
        <tr><td><b>${c.profit >= 0 ? 'Net profit' : 'Net loss'}</b></td><td class="num ${c.profit >= 0 ? 'good' : 'bad'}" style="font-size:16px">${rs(c.profit)}</td></tr>
      </table></div></div>
      <div class="card"><div class="ch">Top clients — ${monthShort(c.month)}</div><div class="cb">${sum.byClient.length ? sum.byClient.map((x) => `
        <div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between"><span>${esc(x.client)}</span><b>${rs(x.total)}</b></div>
        <div class="bar"><div style="width:${(x.total / sum.byClient[0].total) * 100}%"></div></div></div>`).join('') : '<div class="empty">No income this month.</div>'}
        <div class="sub" style="margin-top:12px">Meta ads: ${rs(sum.ads.total)} over ${sum.ads.activeDays} days${sum.ads.costPerLead ? ` · ${rs(sum.ads.costPerLead)} per new lead` : ''} · New leads ${sum.leads.new_leads} · Demos ${sum.leads.demos} · Won ${sum.leads.won}</div></div></div>
    </div>
    <div class="card" style="margin-top:12px"><div class="ch">📣 Meta ads — is it paying off?</div><div class="cb">
      <div class="tiles" style="margin-bottom:8px">
        <div class="tile red"><div class="l">Spent · ${monthShort(c.month)}</div><div class="n">${rs(sum.ads.total)}</div></div>
        <div class="tile green"><div class="l">Earned from Meta clients · ${monthShort(c.month)}</div><div class="n">${rs(sum.ads.earned)}</div><div class="s">${sum.ads.earnedPayments} payment(s)${sum.ads.earnedPending ? ` · ${rs(sum.ads.earnedPending)} pending` : ''}</div></div>
        <div class="tile ${sum.ads.net >= 0 ? 'green' : 'red'}"><div class="l">Return · ${monthShort(c.month)}</div><div class="n">${sum.ads.roas != null ? sum.ads.roas.toFixed(1) + 'x' : '—'}</div><div class="s">${sum.ads.net >= 0 ? 'gain' : 'loss'} ${rs(Math.abs(sum.ads.net))}</div></div>
        <div class="tile"><div class="l">All time</div><div class="n">${sum.ads.roasAllTime != null ? sum.ads.roasAllTime.toFixed(1) + 'x' : '—'}</div><div class="s">${rsK(sum.ads.spentAllTime)} spent → ${rsK(sum.ads.earnedAllTime)} earned</div></div></div>
      ${sum.ads.clients.length ? `<div class="sub" style="margin-bottom:6px">Customers from Meta ads this month</div>${sum.ads.clients.map((x) => `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--line)"><span>${esc(x.client)}</span><b>${rs(x.total)}</b></div>`).join('')}` : '<div class="sub">No payments marked "came from Meta ads" this month. Tick the box when adding a payment.</div>'}
    </div></div>
    <div class="card" style="margin-top:12px"><div class="ch">Month by month</div><div class="tscroll"><table>
      <tr><th>Month</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Profit</th><th class="num">Meta spent</th><th class="num">Meta earned</th><th class="num">Return</th></tr>
      ${[...sum.months].reverse().map((m) => `<tr class="row" data-m="${m.month}"><td>${monthLabel(m.month)}</td><td class="num">${rs(m.income)}</td><td class="num">${rs(m.expenses)}</td><td class="num ${m.profit >= 0 ? 'good' : 'bad'}">${rs(m.profit)}</td>
        <td class="num">${m.metaSpend ? rs(m.metaSpend) : '—'}</td><td class="num">${m.metaIncome ? rs(m.metaIncome) : '—'}</td><td class="num ${m.metaSpend && m.metaIncome >= m.metaSpend ? 'good' : m.metaSpend ? 'bad' : ''}">${m.metaSpend ? (m.metaIncome / m.metaSpend).toFixed(1) + 'x' : '—'}</td></tr>`).join('')}
    </table></div></div>`;
  bindMonth(VIEWS.accounts);
  $$('tr[data-m]').forEach((tr) => (tr.onclick = () => { S.month = tr.dataset.m; VIEWS.accounts(); }));
  const pdf = (period, date) => download(`/api/reports/pdf?period=${period}&date=${date}`, `pokitbio-${period}-report-${date}.pdf`);
  $('#rPdf').onclick = () => pdf($('#rPeriod').value, $('#rDate').value || todayStr());
  $$('[data-rq]').forEach((b) => (b.onclick = () => {
    const q = b.dataset.rq;
    if (q === 'lastmonth') pdf('monthly', monthShift(thisMonth(), -1) + '-01'); else pdf(q, todayStr());
    toast('Preparing PDF…');
  }));
};

// ------------------------------------------------------------ APPS ON RENDER
VIEWS.apps = async () => {
  actions(`<button class="btn light" id="chkBtn">⟳ Check now</button><button class="btn main" id="addMon">＋ App</button>`);
  $('#addMon').onclick = () => openForm({ title: 'Monitor an app', fields: [
    { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Pak Pure Pani' }, { name: 'url', label: 'URL', required: true, placeholder: 'https://….onrender.com', type: 'url' },
    { name: 'kind', label: 'Type', type: 'select', options: [['client', 'Client app'], ['demo', 'Demo'], ['internal', 'Our own']] }],
    onSubmit: async (v) => { await api('/api/monitors', { method: 'POST', body: v }); toast('Added'); route(); } });
  $('#chkBtn').onclick = async () => { $('#chkBtn').disabled = true; $('#chkBtn').textContent = 'Checking… (sleeping apps take up to a minute)'; try { await api('/api/monitors/check', { method: 'POST' }); } catch (e) { toast(e.message); } route(); };
  const d = await api('/api/monitors');
  const up = (m) => m.last_checked && m.last_status && m.last_status < 500;
  const nUp = d.monitors.filter(up).length, nDown = d.monitors.filter((m) => m.last_checked && !up(m)).length;
  const kinds = { client: 'Client apps', internal: 'Our apps', demo: 'Demos' };
  const deployBadge = (s) => ({ live: 'b-good', build_in_progress: 'b-info', update_in_progress: 'b-info', build_failed: 'b-bad', update_failed: 'b-bad', canceled: 'b-mute', deactivated: 'b-mute' }[s] || 'b-mute');
  $('#view').innerHTML = `
    <div class="tiles"><div class="tile green"><div class="l">Up</div><div class="n">${nUp}</div></div><div class="tile ${nDown ? 'red' : ''}"><div class="l">Down / not responding</div><div class="n">${nDown}</div></div>
      <div class="tile"><div class="l">Checked every</div><div class="n">${d.intervalMin} min</div></div></div>
    ${d.renderConnected ? (d.renderError ? `<div class="card cb bad" style="margin-bottom:12px">Render API: ${esc(d.renderError)}</div>` : `
    <div class="card" style="margin-bottom:12px"><div class="ch">Render services (${d.render.length})</div><div class="list">${d.render.map((s) => `
      <div class="li" onclick="window.open('${esc(s.dashboard || 'https://dashboard.render.com')}','_blank')"><div class="grow"><div class="t">${esc(s.name)} ${s.suspended === 'suspended' ? '<span class="badge b-mute">suspended</span>' : ''}</div>
        <div class="sub">${esc(s.type)}${s.plan ? ' · ' + esc(s.plan) : ''}${s.region ? ' · ' + esc(s.region) : ''}${s.deploy?.commit ? ' · “' + esc(s.deploy.commit) + '”' : ''}</div></div>
        <div style="text-align:right">${s.deploy ? `<span class="badge ${deployBadge(s.deploy.status)}">${esc(s.deploy.status.replace(/_/g, ' '))}</span><div class="sub">${rel(s.deploy.finishedAt)}</div>` : ''}</div></div>`).join('')}</div></div>`)
    : `<div class="card cb" style="margin-bottom:12px"><b>Connect Render</b> to see every service and its last deploy (live / failed / building): add <code>RENDER_API_KEY</code> in Render → Environment. Create the key in Render → Account settings → API keys. Until then, the apps below are checked by opening their URL.</div>`}
    ${Object.entries(kinds).map(([k, label]) => { const ms = d.monitors.filter((m) => m.kind === k); return ms.length ? `
      <div class="card" style="margin-bottom:12px"><div class="ch">${label}</div><div class="list">${ms.map((m) => `
        <div class="li"><span class="dot ${!m.last_checked ? 'unk' : up(m) ? 'up' : 'down'}"></span><div class="grow"><div class="t">${esc(m.name)}</div>
          <a class="sub" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.url.replace(/^https?:\/\//, ''))}</a></div>
          <div style="text-align:right"><div class="sub">${!m.last_checked ? 'not checked yet' : up(m) ? `${(m.last_ms / 1000).toFixed(1)}s${m.last_ms > 15000 ? ' (was asleep)' : ''}` : `<span class="bad">${esc(m.last_error || 'HTTP ' + m.last_status)}</span>`}</div>
          <div class="sub">${m.down_since ? 'down since ' + fmtDT(m.down_since) : m.last_checked ? rel(m.last_checked) : ''}</div></div>
          <button class="del btn ghost sm" data-delmon="${m.id}" title="Stop monitoring">✕</button></div>`).join('')}</div></div>` : ''; }).join('')}
    <div class="sub">Free Render apps fall asleep after 15 minutes without visits; the first check after that can take up to a minute, which is normal.</div>`;
  $$('[data-delmon]').forEach((b) => (b.onclick = async () => { await api('/api/monitors/' + b.dataset.delmon, { method: 'DELETE' }); route(); }));
};

// ------------------------------------------------------------ SETTINGS
VIEWS.settings = async () => {
  const catalog = (S.catalog = await api('/api/demo-catalog'));
  const r = S.fin.rates;
  $('#view').innerHTML = `
    <div class="cols2">
      <div class="card"><div class="ch">💱 Exchange rates (1 unit = Rs)</div><div class="cb"><form id="rateForm" class="grid2">
        ${S.fin.currencies.filter((c) => c !== 'PKR').map((c) => `<label class="f">${c}<input name="${c}" type="number" step="any" value="${r[c]}" inputmode="decimal"/></label>`).join('')}
        <div style="grid-column:1/-1"><button class="btn main">Save rates</button></div></form>
        <div class="sub" style="margin-top:8px">Used to convert USD payments (Claude, Meta ads, Upwork) to rupees. Each entry keeps the rate it was saved with, so updating this doesn't change old records.</div></div></div>
      <div class="card"><div class="ch">🎬 Demo list <span class="r sub">${catalog.length}</span></div><div class="list">${catalog.map((c) => `
        <div class="li"><div class="grow"><div class="t">${esc(c.name)}</div>${c.link ? `<a class="sub" href="${esc(c.link)}" target="_blank" rel="noopener">${esc(c.link)}</a>` : ''}</div><button class="btn ghost sm" data-deldc="${c.id}">✕</button></div>`).join('')}</div>
        <div class="cb"><div class="addrow" style="margin:0"><input type="text" id="dcName" placeholder="Demo name" /><input type="text" id="dcLink" placeholder="https://…" /><button class="btn sm main" id="dcAdd">Add</button></div></div></div>
      <div class="card"><div class="ch">📱 App</div><div class="cb" style="display:grid;gap:10px">
        <button class="btn main" id="instBtn3">⬇ Install on this device</button>
        <div class="sub" id="instHelp">On Android Chrome: tap the button above, or open the ⋮ menu → <b>Install app</b> / <b>Add to Home screen</b>. On a laptop: click the install icon at the right of Chrome's address bar.</div>
        <button class="btn light" id="logout">Log out on this device</button></div></div>
    </div>`;
  $('#rateForm').onsubmit = async (e) => { e.preventDefault(); S.fin.rates = await api('/api/finance/rates', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); toast('Rates saved'); };
  $('#dcAdd').onclick = async () => { const name = $('#dcName').value.trim(); if (!name) return toast('Name needed'); await api('/api/demo-catalog', { method: 'POST', body: { name, link: $('#dcLink').value.trim() } }); toast('Added'); VIEWS.settings(); };
  $$('[data-deldc]').forEach((b) => (b.onclick = async () => { await api('/api/demo-catalog/' + b.dataset.deldc, { method: 'DELETE' }); VIEWS.settings(); }));
  $('#instBtn3').onclick = installApp;
  $('#logout').onclick = () => { try { localStorage.removeItem('pb_key'); } catch {} location.reload(); };
};

// ------------------------------------------------------------ PWA install
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; $('#installBtn').classList.remove('hidden'); $('#installBtnM').classList.remove('hidden'); });
window.addEventListener('appinstalled', () => { deferredPrompt = null; $('#installBtn').classList.add('hidden'); $('#installBtnM').classList.add('hidden'); toast('Installed ✅'); });
async function installApp() {
  if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; }
  else toast(window.matchMedia('(display-mode: standalone)').matches ? 'Already installed' : 'Use Chrome menu ⋮ → Install app');
}
$('#installBtn').onclick = installApp; $('#installBtnM').onclick = installApp;
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

if (KEY) boot().catch(() => showLogin()); else showLogin();
