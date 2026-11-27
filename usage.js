// How often each Render app is opened per day, and how long it stays awake.
// Source: Render's metrics API — HTTP request counts and instance count (instance count > 0 = awake).
// Daily totals are saved in the database, so history keeps growing even if Render keeps only a few days.
const RB = process.env.RENDER_API_BASE || 'https://api.render.com/v1';
const STEP = 600; // instance-count resolution: 10 minutes

export async function setupUsage(app, pool, { RENDER_API_KEY = '', APP_TZ = 'Asia/Karachi', SELF_URL = '' } = {}) {
  const all = async (sql, p = []) => (await pool.query(sql, p)).rows;
  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
  await pool.query(`
  CREATE TABLE IF NOT EXISTS render_usage (
    service_id TEXT NOT NULL, day DATE NOT NULL, name TEXT, url TEXT,
    requests INTEGER, own INTEGER NOT NULL DEFAULT 0, awake_min INTEGER, wakes INTEGER, segments JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (service_id, day)
  );`);

  const H = () => ({ Authorization: `Bearer ${RENDER_API_KEY}`, Accept: 'application/json' });
  const raw = {}; // last raw replies, shown on request to diagnose format surprises
  const get = async (path, params) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) (Array.isArray(v) ? v : [v]).forEach((x) => x != null && qs.append(k, x));
    const r = await fetch(`${RB}${path}?${qs}`, { headers: H() });
    const text = await r.text();
    raw[path] = { status: r.status, query: qs.toString().slice(0, 300), body: text.slice(0, 3000) };
    let j = null; try { j = JSON.parse(text); } catch {}
    if (!r.ok) throw Object.assign(new Error(j?.message || `Render API ${r.status}`), { status: r.status });
    return j;
  };
  // Render documents startTime/endTime as date-time; try ISO first, then epoch seconds
  let timeFmt = 'iso';
  const T = (sec) => (timeFmt === 'iso' ? new Date(sec * 1000).toISOString() : String(sec));
  const metric = async (path, start, end, res, ids) => {
    try { return await get(path, { startTime: T(start), endTime: T(end), resolutionSeconds: res, resource: ids }); }
    catch (e) {
      if (e.status === 400 && /startTime|endTime|time/i.test(e.message)) { timeFmt = timeFmt === 'iso' ? 'epoch' : 'iso'; return get(path, { startTime: T(start), endTime: T(end), resolutionSeconds: res, resource: ids }); }
      throw e;
    }
  };
  const dayOf = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: APP_TZ });
  const minOfDay = (ms) => { const p = new Date(ms).toLocaleTimeString('en-GB', { timeZone: APP_TZ, hour12: false, hour: '2-digit', minute: '2-digit' }).split(':'); return +p[0] * 60 + +p[1]; };
  const cleanUrl = (u) => String(u || '').replace(/\/+$/, '');

  // Render's metric responses: a list of series, each with labels and timestamped values. Parse defensively.
  function parseSeries(json) {
    const arr = Array.isArray(json) ? json : json?.data || json?.series || json?.metrics || json?.results || [];
    return arr.map((s) => {
      const labels = Array.isArray(s.labels) ? s.labels : Object.entries(s.labels || {}).map(([field, value]) => ({ field, value }));
      const lab = (re) => labels.find((l) => re.test(l.field || l.name || ''))?.value;
      const resource = lab(/^(resource|service|serviceId|resourceId)$/i) || s.resource || s.service || s.serviceId || s.id;
      const pts = (s.values || s.points || s.data || []).map((v) => {
        const raw = Array.isArray(v) ? v[0] : v.timestamp ?? v.time ?? v.t;
        const t = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(raw);
        return { t, v: Number(Array.isArray(v) ? v[1] : v.value ?? v.v ?? v.count ?? 0) || 0 };
      }).filter((p) => !isNaN(p.t));
      return { resource, labels, pts };
    });
  }

  let svcCache = { at: 0, list: [] };
  async function webServices() {
    if (Date.now() - svcCache.at < 300000 && svcCache.list.length) return svcCache.list;
    const raw = await get('/services', { limit: 100 });
    const list = (Array.isArray(raw) ? raw : []).map((x) => x.service || x)
      .filter((s) => s.type === 'web_service' || s.serviceDetails?.url)
      .map((s) => ({ id: s.id, name: s.name, url: cleanUrl(s.serviceDetails?.url), plan: s.serviceDetails?.plan, suspended: s.suspended === 'suspended' }));
    svcCache = { at: Date.now(), list };
    return list;
  }

  let cache = { at: 0, days: 0, data: null };
  async function refresh(days) {
    const services = await webServices();
    if (!services.length) return { services: [] };
    const end = Math.floor(Date.now() / 1000), start = end - days * 86400;
    const ids = services.map((s) => s.id);
    // Render limits how many resources one call covers; ask in small groups
    const groups = []; for (let i = 0; i < ids.length; i += 10) groups.push(ids.slice(i, i + 10));
    const reqSeries = [], instSeries = [];
    for (const g of groups) {
      reqSeries.push(...parseSeries(await metric('/metrics/http-requests', start, end, 3600, g)));
      instSeries.push(...parseSeries(await metric('/metrics/instance-count', start, end, STEP, g)));
    }
    if (!reqSeries.some((s) => s.pts.length) && !instSeries.some((s) => s.pts.length)) {
      const body = (raw['/metrics/instance-count']?.body || '').trim();
      if (body && body !== '[]') throw new Error('Render replied in a format this app does not read yet — open "details" and send it to Claude');
    }
    const own = await all(`SELECT url, day::text AS day, n FROM own_pings WHERE day >= (now() AT TIME ZONE '${APP_TZ}')::date - $1::int`, [days]).catch(() => []);
    const ownMap = new Map(own.map((o) => [`${cleanUrl(o.url)}|${o.day}`, o.n]));
    for (const s of services) {
      const perDay = {};
      const D = (d) => (perDay[d] ||= { requests: 0, awakeMin: 0, wakes: 0, segments: [] });
      // opens = HTTP requests (summed across status codes / hosts if Render splits them)
      for (const ser of reqSeries.filter((x) => x.resource === s.id || (!x.resource && services.length === 1)))
        for (const p of ser.pts) D(dayOf(p.t)).requests += p.v;
      // awake = instance count > 0; a wake-up = sleeping → running
      const inst = instSeries.filter((x) => x.resource === s.id).flatMap((x) => x.pts).sort((a, b) => a.t - b.t);
      let prevOn = null, seg = null;
      for (const p of inst) {
        const on = p.v > 0, d = dayOf(p.t), m = minOfDay(p.t);
        if (on) {
          D(d).awakeMin += STEP / 60;
          if (prevOn === false) D(d).wakes++;
          if (seg && seg.day === d && seg.end === m) seg.end = m + STEP / 60;
          else { seg = { day: d, start: m, end: m + STEP / 60 }; D(d).segments.push(seg); }
        } else seg = null;
        prevOn = on;
      }
      for (const [day, v] of Object.entries(perDay)) {
        const ownN = ownMap.get(`${s.url}|${day}`) || 0; // our uptime checks + this app's self-pings
        await pool.query(`INSERT INTO render_usage(service_id, day, name, url, requests, own, awake_min, wakes, segments, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
          ON CONFLICT (service_id, day) DO UPDATE SET name=$3, url=$4, requests=$5, own=$6, awake_min=$7, wakes=$8, segments=$9, updated_at=now()`,
          [s.id, day, s.name, s.url, Math.round(v.requests), ownN, Math.min(1440, Math.round(v.awakeMin)), v.wakes,
           JSON.stringify(v.segments.map((x) => [x.start, Math.min(1440, x.end)]))]);
      }
    }
    return { services };
  }

  app.get('/api/render/usage/debug', (_req, res) => res.json({ timeFormat: timeFmt, replies: raw }));
  app.get('/api/render/usage', wrap(async (req, res) => {
    if (!RENDER_API_KEY) return res.json({ connected: false });
    const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 14));
    let error = null;
    if (req.query.refresh || Date.now() - cache.at > 600000 || cache.days < days) {
      try { await refresh(days); cache = { at: Date.now(), days }; }
      catch (e) { error = e.message; }
    }
    const services = await webServices().catch(() => []);
    const rows = await all(`SELECT service_id, day::text AS day, name, url, requests, own, awake_min, wakes, segments FROM render_usage
      WHERE day > (now() AT TIME ZONE '${APP_TZ}')::date - $1::int ORDER BY day`, [days]);
    const ids = [...new Set([...services.map((s) => s.id), ...rows.map((r) => r.service_id)])];
    const out = ids.map((id) => {
      const s = services.find((x) => x.id === id) || {};
      const rs = rows.filter((r) => r.service_id === id);
      const dayRows = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 864e5).toLocaleDateString('en-CA', { timeZone: APP_TZ });
        const r = rs.find((x) => x.day === d);
        dayRows.push({ day: d, opens: r ? Math.max(0, r.requests - r.own) : 0, requests: r?.requests || 0, own: r?.own || 0, awakeMin: r?.awake_min || 0, wakes: r?.wakes || 0, segments: r?.segments || [], hasData: !!r });
      }
      return { id, name: s.name || rs[0]?.name || id, url: s.url || rs[0]?.url, plan: s.plan, suspended: s.suspended, days: dayRows,
        total: { opens: dayRows.reduce((a, d) => a + d.opens, 0), awakeMin: dayRows.reduce((a, d) => a + d.awakeMin, 0), wakes: dayRows.reduce((a, d) => a + d.wakes, 0) } };
    }).sort((a, b) => b.total.opens - a.total.opens);
    res.json({ connected: true, days, services: out, error, updatedAt: cache.at ? new Date(cache.at).toISOString() : null, tz: APP_TZ });
  }));
}
