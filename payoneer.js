import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import path from 'node:path';
import { createRequire } from 'node:module';
const FONTS = path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;

// Payoneer: money that comes in (from Upwork or direct clients), withdrawals to bank, fees, balance.
// Payoneer has no public API for individuals, so data comes from manual entries or Payoneer's CSV export.
export const PAYONEER_KINDS = {
  upwork: 'From Upwork',            // transfer of money already counted as Upwork income
  client: 'Client payment',         // direct client paid you on Payoneer → counts as income
  other_in: 'Other money in',
  withdrawal: 'Withdrawal to bank',
  fee: 'Payoneer fee',
  card: 'Card spend',
  other_out: 'Other money out',
};
const IN_KINDS = ['upwork', 'client', 'other_in'];

// ---------------------------------------------------------------- PDF statement reader
// Reads the transaction table from a Payoneer statement PDF using text positions, so it works with
// "Amount" or "Debit / Credit" layouts and ignores the running "Balance" column.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const DATE_RE = /(\d{4}-\d{2}-\d{2})|(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})|([A-Za-z]{3,9}\.? \d{1,2},? \d{4})|(\d{1,2}[ \-][A-Za-z]{3,9}[ \-,]+\d{2,4})/;
const MONEY_RE = /^[-−+(]?\s*(?:USD|EUR|GBP|AUD|CAD|\$|€|£)?\s*[-−]?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})\)?\s*(?:USD|EUR|GBP|AUD|CAD)?$/i;
function toDate(s) {
  s = s.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) { let [, a, b, y] = m; if (y.length === 2) y = '20' + y; let mo = +a, d = +b; if (mo > 12) [mo, d] = [d, mo]; return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
  m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})/);
  if (m) { const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; }
  m = s.match(/^(\d{1,2})[ \-]([A-Za-z]{3,9})[ \-,]+(\d{2,4})/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) { let y = m[3]; if (y.length === 2) y = '20' + y; return `${y}-${String(MONTHS[m[2].slice(0, 3).toLowerCase()]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; }
  return null;
}
const moneyVal = (s) => { const neg = /^[-−(]|[-−]\s*\d/.test(s.trim()); const n = parseFloat(s.replace(/[^\d.]/g, '')); return neg ? -n : n; };
export async function readPayoneerPdf(buffer) {
  const doc = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, standardFontDataUrl: FONTS, verbosity: 0 }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const byY = new Map();
    for (const it of tc.items) {
      const t = it.str.trim(); if (!t) continue;
      const y = Math.round(it.transform[5] / 3) * 3, x = it.transform[4];
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y).push({ x, w: it.width, t });
    }
    [...byY.entries()].sort((a, b) => b[0] - a[0]).forEach(([, items]) => {
      items.sort((a, b) => a.x - b.x);
      // merge pieces that touch each other into one cell
      const cells = [];
      for (const it of items) { const last = cells[cells.length - 1]; if (last && it.x - (last.x + last.w) < 4) { last.t += (it.x - (last.x + last.w) > 1 ? ' ' : '') + it.t; last.w = it.x + it.w - last.x; } else cells.push({ ...it }); }
      lines.push({ page: p, cells, text: cells.map((c) => c.t).join(' ') });
    });
  }
  const full = lines.map((l) => l.text).join('\n');
  // column positions from the header row
  let cols = null;
  for (const l of lines) {
    const lt = l.text.toLowerCase();
    if (/date/.test(lt) && /(amount|credit|debit|money in|money out)/.test(lt)) {
      cols = l.cells.map((c) => {
        const h = c.t.toLowerCase();
        const kind = /balance/.test(h) ? 'balance' : /credit|money in|^in$|received/.test(h) ? 'credit' : /debit|money out|^out$|sent|paid/.test(h) ? 'debit' : /amount|net/.test(h) ? 'amount' : /fee/.test(h) ? 'fee' : /date/.test(h) ? 'date' : /currency/.test(h) ? 'currency' : 'text';
        return { kind, x: c.x + c.w / 2, right: c.x + c.w };
      });
      break;
    }
  }
  const nearest = (cell) => { if (!cols) return null; const cx = cell.x + cell.w; let best = null, bd = 1e9; for (const c of cols) { if (!['credit', 'debit', 'amount', 'balance', 'fee'].includes(c.kind)) continue; const d = Math.min(Math.abs(c.right - cx), Math.abs(c.x - (cell.x + cell.w / 2))); if (d < bd) { bd = d; best = c; } } return best; };
  const rows = [];
  let cur = null;
  for (const l of lines) {
    const first = l.cells[0]?.t || '';
    const dm = first.match(DATE_RE) && first.match(DATE_RE).index === 0 ? toDate(first.match(DATE_RE)[0]) : (l.cells[0] && l.cells[1] && toDate(`${l.cells[0].t} ${l.cells[1].t}`) && DATE_RE.test(`${l.cells[0].t} ${l.cells[1].t}`) ? toDate(`${l.cells[0].t} ${l.cells[1].t}`) : null);
    const moneyCells = l.cells.filter((c) => MONEY_RE.test(c.t));
    if (dm && moneyCells.length) {
      let amount = null, fee = 0;
      if (cols) {
        for (const c of moneyCells) {
          const col = nearest(c); const v = moneyVal(c.t);
          if (!col || col.kind === 'balance') continue;
          if (col.kind === 'credit') amount = (amount || 0) + Math.abs(v);
          else if (col.kind === 'debit') amount = (amount || 0) - Math.abs(v);
          else if (col.kind === 'fee') fee += Math.abs(v);
          else if (col.kind === 'amount') amount = (amount || 0) + v;
        }
      }
      if (amount == null) { const vals = moneyCells.map((c) => moneyVal(c.t)); amount = vals.length > 1 ? vals[0] : vals[0]; }
      const currency = (l.text.match(/\b(USD|EUR|GBP|AUD|CAD|PKR)\b/) || [])[1] || (/[€]/.test(l.text) ? 'EUR' : /£/.test(l.text) ? 'GBP' : 'USD');
      const desc = l.cells.filter((c) => !MONEY_RE.test(c.t) && !DATE_RE.test(c.t) && !/^(USD|EUR|GBP|AUD|CAD|completed|pending|cancell?ed|failed)$/i.test(c.t)).map((c) => c.t).join(' ');
      const status = (l.text.match(/\b(completed|pending|cancell?ed|failed|declined|reversed)\b/i) || [])[1] || '';
      cur = { date: dm, amount, fee, currency, description: desc, status };
      rows.push(cur);
    } else if (cur && !dm && !moneyCells.length && l.text.length < 120 && !/page \d|statement|balance|total/i.test(l.text)) {
      cur.description = (cur.description + ' ' + l.text).trim(); // wrapped description line
    } else if (dm || /total|closing|opening/i.test(l.text)) cur = null;
  }
  const grab = (re) => { const m = full.match(re); return m ? moneyVal(m[1]) : null; };
  const period = full.match(/(?:statement period|period|from)\s*:?\s*(.+?)\s*(?:to|-|–)\s*([A-Za-z0-9 ,\/.\-]+\d{4})/i);
  return {
    rows: rows.filter((r) => r.amount && !isNaN(r.amount)),
    opening: grab(/opening balance[^\d\-−]*([-−]?[\d,]+\.\d{2})/i), closing: grab(/closing balance[^\d\-−]*([-−]?[\d,]+\.\d{2})/i),
    from: period ? toDate(period[1].trim()) : null, to: period ? toDate(period[2].trim()) : null, pages: doc.numPages, columns: cols ? cols.map((c) => c.kind) : null,
  };
}


export async function setupPayoneer(app, pool, { APP_TZ = 'Asia/Karachi' } = {}) {
  const all = async (sql, p = []) => (await pool.query(sql, p)).rows;
  const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
  const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ });
  const getRates = async () => ({ PKR: 1, USD: 280, ...((await one(`SELECT value FROM settings WHERE key='rates'`))?.value || {}) });

  await pool.query(`
  CREATE TABLE IF NOT EXISTS payoneer_tx (
    id SERIAL PRIMARY KEY, date DATE NOT NULL, kind TEXT NOT NULL, counterparty TEXT, description TEXT,
    amount NUMERIC(14,2) NOT NULL,                 -- always positive; kind says in or out
    currency TEXT NOT NULL DEFAULT 'USD', rate NUMERIC(14,4) NOT NULL DEFAULT 1, amount_pkr NUMERIC(16,2) NOT NULL,
    pkr_received NUMERIC(16,2),                    -- for withdrawals: rupees that actually reached the bank
    income_id INTEGER REFERENCES income(id) ON DELETE SET NULL,
    expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
    ext_ref TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_pyn_date ON payoneer_tx(date);
  `);

  async function addTx(b, { linkMoney = true } = {}) {
    const kind = PAYONEER_KINDS[b.kind] ? b.kind : 'other_in';
    const amount = Math.abs(Number(b.amount));
    if (!(amount > 0)) throw Object.assign(new Error('amount required'), { status: 400 });
    const currency = b.currency || 'USD';
    const rate = currency === 'PKR' ? 1 : Number(b.rate) || (await getRates())[currency] || 1;
    const amount_pkr = Math.round(amount * rate * 100) / 100;
    const date = b.date || todayLocal();
    // the same Upwork withdrawal can arrive twice (Upwork import + Payoneer CSV): match on amount within 3 days
    if (kind === 'upwork') {
      const dup = await one(`SELECT id FROM payoneer_tx WHERE kind='upwork' AND amount=$1 AND currency=$2 AND abs(date - $3::date) <= 3
        AND ($4::text IS NULL OR ext_ref IS DISTINCT FROM $4)`, [amount, currency, date, b.ext_ref || null]);
      if (dup) return null;
    }
    let income_id = null, expense_id = null;
    // a direct client payment is real income (unless you already recorded it in Income)
    if (linkMoney && kind === 'client' && b.add_income !== false && b.add_income !== 'false') {
      const r = await one(`INSERT INTO income (date, client, project, description, amount, currency, rate, amount_pkr, method, status, source, ext_ref)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Payoneer','received',$9,$10) ON CONFLICT (ext_ref) DO NOTHING RETURNING id`,
        [date, b.counterparty || 'Payoneer client', b.project || null, b.description || null, amount, currency, rate, amount_pkr,
         b.source || 'Direct international', b.ext_ref ? 'pyn-inc:' + b.ext_ref : null]);
      income_id = r?.id || null;
    }
    // Payoneer fees are a business cost
    if (linkMoney && kind === 'fee') {
      const r = await one(`INSERT INTO expenses (date, category, subcategory, vendor, description, amount, currency, rate, amount_pkr, ext_ref)
        VALUES ($1,'Taxes & Fees','Payoneer fee','Payoneer',$2,$3,$4,$5,$6,$7) ON CONFLICT (ext_ref) DO NOTHING RETURNING id`,
        [date, b.description || 'Payoneer fee', amount, currency, rate, amount_pkr, b.ext_ref ? 'pyn-exp:' + b.ext_ref : null]);
      expense_id = r?.id || null;
    }
    // historic rows (imports) are dated in the past so they don't move the balance you set today
    const row = await one(`INSERT INTO payoneer_tx (date, kind, counterparty, description, amount, currency, rate, amount_pkr, pkr_received, income_id, expense_id, ext_ref, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $13 THEN $1::date::timestamptz ELSE now() END) ON CONFLICT (ext_ref) DO NOTHING RETURNING id`,
      [date, kind, b.counterparty || null, b.description || null, amount, currency, rate, amount_pkr,
       b.pkr_received ? Number(b.pkr_received) : null, income_id, expense_id, b.ext_ref || null, !!b.historic]);
    return row;
  }

  async function balanceState() {
    const base = (await one(`SELECT value FROM settings WHERE key='payoneer_balance'`))?.value;
    if (!base) return { isSet: false };
    const d = await one(`SELECT
        COALESCE(SUM(amount) FILTER (WHERE kind = ANY($2)),0)::float inn,
        COALESCE(SUM(amount) FILTER (WHERE NOT (kind = ANY($2))),0)::float outt
      FROM payoneer_tx WHERE currency='USD' AND created_at > $1`, [base.at, IN_KINDS]);
    return { isSet: true, balance: Math.round((base.balance + d.inn - d.outt) * 100) / 100, setBalance: base.balance, setAt: base.at, inSince: d.inn, outSince: d.outt };
  }

  app.get('/api/payoneer/config', (_req, res) => res.json({ kinds: PAYONEER_KINDS, inKinds: IN_KINDS }));
  app.get('/api/payoneer', wrap(async (req, res) => {
    const month = req.query.month || todayLocal().slice(0, 7);
    let start = `${month}-01`;
    let end = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString().slice(0, 10);
    // optional custom range (?from=YYYY-MM-DD&to=YYYY-MM-DD, "to" inclusive) e.g. a statement period or a whole year
    if (req.query.from) start = req.query.from;
    if (req.query.to) end = new Date(Date.parse(req.query.to + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
    const yearStart = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 12, 1)).toISOString().slice(0, 10);
    const sumBy = (from, to) => all(`SELECT kind, COUNT(*)::int n, SUM(amount)::float usd, SUM(amount_pkr)::float pkr, SUM(pkr_received)::float bank_pkr
      FROM payoneer_tx WHERE ($1::date IS NULL OR date >= $1) AND ($2::date IS NULL OR date < $2) GROUP BY kind`, [from, to]);
    const [rows, monthK, allK, months, senders, bal] = await Promise.all([
      all(`SELECT *, amount::float, amount_pkr::float, rate::float, pkr_received::float FROM payoneer_tx WHERE date >= $1 AND date < $2 ORDER BY date DESC, id DESC`, [start, end]),
      sumBy(start, end), sumBy(null, null),
      all(`SELECT to_char(date,'YYYY-MM') m, kind, SUM(amount)::float usd FROM payoneer_tx WHERE date >= $1 AND date < $2 GROUP BY 1,2`, [yearStart, end]),
      all(`SELECT COALESCE(counterparty, CASE WHEN kind='upwork' THEN 'Upwork' ELSE 'Unknown' END) who, SUM(amount)::float usd, COUNT(*)::int n
           FROM payoneer_tx WHERE kind = ANY($1) GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [IN_KINDS]),
      balanceState(),
    ]);
    const tot = (list, kinds) => list.filter((k) => kinds.includes(k.kind)).reduce((s, k) => ({ usd: s.usd + k.usd, pkr: s.pkr + k.pkr, n: s.n + k.n }), { usd: 0, pkr: 0, n: 0 });
    const series = [];
    for (let i = 0; i < 12; i++) {
      const m = new Date(Date.UTC(+yearStart.slice(0, 4), +yearStart.slice(5, 7) - 1 + i, 1)).toISOString().slice(0, 7);
      const g = (ks) => months.filter((r) => r.m === m && ks.includes(r.kind)).reduce((s, r) => s + r.usd, 0);
      series.push({ month: m, fromUpwork: g(['upwork']), fromClients: g(['client', 'other_in']), withdrawn: g(['withdrawal']) });
    }
    const pack = (list) => ({
      received: tot(list, IN_KINDS), fromUpwork: tot(list, ['upwork']), fromClients: tot(list, ['client', 'other_in']),
      withdrawn: tot(list, ['withdrawal']), fees: tot(list, ['fee']), card: tot(list, ['card', 'other_out']),
      bankPkr: list.filter((k) => k.kind === 'withdrawal').reduce((s, k) => s + (k.bank_pkr || 0), 0),
    });
    res.json({ month, rows, monthTotals: pack(monthK), allTime: pack(allK), series, senders, balance: bal });
  }));
  app.post('/api/payoneer', wrap(async (req, res) => res.json(await addTx(req.body || {}))));
  app.patch('/api/payoneer/:id', wrap(async (req, res) => {
    const b = req.body || {}, cur = await one(`SELECT * FROM payoneer_tx WHERE id=$1`, [+req.params.id]);
    if (!cur) return res.status(404).json({ error: 'not found' });
    const amount = b.amount != null ? Math.abs(Number(b.amount)) : Number(cur.amount);
    const currency = b.currency || cur.currency;
    const rate = currency === 'PKR' ? 1 : Number(b.rate) || Number(cur.rate);
    await pool.query(`UPDATE payoneer_tx SET date=$1, kind=$2, counterparty=$3, description=$4, amount=$5, currency=$6, rate=$7, amount_pkr=$8, pkr_received=$9 WHERE id=$10`,
      [b.date || cur.date, PAYONEER_KINDS[b.kind] ? b.kind : cur.kind, b.counterparty ?? cur.counterparty, b.description ?? cur.description, amount, currency, rate,
       Math.round(amount * rate * 100) / 100, b.pkr_received === '' ? null : b.pkr_received ?? cur.pkr_received, cur.id]);
    if (cur.income_id) await pool.query(`UPDATE income SET amount=$1, currency=$2, rate=$3, amount_pkr=$4, date=$5 WHERE id=$6`, [amount, currency, rate, Math.round(amount * rate * 100) / 100, b.date || cur.date, cur.income_id]);
    if (cur.expense_id) await pool.query(`UPDATE expenses SET amount=$1, currency=$2, rate=$3, amount_pkr=$4, date=$5 WHERE id=$6`, [amount, currency, rate, Math.round(amount * rate * 100) / 100, b.date || cur.date, cur.expense_id]);
    res.json({ ok: true });
  }));
  app.delete('/api/payoneer/:id', wrap(async (req, res) => {
    const cur = await one(`SELECT * FROM payoneer_tx WHERE id=$1`, [+req.params.id]);
    if (cur?.income_id) await pool.query(`DELETE FROM income WHERE id=$1`, [cur.income_id]);
    if (cur?.expense_id) await pool.query(`DELETE FROM expenses WHERE id=$1`, [cur.expense_id]);
    await pool.query(`DELETE FROM payoneer_tx WHERE id=$1`, [+req.params.id]);
    res.json({ ok: true });
  }));
  app.put('/api/payoneer/balance', wrap(async (req, res) => {
    const n = Number(req.body?.balance);
    if (!(n >= 0)) return res.status(400).json({ error: 'balance required' });
    await pool.query(`INSERT INTO settings(key,value) VALUES('payoneer_balance',$1) ON CONFLICT(key) DO UPDATE SET value=$1`, [JSON.stringify({ balance: n, at: new Date().toISOString() })]);
    res.json(await balanceState());
  }));
  // statement PDF → rows (classified & confirmed in the browser before saving)
  app.post('/api/payoneer/read-pdf', wrap(async (req, res) => {
    const b64 = String(req.body?.file || '').replace(/^data:.*?;base64,/, '');
    if (!b64) return res.status(400).json({ error: 'no file' });
    try { res.json(await readPayoneerPdf(Buffer.from(b64, 'base64'))); }
    catch (e) { res.status(400).json({ error: 'Could not read this PDF: ' + e.message }); }
  }));
  // bulk import (rows already classified in the browser from Payoneer's CSV)
  app.post('/api/payoneer/import', wrap(async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    let added = 0, skipped = 0;
    for (const r of rows) {
      if (!r.include) { skipped++; continue; }
      const ext = r.ext_ref || `csv:${r.date}:${r.amount}:${(r.description || '').slice(0, 40)}`;
      const row = await addTx({ ...r, ext_ref: ext, add_income: r.kind === 'client', historic: true });
      if (row) added++; else skipped++;
    }
    res.json({ added, skipped });
  }));

  return { addTx };
}
