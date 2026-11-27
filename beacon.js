// Free live usage tracking: each app sends a tiny note to this engine when it starts,
// every 5 minutes while it is running, and on every page visit.
// No Render API needed, so no Render plan or rate limits involved.
import crypto from 'node:crypto';

const ALIVE_GAP_MIN = 12; // no note for this long = the app went to sleep

export async function setupBeacon(app, pool, { APP_TZ = 'Asia/Karachi' } = {}) {
  const all = async (sql, p = []) => (await pool.query(sql, p)).rows;
  await pool.query(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
  CREATE TABLE IF NOT EXISTS beacon_apps (app TEXT PRIMARY KEY, url TEXT, first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen TIMESTAMPTZ, last_start TIMESTAMPTZ, last_view TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS beacon_sessions (id SERIAL PRIMARY KEY, app TEXT NOT NULL, start_at TIMESTAMPTZ NOT NULL, last_at TIMESTAMPTZ NOT NULL);
  CREATE INDEX IF NOT EXISTS beacon_sessions_app ON beacon_sessions(app, last_at DESC);
  CREATE TABLE IF NOT EXISTS beacon_hits (app TEXT NOT NULL, day DATE NOT NULL, hour SMALLINT NOT NULL, views INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (app, day, hour));
  CREATE TABLE IF NOT EXISTS beacon_pages (app TEXT NOT NULL, day DATE NOT NULL, path TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (app, day, path));
  `);
  let key = (await all(`SELECT value FROM settings WHERE key='beacon_key'`))[0]?.value;
  if (!key) {
    key = crypto.randomBytes(12).toString('hex');
    await pool.query(`INSERT INTO settings(key, value) VALUES ('beacon_key', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(key)]);
    key = (await all(`SELECT value FROM settings WHERE key='beacon_key'`))[0].value;
  }

  const clean = (s, n) => String(s || '').trim().slice(0, n);
  const localNow = `(now() AT TIME ZONE '${APP_TZ}')`;

  // one note from an app
  async function record(appName, event, { path, url } = {}) {
    const a = clean(appName, 80).toLowerCase();
    if (!a) return;
    await pool.query(`INSERT INTO beacon_apps(app, url, last_seen, last_start, last_view) VALUES ($1,$2,now(), CASE WHEN $3 THEN now() END, CASE WHEN $4 THEN now() END)
      ON CONFLICT (app) DO UPDATE SET last_seen=now(), url=COALESCE($2, beacon_apps.url),
        last_start=CASE WHEN $3 THEN now() ELSE beacon_apps.last_start END,
        last_view=CASE WHEN $4 THEN now() ELSE beacon_apps.last_view END`,
      [a, url ? clean(url, 200).replace(/\/+$/, '') : null, event === 'start', event === 'view']);
    // awake sessions: a start always opens a new one; otherwise continue the last one if it is recent
    const last = (await all(`SELECT id, last_at FROM beacon_sessions WHERE app=$1 ORDER BY last_at DESC LIMIT 1`, [a]))[0];
    const recent = last && Date.now() - new Date(last.last_at).getTime() <= ALIVE_GAP_MIN * 60000;
    if (event !== 'start' && recent) await pool.query(`UPDATE beacon_sessions SET last_at=now() WHERE id=$1`, [last.id]);
    else await pool.query(`INSERT INTO beacon_sessions(app, start_at, last_at) VALUES ($1, now(), now())`, [a]);
    if (event === 'view') {
      await pool.query(`INSERT INTO beacon_hits(app, day, hour, views) VALUES ($1, ${localNow}::date, EXTRACT(hour FROM ${localNow})::int, 1)
        ON CONFLICT (app, day, hour) DO UPDATE SET views = beacon_hits.views + 1`, [a]);
      const p = clean(path, 120).split('?')[0] || '/';
      await pool.query(`INSERT INTO beacon_pages(app, day, path, n) VALUES ($1, ${localNow}::date, $2, 1)
        ON CONFLICT (app, day, path) DO UPDATE SET n = beacon_pages.n + 1`, [a, p]);
    }
  }

  // public endpoint the apps call (GET or POST, works from servers and from browsers)
  const queue = []; let busy = false;
  const drain = async () => { if (busy) return; busy = true; while (queue.length) { const j = queue.shift(); await record(...j).catch(() => {}); } busy = false; };
  app.all('/beacon', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    const q = { ...(req.query || {}), ...(typeof req.body === 'object' ? req.body : {}) };
    if (q.k !== key) return res.status(403).json({ error: 'bad key' });
    const e = ['start', 'alive', 'view'].includes(q.e) ? q.e : 'view';
    queue.push([q.app, e, { path: q.p, url: q.u }]); drain();
    res.status(204).end();
  });

  // ----- reading it back, per app per day (in APP_TZ)
  const offsetMin = (t) => { const d = new Date(t);
    return (Date.parse(d.toLocaleString('en-US', { timeZone: APP_TZ })) - Date.parse(d.toLocaleString('en-US', { timeZone: 'UTC' }))) / 60000; };
  const dayOf = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: APP_TZ });

  async function daily(days) {
    const apps = await all(`SELECT app, url, first_seen, last_seen, last_start, last_view FROM beacon_apps`);
    if (!apps.length) return { apps: [] };
    const hits = await all(`SELECT app, day::text AS day, hour, views FROM beacon_hits WHERE day > ${localNow}::date - $1::int`, [days]);
    const sess = await all(`SELECT app, start_at, last_at FROM beacon_sessions WHERE last_at > now() - ($1::int + 1) * interval '1 day' ORDER BY start_at`, [days]);
    const pages = await all(`SELECT app, path, SUM(n)::int n FROM beacon_pages WHERE day > ${localNow}::date - $1::int GROUP BY 1,2 ORDER BY n DESC`, [days]);
    const out = apps.map((a) => {
      const per = {};
      const D = (d) => (per[d] ||= { views: 0, hours: Array(24).fill(0), awakeMin: 0, wakes: 0, segments: [] });
      for (const h of hits.filter((x) => x.app === a.app)) { D(h.day).views += h.views; D(h.day).hours[h.hour] += h.views; }
      for (const s of sess.filter((x) => x.app === a.app)) {
        let t = new Date(s.start_at).getTime();
        const end = Math.max(t + 60000, new Date(s.last_at).getTime()); // at least a minute
        D(dayOf(t)).wakes++;
        while (t < end) { // split across midnight
          const off = offsetMin(t), localMs = t + off * 60000;
          const startMin = Math.floor((localMs % 864e5) / 60000);
          const toMidnight = (1440 - startMin) * 60000;
          const segEnd = Math.min(end, t + toMidnight);
          const d = D(dayOf(t));
          const a1 = startMin, b1 = Math.min(1440, startMin + Math.ceil((segEnd - t) / 60000));
          d.awakeMin += b1 - a1; d.segments.push([a1, b1]);
          t = segEnd;
        }
      }
      const lastSeen = a.last_seen ? new Date(a.last_seen).getTime() : 0;
      return { app: a.app, url: a.url, firstDay: dayOf(a.first_seen), perDay: per,
        awakeNow: Date.now() - lastSeen <= ALIVE_GAP_MIN * 60000, lastSeen: a.last_seen, lastStart: a.last_start, lastView: a.last_view,
        topPages: pages.filter((p) => p.app === a.app).slice(0, 6).map((p) => ({ path: p.path, n: p.n })) };
    });
    return { apps: out };
  }

  // the engine tracks itself the same way (no network call)
  const selfName = (process.env.RENDER_SERVICE_NAME || '').toLowerCase();
  if (selfName) {
    const selfUrl = process.env.RENDER_EXTERNAL_URL || '';
    record(selfName, 'start', { url: selfUrl }).catch(() => {});
    setInterval(() => record(selfName, 'alive', { url: selfUrl }).catch(() => {}), 5 * 60000).unref();
    app.use((req, _res, next) => {
      if (req.method === 'GET' && (req.get('accept') || '').includes('text/html') && !/\.\w+$/.test(req.path) && !isBot(req.get('user-agent')))
        record(selfName, 'view', { path: req.path, url: selfUrl }).catch(() => {});
      next();
    });
  }

  return { key: () => key, daily, record };
}

export const isBot = (ua) => /PokitBio-Monitor|Render\/|bot|crawl|spider|uptime|monitor|curl|wget|python-requests|headless/i.test(ua || '');
