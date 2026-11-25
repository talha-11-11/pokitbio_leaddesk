// Demos sent to leads, call log, Render / uptime monitor, PDF reports.
import PDFDocument from 'pdfkit';

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
  function rangeFor(period, dateStr) {
    const d = new Date((dateStr || todayLocal()) + 'T12:00:00Z');
    const ymd = (x) => x.toISOString().slice(0, 10);
    if (period === 'weekly') {
      const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      const start = new Date(d); start.setUTCDate(d.getUTCDate() - dow);
      const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
      return { start: ymd(start), end: ymd(end), label: `Week of ${fmtD(ymd(start))} – ${fmtD(ymd(end))}` };
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

  async function reportData(period, date) {
    const r = rangeFor(period, date);
    const p = [r.start, r.end];
    const loc = (c) => `(${c} AT TIME ZONE '${APP_TZ}')::date`;
    const inR = (c) => `${loc(c)} BETWEEN $1::date AND $2::date`;
    const [incomeRows, expRows, byCat, pendingInc, ads, newLeads, contacted, demos, calls, fuDone, fuOpen, won, lost, salaries, subsPaid, subsUpcoming, monitors] = await Promise.all([
      all(`SELECT date, client, project, source, amount::float, currency, amount_pkr::float, status FROM income WHERE date BETWEEN $1 AND $2 ORDER BY date`, p),
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
    const income = incomeRows.filter((x) => x.status === 'received').reduce((s, x) => s + x.amount_pkr, 0);
    const expenses = expRows.reduce((s, x) => s + x.amount_pkr, 0);
    const adsTotal = ads.reduce((s, x) => s + x.pkr, 0);
    return { period, range: r, income, expenses, profit: income - expenses, pendingInc, incomeRows, expRows, byCat, ads, adsTotal,
      newLeads, contacted, demos, calls, fuDone, fuOpen, won, lost, salaries, subsPaid, subsUpcoming, monitors };
  }

  app.get('/api/reports/data', wrap(async (req, res) => res.json(await reportData(req.query.period || 'daily', req.query.date))));

  app.get('/api/reports/pdf', wrap(async (req, res) => {
    const period = ['daily', 'weekly', 'monthly'].includes(req.query.period) ? req.query.period : 'daily';
    const d = await reportData(period, req.query.date);
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `PokitBio ${period} report — ${d.range.label}` } });
    res.type('application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="pokitbio-${period}-report-${d.range.start}.pdf"`);
    doc.pipe(res);
    drawReport(doc, d);
    doc.end();
  }));

  function drawReport(doc, d) {
    const RED = '#FF7878', BLUE = '#004AAD', INK = '#0f1d33', MUTED = '#5d6b82', LINE = '#e4e9f2';
    const W = doc.page.width - 80, X = 40;
    const bottom = () => doc.page.height - 50;
    const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
    const title = d.period[0].toUpperCase() + d.period.slice(1);

    // header band
    doc.rect(0, 0, doc.page.width, 80).fill(BLUE);
    doc.fill('#fff').font('Helvetica-Bold').fontSize(20).text('Pokit', X, 24, { continued: true }).fill(RED).text('Bio', { continued: true }).fill('#fff').text(`  ${title} Report`);
    doc.font('Helvetica').fontSize(11).fill('#dbe6ff').text(d.range.label + `   ·   generated ${fmtDT(new Date())}`, X, 52);
    doc.y = 100;

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

    // KPI tiles
    const tiles = [
      ['Income received', rs(d.income), BLUE], ['Expenses', rs(d.expenses), RED], [d.profit >= 0 ? 'Profit' : 'Loss', rs(d.profit), d.profit >= 0 ? '#137a3a' : RED],
      ['Meta ads spend', rs(d.adsTotal), RED], ['New leads', String(d.newLeads.length), BLUE], ['Demos sent', String(d.demos.length), BLUE],
    ];
    const tw = (W - 20) / 3;
    tiles.forEach(([l, v, c], i) => {
      const x = X + (i % 3) * (tw + 10), y = 100 + Math.floor(i / 3) * 58;
      doc.roundedRect(x, y, tw, 50, 6).lineWidth(1).stroke(LINE);
      doc.font('Helvetica').fontSize(9).fill(MUTED).text(l, x + 10, y + 9, { width: tw - 20 });
      doc.font('Helvetica-Bold').fontSize(15).fill(c).text(v, x + 10, y + 24, { width: tw - 20 });
    });
    doc.y = 100 + 2 * 58 + 4; doc.x = X;
    if (d.pendingInc.n) doc.font('Helvetica').fontSize(9.5).fill(MUTED).text(`Pending payments from clients (all time): ${rs(d.pendingInc.total)} across ${d.pendingInc.n} invoice(s).`, X);

    section('Leads & sales');
    doc.font('Helvetica').fontSize(10).fill(INK).text(
      `New leads: ${d.newLeads.length}   ·   Contacted: ${d.contacted.length}   ·   Demos sent: ${d.demos.length}   ·   Calls: ${d.calls.length}   ·   Won: ${d.won.length}   ·   Lost: ${d.lost.length}`, X);
    doc.moveDown(0.4);
    if (d.newLeads.length) table([{ h: 'New lead', w: 0.3 }, { h: 'Source', w: 0.15 }, { h: 'Phone', w: 0.2 }, { h: 'Business', w: 0.35 }],
      d.newLeads.map((l) => [l.name || 'Unknown', l.platform, l.phone || '—', l.business || '—']));
    if (d.won.length) doc.font('Helvetica-Bold').fontSize(10).fill('#137a3a').text('Won: ' + d.won.map((x) => x.name).join(', '), X).moveDown(0.3);

    section('Demos sent');
    if (!d.demos.length) empty('No demos sent in this period.');
    table([{ h: 'Date', w: 0.18 }, { h: 'Lead', w: 0.25 }, { h: 'Demo', w: 0.3 }, { h: 'Note', w: 0.27 }],
      d.demos.map((x) => [fmtDT(x.sent_at), x.name || 'Unknown', x.demo_name, x.note || '']));

    section('Calls — what was discussed');
    if (!d.calls.length) empty('No calls logged in this period.');
    table([{ h: 'Date', w: 0.16 }, { h: 'Lead', w: 0.18 }, { h: 'Outcome', w: 0.13 }, { h: 'Discussed', w: 0.35 }, { h: 'Next step', w: 0.18 }],
      d.calls.map((c) => [fmtDT(c.call_at) + (c.duration_min ? `\n${c.duration_min} min` : ''), c.name || 'Unknown', c.outcome || '', c.summary, c.next_step || '']));

    section('Follow-ups');
    doc.font('Helvetica').fontSize(10).fill(INK).text(`Completed in period: ${d.fuDone.length}   ·   Still open (due by ${fmtD(d.range.end)}): ${d.fuOpen.length}`, X).moveDown(0.3);
    table([{ h: 'Due', w: 0.2 }, { h: 'Lead', w: 0.3 }, { h: 'What', w: 0.5 }], d.fuOpen.map((f) => [fmtD(new Date(f.due_at).toISOString()), f.name || 'Unknown', f.note || '']));

    section('Meta ads');
    const days = d.ads.filter((a) => a.pkr > 0).length;
    doc.font('Helvetica').fontSize(10).fill(INK).text(`Total ${rs(d.adsTotal)} over ${days} day(s)` + (days ? `   ·   average ${rs(d.adsTotal / days)}/day` : '') +
      (d.newLeads.length && d.adsTotal ? `   ·   cost per new lead ${rs(d.adsTotal / d.newLeads.length)}` : ''), X).moveDown(0.3);
    table([{ h: 'Date', w: 0.4 }, { h: 'USD', w: 0.3, a: 'right' }, { h: 'PKR', w: 0.3, a: 'right' }], d.ads.map((a) => [fmtD(a.date), a.usd ? '$' + a.usd.toFixed(2) : '—', rs(a.pkr)]));

    section('Income');
    if (!d.incomeRows.length) empty('No income recorded in this period.');
    table([{ h: 'Date', w: 0.14 }, { h: 'Client', w: 0.24 }, { h: 'Project / source', w: 0.26 }, { h: 'Amount', w: 0.14, a: 'right' }, { h: 'PKR', w: 0.13, a: 'right' }, { h: 'Status', w: 0.09 }],
      d.incomeRows.map((x) => [fmtD(x.date), x.client, [x.project, x.source].filter(Boolean).join(' · '), `${x.currency} ${x.amount.toLocaleString()}`, rs(x.amount_pkr), x.status]));

    section('Expenses by category');
    if (!d.byCat.length) empty('No expenses recorded in this period.');
    table([{ h: 'Category', w: 0.6 }, { h: 'Total (PKR)', w: 0.4, a: 'right' }], [...d.byCat.map((c) => [c.category, rs(c.total)]), ...(d.byCat.length ? [['TOTAL', rs(d.expenses)]] : [])]);
    if (d.period !== 'monthly' || d.expRows.length <= 60) {
      table([{ h: 'Date', w: 0.14 }, { h: 'Category', w: 0.2 }, { h: 'Paid to / details', w: 0.36 }, { h: 'Amount', w: 0.15, a: 'right' }, { h: 'PKR', w: 0.15, a: 'right' }],
        d.expRows.map((x) => [fmtD(x.date), x.category, [x.vendor, x.description].filter(Boolean).join(' — '), `${x.currency} ${x.amount.toLocaleString()}`, rs(x.amount_pkr)]));
    }

    section('Staff payments');
    if (!d.salaries.length) empty('No salary or commission paid in this period.');
    table([{ h: 'Date', w: 0.2 }, { h: 'Staff', w: 0.35 }, { h: 'Type', w: 0.2 }, { h: 'PKR', w: 0.25, a: 'right' }], d.salaries.map((s) => [fmtD(s.date), s.vendor, s.category, rs(s.amount_pkr)]));

    section('Subscriptions');
    table([{ h: 'Paid on', w: 0.25 }, { h: 'Service', w: 0.35 }, { h: 'Amount', w: 0.2, a: 'right' }, { h: 'PKR', w: 0.2, a: 'right' }], d.subsPaid.map((s) => [fmtD(s.date), s.vendor, `${s.currency} ${s.amount}`, rs(s.amount_pkr)]));
    if (d.subsUpcoming.length) {
      doc.font('Helvetica-Bold').fontSize(10).fill(INK).text('Coming up / overdue', X).moveDown(0.2);
      table([{ h: 'Due', w: 0.3 }, { h: 'Service', w: 0.45 }, { h: 'Amount', w: 0.25, a: 'right' }], d.subsUpcoming.map((s) => [fmtD(s.next_due), s.name, `${s.currency} ${s.amount}`]));
    } else if (!d.subsPaid.length) empty('Nothing paid or due.');

    section('Apps on Render — status now');
    if (!d.monitors.length) empty('No apps being monitored.');
    table([{ h: 'App', w: 0.3 }, { h: 'Status', w: 0.2 }, { h: 'Response', w: 0.15, a: 'right' }, { h: 'Last checked', w: 0.35 }],
      d.monitors.map((m) => [m.name, m.last_checked ? (m.last_status && m.last_status < 500 ? 'UP' : 'DOWN' + (m.down_since ? ' since ' + fmtDT(m.down_since) : '')) : 'not checked yet',
        m.last_ms ? (m.last_ms / 1000).toFixed(1) + 's' : '—', fmtDT(m.last_checked)]));

    // footer on every page
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // writing in the margin must not create a new page
      doc.font('Helvetica').fontSize(8).fill(MUTED).text(`PokitBio · talha@pokitbio.com · page ${i + 1} of ${range.count}`, X, doc.page.height - 35, { width: W, align: 'center', lineBreak: false });
    }
  }
}
