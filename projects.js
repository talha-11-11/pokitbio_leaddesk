// Projects (ongoing / completed client work) and Upwork money tracking.
export const UPWORK_SPEND_TYPES = ['Connects', 'Freelancer Plus membership', 'Service fee', 'Withdrawal fee', 'Boosted proposals', 'Other'];

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const IMPORT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'upwork-import.json');

export async function setupProjects(app, pool, { APP_TZ = 'Asia/Karachi', payoneer = null } = {}) {
  const all = async (sql, p = []) => (await pool.query(sql, p)).rows;
  const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
  const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ });
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const getRates = async () => ({ PKR: 1, USD: 280, ...((await one(`SELECT value FROM settings WHERE key='rates'`))?.value || {}) });

  await pool.query(`
  CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, client TEXT,
    platform TEXT NOT NULL DEFAULT 'Upwork',          -- Upwork | Local | Direct (international) | Other
    contract_type TEXT NOT NULL DEFAULT 'fixed',      -- fixed | hourly | monthly
    status TEXT NOT NULL DEFAULT 'ongoing',           -- ongoing | paused | completed | cancelled
    budget NUMERIC(14,2), currency TEXT NOT NULL DEFAULT 'USD', hourly_rate NUMERIC(14,2),
    start_date DATE, deadline DATE, completed_date DATE,
    contract_url TEXT, live_url TEXT, repo_url TEXT, tech TEXT, description TEXT,
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    from_meta BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE income ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS subcategory TEXT;
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS qty INTEGER;
  CREATE INDEX IF NOT EXISTS idx_inc_project ON income(project_id);
  CREATE TABLE IF NOT EXISTS proposals (
    id SERIAL PRIMARY KEY, date DATE NOT NULL, job_title TEXT NOT NULL, job_url TEXT, client TEXT,
    connects INTEGER NOT NULL DEFAULT 0, boost INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'sent',              -- sent | viewed | interview | hired | declined | archived
    bid NUMERIC(14,2), bid_type TEXT, sent_by TEXT, notes TEXT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_prop_date ON proposals(date);
  ALTER TABLE projects ADD COLUMN IF NOT EXISTS ext_ref TEXT;
  ALTER TABLE income ADD COLUMN IF NOT EXISTS ext_ref TEXT;
  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS ext_ref TEXT;
  ALTER TABLE proposals ADD COLUMN IF NOT EXISTS ext_ref TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS ux_projects_ext ON projects(ext_ref);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_income_ext ON income(ext_ref);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_expenses_ext ON expenses(ext_ref);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_proposals_ext ON proposals(ext_ref);
  `);
  // old "N connects" descriptions → qty
  await pool.query(`UPDATE expenses SET qty = substring(description from '^([0-9]+) connects')::int
    WHERE category='Upwork' AND subcategory='Connects' AND qty IS NULL AND description ~ '^[0-9]+ connects'`);

  const isUpworkIncome = `(i.source ILIKE 'upwork%' OR p.platform = 'Upwork')`;

  // ---------------------------------------------------------------- projects
  const projectSelect = `
    SELECT p.*, p.budget::float, p.hourly_rate::float,
      COALESCE((SELECT SUM(amount_pkr) FROM income i WHERE i.project_id=p.id AND i.status='received'),0)::float AS received_pkr,
      COALESCE((SELECT SUM(amount) FROM income i WHERE i.project_id=p.id AND i.status='received' AND i.currency=p.currency),0)::float AS received_cur,
      COALESCE((SELECT SUM(amount_pkr) FROM income i WHERE i.project_id=p.id AND i.status='pending'),0)::float AS pending_pkr,
      COALESCE((SELECT SUM(amount_pkr) FROM expenses e WHERE e.project_id=p.id),0)::float AS costs_pkr,
      (SELECT COUNT(*)::int FROM income i WHERE i.project_id=p.id) AS payments,
      (SELECT MAX(date) FROM income i WHERE i.project_id=p.id AND i.status='received') AS last_payment
    FROM projects p`;
  app.get('/api/projects', wrap(async (req, res) => {
    const where = [], args = [];
    if (req.query.status && req.query.status !== 'all') { args.push(req.query.status); where.push(`p.status=$${args.length}`); }
    if (req.query.platform && req.query.platform !== 'all') { args.push(req.query.platform); where.push(`p.platform=$${args.length}`); }
    const rates = await getRates();
    const rows = await all(`${projectSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE p.status WHEN 'ongoing' THEN 0 WHEN 'paused' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END, p.deadline NULLS LAST, p.created_at DESC`, args);
    for (const r of rows) {
      r.budget_pkr = r.budget ? Math.round(r.budget * (rates[r.currency] || 1)) : null;
      r.remaining_pkr = r.budget_pkr != null ? Math.max(0, r.budget_pkr - r.received_pkr) : null;
    }
    res.json(rows);
  }));
  const P_FIELDS = ['name', 'client', 'platform', 'contract_type', 'status', 'budget', 'currency', 'hourly_rate', 'start_date', 'deadline', 'completed_date',
    'contract_url', 'live_url', 'repo_url', 'tech', 'description', 'lead_id', 'from_meta'];
  const pval = (k, v) => (['budget', 'hourly_rate', 'lead_id'].includes(k) ? num(v) : k === 'from_meta' ? v === true || v === 'true' : v === '' ? null : v);
  app.post('/api/projects', wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    const keys = P_FIELDS.filter((k) => k in b && b[k] !== '' && b[k] != null);
    const r = await one(`INSERT INTO projects (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, keys.map((k) => pval(k, b[k])));
    res.json(r);
  }));
  app.patch('/api/projects/:id', wrap(async (req, res) => {
    const b = { ...(req.body || {}) };
    if (b.status === 'completed' && !('completed_date' in b)) {
      const cur = await one(`SELECT completed_date FROM projects WHERE id=$1`, [+req.params.id]);
      if (!cur?.completed_date) b.completed_date = todayLocal();
    }
    const keys = P_FIELDS.filter((k) => k in b);
    if (!keys.length) return res.json({ ok: true });
    await pool.query(`UPDATE projects SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1}`, [...keys.map((k) => pval(k, b[k])), +req.params.id]);
    res.json({ ok: true });
  }));
  app.delete('/api/projects/:id', wrap(async (req, res) => { await pool.query(`DELETE FROM projects WHERE id=$1`, [+req.params.id]); res.json({ ok: true }); }));

  // payment on a project → income (+ Upwork fee as an expense, so you see gross, fee and net)
  app.post('/api/projects/:id/payment', wrap(async (req, res) => {
    const p = await one(`SELECT * FROM projects WHERE id=$1`, [+req.params.id]);
    if (!p) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const amount = num(b.amount);
    if (!(amount > 0)) return res.status(400).json({ error: 'amount required' });
    const currency = b.currency || p.currency;
    const rates = await getRates();
    const rate = currency === 'PKR' ? 1 : num(b.rate) || rates[currency] || 1;
    const date = b.date || todayLocal();
    const status = b.status === 'pending' ? 'pending' : 'received';
    const inc = await one(`INSERT INTO income (date, client, project, description, amount, currency, rate, amount_pkr, method, status, source, lead_id, from_meta, project_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [date, p.client || p.name, p.name, b.description || (b.milestone ? `Milestone: ${b.milestone}` : null), amount, currency, rate, Math.round(amount * rate * 100) / 100,
       b.method || (p.platform === 'Upwork' ? 'Upwork' : null), status, p.platform === 'Upwork' ? 'Upwork' : p.platform === 'Local' ? 'Local client' : p.platform,
       p.lead_id, p.from_meta, p.id]);
    const feePct = num(b.fee_percent);
    if (status === 'received' && feePct > 0) {
      const fee = Math.round(amount * feePct) / 100;
      await pool.query(`INSERT INTO expenses (date, category, subcategory, vendor, description, amount, currency, rate, amount_pkr, project_id)
        VALUES ($1,'Upwork','Service fee','Upwork',$2,$3,$4,$5,$6,$7)`,
        [date, `${feePct}% fee — ${p.name}`, fee, currency, rate, Math.round(fee * rate * 100) / 100, p.id]);
    }
    res.json({ id: inc.id });
  }));

  // finished project → demo list (+ uptime monitor)
  app.post('/api/projects/:id/to-demo', wrap(async (req, res) => {
    const p = await one(`SELECT * FROM projects WHERE id=$1`, [+req.params.id]);
    if (!p) return res.status(404).json({ error: 'not found' });
    const name = req.body?.name || p.name, link = req.body?.link || p.live_url;
    const exists = await one(`SELECT id FROM demo_catalog WHERE name=$1 OR (link IS NOT NULL AND link=$2)`, [name, link]);
    if (!exists) await pool.query(`INSERT INTO demo_catalog(name, link) VALUES ($1,$2)`, [name, link || null]);
    if (link && /^https?:\/\//.test(link)) await pool.query(`INSERT INTO monitors(name, url, kind) VALUES ($1,$2,'client') ON CONFLICT (url) DO NOTHING`, [name, link]);
    res.json({ ok: true, added: !exists });
  }));

  // ---------------------------------------------------------------- Upwork import (from Claude's Upwork connector export)
  // Safe to run any number of times: every row carries its Upwork record id (ext_ref), so nothing is duplicated.
  async function importUpwork(d) {
    const rate = (await getRates()).USD || 280;
    const pkr = (usd) => Math.round(usd * rate * 100) / 100;
    const counts = { projects: 0, income: 0, fees: 0, connects: 0, proposals: 0 };
    const projectIds = {}, contracts = {};
    for (const c of d.contracts || []) {
      contracts[c.id] = c;
      const status = c.status === 'ACTIVE' ? 'ongoing' : c.status === 'PAUSED' ? 'paused' : 'completed';
      const r = await one(`INSERT INTO projects (ext_ref, name, client, platform, contract_type, status, currency, hourly_rate, start_date, completed_date, contract_url)
        VALUES ($1,$2,$3,'Upwork',$4,$5,'USD',$6,$7,$8,$9)
        ON CONFLICT (ext_ref) DO UPDATE SET status=EXCLUDED.status, completed_date=EXCLUDED.completed_date
        RETURNING id, (xmax = 0) AS inserted`,
        [`upwork:contract:${c.id}`, c.title, c.client, c.type || 'fixed', status, c.rate || null, c.start, status === 'completed' ? c.end || c.start : null,
         'https://www.upwork.com/freelancers/contracts']);
      projectIds[c.id] = r.id; if (r.inserted) counts.projects++;
    }
    for (const i of d.income || []) {
      const c = contracts[i.contract] || {};
      const r = await one(`INSERT INTO income (ext_ref, date, client, project, description, amount, currency, rate, amount_pkr, method, status, source, project_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,'Upwork','received','Upwork',$9,$2::date) ON CONFLICT (ext_ref) DO NOTHING RETURNING id`,
        [`upwork:tx:${i.ref}`, i.date, c.client || 'Upwork client', c.title || null, i.description, i.amount, rate, pkr(i.amount), projectIds[i.contract] || null]);
      if (r) counts.income++;
    }
    for (const f of d.fees || []) {
      const c = contracts[f.contract] || {};
      const r = await one(`INSERT INTO expenses (ext_ref, date, category, subcategory, vendor, description, amount, currency, rate, amount_pkr, project_id, created_at)
        VALUES ($1,$2,'Upwork',$3,'Upwork',$4,$5,'USD',$6,$7,$8,$2::date) ON CONFLICT (ext_ref) DO NOTHING RETURNING id`,
        [`upwork:tx:${f.ref}`, f.date, f.type, f.description + (c.title ? ` — ${c.title}` : ''), f.amount, rate, pkr(f.amount), projectIds[f.contract] || null]);
      if (r) counts.fees++;
    }
    for (const c of d.connects_purchases || []) {
      const r = await one(`INSERT INTO expenses (ext_ref, date, category, subcategory, vendor, description, amount, currency, rate, amount_pkr, qty, created_at)
        VALUES ($1,$2,'Upwork','Connects','Upwork',$3,$4,'USD',$5,$6,$7,$2::date) ON CONFLICT (ext_ref) DO NOTHING RETURNING id`,
        [`upwork:tx:${c.ref}`, c.date, `${c.qty} connects`, c.amount, rate, pkr(c.amount), c.qty]);
      if (r) counts.connects++;
    }
    // Upwork → Payoneer withdrawals: money arriving in Payoneer (a transfer, not new income)
    for (const w of d.withdrawals || []) {
      if (w.to !== 'Payoneer' || !payoneer) continue;
      const r = await payoneer.addTx({ date: w.date, kind: 'upwork', counterparty: 'Upwork', description: `Withdrawal from Upwork ($${w.amount.toFixed(2)})`,
        amount: w.amount, currency: 'USD', ext_ref: `upwork:tx:${w.ref}`, historic: true });
      if (r) counts.payoneer = (counts.payoneer || 0) + 1;
    }
    const stMap = { Accepted: null, Hired: 'hired', Offered: 'interview', Declined: 'declined', Withdrawn: 'archived', Archived: 'archived' };
    for (const p of d.proposals || []) {
      const status = stMap[p.status] || (p.viewed ? 'viewed' : 'sent');
      const linked = Object.values(contracts).find((c) => c.title === p.title);
      const r = await one(`INSERT INTO proposals (ext_ref, date, job_title, job_url, connects, boost, status, bid, sent_by, notes, project_id, created_at)
        VALUES ($1,$2,$3,$4,0,$5,$6,$7,'Me',$8,$9,$2::date)
        ON CONFLICT (ext_ref) DO UPDATE SET status=EXCLUDED.status RETURNING (xmax = 0) AS inserted`,
        [`upwork:proposal:${p.id}`, p.date, p.title, p.url, p.connects_bid || 0, status, p.bid || null,
         `Imported from Upwork${p.boosted ? ' (boosted)' : ''}${p.viewed ? ' · viewed by client' : ''}`, linked ? projectIds[linked.id] : null]);
      if (r.inserted) counts.proposals++;
    }
    // Connects balance: take Upwork's number as the new starting point (only if this export is newer)
    const last = (await one(`SELECT value FROM settings WHERE key='upwork_import'`))?.value;
    if (d.connects_balance != null && (!last || !last.fetched_at || d.fetched_at > last.fetched_at)) {
      await pool.query(`INSERT INTO settings(key,value) VALUES('connects',$1) ON CONFLICT(key) DO UPDATE SET value=$1`,
        [JSON.stringify({ balance: d.connects_balance, at: new Date().toISOString() })]);
    }
    const info = { fetched_at: d.fetched_at, imported_at: new Date().toISOString(), counts };
    await pool.query(`INSERT INTO settings(key,value) VALUES('upwork_import',$1) ON CONFLICT(key) DO UPDATE SET value=$1`, [JSON.stringify(info)]);
    return info;
  }
  app.post('/api/upwork/import', wrap(async (req, res) => {
    if (!req.body || !Array.isArray(req.body.contracts)) return res.status(400).json({ error: 'Not an Upwork export file' });
    res.json(await importUpwork(req.body));
  }));
  app.get('/api/upwork/import', wrap(async (_req, res) => res.json((await one(`SELECT value FROM settings WHERE key='upwork_import'`))?.value || null)));
  // auto-import the file that ships in the repo (data/upwork-import.json)
  if (fs.existsSync(IMPORT_FILE)) {
    try {
      const d = JSON.parse(fs.readFileSync(IMPORT_FILE, 'utf8'));
      const last = (await one(`SELECT value FROM settings WHERE key='upwork_import'`))?.value;
      if (!last || d.fetched_at > last.fetched_at) {
        const r = await importUpwork(d);
        console.log('Upwork data imported:', JSON.stringify(r.counts));
      }
    } catch (e) { console.warn('Upwork import failed:', e.message); }
  }

  // ---------------------------------------------------------------- Connects balance
  // Upwork has no public API for the balance, so: you set it, purchases add, proposals subtract.
  async function connectsState() {
    const base = (await one(`SELECT value FROM settings WHERE key='connects'`))?.value || { balance: 0, at: '1970-01-01T00:00:00Z' };
    const bought = (await one(`SELECT COALESCE(SUM(qty),0)::int n FROM expenses WHERE category='Upwork' AND subcategory='Connects' AND created_at > $1`, [base.at])).n;
    const used = (await one(`SELECT COALESCE(SUM(connects + boost),0)::int n FROM proposals WHERE created_at > $1`, [base.at])).n;
    return { balance: base.balance + bought - used, setBalance: base.balance, setAt: base.at, boughtSince: bought, usedSince: used, isSet: base.at !== '1970-01-01T00:00:00Z' };
  }
  app.get('/api/upwork/connects', wrap(async (_req, res) => res.json(await connectsState())));
  app.put('/api/upwork/connects', wrap(async (req, res) => {
    const n = parseInt(req.body?.balance, 10);
    if (!(n >= 0)) return res.status(400).json({ error: 'balance required' });
    await pool.query(`INSERT INTO settings(key,value) VALUES('connects',$1) ON CONFLICT(key) DO UPDATE SET value=$1`, [JSON.stringify({ balance: n, at: new Date().toISOString() })]);
    res.json(await connectsState());
  }));

  // ---------------------------------------------------------------- Proposals
  app.get('/api/proposals', wrap(async (req, res) => {
    const where = [], args = [];
    if (req.query.month) { args.push(`${req.query.month}-01`); where.push(`date >= $${args.length}::date AND date < ($${args.length}::date + interval '1 month')`); }
    if (req.query.status && req.query.status !== 'all') { args.push(req.query.status); where.push(`status=$${args.length}`); }
    res.json(await all(`SELECT *, bid::float FROM proposals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, id DESC LIMIT 500`, args));
  }));
  const PR_FIELDS = ['date', 'job_title', 'job_url', 'client', 'connects', 'boost', 'status', 'bid', 'bid_type', 'sent_by', 'notes', 'project_id'];
  const prval = (k, v) => (['connects', 'boost'].includes(k) ? parseInt(v, 10) || 0 : ['bid', 'project_id'].includes(k) ? num(v) : v === '' ? null : v);
  app.post('/api/proposals', wrap(async (req, res) => {
    const b = { date: todayLocal(), ...(req.body || {}) };
    if (!b.job_title) return res.status(400).json({ error: 'job title required' });
    const keys = PR_FIELDS.filter((k) => k in b && b[k] !== '' && b[k] != null);
    const r = await one(`INSERT INTO proposals (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, keys.map((k) => prval(k, b[k])));
    res.json({ ...r, connects: await connectsState() });
  }));
  app.patch('/api/proposals/:id', wrap(async (req, res) => {
    const b = req.body || {};
    const keys = PR_FIELDS.filter((k) => k in b);
    if (keys.length) await pool.query(`UPDATE proposals SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1}`, [...keys.map((k) => prval(k, b[k])), +req.params.id]);
    res.json({ ok: true });
  }));
  app.delete('/api/proposals/:id', wrap(async (req, res) => { await pool.query(`DELETE FROM proposals WHERE id=$1`, [+req.params.id]); res.json({ ok: true }); }));
  // hired proposal → create the project in one go
  app.post('/api/proposals/:id/to-project', wrap(async (req, res) => {
    const pr = await one(`SELECT * FROM proposals WHERE id=$1`, [+req.params.id]);
    if (!pr) return res.status(404).json({ error: 'not found' });
    const p = await one(`INSERT INTO projects (name, client, platform, contract_type, budget, currency, start_date, contract_url, description)
      VALUES ($1,$2,'Upwork',$3,$4,'USD',$5,$6,$7) RETURNING id`,
      [pr.job_title, pr.client, pr.bid_type === 'hourly' ? 'hourly' : 'fixed', pr.bid, todayLocal(), pr.job_url, pr.notes]);
    await pool.query(`UPDATE proposals SET status='hired', project_id=$1 WHERE id=$2`, [p.id, pr.id]);
    res.json({ id: p.id });
  }));

  // ---------------------------------------------------------------- Upwork
  app.get('/api/upwork/summary', wrap(async (req, res) => {
    const month = req.query.month || todayLocal().slice(0, 7);
    const start = `${month}-01`;
    const end = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString().slice(0, 10);
    const yearStart = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 12, 1)).toISOString().slice(0, 10);
    const earnedQ = (extra, args) => one(`SELECT COALESCE(SUM(i.amount_pkr),0)::float pkr,
        COALESCE(SUM(CASE WHEN i.currency='USD' THEN i.amount ELSE 0 END),0)::float usd, COUNT(*)::int n
      FROM income i LEFT JOIN projects p ON p.id=i.project_id WHERE ${isUpworkIncome} AND i.status='received' ${extra}`, args);
    const spentQ = (extra, args) => one(`SELECT COALESCE(SUM(amount_pkr),0)::float pkr, COALESCE(SUM(CASE WHEN currency='USD' THEN amount ELSE 0 END),0)::float usd
      FROM expenses WHERE category='Upwork' ${extra}`, args);
    const [earned, spent, earnedAll, spentAll, byType, byTypeAll, pending] = await Promise.all([
      earnedQ(`AND i.date >= $1 AND i.date < $2`, [start, end]), spentQ(`AND date >= $1 AND date < $2`, [start, end]),
      earnedQ('', []), spentQ('', []),
      all(`SELECT COALESCE(subcategory,'Other') t, SUM(amount_pkr)::float pkr, SUM(CASE WHEN currency='USD' THEN amount ELSE 0 END)::float usd, COUNT(*)::int n
           FROM expenses WHERE category='Upwork' AND date >= $1 AND date < $2 GROUP BY 1 ORDER BY 2 DESC`, [start, end]),
      all(`SELECT COALESCE(subcategory,'Other') t, SUM(amount_pkr)::float pkr FROM expenses WHERE category='Upwork' GROUP BY 1 ORDER BY 2 DESC`),
      one(`SELECT COALESCE(SUM(i.amount_pkr),0)::float pkr, COUNT(*)::int n FROM income i LEFT JOIN projects p ON p.id=i.project_id WHERE ${isUpworkIncome} AND i.status='pending'`),
    ]);
    const mi = await all(`SELECT to_char(i.date,'YYYY-MM') m, SUM(i.amount_pkr)::float v FROM income i LEFT JOIN projects p ON p.id=i.project_id
      WHERE ${isUpworkIncome} AND i.status='received' AND i.date >= $1 AND i.date < $2 GROUP BY 1`, [yearStart, end]);
    const ms = await all(`SELECT to_char(date,'YYYY-MM') m, SUM(amount_pkr)::float v FROM expenses WHERE category='Upwork' AND date >= $1 AND date < $2 GROUP BY 1`, [yearStart, end]);
    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(+yearStart.slice(0, 4), +yearStart.slice(5, 7) - 1 + i, 1)).toISOString().slice(0, 7);
      const e = mi.find((r) => r.m === d)?.v || 0, s = ms.find((r) => r.m === d)?.v || 0;
      months.push({ month: d, earned: e, spent: s, net: e - s });
    }
    const connects = await one(`SELECT COALESCE(SUM(qty),0)::int n FROM expenses WHERE category='Upwork' AND subcategory='Connects' AND date >= $1 AND date < $2`, [start, end]);
    const prop = await one(`SELECT COUNT(*)::int sent, COALESCE(SUM(connects+boost),0)::int connects,
        COUNT(*) FILTER (WHERE status IN ('viewed','interview','hired'))::int viewed,
        COUNT(*) FILTER (WHERE status IN ('interview','hired'))::int interviews,
        COUNT(*) FILTER (WHERE status='hired')::int hired
      FROM proposals WHERE date >= $1 AND date < $2`, [start, end]);
    const propAll = await one(`SELECT COUNT(*)::int sent, COUNT(*) FILTER (WHERE status='hired')::int hired FROM proposals`);
    const recentProposals = await all(`SELECT *, bid::float FROM proposals ORDER BY date DESC, id DESC LIMIT 15`);
    const connectsNow = await connectsState();
    const clients = await all(`SELECT i.client, SUM(i.amount_pkr)::float total FROM income i LEFT JOIN projects p ON p.id=i.project_id
      WHERE ${isUpworkIncome} AND i.status='received' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`);
    const projects = await all(`${projectSelect} WHERE p.platform='Upwork' AND p.status IN ('ongoing','paused') ORDER BY p.deadline NULLS LAST`);
    const recent = await all(`SELECT i.date, i.client, i.project, i.amount::float, i.currency, i.amount_pkr::float, i.status FROM income i LEFT JOIN projects p ON p.id=i.project_id
      WHERE ${isUpworkIncome} ORDER BY i.date DESC, i.id DESC LIMIT 10`);
    const recentSpend = await all(`SELECT id, date, subcategory, description, amount::float, currency, amount_pkr::float FROM expenses WHERE category='Upwork' ORDER BY date DESC, id DESC LIMIT 10`);
    res.json({
      month, earned, spent, net: earned.pkr - spent.pkr, roi: spent.pkr ? earned.pkr / spent.pkr : null,
      allTime: { earned: earnedAll, spent: spentAll, net: earnedAll.pkr - spentAll.pkr, roi: spentAll.pkr ? earnedAll.pkr / spentAll.pkr : null },
      byType, byTypeAll, pending, months, connectsBought: connects.n, clients, projects, recent, recentSpend,
      connects: connectsNow, proposals: { ...prop, winRate: prop.sent ? prop.hired / prop.sent : null,
        costPerProposal: prop.sent ? spent.pkr / prop.sent : null, allSent: propAll.sent, allHired: propAll.hired }, recentProposals,
    });
  }));
}
