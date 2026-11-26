// Phone / laptop reminders via Web Push (works when the installed app is closed).
// - 1 hour (configurable) before every timed follow-up, call, demo or meeting
// - a morning summary at 9:00 of everything due today
// Keys are generated once and stored in the database, so there is nothing to configure.
import webpush from 'web-push';

const KIND = {
  followup: { icon: '⏰', word: 'Follow-up' },
  call: { icon: '📞', word: 'Call' },
  demo: { icon: '🎬', word: 'Demo' },
  meeting: { icon: '🤝', word: 'Meeting' },
};

export async function setupReminders(app, pool, { APP_TZ = 'Asia/Karachi' } = {}) {
  const all = async (sql, p = []) => (await pool.query(sql, p)).rows;
  const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

  await pool.query(`
  ALTER TABLE followups ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'followup';
  ALTER TABLE followups ADD COLUMN IF NOT EXISTS has_time BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE followups ADD COLUMN IF NOT EXISTS remind_min INTEGER NOT NULL DEFAULT 60;
  ALTER TABLE followups ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;
  CREATE TABLE IF NOT EXISTS push_subs (
    id SERIAL PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, keys JSONB NOT NULL, device TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_ok TIMESTAMPTZ
  );
  `);

  // VAPID keys: create once, keep in settings
  let vapid = (await one(`SELECT value FROM settings WHERE key='vapid'`))?.value;
  if (!vapid) {
    vapid = webpush.generateVAPIDKeys();
    await pool.query(`INSERT INTO settings(key,value) VALUES('vapid',$1) ON CONFLICT(key) DO NOTHING`, [JSON.stringify(vapid)]);
    vapid = (await one(`SELECT value FROM settings WHERE key='vapid'`)).value;
  }
  webpush.setVapidDetails('mailto:talha@pokitbio.com', vapid.publicKey, vapid.privateKey);

  async function pushAll(payload) {
    const subs = await all(`SELECT * FROM push_subs`);
    let sent = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
        sent++; await pool.query(`UPDATE push_subs SET last_ok=now() WHERE id=$1`, [s.id]);
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) await pool.query(`DELETE FROM push_subs WHERE id=$1`, [s.id]); // phone unsubscribed
        else console.warn('push failed', e.statusCode || e.message);
      }
    }));
    return { sent, devices: subs.length };
  }
  const timeStr = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: APP_TZ });
  const before = (min) => (min >= 1440 ? `${Math.round(min / 1440)} day` : min >= 60 ? `${Math.round(min / 60)} hour${min >= 120 ? 's' : ''}` : `${min} min`);

  // ---------------------------------------------------------------- scheduler (every minute)
  async function tick() {
    // 1) reminders before timed items (catches up if the server was asleep, up to 3h after the time)
    const due = await all(`SELECT f.*, l.name, l.username, l.phone, l.business FROM followups f JOIN leads l ON l.id=f.lead_id
      WHERE f.done_at IS NULL AND f.reminded_at IS NULL AND f.has_time AND f.remind_min > 0
        AND f.due_at - make_interval(mins => f.remind_min) <= now() AND f.due_at > now() - interval '3 hours'`);
    for (const f of due) {
      const k = KIND[f.kind] || KIND.followup;
      const who = f.name || (f.username ? '@' + f.username : 'a lead');
      const late = new Date(f.due_at) <= new Date();
      await pushAll({
        title: `${k.icon} ${k.word} ${late ? 'was due' : 'at'} ${timeStr(f.due_at)} — ${who}`,
        body: [f.note, f.business, f.phone && `📞 ${f.phone}`].filter(Boolean).join(' · ') || `${k.word} with ${who}`,
        tag: `fu-${f.id}`, url: `/?lead=${f.lead_id}#leads`,
      });
      await pool.query(`UPDATE followups SET reminded_at=now() WHERE id=$1`, [f.id]);
    }
    // 2) morning summary at 9:00 local time
    const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: APP_TZ }));
    const today = new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ });
    if (nowLocal.getHours() >= 9) {
      const last = (await one(`SELECT value FROM settings WHERE key='digest_last'`))?.value;
      if (last !== today) {
        await pool.query(`INSERT INTO settings(key,value) VALUES('digest_last',$1) ON CONFLICT(key) DO UPDATE SET value=$1`, [JSON.stringify(today)]);
        const items = await all(`SELECT f.*, l.name FROM followups f JOIN leads l ON l.id=f.lead_id WHERE f.done_at IS NULL
          AND (f.due_at AT TIME ZONE '${APP_TZ}')::date <= $1::date ORDER BY f.due_at`, [today]);
        if (items.length) {
          const overdue = items.filter((f) => new Date(f.due_at).toLocaleDateString('en-CA', { timeZone: APP_TZ }) < today).length;
          await pushAll({
            title: `☀️ Today: ${items.length - overdue} planned${overdue ? ` · ${overdue} overdue` : ''}`,
            body: items.slice(0, 6).map((f) => `${(KIND[f.kind] || KIND.followup).icon} ${f.has_time ? timeStr(f.due_at) + ' ' : ''}${f.name || 'Lead'}${f.note ? ' — ' + f.note : ''}`).join('\n'),
            tag: 'digest', url: '/#leads',
          });
        }
      }
    }
  }
  setTimeout(() => tick().catch((e) => console.warn('reminder tick', e.message)), 20000);
  setInterval(() => tick().catch((e) => console.warn('reminder tick', e.message)), 60000);

  // ---------------------------------------------------------------- API
  app.get('/api/push/key', (_req, res) => res.json({ publicKey: vapid.publicKey }));
  app.get('/api/push/status', wrap(async (_req, res) => res.json({ devices: (await all(`SELECT id, device, created_at, last_ok FROM push_subs ORDER BY created_at DESC`)) })));
  app.post('/api/push/subscribe', wrap(async (req, res) => {
    const s = req.body?.subscription;
    if (!s?.endpoint || !s.keys) return res.status(400).json({ error: 'bad subscription' });
    await pool.query(`INSERT INTO push_subs(endpoint, keys, device) VALUES ($1,$2,$3) ON CONFLICT (endpoint) DO UPDATE SET keys=$2, device=$3`,
      [s.endpoint, JSON.stringify(s.keys), req.body.device || null]);
    res.json({ ok: true });
  }));
  app.post('/api/push/unsubscribe', wrap(async (req, res) => { await pool.query(`DELETE FROM push_subs WHERE endpoint=$1`, [req.body?.endpoint || '']); res.json({ ok: true }); }));
  app.post('/api/push/test', wrap(async (_req, res) => res.json(await pushAll({ title: '🔔 PokitBio reminders are on', body: 'You\'ll get a reminder before each follow-up, call and demo.', tag: 'test', url: '/#leads' }))));
  app.get('/api/reminders/upcoming', wrap(async (_req, res) => {
    res.json(await all(`SELECT f.*, l.name, l.phone, l.business FROM followups f JOIN leads l ON l.id=f.lead_id
      WHERE f.done_at IS NULL AND f.has_time AND f.due_at > now() - interval '1 hour' AND f.due_at < now() + interval '24 hours' ORDER BY f.due_at`));
  }));

  return { pushAll, KIND, before };
}
