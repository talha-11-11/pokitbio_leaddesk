import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  PORT = 3000,
  ADMIN_PASSWORD = 'change-me',
  DATABASE_URL,
  APP_TZ = 'Asia/Karachi',
  META_VERIFY_TOKEN = '',
  META_APP_SECRET = '',
  META_PAGE_TOKEN = '',
  META_PAGE_ID = '',
  META_IG_ID = '',
  META_IG_TOKEN = '', // optional: system-user token from the Instagram "Unified login" setup
  GRAPH_VERSION = 'v21.0',
} = process.env;
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

if (!DATABASE_URL) { console.error('DATABASE_URL is not set (paste your Neon connection string)'); process.exit(1); }

// ---------------------------------------------------------------- database (Neon Postgres)
const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000, // Neon free tier auto-suspends; let idle connections go
});
pool.on('error', (e) => console.error('pg pool error', e.message));

const all = async (sql, params = []) => (await pool.query(sql, params)).rows;
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];

await pool.query(`
CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  platform TEXT NOT NULL,              -- messenger | instagram | manual
  external_id TEXT,                    -- PSID / IGSID
  name TEXT, username TEXT, profile_pic TEXT,
  phone TEXT, email TEXT, business TEXT, interest TEXT, tags TEXT,
  status TEXT NOT NULL DEFAULT 'new',  -- new|contacted|demo_sent|negotiation|won|lost
  contacted_at TIMESTAMPTZ, demo_sent_at TIMESTAMPTZ,
  last_message TEXT, last_message_at TIMESTAMPTZ, last_direction TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, external_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  mid TEXT UNIQUE, direction TEXT NOT NULL, text TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'note',   -- note | activity
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS followups (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  due_at TIMESTAMPTZ NOT NULL, note TEXT, done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_msg_lead ON messages(lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fu_lead ON followups(lead_id, due_at);
CREATE INDEX IF NOT EXISTS idx_notes_lead ON notes(lead_id, created_at);
`);

// undo auto-"contacted" from the earlier version (only where you never changed it yourself)
await pool.query(`
  UPDATE leads SET contacted_at=NULL, status='new'
  WHERE status='contacted'
    AND id IN (SELECT lead_id FROM notes WHERE text='Marked contacted (first reply sent from page)')
    AND id NOT IN (SELECT lead_id FROM notes WHERE kind='activity' AND (text LIKE 'Status:%' OR text LIKE 'Contacted on%'));
  DELETE FROM notes WHERE text='Marked contacted (first reply sent from page)';
`);

const STATUSES = ['new', 'contacted', 'demo_sent', 'negotiation', 'won', 'lost'];
const STATUS_LABEL = { new: 'New', contacted: 'Contacted', demo_sent: 'Demo sent', negotiation: 'Negotiation', won: 'Won', lost: 'Lost' };
const isoDay = (v) => new Date(v).toLocaleDateString('en-CA', { timeZone: APP_TZ });

const logActivity = (leadId, text) =>
  pool.query(`INSERT INTO notes (lead_id, kind, text) VALUES ($1, 'activity', $2)`, [leadId, text]);

// ---------------------------------------------------------------- Meta helpers
const IG_TOKEN = META_IG_TOKEN || META_PAGE_TOKEN;
async function graph(pathAndQuery, token = META_PAGE_TOKEN) {
  if (!token) throw new Error('No Meta access token set');
  const url = pathAndQuery.startsWith('http')
    ? pathAndQuery
    : `${GRAPH}/${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}access_token=${token}`;
  const j = await (await fetch(url)).json();
  if (j.error) throw new Error(j.error.message);
  return j;
}

async function fetchProfile(platform, id) {
  try {
    if (platform === 'messenger') {
      const p = await graph(`${id}?fields=first_name,last_name,profile_pic`);
      return { name: [p.first_name, p.last_name].filter(Boolean).join(' '), profile_pic: p.profile_pic };
    }
    const p = await graph(`${id}?fields=name,username,profile_pic`, IG_TOKEN);
    return { name: p.name || p.username, username: p.username, profile_pic: p.profile_pic };
  } catch (e) {
    console.warn(`profile lookup failed (${platform} ${id}):`, e.message);
    return {};
  }
}

/** Find or create the lead for a platform user; returns lead row. Safe under concurrent webhooks. */
async function upsertLead(platform, externalId, hint = {}) {
  const existing = await one(`SELECT * FROM leads WHERE platform=$1 AND external_id=$2`, [platform, externalId]);
  if (existing) {
    if (!existing.name && (hint.name || hint.username)) {
      return one(`UPDATE leads SET name=$1, username=COALESCE(username,$2) WHERE id=$3 RETURNING *`,
        [hint.name || hint.username, hint.username ?? null, existing.id]);
    }
    return existing;
  }
  const prof = hint.name ? hint : { ...hint, ...(await fetchProfile(platform, externalId)) };
  const created = await one(
    `INSERT INTO leads (platform, external_id, name, username, profile_pic, created_at)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now()))
     ON CONFLICT (platform, external_id) DO NOTHING RETURNING *`,
    [platform, externalId, prof.name || null, prof.username || null, prof.profile_pic || null, hint.created_at || null]);
  if (!created) return one(`SELECT * FROM leads WHERE platform=$1 AND external_id=$2`, [platform, externalId]);
  await logActivity(created.id, `New lead captured from ${platform === 'instagram' ? 'Instagram' : 'Messenger'}`);
  return created;
}

async function saveMessage(leadId, { mid, direction, text, created_at }) {
  const ins = await one(
    `INSERT INTO messages (lead_id, mid, direction, text, created_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (mid) DO NOTHING RETURNING id`,
    [leadId, mid || null, direction, text || '', created_at]);
  if (!ins) return false; // duplicate (Meta retries / re-sync)
  // only bump "last message" if this one is newest
  await pool.query(
    `UPDATE leads SET last_message=$1, last_message_at=$2, last_direction=$3, updated_at=now(),
       unread = CASE WHEN $3='in' THEN unread+1 ELSE 0 END
     WHERE id=$4 AND (last_message_at IS NULL OR last_message_at <= $2)`,
    [(text || '[attachment]').slice(0, 300), created_at, direction, leadId]);
  // Contacted / demo are set manually from the dashboard — messages never change the stage.
  return true;
}

// ---------------------------------------------------------------- app
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.get('/healthz', wrap(async (_req, res) => { await pool.query('SELECT 1'); res.send('ok'); }));

// --- Meta webhook verification (GET) ---
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === META_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// --- Meta webhook events (POST) ---
app.post('/webhook', async (req, res) => {
  if (META_APP_SECRET) {
    const sig = req.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody || '').digest('hex');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.sendStatus(401);
    }
  }
  res.sendStatus(200); // reply fast; Meta retries on slow responses
  const body = req.body || {};
  const platform = body.object === 'instagram' ? 'instagram' : body.object === 'page' ? 'messenger' : null;
  if (!platform) return;
  for (const entry of body.entry || []) {
    const ownId = String(entry.id);
    for (const ev of entry.messaging || []) {
      try {
        if (!ev.message || ev.message.is_deleted) continue;
        const sender = String(ev.sender?.id);
        const fromUs = ev.message.is_echo || sender === ownId || sender === META_PAGE_ID || sender === META_IG_ID;
        const userId = String(fromUs ? ev.recipient?.id : ev.sender?.id);
        if (!userId || userId === 'undefined') continue;
        const lead = await upsertLead(platform, userId);
        const text = ev.message.text || (ev.message.attachments?.length ? `[${ev.message.attachments[0].type || 'attachment'}]` : '');
        await saveMessage(lead.id, {
          mid: ev.message.mid,
          direction: fromUs ? 'out' : 'in',
          text,
          created_at: new Date(ev.timestamp || Date.now()).toISOString(),
        });
      } catch (e) { console.error('webhook event error', e); }
    }
  }
});

// --- privacy policy page (Meta requires a URL for app review) ---
app.get('/privacy', (_req, res) => res.type('html').send(`<h1>PokitBio Lead Desk — Privacy</h1>
<p>Messages sent to the PokitBio Facebook page and Instagram account are stored privately so our team can reply and follow up.
We do not sell or share this data. To delete your data, email talha@pokitbio.com.</p>`));

// --- auth for dashboard API ---
app.use('/api', (req, res, next) => {
  const a = Buffer.from(req.get('x-admin-key') || ''), b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? next() : res.status(401).json({ error: 'unauthorized' });
});

const leadSelect = `
  SELECT l.*,
    (SELECT MIN(due_at) FROM followups f WHERE f.lead_id=l.id AND f.done_at IS NULL) AS next_followup_at,
    (SELECT note FROM followups f WHERE f.lead_id=l.id AND f.done_at IS NULL ORDER BY due_at LIMIT 1) AS next_followup_note,
    (SELECT COUNT(*)::int FROM notes n WHERE n.lead_id=l.id AND n.kind='note') AS note_count
  FROM leads l`;

app.get('/api/config', (_req, res) => res.json({
  statuses: STATUSES.map((s) => ({ id: s, label: STATUS_LABEL[s] })),
  meta: { pageConnected: !!(META_PAGE_TOKEN && META_PAGE_ID), igConnected: !!(IG_TOKEN && META_IG_ID) },
}));

app.get('/api/leads', wrap(async (req, res) => {
  const { status, platform, q: search } = req.query;
  const where = [], args = [];
  if (status && status !== 'all') { args.push(status); where.push(`l.status=$${args.length}`); }
  if (platform && platform !== 'all') { args.push(platform); where.push(`l.platform=$${args.length}`); }
  if (search) {
    args.push(`%${search}%`);
    const p = `$${args.length}`;
    where.push(`(l.name ILIKE ${p} OR l.username ILIKE ${p} OR l.phone ILIKE ${p} OR l.business ILIKE ${p} OR l.last_message ILIKE ${p} OR l.tags ILIKE ${p})`);
  }
  res.json(await all(`${leadSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                      ORDER BY COALESCE(l.last_message_at, l.created_at) DESC LIMIT 1000`, args));
}));

app.get('/api/leads/:id', wrap(async (req, res) => {
  const id = +req.params.id;
  const lead = await one(`${leadSelect} WHERE l.id=$1`, [id]);
  if (!lead) return res.status(404).json({ error: 'not found' });
  await pool.query(`UPDATE leads SET unread=0 WHERE id=$1`, [id]);
  const [messages, notes, followups] = await Promise.all([
    all(`SELECT * FROM messages WHERE lead_id=$1 ORDER BY created_at`, [id]),
    all(`SELECT * FROM notes WHERE lead_id=$1 ORDER BY created_at DESC, id DESC`, [id]),
    all(`SELECT * FROM followups WHERE lead_id=$1 ORDER BY (done_at IS NOT NULL), due_at`, [id]),
  ]);
  res.json({ ...lead, messages, notes, followups });
}));

app.post('/api/leads', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const row = await one(
    `INSERT INTO leads (platform, external_id, name, username, phone, email, business, interest, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [b.platform || 'manual', b.external_id || `manual-${Date.now()}`, b.name, b.username || null, b.phone || null,
     b.email || null, b.business || null, b.interest || null, b.tags || null]);
  await logActivity(row.id, 'Lead added manually');
  res.json({ id: row.id });
}));

const EDITABLE = ['name', 'username', 'phone', 'email', 'business', 'interest', 'tags', 'status', 'contacted_at', 'demo_sent_at'];
app.patch('/api/leads/:id', wrap(async (req, res) => {
  const lead = await one(`SELECT * FROM leads WHERE id=$1`, [+req.params.id]);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const b = { ...(req.body || {}) };
  if (b.status && !STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad status' });
  const now = new Date().toISOString();
  // status shortcuts fill dates automatically
  if (b.status === 'contacted' && !lead.contacted_at && b.contacted_at === undefined) b.contacted_at = now;
  if (b.status === 'demo_sent' && !lead.demo_sent_at && b.demo_sent_at === undefined) b.demo_sent_at = now;
  if (b.status === 'demo_sent' && !lead.contacted_at && b.contacted_at === undefined) b.contacted_at = now;
  const keys = EDITABLE.filter((k) => k in b);
  if (!keys.length) return res.json({ ok: true });
  const vals = keys.map((k) => (b[k] === '' ? null : b[k]));
  await pool.query(`UPDATE leads SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(', ')}, updated_at=now() WHERE id=$${keys.length + 1}`,
    [...vals, lead.id]);
  const changed = (k) => k in b && (b[k] ? new Date(b[k]).getTime() : null) !== (lead[k] ? new Date(lead[k]).getTime() : null);
  if (b.status && b.status !== lead.status) await logActivity(lead.id, `Status: ${STATUS_LABEL[lead.status]} → ${STATUS_LABEL[b.status]}`);
  if (changed('contacted_at')) await logActivity(lead.id, b.contacted_at ? `Contacted on ${isoDay(b.contacted_at)}` : 'Contacted date cleared');
  if (changed('demo_sent_at')) await logActivity(lead.id, b.demo_sent_at ? `Demo sent on ${isoDay(b.demo_sent_at)}` : 'Demo date cleared');
  res.json({ ok: true });
}));

app.delete('/api/leads/:id', wrap(async (req, res) => {
  await pool.query(`DELETE FROM leads WHERE id=$1`, [+req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/leads/:id/notes', wrap(async (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  await pool.query(`INSERT INTO notes (lead_id, kind, text, created_at) VALUES ($1,'note',$2,COALESCE($3::timestamptz, now()))`,
    [+req.params.id, text, req.body.created_at || null]);
  await pool.query(`UPDATE leads SET updated_at=now() WHERE id=$1`, [+req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/notes/:id', wrap(async (req, res) => {
  await pool.query(`DELETE FROM notes WHERE id=$1`, [+req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/leads/:id/followups', wrap(async (req, res) => {
  const { due_at, note } = req.body || {};
  if (!due_at) return res.status(400).json({ error: 'due_at required' });
  await pool.query(`INSERT INTO followups (lead_id, due_at, note) VALUES ($1,$2,$3)`, [+req.params.id, due_at, note || null]);
  await logActivity(+req.params.id, `Follow-up scheduled for ${isoDay(due_at)}${note ? ' — ' + note : ''}`);
  res.json({ ok: true });
}));
app.patch('/api/followups/:id', wrap(async (req, res) => {
  const fu = await one(`SELECT * FROM followups WHERE id=$1`, [+req.params.id]);
  if (!fu) return res.status(404).json({ error: 'not found' });
  const done = !!req.body?.done;
  await pool.query(`UPDATE followups SET done_at=${done ? 'now()' : 'NULL'} WHERE id=$1`, [fu.id]);
  await logActivity(fu.lead_id, done ? `Follow-up done (${isoDay(fu.due_at)}${fu.note ? ' — ' + fu.note : ''})` : 'Follow-up reopened');
  res.json({ ok: true });
}));
app.delete('/api/followups/:id', wrap(async (req, res) => {
  await pool.query(`DELETE FROM followups WHERE id=$1`, [+req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/stats', wrap(async (_req, res) => {
  const localDay = (col) => `(${col} AT TIME ZONE '${APP_TZ}')::date`;
  const today = `(now() AT TIME ZONE '${APP_TZ}')::date`;
  const s = await one(`SELECT
      (SELECT COUNT(*)::int FROM leads) AS total,
      (SELECT COUNT(*)::int FROM leads WHERE created_at >= now() - interval '7 days') AS "newThisWeek",
      (SELECT COUNT(*)::int FROM leads WHERE demo_sent_at IS NOT NULL) AS "demosSent",
      (SELECT COUNT(*)::int FROM leads WHERE contacted_at IS NULL AND status NOT IN ('won','lost')) AS "notContacted",
      (SELECT COUNT(DISTINCT lead_id)::int FROM followups WHERE done_at IS NULL AND ${localDay('due_at')} < ${today}) AS overdue,
      (SELECT COUNT(DISTINCT lead_id)::int FROM followups WHERE done_at IS NULL AND ${localDay('due_at')} = ${today}) AS "dueToday"`);
  const byStatus = Object.fromEntries(STATUSES.map((st) => [st, 0]));
  for (const r of await all(`SELECT status, COUNT(*)::int c FROM leads GROUP BY status`)) byStatus[r.status] = r.c;
  const byPlatform = Object.fromEntries((await all(`SELECT platform, COUNT(*)::int c FROM leads GROUP BY platform`)).map((r) => [r.platform, r.c]));
  res.json({ ...s, byStatus, byPlatform });
}));

app.get('/api/followups', wrap(async (_req, res) => {
  res.json(await all(`SELECT f.*, l.name, l.platform, l.status FROM followups f JOIN leads l ON l.id=f.lead_id
                      WHERE f.done_at IS NULL ORDER BY f.due_at LIMIT 300`));
}));

// --- backfill old conversations from Meta ---
const CONV_FIELDS = 'participants,updated_time,messages.limit(25){id,message,from,created_time}';

async function syncPlatform(platform) {
  const ownId = platform === 'instagram' ? META_IG_ID : META_PAGE_ID;
  if (!ownId) return { platform, skipped: 'id not set' };
  // Instagram: try the IG account's own conversations (unified login token), then the page's.
  const sources = platform === 'instagram'
    ? [[`${META_IG_ID}/conversations?platform=instagram&limit=25&fields=${CONV_FIELDS}`, IG_TOKEN],
       [`${META_PAGE_ID}/conversations?platform=instagram&limit=25&fields=${CONV_FIELDS}`, META_PAGE_TOKEN]]
    : [[`${META_PAGE_ID}/conversations?platform=messenger&limit=25&fields=${CONV_FIELDS}`, META_PAGE_TOKEN]];
  let lastErr;
  for (const [start, token] of sources) {
    if (!token) continue;
    try { return await syncFrom(platform, ownId, start, token); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no token');
}

async function syncFrom(platform, ownId, start, token) {
  let url = start, leads = 0, msgs = 0, pages = 0;
  const isOwn = (id) => [String(ownId), String(META_PAGE_ID), String(META_IG_ID)].includes(String(id));
  while (url && pages < 20) {
    const data = await graph(url, token);
    pages++;
    for (const conv of data.data || []) {
      const other = (conv.participants?.data || []).find((p) => !isOwn(p.id));
      if (!other) continue;
      const before = await one(`SELECT id FROM leads WHERE platform=$1 AND external_id=$2`, [platform, String(other.id)]);
      const oldest = conv.messages?.data?.at(-1)?.created_time;
      const lead = await upsertLead(platform, String(other.id), {
        name: other.name || other.username, username: other.username,
        created_at: oldest ? new Date(oldest).toISOString() : undefined,
      });
      if (!before) leads++;
      for (const m of [...(conv.messages?.data || [])].reverse()) {
        const out = isOwn(m.from?.id);
        if (await saveMessage(lead.id, { mid: m.id, direction: out ? 'out' : 'in', text: m.message, created_at: new Date(m.created_time).toISOString() })) msgs++;
      }
    }
    url = data.paging?.next || null;
  }
  return { platform, newLeads: leads, newMessages: msgs };
}

app.post('/api/sync', wrap(async (_req, res) => {
  const out = [];
  for (const p of ['messenger', 'instagram']) {
    try { out.push(await syncPlatform(p)); } catch (e) { out.push({ platform: p, error: e.message }); }
  }
  res.json(out);
}));

app.get('/api/export.csv', wrap(async (_req, res) => {
  const rows = await all(leadSelect + ' ORDER BY l.created_at DESC');
  const cols = ['id', 'platform', 'name', 'username', 'phone', 'email', 'business', 'interest', 'tags', 'status', 'contacted_at', 'demo_sent_at', 'next_followup_at', 'last_message', 'last_message_at', 'created_at'];
  const cell = (v) => (v == null ? '' : `"${String(v instanceof Date ? v.toISOString() : v).replace(/"/g, '""')}"`);
  res.type('text/csv').attachment('pokitbio-leads.csv')
    .send([cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message }); });
app.listen(PORT, () => console.log(`PokitBio Lead Desk running on :${PORT}`));
