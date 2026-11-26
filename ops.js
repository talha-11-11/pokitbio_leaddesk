// Demos sent to leads, call log, Render / uptime monitor, PDF reports.
import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const LOGO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'logo-wordmark.png');

const DEFAULT_DEMOS = [
  { name: 'SA Footballer — AI sports media', link: 'https://safootballerdemo.onrender.com' },
  { name: 'Healthcare chatbot', link: 'https://healthcare-chatbot-demo.onrender.com' },
  { name: 'Phlow AI — pharma RAG chatbot', link: 'https://phlowai.onrender.com/' },
  { name: 'NBA analytics', link: 'https://nba-analytics-demo.onrender.com' },
  { name: 'Data quality checker (dxplorer)', link: 'https://data-quality-checker-demo.onrender.com' },
  { name: 'AI credit underwriting', link: 'https://demo-ai-credit-underwriting.onrender.com' },
  { name: 'Ejection fraction predictor', link: 'https://ejection-fraction.onrender.com' },
  { name: 'Portfolio', link: 'https://portfolio-peuk.onrender.com' },
];

export async function setupOps(app, pool, { APP_TZ = 'Asia/Karachi', RENDER_API_KEY = '', MONITOR_INTERVAL_MIN = 30, SELF_URL = '' } = {}) {
  const all = async (sql, p = []) => (await pool.query(sql, p)).rows;
  const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
  const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ });
  const logActivity = (leadId, text) => pool.query(`INSERT INTO notes (lead_id, kind, text) VALUES ($1,'activity',$2)`, [leadId, text]);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS demo_catalog (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, link TEXT, active BOOLEAN NOT NULL DEFAULT true
  );
  CREATE TABLE IF NOT EXISTS lead_demos (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    demo_name TEXT NOT NULL, link TEXT, note TEXT, sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS calls (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    call_at TIMESTAMPTZ NOT NULL DEFAULT now(), duration_min INTEGER, outcome TEXT,
    summary TEXT NOT NULL, next_step TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS monitors (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'client',
    render_id TEXT, last_status INTEGER, last_ms INTEGER, last_error TEXT, last_checked TIMESTAMPTZ,
    last_ok_at TIMESTAMPTZ, down_since TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT true
  );
  CREATE INDEX IF NOT EXISTS idx_ld_lead ON lead_demos(lead_id);
  CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);
  `);
  if (!(await one(`SELECT 1 FROM demo_catalog LIMIT 1`))) {
    for (const d of DEFAULT_DEMOS) await pool.query(`INSERT INTO demo_catalog(name, link) VALUES ($1,$2)`, [d.name, d.link]);
    for (const d of DEFAULT_DEMOS) await pool.query(`INSERT INTO monitors(name, url, kind) VALUES ($1,$2,'demo') ON CONFLICT (url) DO NOTHING`, [d.name, d.link]);
  }

  // ---------------------------------------------------------------- demo catalog
  app.get('/api/demo-catalog', wrap(async (_req, res) => res.json(await all(`SELECT * FROM demo_catalog ORDER BY active DESC, name`))));
  app.post('/api/demo-catalog', wrap(async (req, res) => {
    if (!req.body?.name) return res.status(400).json({ error: 'name required' });
    res.json(await one(`INSERT INTO demo_catalog(name, link) VALUES ($1,$2) RETURNING *`, [req.body.name, req.body.link || null]));
  }));
  app.delete('/api/demo-catalog/:id', wrap(async (req, res) => { await pool.query(`DELETE FROM demo_catalog WHERE id=$1`, [+req.params.id]); res.json({ ok: true }); }));

  // ---------------------------------------------------------------- demos sent to a lead
  app.get('/api/leads/:id/demos', wrap(async (req, res) => res.json(await all(`SELECT * FROM lead_demos WHERE lead_id=$1 ORDER BY sent_at DESC`, [+req.params.id]))));
  app.post('/api/leads/:id/demos', wrap(async (req, res) => {
    const id = +req.params.id, b = req.body || {};
    if (!b.demo_name) return res.status(400).json({ error: 'demo required' });
    const sent = b.sent_at || new Date().toISOString();
    await pool.query(`INSERT INTO lead_demos(lead_id, demo_name, link, note, sent_at) VALUES ($1,$2,$3,$4,$5)`, [id, b.demo_name, b.link || null, b.note || null, sent]);
    // first demo also fills the lead's "Demo sent" date
    await pool.query(`UPDATE leads SET demo_sent_at=COALESCE(demo_sent_at,$2), updated_at=now() WHERE id=$1`, [id, sent]);
    await logActivity(id, `Demo sent: ${b.demo_name}${b.note ? ' — ' + b.note : ''}`);
    res.json({ ok: true });
  }));
  app.delete('/api/lead-demos/:id', wrap(async (req, res) => { await pool.query(`DELETE FROM lead_demos WHERE id=$1`, [+req.params.id]); res.json({ ok: true }); }));

  // ---------------------------------------------------------------- call log
  app.get('/api/leads/:id/calls', wrap(async (req, res) => res.json(await all(`SELECT * FROM calls WHERE lead_id=$1 ORDER BY call_at DESC`, [+req.params.id]))));
  app.post('/api/leads/:id/calls', wrap(async (req, res) => {
    const id = +req.params.id, b = req.body || {};
    if (!b.summary?.trim()) return res.status(400).json({ error: 'summary required' });
    await pool.query(`INSERT INTO calls(lead_id, call_at, duration_min, outcome, summary, next_step) VALUES ($1,COALESCE($2::timestamptz, now()),$3,$4,$5,$6)`,
      [id, b.call_at || null, b.duration_min ? +b.duration_min : null, b.outcome || null, b.summary.trim(), b.next_step || null]);
    await pool.query(`UPDATE leads SET updated_at=now() WHERE id=$1`, [id]);
    await logActivity(id, `Call logged${b.outcome ? ' (' + b.outcome + ')' : ''}`);
    res.json({ ok: true });
  }));
  app.delete('/api/calls/:id', wrap(async (req, res) => { await pool.query(`DELETE FROM calls WHERE id=$1`, [+req.params.id]); res.json({ ok: true }); }));

  // ---------------------------------------------------------------- Render + uptime
  let renderCache = { at: 0, data: null };
  async function renderServices() {
    if (!RENDER_API_KEY) return null;
    if (Date.now() - renderCache.at < 120000 && renderCache.data) return renderCache.data;
    const h = { Authorization: `Bearer ${RENDER_API_KEY}`, Accept: 'application/json' };
    const list = await (await fetch('https://api.render.com/v1/services?limit=100', { headers: h })).json();
    if (!Array.isArray(list)) throw new Error(list?.message || 'Render API error');
    const out = await Promise.all(list.map(async ({ service: s }) => {
      let deploy = null;
      try {
        const d = await (await fetch(`https://api.render.com/v1/services/${s.id}/deploys?limit=1`, { headers: h })).json();
        deploy = d?.[0]?.deploy || null;
      } catch {}
      return {
        id: s.id, name: s.name, type: s.type, suspended: s.suspended, url: s.serviceDetails?.url || null,
        plan: s.serviceDetails?.plan || null, region: s.serviceDetails?.region || null, updatedAt: s.updatedAt,
        dashboard: s.dashboardUrl, deploy: deploy && { status: deploy.status, finishedAt: deploy.finishedAt, commit: deploy.commit?.message?.split('\n')[0] || null },
      };
    }));
    // auto-add every Render web service to the uptime monitor
    for (const s of out) if (s.url) await pool.query(`INSERT INTO monitors(name, url, kind, render_id) VALUES ($1,$2,'client',$3) ON CONFLICT (url) DO UPDATE SET render_id=$3`, [s.name, s.url, s.id]);
    renderCache = { at: Date.now(), data: out };
    return out;
  }

  async function check(m) {
    const t0 = Date.now();
    let status = null, err = null;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 60000); // free Render apps can take ~50s to wake up
      const r = await fetch(m.url, { signal: ctl.signal, redirect: 'follow' });
      clearTimeout(timer);
      status = r.status;
    } catch (e) { err = e.name === 'AbortError' ? 'timeout (60s)' : e.message; }
    const ms = Date.now() - t0;
    const ok = status && status < 500;
    await pool.query(`UPDATE monitors SET last_status=$1, last_ms=$2, last_error=$3, last_checked=now(),
      last_ok_at=CASE WHEN $4 THEN now() ELSE last_ok_at END,
      down_since=CASE WHEN $4 THEN NULL ELSE COALESCE(down_since, now()) END WHERE id=$5`, [status, ms, err, !!ok, m.id]);
  }
  async function checkAll() {
    const ms = await all(`SELECT * FROM monitors WHERE active`);
    await Promise.all(ms.map((m) => check(m).catch(() => {})));
  }
  setTimeout(() => checkAll().catch(() => {}), 15000);
  setInterval(() => checkAll().catch(() => {}), Math.max(5, +MONITOR_INTERVAL_MIN) * 60000);
  // keep this app awake (free Render sleeps after 15 min)
  if (SELF_URL) setInterval(() => fetch(SELF_URL.replace(/\/$/, '') + '/healthz').catch(() => {}), 10 * 60000);

  app.get('/api/monitors', wrap(async (_req, res) => {
    let render = null, renderError = null;
    try { render = await renderServices(); } catch (e) { renderError = e.message; }
    res.json({ monitors: await all(`SELECT * FROM monitors ORDER BY active DESC, kind, name`), render, renderError, renderConnected: !!RENDER_API_KEY, intervalMin: +MONITOR_INTERVAL_MIN });
  }));
  app.post('/api/monitors', wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.name || !/^https?:\/\//.test(b.url || '')) return res.status(400).json({ error: 'name and full URL required' });
    const m = await one(`INSERT INTO monitors(name, url, kind) VALUES ($1,$2,$3) ON CONFLICT (url) DO UPDATE SET name=$1, kind=$3, active=true RETURNING *`, [b.name, b.url, b.kind || 'client']);
    await check(m); res.json({ ok: true });
  }));
  app.post('/api/monitors/check', wrap(async (_req, res) => { await checkAll(); res.json({ ok: true }); }));
  app.delete('/api/monitors/:id', wrap(async (req, res) => { await pool.query(`DELETE FROM monitors WHERE id=$1`, [+req.params.id]); res.json({ ok: true }); }));

  // ---------------------------------------------------------------- reports
  const ALL_SECTIONS = ['highlights', 'leads', 'demos', 'calls', 'followups', 'meta', 'projects', 'upwork', 'payoneer', 'income', 'expenses', 'staff', 'subs', 'apps'];
  const REPORT_TYPES = {
    full: { title: 'Business report', sections: ALL_SECTIONS, tiles: 'full' },
    finance: { title: 'Money report (profit & loss)', sections: ['highlights', 'income', 'expenses', 'staff', 'subs', 'payoneer'], tiles: 'finance' },
    sales: { title: 'Sales & leads report', sections: ['highlights', 'leads', 'demos', 'calls', 'followups'], tiles: 'sales' },
    marketing: { title: 'Meta ads report', sections: ['highlights', 'meta', 'leads'], tiles: 'marketing' },
    upwork: { title: 'Upwork report', sections: ['highlights', 'upwork', 'projects'], tiles: 'upwork' },
    payoneer: { title: 'Payoneer report', sections: ['payoneer'], tiles: 'payoneer' },
    projects: { title: 'Projects report', sections: ['projects'], tiles: 'projects' },
    team: { title: 'Team & costs report', sections: ['staff', 'subs', 'expenses'], tiles: 'team' },
    apps: { title: 'Apps status report', sections: ['apps'], tiles: 'apps' },
  };
  app.get('/api/reports/types', (_req, res) => res.json({ types: Object.fromEntries(Object.entries(REPORT_TYPES).map(([k, v]) => [k, { title: v.title, sections: v.sections }])), sections: ALL_SECTIONS }));
  function rangeFor(period, dateStr, from, to) {
    if (period === 'custom' && from && to) {
      const [a, b] = from <= to ? [from, to] : [to, from];
      return { start: a, end: b, label: `${fmtD(a)} – ${fmtD(b)}` };
    }
    const d = new Date((dateStr || todayLocal()) + 'T12:00:00Z');
    const ymd = (x) => x.toISOString().slice(0, 10);
    if (period === 'weekly') {
      const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      const start = new Date(d); start.setUTCDate(d.getUTCDate() - dow);
      const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
      return { start: ymd(start), end: ymd(end), label: `Week of ${fmtD(ymd(start))} – ${fmtD(ymd(end))}` };
    }
    if (period === 'yearly') {
      const y = d.getUTCFullYear();
      return { start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
    }
    if (period === 'monthly') {
      const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      return { start: ymd(start), end: ymd(end), label: start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
    }
    return { start: ymd(d), end: ymd(d), label: fmtD(ymd(d)) };
  }
  const fmtD = (s) => (s ? new Date(String(s).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
  const fmtDT = (s) => (s ? new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: APP_TZ }) : '');
  const rs = (n) => 'Rs ' + Math.round(n || 0).toLocaleString('en-PK');

  async function reportData(period, date, from, to) {
    const r = rangeFor(period, date, from, to);
    const p = [r.start, r.end];
    const loc = (c) => `(${c} AT TIME ZONE '${APP_TZ}')::date`;
    const inR = (c) => `${loc(c)} BETWEEN $1::date AND $2::date`;
    const [incomeRows, expRows, byCat, pendingInc, ads, newLeads, contacted, demos, calls, fuDone, fuOpen, won, lost, salaries, subsPaid, subsUpcoming, monitors] = await Promise.all([
      all(`SELECT date, client, project, source, amount::float, currency, amount_pkr::float, status, from_meta FROM income WHERE date BETWEEN $1 AND $2 ORDER BY date`, p),
      all(`SELECT date, category, vendor, description, amount::float, currency, amount_pkr::float FROM expenses WHERE date BETWEEN $1 AND $2 ORDER BY date`, p),
      all(`SELECT category, SUM(amount_pkr)::float total FROM expenses WHERE date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`, p),
      one(`SELECT COALESCE(SUM(amount_pkr),0)::float total, COUNT(*)::int n FROM income WHERE status='pending'`),
      all(`SELECT date, SUM(amount_pkr)::float pkr, SUM(CASE WHEN currency='USD' THEN amount ELSE 0 END)::float usd FROM expenses WHERE category='Meta Ads' AND date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, p),
      all(`SELECT name, platform, phone, business FROM leads WHERE ${inR('created_at')} ORDER BY created_at`, p),
      all(`SELECT name, platform FROM leads WHERE ${inR('contacted_at')}`, p),
      all(`SELECT d.sent_at, d.demo_name, d.note, l.name FROM lead_demos d JOIN leads l ON l.id=d.lead_id WHERE ${inR('d.sent_at')} ORDER BY d.sent_at`, p),
      all(`SELECT c.call_at, c.duration_min, c.outcome, c.summary, c.next_step, l.name FROM calls c JOIN leads l ON l.id=c.lead_id WHERE ${inR('c.call_at')} ORDER BY c.call_at`, p),
      all(`SELECT f.due_at, f.note, l.name FROM followups f JOIN leads l ON l.id=f.lead_id WHERE f.done_at IS NOT NULL AND ${inR('f.done_at')}`, p),
      all(`SELECT f.due_at, f.note, l.name FROM followups f JOIN leads l ON l.id=f.lead_id WHERE f.done_at IS NULL AND $1::date IS NOT NULL AND ${loc('f.due_at')} <= $2::date ORDER BY f.due_at`, p),
      all(`SELECT DISTINCT l.name FROM notes n JOIN leads l ON l.id=n.lead_id WHERE n.text LIKE '%→ Won' AND ${inR('n.created_at')}`, p),
      all(`SELECT DISTINCT l.name FROM notes n JOIN leads l ON l.id=n.lead_id WHERE n.text LIKE '%→ Lost' AND ${inR('n.created_at')}`, p),
      all(`SELECT date, vendor, category, amount::float, currency, amount_pkr::float FROM expenses WHERE staff_id IS NOT NULL AND date BETWEEN $1 AND $2 ORDER BY date`, p),
      all(`SELECT date, vendor, amount::float, currency, amount_pkr::float FROM expenses WHERE subscription_id IS NOT NULL AND date BETWEEN $1 AND $2 ORDER BY date`, p),
      all(`SELECT name, next_due, amount::float, currency FROM subscriptions WHERE active AND $1::date IS NOT NULL AND next_due <= ($2::date + 14) ORDER BY next_due`, p),
      all(`SELECT name, url, last_status, last_ms, last_checked, down_since, last_error FROM monitors WHERE active ORDER BY kind, name`),
    ]);
    const pyn = await all(`SELECT kind, SUM(amount)::float usd, SUM(amount_pkr)::float pkr, COUNT(*)::int n FROM payoneer_tx WHERE date BETWEEN $1 AND $2 GROUP BY kind`, p).catch(() => []);
    const [upEarned, upSpent, projOngoing, projDone, props] = await Promise.all([
      one(`SELECT COALESCE(SUM(i.amount_pkr),0)::float pkr, COUNT(*)::int n FROM income i LEFT JOIN projects p ON p.id=i.project_id
           WHERE (i.source ILIKE 'upwork%' OR p.platform='Upwork') AND i.status='received' AND i.date BETWEEN $1 AND $2`, p),
      all(`SELECT COALESCE(subcategory,'Other') t, SUM(amount_pkr)::float pkr FROM expenses WHERE category='Upwork' AND date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`, p),
      all(`SELECT p.name, p.client, p.platform, p.deadline, p.budget::float, p.currency,
             COALESCE((SELECT SUM(amount_pkr) FROM income i WHERE i.project_id=p.id AND i.status='received'),0)::float received
           FROM projects p WHERE p.status IN ('ongoing','paused') ORDER BY p.deadline NULLS LAST`),
      all(`SELECT p.name, p.client, p.platform, p.completed_date, p.live_url,
             COALESCE((SELECT SUM(amount_pkr) FROM income i WHERE i.project_id=p.id AND i.status='received'),0)::float received
           FROM projects p WHERE p.status='completed' AND p.completed_date BETWEEN $1 AND $2 ORDER BY p.completed_date`, p),
      all(`SELECT date, job_title, connects + boost AS connects, status, bid::float FROM proposals WHERE date BETWEEN $1 AND $2 ORDER BY date`, p),
    ]).catch(() => [{ pkr: 0, n: 0 }, [], [], [], []]);
    const income = incomeRows.filter((x) => x.status === 'received').reduce((s, x) => s + x.amount_pkr, 0);
    const expenses = expRows.reduce((s, x) => s + x.amount_pkr, 0);
    // previous period of the same length (for "vs last period")
    const days = Math.round((Date.parse(r.end) - Date.parse(r.start)) / 864e5) + 1;
    const pEnd = new Date(Date.parse(r.start + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
    const pStart = new Date(Date.parse(pEnd + 'T12:00:00Z') - (days - 1) * 864e5).toISOString().slice(0, 10);
    const prev = await one(`SELECT
        (SELECT COALESCE(SUM(amount_pkr),0)::float FROM income WHERE status='received' AND date BETWEEN $1 AND $2) inc,
        (SELECT COALESCE(SUM(amount_pkr),0)::float FROM expenses WHERE date BETWEEN $1 AND $2) exp,
        (SELECT COUNT(*)::int FROM leads WHERE (created_at AT TIME ZONE '${APP_TZ}')::date BETWEEN $1 AND $2) leads`, [pStart, pEnd]);
    const clientTotals = {}; incomeRows.filter((x) => x.status === 'received').forEach((x) => (clientTotals[x.client] = (clientTotals[x.client] || 0) + x.amount_pkr));
    const topClient = Object.entries(clientTotals).sort((a, b) => b[1] - a[1])[0] || null;
    const adsTotal = ads.reduce((s, x) => s + x.pkr, 0);
    const metaEarned = incomeRows.filter((x) => x.from_meta && x.status === 'received').reduce((s, x) => s + x.amount_pkr, 0);
    return { prev, prevRange: { start: pStart, end: pEnd }, topClient, pyn, props, upEarned, upSpent, projOngoing, projDone, metaEarned, period, range: r, income, expenses, profit: income - expenses, pendingInc, incomeRows, expRows, byCat, ads, adsTotal,
      newLeads, contacted, demos, calls, fuDone, fuOpen, won, lost, salaries, subsPaid, subsUpcoming, monitors };
  }

  app.get('/api/reports/data', wrap(async (req, res) => res.json(await reportData(req.query.period || 'daily', req.query.date, req.query.from, req.query.to))));

  app.get('/api/reports/pdf', wrap(async (req, res) => {
    const period = ['daily', 'weekly', 'monthly', 'yearly', 'custom'].includes(req.query.period) ? req.query.period : 'monthly';
    const type = REPORT_TYPES[req.query.type] ? req.query.type : 'full';
    const custom = String(req.query.sections || '').split(',').filter((s) => ALL_SECTIONS.includes(s));
    const opts = { type, title: custom.length && req.query.type === 'custom' ? 'Custom report' : REPORT_TYPES[type].title,
      sections: new Set(custom.length ? custom : REPORT_TYPES[type].sections), tiles: custom.length && req.query.type === 'custom' ? 'full' : REPORT_TYPES[type].tiles };
    const d = await reportData(period, req.query.date, req.query.from, req.query.to);
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `PokitBio ${opts.title} — ${d.range.label}`, Author: 'PokitBio Technologies' } });
    res.type('application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="pokitbio-${type}-${period}-${d.range.start}.pdf"`);
    doc.pipe(res);
    drawReport(doc, d, opts);
    doc.end();
  }));

  function drawReport(doc, d, opts = { title: 'Business report', sections: new Set(ALL_SECTIONS), tiles: 'full' }) {
    const has = (k) => opts.sections.has(k);
    const RED = '#FF7878', BLUE = '#004AAD', INK = '#0f1d33', MUTED = '#5d6b82', LINE = '#e4e9f2';
    const W = doc.page.width - 80, X = 40;
    const bottom = () => doc.page.height - 50;
    const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
    const periodName = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly', custom: '' }[d.period] || '';
    const title = opts.title;

    // header band in brand coral with the PokitBio wordmark
    doc.rect(0, 0, doc.page.width, 84).fill(RED);
    if (fs.existsSync(LOGO)) doc.image(LOGO, X - 6, 10, { height: 64 });
    doc.fill('#fff').font('Helvetica-Bold').fontSize(18).text(title, X + 150, 20, { width: W - 150, align: 'right' });
    doc.font('Helvetica').fontSize(10.5).fill('#fff').text(`${periodName ? periodName + ' · ' : ''}${d.range.label}`, X, 46, { width: W, align: 'right' });
    doc.fontSize(8.5).fill('#ffe3e3').text(`generated ${fmtDT(new Date())}`, X, 63, { width: W, align: 'right' });
    doc.y = 104;

    const section = (name) => { ensure(60); doc.moveDown(0.6); doc.font('Helvetica-Bold').fontSize(13).fill(BLUE).text(name, X); doc.moveTo(X, doc.y + 2).lineTo(X + W, doc.y + 2).lineWidth(1.5).stroke(RED); doc.moveDown(0.5); };
    const empty = (t) => doc.font('Helvetica-Oblique').fontSize(9.5).fill(MUTED).text(t, X).moveDown(0.3);
    function table(cols, rows) {
      if (!rows.length) return;
      const widths = cols.map((c) => c.w * W);
      const row = (cells, bold, fill) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
        const hs = cells.map((c, i) => doc.heightOfString(String(c ?? ''), { width: widths[i] - 8 }));
        const h = Math.max(...hs) + 8;
        if (doc.y + h > bottom()) { doc.addPage(); if (!bold) row(cols.map((c) => c.h), true, '#eef2f9'); }
        const y = doc.y;
        if (fill) doc.rect(X, y, W, h).fill(fill);
        let x = X;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
        cells.forEach((c, i) => { doc.fill(bold ? BLUE : INK).text(String(c ?? ''), x + 4, y + 4, { width: widths[i] - 8, align: cols[i].a || 'left' }); x += widths[i]; });
        doc.moveTo(X, y + h).lineTo(X + W, y + h).lineWidth(0.5).stroke(LINE);
        doc.y = y + h;
      };
      ensure(60); // never leave a header alone at the bottom of a page
      row(cols.map((c) => c.h), true, '#eef2f9');
      rows.forEach((r) => row(r, false));
      doc.x = X; doc.moveDown(0.4);
    }

    // headline figures — chosen per report type
    const pct = (a, b) => (b ? `${a >= b ? '+' : '−'}${Math.abs(Math.round(((a - b) / Math.abs(b)) * 100))}% vs previous` : '');
    const usd = (n) => '$' + (n || 0).toFixed(2);
    const pk = (ks) => d.pyn.filter((x) => ks.includes(x.kind)).reduce((s, x) => s + x.usd, 0);
    const upSpentTotal = d.upSpent.reduce((s, x) => s + x.pkr, 0);
    const GREEN = '#137a3a';
    const TILES = {
      full: [['Income received', rs(d.income), BLUE, pct(d.income, d.prev.inc)], ['Expenses', rs(d.expenses), RED, pct(d.expenses, d.prev.exp)], [d.profit >= 0 ? 'Profit' : 'Loss', rs(Math.abs(d.profit)), d.profit >= 0 ? GREEN : RED, d.income ? `${Math.round((d.profit / d.income) * 100)}% margin` : ''],
        ['Meta ads spend', rs(d.adsTotal), RED, d.adsTotal ? `${(d.metaEarned / d.adsTotal).toFixed(1)}x return` : ''], ['New leads', String(d.newLeads.length), BLUE, pct(d.newLeads.length, d.prev.leads)], ['Demos sent', String(d.demos.length), BLUE, `${d.calls.length} calls logged`]],
      finance: [['Income received', rs(d.income), BLUE, pct(d.income, d.prev.inc)], ['Expenses', rs(d.expenses), RED, pct(d.expenses, d.prev.exp)], [d.profit >= 0 ? 'Profit' : 'Loss', rs(Math.abs(d.profit)), d.profit >= 0 ? GREEN : RED, d.income ? `${Math.round((d.profit / d.income) * 100)}% margin` : ''],
        ['Pending payments', rs(d.pendingInc.total), RED, `${d.pendingInc.n} unpaid (all time)`], ['Staff paid', rs(d.salaries.reduce((s, x) => s + x.amount_pkr, 0)), BLUE, `${d.salaries.length} payment(s)`], ['Subscriptions paid', rs(d.subsPaid.reduce((s, x) => s + x.amount_pkr, 0)), BLUE, `${d.subsPaid.length} bill(s)`]],
      sales: [['New leads', String(d.newLeads.length), BLUE, pct(d.newLeads.length, d.prev.leads)], ['Contacted', String(d.contacted.length), BLUE, ''], ['Demos sent', String(d.demos.length), BLUE, ''],
        ['Calls logged', String(d.calls.length), BLUE, ''], ['Won', String(d.won.length), GREEN, d.lost.length ? `${d.lost.length} lost` : ''], ['Follow-ups open', String(d.fuOpen.length), RED, `${d.fuDone.length} done`]],
      marketing: [['Meta ads spend', rs(d.adsTotal), RED, `${d.ads.filter((a) => a.pkr > 0).length} active day(s)`], ['Earned from Meta clients', rs(d.metaEarned), GREEN, ''], ['Return', d.adsTotal ? (d.metaEarned / d.adsTotal).toFixed(1) + 'x' : '—', d.metaEarned >= d.adsTotal ? GREEN : RED, ''],
        ['New leads', String(d.newLeads.length), BLUE, d.newLeads.length ? `${d.newLeads.filter((l) => l.platform !== 'manual').length} via Messenger/Instagram` : ''], ['Cost per lead', d.newLeads.length && d.adsTotal ? rs(d.adsTotal / d.newLeads.length) : '—', BLUE, ''], ['Demos sent', String(d.demos.length), BLUE, '']],
      upwork: [['Earned on Upwork', rs(d.upEarned.pkr), GREEN, `${d.upEarned.n} payment(s)`], ['Spent on Upwork', rs(upSpentTotal), RED, 'Connects, fees'], ['Net', rs(d.upEarned.pkr - upSpentTotal), d.upEarned.pkr >= upSpentTotal ? GREEN : RED, ''],
        ['Proposals sent', String(d.props.length), BLUE, `${d.props.reduce((s, x) => s + x.connects, 0)} Connects`], ['Hired', String(d.props.filter((x) => x.status === 'hired').length), GREEN, d.props.length ? `${Math.round((d.props.filter((x) => x.status === 'hired').length / d.props.length) * 100)}% win rate` : ''], ['Ongoing projects', String(d.projOngoing.length), BLUE, '']],
      payoneer: [['Money in', usd(pk(['upwork', 'client', 'other_in'])), GREEN, ''], ['From Upwork', usd(pk(['upwork'])), BLUE, ''], ['From clients', usd(pk(['client', 'other_in'])), BLUE, ''],
        ['Withdrawn to bank', usd(pk(['withdrawal'])), RED, ''], ['Fees', usd(pk(['fee'])), RED, ''], ['Card spend', usd(pk(['card', 'other_out'])), RED, '']],
      projects: [['Ongoing', String(d.projOngoing.length), BLUE, ''], ['Completed this period', String(d.projDone.length), GREEN, ''], ['Received (ongoing)', rs(d.projOngoing.reduce((s, x) => s + x.received, 0)), BLUE, '']],
      team: [['Staff paid', rs(d.salaries.reduce((s, x) => s + x.amount_pkr, 0)), BLUE, `${d.salaries.length} payment(s)`], ['Subscriptions paid', rs(d.subsPaid.reduce((s, x) => s + x.amount_pkr, 0)), BLUE, ''], ['All expenses', rs(d.expenses), RED, pct(d.expenses, d.prev.exp)]],
      apps: [['Apps monitored', String(d.monitors.length), BLUE, ''], ['Up', String(d.monitors.filter((m) => m.last_status && m.last_status < 500).length), GREEN, ''], ['Down', String(d.monitors.filter((m) => m.last_checked && !(m.last_status && m.last_status < 500)).length), RED, '']],
    };
    const tiles = TILES[opts.tiles] || TILES.full;
    const tw = (W - 20) / 3;
    tiles.forEach(([l, v, c, note], i) => {
      const x = X + (i % 3) * (tw + 10), y = 104 + Math.floor(i / 3) * 62;
      doc.roundedRect(x, y, tw, 54, 6).lineWidth(1).stroke(LINE);
      doc.rect(x, y + 6, 3, 42).fill(c);
      doc.font('Helvetica').fontSize(9).fill(MUTED).text(l, x + 12, y + 8, { width: tw - 22 });
      doc.font('Helvetica-Bold').fontSize(15).fill(c).text(v, x + 12, y + 21, { width: tw - 22, lineBreak: false });
      if (note) doc.font('Helvetica').fontSize(8).fill(MUTED).text(note, x + 12, y + 40, { width: tw - 22, lineBreak: false });
    });
    doc.y = 104 + Math.ceil(tiles.length / 3) * 62 + 2; doc.x = X;

    if (has('highlights')) {
      // each highlight is tagged with the report types it belongs to
      const all = [];
      const add = (tags, text) => all.push({ tags, text });
      if (d.income || d.expenses) add(['full', 'finance', 'team'], `${d.profit >= 0 ? 'Profit' : 'Loss'} of ${rs(Math.abs(d.profit))} on ${rs(d.income)} income${d.prev.inc || d.prev.exp ? ` (previous period: ${rs(d.prev.inc - d.prev.exp)})` : ''}.`);
      if (d.topClient) add(['full', 'finance', 'sales'], `Top client: ${d.topClient[0]} with ${rs(d.topClient[1])}${d.income ? ` (${Math.round((d.topClient[1] / d.income) * 100)}% of income)` : ''}.`);
      if (d.byCat.length) add(['full', 'finance', 'team'], `Biggest cost: ${d.byCat[0].category} at ${rs(d.byCat[0].total)}${d.expenses ? ` (${Math.round((d.byCat[0].total / d.expenses) * 100)}% of spending)` : ''}.`);
      if (d.adsTotal) add(['full', 'marketing', 'finance'], `Meta ads: ${rs(d.adsTotal)} spent, ${rs(d.metaEarned)} earned from Meta clients — ${(d.metaEarned / d.adsTotal).toFixed(1)}x return.`);
      if (d.adsTotal && d.newLeads.length) add(['marketing'], `Each new lead cost about ${rs(d.adsTotal / d.newLeads.length)} in ads (${d.newLeads.length} lead${d.newLeads.length > 1 ? 's' : ''}${d.prev.leads ? `, ${d.prev.leads} in the previous period` : ''}).`);
      if (d.adsTotal) { const dd = d.ads.filter((a) => a.pkr > 0); const peak = dd.reduce((a, b) => (b.pkr > a.pkr ? b : a), dd[0]); add(['marketing'], `Spend ran on ${dd.length} day(s), averaging ${rs(d.adsTotal / dd.length)}; the highest day was ${fmtD(peak.date)} at ${rs(peak.pkr)}.`); }
      if (d.newLeads.length || d.demos.length || d.calls.length) add(['full', 'sales', 'marketing'], `${d.newLeads.length} new lead(s)${d.prev.leads ? ` (previous period: ${d.prev.leads})` : ''}, ${d.contacted.length} contacted, ${d.demos.length} demo(s) sent, ${d.calls.length} call(s), ${d.won.length} won.`);
      if (d.newLeads.length && !d.contacted.length) add(['sales'], `None of this period's new leads has been marked contacted yet.`);
      if (d.fuOpen.length) add(['full', 'sales'], `${d.fuOpen.length} follow-up(s) still open at the end of the period${d.fuDone.length ? `; ${d.fuDone.length} completed` : ''}.`);
      if (d.upEarned.pkr || upSpentTotal) add(['full', 'upwork'], `Upwork: earned ${rs(d.upEarned.pkr)}, spent ${rs(upSpentTotal)} on Connects and fees — net ${rs(d.upEarned.pkr - upSpentTotal)}.`);
      if (d.props.length) { const h = d.props.filter((x) => x.status === 'hired').length; add(['full', 'upwork'], `${d.props.length} proposal(s) sent using ${d.props.reduce((s, x) => s + x.connects, 0)} Connects; ${h} hired (${Math.round((h / d.props.length) * 100)}% win rate).`); }
      if (d.projOngoing.length) add(['upwork'], `${d.projOngoing.length} project(s) ongoing; ${d.projDone.length} completed in this period.`);
      if (d.pendingInc.n) add(['full', 'finance'], `Pending client payments (all time): ${rs(d.pendingInc.total)} across ${d.pendingInc.n} invoice(s).`);
      const hl = all.filter((h) => h.tags.includes(opts.tiles)).map((h) => h.text);
      if (hl.length) {
        section('Highlights');
        hl.forEach((t) => { ensure(16); doc.circle(X + 3, doc.y + 5, 1.8).fill(BLUE); doc.font('Helvetica').fontSize(10).fill(INK).text(t, X + 12, doc.y, { width: W - 12 }); doc.moveDown(0.25); });
      }
    }

    if (has('leads')) {
    section('Leads & sales');
    doc.font('Helvetica').fontSize(10).fill(INK).text(
      `New leads: ${d.newLeads.length}   ·   Contacted: ${d.contacted.length}   ·   Demos sent: ${d.demos.length}   ·   Calls: ${d.calls.length}   ·   Won: ${d.won.length}   ·   Lost: ${d.lost.length}`, X);
    doc.moveDown(0.4);
    if (d.newLeads.length) table([{ h: 'New lead', w: 0.3 }, { h: 'Source', w: 0.15 }, { h: 'Phone', w: 0.2 }, { h: 'Business', w: 0.35 }],
      d.newLeads.map((l) => [l.name || 'Unknown', l.platform, l.phone || '—', l.business || '—']));
    if (d.won.length) doc.font('Helvetica-Bold').fontSize(10).fill('#137a3a').text('Won: ' + d.won.map((x) => x.name).join(', '), X).moveDown(0.3);
    }

    if (has('demos')) {
    section('Demos sent');
    if (!d.demos.length) empty('No demos sent in this period.');
    table([{ h: 'Date', w: 0.18 }, { h: 'Lead', w: 0.25 }, { h: 'Demo', w: 0.3 }, { h: 'Note', w: 0.27 }],
      d.demos.map((x) => [fmtDT(x.sent_at), x.name || 'Unknown', x.demo_name, x.note || '']));
    }

    if (has('calls')) {
    section('Calls — what was discussed');
    if (!d.calls.length) empty('No calls logged in this period.');
    table([{ h: 'Date', w: 0.16 }, { h: 'Lead', w: 0.18 }, { h: 'Outcome', w: 0.13 }, { h: 'Discussed', w: 0.35 }, { h: 'Next step', w: 0.18 }],
      d.calls.map((c) => [fmtDT(c.call_at) + (c.duration_min ? `\n${c.duration_min} min` : ''), c.name || 'Unknown', c.outcome || '', c.summary, c.next_step || '']));
    }

    if (has('followups')) {
    section('Follow-ups');
    doc.font('Helvetica').fontSize(10).fill(INK).text(`Completed in period: ${d.fuDone.length}   ·   Still open (due by ${fmtD(d.range.end)}): ${d.fuOpen.length}`, X).moveDown(0.3);
    table([{ h: 'Due', w: 0.2 }, { h: 'Lead', w: 0.3 }, { h: 'What', w: 0.5 }], d.fuOpen.map((f) => [fmtD(new Date(f.due_at).toISOString()), f.name || 'Unknown', f.note || '']));
    }

    if (has('meta')) {
    section('Meta ads — spend vs earnings');
    const days = d.ads.filter((a) => a.pkr > 0).length;
    doc.font('Helvetica').fontSize(10).fill(INK).text(`Total ${rs(d.adsTotal)} over ${days} day(s)` + (days ? `   ·   average ${rs(d.adsTotal / days)}/day` : '') +
      (d.newLeads.length && d.adsTotal ? `   ·   cost per new lead ${rs(d.adsTotal / d.newLeads.length)}` : ''), X).moveDown(0.3);
    const metaRows = d.incomeRows.filter((x) => x.from_meta && x.status === 'received');
    doc.font('Helvetica-Bold').fontSize(10.5).fill(d.metaEarned >= d.adsTotal ? '#137a3a' : RED)
      .text(`Earned from Meta-ads customers: ${rs(d.metaEarned)}   ·   Spent: ${rs(d.adsTotal)}   ·   ` +
        (d.adsTotal ? `Return: ${(d.metaEarned / d.adsTotal).toFixed(1)}x (every Rs 1 spent brought Rs ${(d.metaEarned / d.adsTotal).toFixed(1)})` : 'no ad spend logged'), X).moveDown(0.3);
    table([{ h: 'Paid on', w: 0.25 }, { h: 'Client from Meta ads', w: 0.5 }, { h: 'PKR', w: 0.25, a: 'right' }], metaRows.map((x) => [fmtD(x.date), x.client, rs(x.amount_pkr)]));
    table([{ h: 'Date', w: 0.4 }, { h: 'USD', w: 0.3, a: 'right' }, { h: 'PKR', w: 0.3, a: 'right' }], d.ads.map((a) => [fmtD(a.date), a.usd ? '$' + a.usd.toFixed(2) : '—', rs(a.pkr)]));
    }

    if (has('projects')) {
    section('Projects');
    doc.font('Helvetica').fontSize(10).fill(INK).text(`Ongoing: ${d.projOngoing.length}   ·   Completed in this period: ${d.projDone.length}`, X).moveDown(0.3);
    table([{ h: 'Ongoing project', w: 0.3 }, { h: 'Client', w: 0.22 }, { h: 'Platform', w: 0.13 }, { h: 'Deadline', w: 0.15 }, { h: 'Received', w: 0.2, a: 'right' }],
      d.projOngoing.map((x) => [x.name, x.client || '', x.platform, x.deadline ? fmtD(x.deadline) : '—', rs(x.received) + (x.budget ? `\nof ${x.currency} ${x.budget.toLocaleString()}` : '')]));
    table([{ h: 'Completed', w: 0.3 }, { h: 'Client', w: 0.22 }, { h: 'On', w: 0.15 }, { h: 'Link', w: 0.18 }, { h: 'Earned', w: 0.15, a: 'right' }],
      d.projDone.map((x) => [x.name, x.client || '', fmtD(x.completed_date), x.live_url ? 'live' : '', rs(x.received)]));
    }

    if (has('upwork')) {
    section('Upwork');
    const upSpentTotal = d.upSpent.reduce((s, x) => s + x.pkr, 0);
    doc.font('Helvetica-Bold').fontSize(10.5).fill(d.upEarned.pkr >= upSpentTotal ? '#137a3a' : RED)
      .text(`Earned on Upwork: ${rs(d.upEarned.pkr)} (${d.upEarned.n} payment(s))   ·   Spent on Upwork: ${rs(upSpentTotal)}   ·   Net: ${rs(d.upEarned.pkr - upSpentTotal)}`, X).moveDown(0.3);
    table([{ h: 'Upwork spending', w: 0.6 }, { h: 'PKR', w: 0.4, a: 'right' }], d.upSpent.map((x) => [x.t, rs(x.pkr)]));
    const hired = d.props.filter((x) => x.status === 'hired').length, cn = d.props.reduce((s, x) => s + x.connects, 0);
    doc.font('Helvetica').fontSize(10).fill(INK).text(`Proposals sent: ${d.props.length}   ·   Connects used: ${cn}   ·   Hired: ${hired}` +
      (d.props.length ? `   ·   Win rate: ${Math.round((hired / d.props.length) * 100)}%` : ''), X).moveDown(0.3);
    table([{ h: 'Date', w: 0.15 }, { h: 'Job', w: 0.5 }, { h: 'Connects', w: 0.12, a: 'right' }, { h: 'Status', w: 0.23 }],
      d.props.map((x) => [fmtD(x.date), x.job_title, String(x.connects), x.status]));
    }

    if (has('payoneer')) {
    section('Payoneer');
    const pk = (ks) => d.pyn.filter((x) => ks.includes(x.kind)).reduce((s, x) => s + x.usd, 0);
    if (!d.pyn.length) empty('No Payoneer activity in this period.');
    else doc.font('Helvetica').fontSize(10).fill(INK).text(`Received: $${pk(['upwork', 'client', 'other_in']).toFixed(2)} (from Upwork $${pk(['upwork']).toFixed(2)}, from clients $${pk(['client', 'other_in']).toFixed(2)})   ·   Withdrawn to bank: $${pk(['withdrawal']).toFixed(2)}   ·   Fees: $${pk(['fee']).toFixed(2)}`, X).moveDown(0.3);
    }

    if (has('income')) {
    section('Income');
    if (!d.incomeRows.length) empty('No income recorded in this period.');
    table([{ h: 'Date', w: 0.14 }, { h: 'Client', w: 0.24 }, { h: 'Project / source', w: 0.26 }, { h: 'Amount', w: 0.14, a: 'right' }, { h: 'PKR', w: 0.13, a: 'right' }, { h: 'Status', w: 0.09 }],
      d.incomeRows.map((x) => [fmtD(x.date), x.client + (x.from_meta ? '  [Meta ads]' : ''), [x.project, x.source].filter(Boolean).join(' · '), `${x.currency} ${x.amount.toLocaleString()}`, rs(x.amount_pkr), x.status]));
    }

    if (has('expenses')) {
    section('Expenses by category');
    if (!d.byCat.length) empty('No expenses recorded in this period.');
    table([{ h: 'Category', w: 0.6 }, { h: 'Total (PKR)', w: 0.4, a: 'right' }], [...d.byCat.map((c) => [c.category, rs(c.total)]), ...(d.byCat.length ? [['TOTAL', rs(d.expenses)]] : [])]);
    if (d.period !== 'monthly' || d.expRows.length <= 60) {
      table([{ h: 'Date', w: 0.14 }, { h: 'Category', w: 0.2 }, { h: 'Paid to / details', w: 0.36 }, { h: 'Amount', w: 0.15, a: 'right' }, { h: 'PKR', w: 0.15, a: 'right' }],
        d.expRows.map((x) => [fmtD(x.date), x.category, [x.vendor, x.description].filter(Boolean).join(' — '), `${x.currency} ${x.amount.toLocaleString()}`, rs(x.amount_pkr)]));
    }
    }

    if (has('staff')) {
    section('Staff payments');
    if (!d.salaries.length) empty('No salary or commission paid in this period.');
    table([{ h: 'Date', w: 0.2 }, { h: 'Staff', w: 0.35 }, { h: 'Type', w: 0.2 }, { h: 'PKR', w: 0.25, a: 'right' }], d.salaries.map((s) => [fmtD(s.date), s.vendor, s.category, rs(s.amount_pkr)]));
    }

    if (has('subs')) {
    section('Subscriptions');
    table([{ h: 'Paid on', w: 0.25 }, { h: 'Service', w: 0.35 }, { h: 'Amount', w: 0.2, a: 'right' }, { h: 'PKR', w: 0.2, a: 'right' }], d.subsPaid.map((s) => [fmtD(s.date), s.vendor, `${s.currency} ${s.amount}`, rs(s.amount_pkr)]));
    if (d.subsUpcoming.length) {
      doc.font('Helvetica-Bold').fontSize(10).fill(INK).text('Coming up / overdue', X).moveDown(0.2);
      table([{ h: 'Due', w: 0.3 }, { h: 'Service', w: 0.45 }, { h: 'Amount', w: 0.25, a: 'right' }], d.subsUpcoming.map((s) => [fmtD(s.next_due), s.name, `${s.currency} ${s.amount}`]));
    } else if (!d.subsPaid.length) empty('Nothing paid or due.');
    }

    if (has('apps')) {
    section('Apps on Render — status now');
    if (!d.monitors.length) empty('No apps being monitored.');
    table([{ h: 'App', w: 0.3 }, { h: 'Status', w: 0.2 }, { h: 'Response', w: 0.15, a: 'right' }, { h: 'Last checked', w: 0.35 }],
      d.monitors.map((m) => [m.name, m.last_checked ? (m.last_status && m.last_status < 500 ? 'UP' : 'DOWN' + (m.down_since ? ' since ' + fmtDT(m.down_since) : '')) : 'not checked yet',
        m.last_ms ? (m.last_ms / 1000).toFixed(1) + 's' : '—', fmtDT(m.last_checked)]));
    }

    // footer on every page
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // writing in the margin must not create a new page
      doc.font('Helvetica').fontSize(8).fill(MUTED).text(`PokitBio · talha@pokitbio.com · page ${i + 1} of ${range.count}`, X, doc.page.height - 35, { width: W, align: 'center', lineBreak: false });
    }
  }
}
