// One shared, polite Render API client for the whole app.
// - every call goes through a single queue (one call at a time, spaced out)
// - when Render says "slow down" (429), ALL calls pause until Render's wait is over
// - the service list is fetched once and shared (also kept in the database, so a restart needs no call)
// - each service's latest deploy is read slowly in the background, not all at once
const RB = process.env.RENDER_API_BASE || 'https://api.render.com/v1';
const GAP_MS = 700;              // space between calls
const LIST_TTL = 15 * 60000;     // service list stays fresh for 15 min
const DEPLOY_TTL = 60 * 60000;   // each service's deploy status re-read at most hourly

let client = null;
export function renderClient(pool, key) {
  if (client) return client;
  const raw = {};
  let nextAllowed = 0, chain = Promise.resolve();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rateErr = () => Object.assign(new Error('Render asked us to slow down'), { status: 429, rate: true });

  function get(path, params = {}) {
    const job = chain.then(async () => {
      if (Date.now() < nextAllowed) throw rateErr();
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) (Array.isArray(v) ? v : [v]).forEach((x) => x != null && qs.append(k, x));
      const r = await fetch(`${RB}${path}${qs.toString() ? '?' + qs : ''}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
      const text = await r.text();
      const hdr = (n) => r.headers.get(n);
      const slot = path.startsWith('/services/') ? '/services/:id/deploys' : path;
      raw[slot] = { at: new Date().toISOString(), status: r.status, query: qs.toString().slice(0, 300), body: text.slice(0, 3000),
        headers: { 'retry-after': hdr('retry-after'), 'ratelimit-limit': hdr('ratelimit-limit'), 'ratelimit-remaining': hdr('ratelimit-remaining'), 'ratelimit-reset': hdr('ratelimit-reset') } };
      await sleep(GAP_MS);
      if (r.status === 429) {
        const ra = Number(hdr('retry-after')), rr = Number(hdr('ratelimit-reset'));
        const waitS = ra > 0 ? ra : rr > 1e9 ? rr - Date.now() / 1000 : rr > 0 ? rr : 300;
        nextAllowed = Date.now() + Math.min(3600, Math.max(60, waitS)) * 1000;
        throw rateErr();
      }
      // running low? leave room before the next call
      const left = Number(hdr('ratelimit-remaining')), reset = Number(hdr('ratelimit-reset'));
      if (Number.isFinite(left) && left <= 2 && reset > 0) nextAllowed = Date.now() + Math.min(3600, reset > 1e9 ? reset - Date.now() / 1000 : reset) * 1000;
      let j = null; try { j = JSON.parse(text); } catch {}
      if (!r.ok) throw Object.assign(new Error(j?.message || `Render API ${r.status}`), { status: r.status });
      return j;
    });
    chain = job.catch(() => {});
    return job;
  }

  // ---- service list (shared, deduplicated, persisted)
  let list = null, listAt = 0, inflight = null, loaded = false;
  const deploys = {}; // id -> { at, deploy }
  async function loadSaved() {
    if (loaded) return; loaded = true;
    try {
      const r = (await pool.query(`SELECT value FROM settings WHERE key='render_services'`)).rows[0]?.value;
      if (r?.list?.length) { list = r.list; listAt = r.at || 0; for (const s of list) if (s.deploy) deploys[s.id] = { at: r.at || 0, deploy: s.deploy }; }
    } catch {}
  }
  const shape = (s) => ({
    id: s.id, name: s.name, type: s.type, suspended: s.suspended, url: (s.serviceDetails?.url || '').replace(/\/+$/, '') || null,
    plan: s.serviceDetails?.plan || null, region: s.serviceDetails?.region || null, updatedAt: s.updatedAt, dashboard: s.dashboardUrl,
  });
  const withDeploys = () => (list || []).map((s) => ({ ...s, deploy: deploys[s.id]?.deploy || null }));
  async function save() {
    try {
      await pool.query(`INSERT INTO settings(key, value) VALUES ('render_services', $1) ON CONFLICT (key) DO UPDATE SET value=$1`,
        [JSON.stringify({ at: listAt, list: withDeploys() })]);
    } catch {}
  }

  async function services({ fresh = false } = {}) {
    if (!key) return null;
    await loadSaved();
    if (list && !fresh && Date.now() - listAt < LIST_TTL) return withDeploys();
    if (list && Date.now() < nextAllowed) return withDeploys(); // waiting: use what we have
    if (!inflight) inflight = (async () => {
      try {
        const j = await get('/services', { limit: 100 });
        if (!Array.isArray(j)) throw new Error(j?.message || 'Render API error');
        list = j.map((x) => shape(x.service || x)); listAt = Date.now();
        await save();
      } finally { inflight = null; }
    })();
    try { await inflight; } catch (e) { if (!list) throw e; }
    return withDeploys();
  }

  // ---- deploy status, a few services at a time in the background
  let deployRunning = false;
  async function refreshDeploys(max = 5) {
    if (deployRunning || !list?.length || Date.now() < nextAllowed) return;
    deployRunning = true;
    try {
      const due = list.filter((s) => !deploys[s.id] || Date.now() - deploys[s.id].at > DEPLOY_TTL)
        .sort((a, b) => (deploys[a.id]?.at || 0) - (deploys[b.id]?.at || 0)).slice(0, max);
      for (const s of due) {
        const d = await get(`/services/${s.id}/deploys`, { limit: 1 });
        const dep = d?.[0]?.deploy || null;
        deploys[s.id] = { at: Date.now(), deploy: dep && { status: dep.status, finishedAt: dep.finishedAt, commit: dep.commit?.message?.split('\n')[0] || null } };
      }
      if (due.length) await save();
    } catch {} finally { deployRunning = false; }
  }
  if (key) {
    setTimeout(() => services().then(() => refreshDeploys()).catch(() => {}), 20000);
    setInterval(() => services().then(() => refreshDeploys()).catch(() => {}), 5 * 60000); // ~5 deploy reads per 5 min at most
  }

  client = {
    get, services, raw,
    waitingMin: () => (Date.now() < nextAllowed ? Math.ceil((nextAllowed - Date.now()) / 60000) : 0),
    canCall: () => Date.now() >= nextAllowed,
  };
  return client;
}
