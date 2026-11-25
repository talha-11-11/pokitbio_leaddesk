// PokitBio business modules: staff, expenses, subscriptions, income, accounts.
// All amounts are stored in their original currency AND converted to PKR at the rate on that day.

export const EXPENSE_CATEGORIES = [
  'Meta Ads', 'Marketing', 'Salaries', 'Software & AI tools', 'Hosting & Domains', 'Email',
  'Office & Utilities', 'Equipment', 'Travel', 'Commission', 'Taxes & Fees', 'Other',
];
export const CURRENCIES = ['PKR', 'USD', 'EUR', 'GBP', 'AUD', 'AED'];
const DEFAULT_RATES = { PKR: 1, USD: 280, EUR: 300, GBP: 355, AUD: 182, AED: 76 };

export async function setupFinance(app, pool, { APP_TZ = 'Asia/Karachi' } = {}) {
  const all = async (sql, p = []) => (await pool.query(sql, p)).rows;
  const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
  const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ });
  const monthLocal = () => todayLocal().slice(0, 7);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
  CREATE TABLE IF NOT EXISTS staff (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, role TEXT, phone TEXT, email TEXT,
    join_date DATE, monthly_salary NUMERIC(14,2) NOT NULL DEFAULT 0, salary_currency TEXT NOT NULL DEFAULT 'PKR',
    pay_type TEXT NOT NULL DEFAULT 'salary',          -- salary | commission | freelance
    status TEXT NOT NULL DEFAULT 'active',            -- active | left
    notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Software & AI tools', vendor TEXT,
    amount NUMERIC(14,2) NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
    cycle TEXT NOT NULL DEFAULT 'monthly',            -- monthly | yearly
    next_due DATE, active BOOLEAN NOT NULL DEFAULT true, notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY, date DATE NOT NULL, category TEXT NOT NULL, vendor TEXT, description TEXT,
    amount NUMERIC(14,2) NOT NULL, currency TEXT NOT NULL DEFAULT 'PKR', rate NUMERIC(14,4) NOT NULL DEFAULT 1,
    amount_pkr NUMERIC(16,2) NOT NULL, method TEXT,
    staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
    subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
    salary_month TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS income (
    id SERIAL PRIMARY KEY, date DATE NOT NULL, client TEXT NOT NULL, project TEXT, description TEXT,
    amount NUMERIC(14,2) NOT NULL, currency TEXT NOT NULL DEFAULT 'PKR', rate NUMERIC(14,4) NOT NULL DEFAULT 1,
    amount_pkr NUMERIC(16,2) NOT NULL, method TEXT,
    status TEXT NOT NULL DEFAULT 'received',          -- received | pending
    source TEXT,                                      -- Upwork, Local client, Website, Referral…
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE income ADD COLUMN IF NOT EXISTS from_meta BOOLEAN NOT NULL DEFAULT false;
  CREATE INDEX IF NOT EXISTS idx_exp_date ON expenses(date);
  CREATE INDEX IF NOT EXISTS idx_inc_date ON income(date);
  INSERT INTO settings(key, value) VALUES ('rates', '${JSON.stringify(DEFAULT_RATES)}') ON CONFLICT (key) DO NOTHING;
  `);

  const getRates = async () => ({ ...DEFAULT_RATES, ...((await one(`SELECT value FROM settings WHERE key='rates'`))?.value || {}) });
  const num = (v) => (v === '' || v == null ? null : Number(v));
  async function money(b) {
    const amount = num(b.amount);
    if (!(amount >= 0)) throw Object.assign(new Error('amount required'), { status: 400 });
    const currency = CURRENCIES.includes(b.currency) ? b.currency : 'PKR';
    const rate = currency === 'PKR' ? 1 : num(b.rate) || (await getRates())[currency] || 1;
    return { amount, currency, rate, amount_pkr: Math.round(amount * rate * 100) / 100 };
  }
  const addMonths = (dateStr, n) => {
    const d = new Date(dateStr + 'T12:00:00Z');
    const day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString().slice(0, 10);
  };
  const monthRange = (m) => [`${m}-01`, addMonths(`${m}-01`, 1)];
  // pg returns DATE as JS Date at local midnight; send plain YYYY-MM-DD strings instead
  const fixDates = (rows, keys = ['date', 'join_date', 'next_due']) =>
    rows.map((r) => { for (const k of keys) if (r[k] instanceof Date) r[k] = toYMD(r[k]); return r; });
  const toYMD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // ---------------------------------------------------------------- settings
  app.get('/api/finance/config', wrap(async (_req, res) => {
    res.json({ categories: EXPENSE_CATEGORIES, currencies: CURRENCIES, rates: await getRates(), today: todayLocal(), month: monthLocal() });
  }));
  app.put('/api/finance/rates', wrap(async (req, res) => {
    const rates = { ...(await getRates()) };
    for (const c of CURRENCIES) if (c !== 'PKR' && num(req.body?.[c]) > 0) rates[c] = num(req.body[c]);
    await pool.query(`INSERT INTO settings(key,value) VALUES('rates',$1) ON CONFLICT(key) DO UPDATE SET value=$1`, [JSON.stringify(rates)]);
    res.json(rates);
  }));

  // ---------------------------------------------------------------- staff
  app.get('/api/staff', wrap(async (req, res) => {
    const m = req.query.month || monthLocal();
    const rows = await all(`
      SELECT s.*,
        COALESCE((SELECT SUM(amount_pkr) FROM expenses e WHERE e.staff_id=s.id AND e.salary_month=$1),0)::float AS paid_this_month,
        COALESCE((SELECT SUM(amount_pkr) FROM expenses e WHERE e.staff_id=s.id),0)::float AS paid_total,
        (SELECT MAX(date) FROM expenses e WHERE e.staff_id=s.id) AS last_paid
      FROM staff s ORDER BY (s.status='active') DESC, s.name`, [m]);
    res.json(fixDates(rows, ['join_date', 'last_paid']));
  }));
  const STAFF_FIELDS = ['name', 'role', 'phone', 'email', 'join_date', 'monthly_salary', 'salary_currency', 'pay_type', 'status', 'notes'];
  app.post('/api/staff', wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    const vals = STAFF_FIELDS.map((k) => (b[k] === '' ? null : b[k] ?? null));
    vals[STAFF_FIELDS.indexOf('monthly_salary')] = num(b.monthly_salary) || 0;
    vals[STAFF_FIELDS.indexOf('salary_currency')] = b.salary_currency || 'PKR';
    vals[STAFF_FIELDS.indexOf('pay_type')] = b.pay_type || 'salary';
    vals[STAFF_FIELDS.indexOf('status')] = b.status || 'active';
    const r = await one(`INSERT INTO staff (${STAFF_FIELDS.join(',')}) VALUES (${STAFF_FIELDS.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, vals);
    res.json(r);
  }));
  app.patch('/api/staff/:id', wrap(async (req, res) => {
    const b = req.body || {};
    const keys = STAFF_FIELDS.filter((k) => k in b);
    if (!keys.length) return res.json({ ok: true });
    await pool.query(`UPDATE staff SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1}`,
      [...keys.map((k) => (k === 'monthly_salary' ? num(b[k]) || 0 : b[k] === '' ? null : b[k])), +req.params.id]);
    res.json({ ok: true });
  }));
  app.delete('/api/staff/:id', wrap(async (req, res) => { await pool.query(`DELETE FROM staff WHERE id=$1`, [+req.params.id]); res.json({ ok: true }); }));
  app.post('/api/staff/:id/pay', wrap(async (req, res) => {
    const s = await one(`SELECT * FROM staff WHERE id=$1`, [+req.params.id]);
    if (!s) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const month = b.month || monthLocal();
    const m = await money({ amount: b.amount ?? s.monthly_salary, currency: b.currency || s.salary_currency, rate: b.rate });
    const label = new Date(month + '-15').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    const kind = s.pay_type === 'commission' ? 'Commission' : 'Salaries';
    const r = await one(`INSERT INTO expenses (date, category, vendor, description, amount, currency, rate, amount_pkr, method, staff_id, salary_month)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [b.date || todayLocal(), kind, s.name, b.description || `${kind === 'Commission' ? 'Commission' : 'Salary'} — ${label}`,
       m.amount, m.currency, m.rate, m.amount_pkr, b.method || null, s.id, month]);
    res.json(r);
  }));

  // ---------------------------------------------------------------- expenses
  app.get('/api/expenses', wrap(async (req, res) => {
    const where = [], args = [];
    if (req.query.month) { const [a, b] = monthRange(req.query.month); args.push(a, b); where.push(`e.date >= $${args.length - 1} AND e.date < $${args.length}`); }
    if (req.query.category && req.query.category !== 'all') { args.push(req.query.category); where.push(`e.category=$${args.length}`); }
    if (req.query.q) { args.push(`%${req.query.q}%`); where.push(`(e.vendor ILIKE $${args.length} OR e.description ILIKE $${args.length})`); }
    const rows = await all(`SELECT e.*, e.amount::float, e.amount_pkr::float, e.rate::float FROM expenses e
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.date DESC, e.id DESC LIMIT 2000`, args);
    res.json(fixDates(rows));
  }));
  const EXP_FIELDS = ['date', 'category', 'vendor', 'description', 'method'];
  app.post('/api/expenses', wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.category) return res.status(400).json({ error: 'category required' });
    const m = await money(b);
    const r = await one(`INSERT INTO expenses (date, category, vendor, description, method, amount, currency, rate, amount_pkr)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [b.date || todayLocal(), b.category, b.vendor || null, b.description || null, b.method || null, m.amount, m.currency, m.rate, m.amount_pkr]);
    res.json(r);
  }));
  app.patch('/api/expenses/:id', wrap(async (req, res) => {
    const b = req.body || {};
    const cur = await one(`SELECT * FROM expenses WHERE id=$1`, [+req.params.id]);
    if (!cur) return res.status(404).json({ error: 'not found' });
    const m = await money({ amount: b.amount ?? cur.amount, currency: b.currency ?? cur.currency, rate: b.rate ?? (b.currency && b.currency !== cur.currency ? null : cur.rate) });
    const keys = EXP_FIELDS.filter((k) => k in b);
    await pool.query(`UPDATE expenses SET ${[...keys.map((k, i) => `${k}=$${i + 1}`), `amount=$${keys.length + 1}`, `currency=$${keys.length + 2}`, `rate=$${keys.length + 3}`, `amount_pkr=$${keys.length + 4}`].join(',')} WHERE id=$${keys.length + 5}`,
      [...keys.map((k) => (b[k] === '' ? null : b[k])), m.amount, m.currency, m.rate, m.amount_pkr, cur.id]);
    res.json({ ok: true });
  }));
  app.delete('/api/expenses/:id', wrap(async (req, res) => { await pool.query(`DELETE FROM expenses WHERE id=$1`, [+req.params.id]); res.json({ ok: true }); }));

  // ---------------------------------------------------------------- subscriptions
  app.get('/api/subscriptions', wrap(async (_req, res) => {
    const rates = await getRates();
    const rows = fixDates(await all(`SELECT s.*, s.amount::float,
      (SELECT MAX(date) FROM expenses e WHERE e.subscription_id=s.id) AS last_paid FROM subscriptions s ORDER BY s.active DESC, s.next_due NULLS LAST, s.name`), ['next_due', 'last_paid']);
    for (const r of rows) {
      r.amount_pkr = Math.round(r.amount * (rates[r.currency] || 1));
      r.monthly_pkr = Math.round(r.cycle === 'yearly' ? r.amount_pkr / 12 : r.amount_pkr);
    }
    res.json(rows);
  }));
  const SUB_FIELDS = ['name', 'category', 'vendor', 'amount', 'currency', 'cycle', 'next_due', 'active', 'notes'];
  app.post('/api/subscriptions', wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.name || !(num(b.amount) >= 0)) return res.status(400).json({ error: 'name and amount required' });
    const r = await one(`INSERT INTO subscriptions (name, category, vendor, amount, currency, cycle, next_due, active, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [b.name, b.category || 'Software & AI tools', b.vendor || null, num(b.amount), b.currency || 'USD', b.cycle === 'yearly' ? 'yearly' : 'monthly',
       b.next_due || null, b.active !== false, b.notes || null]);
    res.json(r);
  }));
  app.patch('/api/subscriptions/:id', wrap(async (req, res) => {
    const b = req.body || {};
    const keys = SUB_FIELDS.filter((k) => k in b);
    if (!keys.length) return res.json({ ok: true });
    await pool.query(`UPDATE subscriptions SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1}`,
      [...keys.map((k) => (k === 'amount' ? num(b[k]) : b[k] === '' ? null : b[k])), +req.params.id]);
    res.json({ ok: true });
  }));
  app.delete('/api/subscriptions/:id', wrap(async (req, res) => { await pool.query(`DELETE FROM subscriptions WHERE id=$1`, [+req.params.id]); res.json({ ok: true }); }));
  // record a payment → becomes an expense, moves next due date forward
  app.post('/api/subscriptions/:id/pay', wrap(async (req, res) => {
    const s = await one(`SELECT * FROM subscriptions WHERE id=$1`, [+req.params.id]);
    if (!s) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const m = await money({ amount: b.amount ?? s.amount, currency: b.currency || s.currency, rate: b.rate });
    const date = b.date || todayLocal();
    await pool.query(`INSERT INTO expenses (date, category, vendor, description, amount, currency, rate, amount_pkr, method, subscription_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [date, s.category, s.vendor || s.name, `${s.name} (${s.cycle})`, m.amount, m.currency, m.rate, m.amount_pkr, b.method || null, s.id]);
    const base = s.next_due ? (s.next_due instanceof Date ? toYMD(s.next_due) : String(s.next_due).slice(0, 10)) : date;
    const next = addMonths(base, s.cycle === 'yearly' ? 12 : 1);
    await pool.query(`UPDATE subscriptions SET next_due=$1 WHERE id=$2`, [next, s.id]);
    res.json({ ok: true, next_due: next });
  }));

  // ---------------------------------------------------------------- income
  app.get('/api/income', wrap(async (req, res) => {
    const where = [], args = [];
    if (req.query.month) { const [a, b] = monthRange(req.query.month); args.push(a, b); where.push(`i.date >= $${args.length - 1} AND i.date < $${args.length}`); }
    if (req.query.status === 'meta') where.push(`i.from_meta`);
    else if (req.query.status && req.query.status !== 'all') { args.push(req.query.status); where.push(`i.status=$${args.length}`); }
    if (req.query.q) { args.push(`%${req.query.q}%`); where.push(`(i.client ILIKE $${args.length} OR i.project ILIKE $${args.length} OR i.description ILIKE $${args.length})`); }
    const rows = await all(`SELECT i.*, i.amount::float, i.amount_pkr::float, i.rate::float FROM income i
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.date DESC, i.id DESC LIMIT 2000`, args);
    res.json(fixDates(rows));
  }));
  const INC_FIELDS = ['date', 'client', 'project', 'description', 'method', 'status', 'source', 'lead_id', 'from_meta'];
  const bool = (v) => v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
  app.post('/api/income', wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.client) return res.status(400).json({ error: 'client required' });
    const m = await money(b);
    const r = await one(`INSERT INTO income (date, client, project, description, method, status, source, lead_id, amount, currency, rate, amount_pkr, from_meta)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [b.date || todayLocal(), b.client, b.project || null, b.description || null, b.method || null, b.status === 'pending' ? 'pending' : 'received',
       b.source || null, num(b.lead_id), m.amount, m.currency, m.rate, m.amount_pkr, bool(b.from_meta)]);
    res.json(r);
  }));
  app.patch('/api/income/:id', wrap(async (req, res) => {
    const b = req.body || {};
    const cur = await one(`SELECT * FROM income WHERE id=$1`, [+req.params.id]);
    if (!cur) return res.status(404).json({ error: 'not found' });
    const m = await money({ amount: b.amount ?? cur.amount, currency: b.currency ?? cur.currency, rate: b.rate ?? (b.currency && b.currency !== cur.currency ? null : cur.rate) });
    const keys = INC_FIELDS.filter((k) => k in b);
    await pool.query(`UPDATE income SET ${[...keys.map((k, i) => `${k}=$${i + 1}`), `amount=$${keys.length + 1}`, `currency=$${keys.length + 2}`, `rate=$${keys.length + 3}`, `amount_pkr=$${keys.length + 4}`].join(',')} WHERE id=$${keys.length + 5}`,
      [...keys.map((k) => (k === 'lead_id' ? num(b[k]) : k === 'from_meta' ? bool(b[k]) : b[k] === '' ? null : b[k])), m.amount, m.currency, m.rate, m.amount_pkr, cur.id]);
    res.json({ ok: true });
  }));
  app.delete('/api/income/:id', wrap(async (req, res) => { await pool.query(`DELETE FROM income WHERE id=$1`, [+req.params.id]); res.json({ ok: true }); }));

  // ---------------------------------------------------------------- accounts / dashboard
  app.get('/api/accounts/summary', wrap(async (req, res) => {
    const month = req.query.month || monthLocal();
    const [mStart, mEnd] = monthRange(month);
    const yearStart = addMonths(mStart, -11);
    const rates = await getRates();

    const monthlyInc = await all(`SELECT to_char(date,'YYYY-MM') m, SUM(amount_pkr)::float v FROM income WHERE status='received' AND date >= $1 AND date < $2 GROUP BY 1`, [yearStart, mEnd]);
    const monthlyExp = await all(`SELECT to_char(date,'YYYY-MM') m, SUM(amount_pkr)::float v FROM expenses WHERE date >= $1 AND date < $2 GROUP BY 1`, [yearStart, mEnd]);
    const months = [];
    for (let i = 0; i < 12; i++) {
      const m = addMonths(yearStart, i).slice(0, 7);
      const inc = monthlyInc.find((r) => r.m === m)?.v || 0, exp = monthlyExp.find((r) => r.m === m)?.v || 0;
      months.push({ month: m, income: inc, expenses: exp, profit: inc - exp });
    }
    const byCategory = await all(`SELECT category, SUM(amount_pkr)::float total, COUNT(*)::int n FROM expenses WHERE date >= $1 AND date < $2 GROUP BY category ORDER BY total DESC`, [mStart, mEnd]);
    const bySource = await all(`SELECT COALESCE(source,'Other') source, SUM(amount_pkr)::float total FROM income WHERE status='received' AND date >= $1 AND date < $2 GROUP BY 1 ORDER BY total DESC`, [mStart, mEnd]);
    const byClient = await all(`SELECT client, SUM(amount_pkr)::float total FROM income WHERE status='received' AND date >= $1 AND date < $2 GROUP BY 1 ORDER BY total DESC LIMIT 10`, [mStart, mEnd]);
    const cur = months.at(-1);
    const prev = months.at(-2);
    const pending = await one(`SELECT COALESCE(SUM(amount_pkr),0)::float total, COUNT(*)::int n FROM income WHERE status='pending'`);

    // daily Meta ads for selected month
    const ads = await all(`SELECT date, SUM(amount_pkr)::float v, SUM(CASE WHEN currency='USD' THEN amount ELSE 0 END)::float usd FROM expenses WHERE category='Meta Ads' AND date >= $1 AND date < $2 GROUP BY date ORDER BY date`, [mStart, mEnd]);
    const daysInMonth = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
    const adsDaily = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${month}-${String(d).padStart(2, '0')}`;
      const row = ads.find((r) => (r.date instanceof Date ? toYMD(r.date) : String(r.date).slice(0, 10)) === ds);
      adsDaily.push({ date: ds, pkr: row?.v || 0, usd: row?.usd || 0 });
    }
    const adsTotal = adsDaily.reduce((s, d) => s + d.pkr, 0);
    const adsDays = adsDaily.filter((d) => d.pkr > 0).length;

    const subs = fixDates(await all(`SELECT *, amount::float FROM subscriptions WHERE active ORDER BY next_due NULLS LAST`), ['next_due']);
    const subsMonthly = subs.reduce((s, r) => s + (r.cycle === 'yearly' ? r.amount / 12 : r.amount) * (rates[r.currency] || 1), 0);
    const in14 = (new Date(Date.parse(todayLocal() + 'T12:00:00Z') + 14 * 864e5).toISOString().slice(0, 10));
    const upcoming = subs.filter((s) => s.next_due && s.next_due <= in14)
      .map((s) => ({ ...s, amount_pkr: Math.round(s.amount * (rates[s.currency] || 1)), overdue: s.next_due < todayLocal() }));

    const staffActive = await one(`SELECT COUNT(*)::int n, COALESCE(SUM(monthly_salary * CASE salary_currency ${Object.entries(rates).map(([c, r]) => `WHEN '${c}' THEN ${Number(r)}`).join(' ')} ELSE 1 END),0)::float payroll FROM staff WHERE status='active' AND pay_type='salary'`);
    const unpaidStaff = await all(`SELECT s.id, s.name, s.monthly_salary::float, s.salary_currency FROM staff s WHERE s.status='active' AND s.pay_type='salary' AND s.monthly_salary > 0
      AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.staff_id=s.id AND e.salary_month=$1)`, [month]);

    const metaRow = await one(`SELECT
        COALESCE(SUM(amount_pkr) FILTER (WHERE date >= $1 AND date < $2),0)::float AS month,
        COUNT(*) FILTER (WHERE date >= $1 AND date < $2)::int AS month_n,
        COALESCE(SUM(amount_pkr),0)::float AS all_time
      FROM income WHERE from_meta AND status='received'`, [mStart, mEnd]);
    const metaClients = await all(`SELECT client, SUM(amount_pkr)::float total FROM income WHERE from_meta AND status='received' AND date >= $1 AND date < $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [mStart, mEnd]);
    const metaPending = await one(`SELECT COALESCE(SUM(amount_pkr),0)::float total FROM income WHERE from_meta AND status='pending'`);
    const adsAllTime = (await one(`SELECT COALESCE(SUM(amount_pkr),0)::float v FROM expenses WHERE category='Meta Ads'`)).v;
    const metaMonthlyInc = await all(`SELECT to_char(date,'YYYY-MM') m, SUM(amount_pkr)::float v FROM income WHERE from_meta AND status='received' AND date >= $1 AND date < $2 GROUP BY 1`, [yearStart, mEnd]);
    const metaMonthlyAds = await all(`SELECT to_char(date,'YYYY-MM') m, SUM(amount_pkr)::float v FROM expenses WHERE category='Meta Ads' AND date >= $1 AND date < $2 GROUP BY 1`, [yearStart, mEnd]);
    for (const mo of months) {
      mo.metaIncome = metaMonthlyInc.find((r) => r.m === mo.month)?.v || 0;
      mo.metaSpend = metaMonthlyAds.find((r) => r.m === mo.month)?.v || 0;
    }

    const leadStats = await one(`SELECT
      (SELECT COUNT(*)::int FROM leads WHERE created_at >= $1::date AND created_at < $2::date) AS new_leads,
      (SELECT COUNT(*)::int FROM leads WHERE status='won' AND updated_at >= $1::date AND updated_at < $2::date) AS won,
      (SELECT COUNT(*)::int FROM leads WHERE demo_sent_at >= $1::date AND demo_sent_at < $2::date) AS demos`, [mStart, mEnd]);

    res.json({
      month, months, current: cur, previous: prev, byCategory, bySource, byClient, pending,
      ads: { daily: adsDaily, total: adsTotal, activeDays: adsDays, avgPerDay: adsDays ? adsTotal / adsDays : 0,
             costPerLead: leadStats.new_leads ? adsTotal / leadStats.new_leads : null,
             earned: metaRow.month, earnedPayments: metaRow.month_n, earnedPending: metaPending.total, clients: metaClients,
             roas: adsTotal ? metaRow.month / adsTotal : null, net: metaRow.month - adsTotal,
             earnedAllTime: metaRow.all_time, spentAllTime: adsAllTime, roasAllTime: adsAllTime ? metaRow.all_time / adsAllTime : null },
      subscriptions: { monthlyBurn: Math.round(subsMonthly), count: subs.length, upcoming },
      staff: { active: staffActive.n, payroll: staffActive.payroll, unpaid: unpaidStaff },
      leads: leadStats,
    });
  }));

  // combined ledger for a month (CSV) — handy for your accountant / SECP records
  app.get('/api/accounts/ledger.csv', wrap(async (req, res) => {
    const month = req.query.month || monthLocal();
    const [a, b] = monthRange(month);
    const rows = await all(`
      SELECT date, 'Income' AS type, COALESCE(source,'') AS category, client AS party, COALESCE(project,'') || CASE WHEN description IS NOT NULL THEN ' - ' || description ELSE '' END AS details,
             amount::float, currency, rate::float, amount_pkr::float, COALESCE(method,'') method, status
        FROM income WHERE date >= $1 AND date < $2
      UNION ALL
      SELECT date, 'Expense', category, COALESCE(vendor,''), COALESCE(description,''), amount::float, currency, rate::float, -amount_pkr::float, COALESCE(method,''), 'paid'
        FROM expenses WHERE date >= $1 AND date < $2
      ORDER BY date, type DESC`, [a, b]);
    const cols = ['date', 'type', 'category', 'party', 'details', 'amount', 'currency', 'rate', 'amount_pkr', 'method', 'status'];
    const cell = (v) => (v == null ? '' : `"${String(v instanceof Date ? toYMD(v) : v).replace(/"/g, '""')}"`);
    res.type('text/csv').attachment(`pokitbio-ledger-${month}.csv`)
      .send([cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));
  }));
}
