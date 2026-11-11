import crypto from 'node:crypto';
import { config } from './config.js';
import { loadDb, saveDb, saveDbNow, log } from './store.js';
import { listAccounts, addAccount, authenticate, refreshAccountInfo, getAccount, ensureToken, setPool, poolStats, isHealthy, poolOf } from './pool.js';
import { listModels, MODELS } from './models.js';
import { getServicePrices } from './upstream.js';
import { submitManualToken } from './turnstile.js';
import { registerOne, registerBatch, registrarStats } from './registrar.js';
import { replSettings, replenishCycle, replStatus } from './replenisher.js';
import { sendJson, readJson, parseCookies, randToken, bearerToken, sha256 } from './util.js';
import { getHistory } from './upstream.js';

const cookieName = 'vg_admin';

function sessionFromReq(req) {
  const c = parseCookies(req)[cookieName];
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  const t = c || bearer;
  const db = loadDb();
  if (t && db.sessions[t] && db.sessions[t] > Date.now()) return t;
  return null;
}

// Independent management credentials:
//   1. MASTER_KEY env — god-mode bearer, always works
//   2. apikeys[].admin — `vg-admin-…` keys minted from the Keys tab
// Either works as `Authorization: Bearer <key>` on every /admin/api route.
function adminKeyFromReq(req) {
  const k = bearerToken(req);
  if (!k) return null;
  if (config.masterKey && k === config.masterKey) return { id: 'master', name: 'MASTER_KEY' };
  const db = loadDb();
  const h = sha256(k);
  const key = db.apikeys.find((x) => x.key_hash === h && x.enabled && x.admin);
  if (key) { key.last_used_at = Date.now(); saveDb(); }
  return key || null;
}

function newSession() {
  const db = loadDb();
  // sweep expired
  for (const [t, exp] of Object.entries(db.sessions)) if (exp < Date.now()) delete db.sessions[t];
  const token = randToken(32);
  db.sessions[token] = Date.now() + config.sessionTtlMs;
  saveDb();
  return token;
}

const pubKey = (k) => ({
  id: k.id, name: k.name, key_preview: k.key_preview, enabled: k.enabled,
  admin: !!k.admin,
  models: k.models, created_at: k.created_at, last_used_at: k.last_used_at,
  usage_count: k.usage_count || 0,
});

const pubJob = (j) => ({
  id: j.id, upstream_uuid: j.upstream_uuid, model: j.model, status: j.status,
  upstream_status: j.upstream_status, progress: j.progress, video_url: j.video_url,
  error: j.error, key_id: j.key_id, account_id: j.account_id,
  account: getAccount(j.account_id)?.username || null,
  params: { prompt: j.params?.prompt?.slice(0, 200), duration: j.params?.duration ?? j.params?.seconds,
    aspect_ratio: j.params?.aspect_ratio, orientation: j.params?.orientation, resolution: j.params?.resolution },
  created_at: j.created_at, updated_at: j.updated_at,
});

export async function handleAdmin(req, res, url) {
  const db = loadDb();
  const path = url.pathname.replace(/^\/admin\/api/, '') || '/';

  // POST /admin/api/login
  if (req.method === 'POST' && path === '/login') {
    const b = await readJson(req);
    if (b.password !== config.adminPassword) {
      log('warn', 'admin login failed', { ip: req.socket.remoteAddress });
      return sendJson(res, 401, { error: 'wrong password' });
    }
    const token = newSession();
    return sendJson(res, 200, { ok: true, token }, {
      'Set-Cookie': `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`,
    });
  }

  const sess = sessionFromReq(req) || adminKeyFromReq(req)?.id;
  if (!sess) return sendJson(res, 401, { error: 'unauthorized' });

  if (req.method === 'POST' && path === '/logout') {
    delete db.sessions[sess];
    saveDb();
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; Max-Age=0` });
  }

  if (req.method === 'GET' && path === '/overview') {
    return sendJson(res, 200, {
      accounts: { total: db.accounts.length, enabled: db.accounts.filter((a) => a.enabled).length, authed: db.accounts.filter((a) => a.access_token).length },
      pools: poolStats(),
      keys: { total: db.apikeys.length, enabled: db.apikeys.filter((k) => k.enabled).length },
      jobs: { total: db.jobs.length, running: db.jobs.filter((j) => !['completed', 'failed'].includes(j.status)).length, completed: db.jobs.filter((j) => j.status === 'completed').length, failed: db.jobs.filter((j) => j.status === 'failed').length },
      models_enabled: listModels(db).filter((m) => m.enabled).length,
      recent_logs: db.logs.slice(-30).reverse(),
    });
  }

  // ---- accounts ----
  if (path === '/accounts' && req.method === 'GET') return sendJson(res, 200, { data: listAccounts() });
  if (path === '/accounts' && req.method === 'POST') {
    const b = await readJson(req);
    if (!b.username || !b.password) return sendJson(res, 400, { error: 'username and password required' });
    const acc = await addAccount({ username: b.username, password: b.password, enabled: b.enabled !== false, notes: b.notes, pool: ['main', 'reserve', 'spent'].includes(b.pool) ? b.pool : 'main' });
    return sendJson(res, 200, { data: listAccounts().find((a) => a.id === acc.id) });
  }
  let m = path.match(/^\/accounts\/([A-Za-z0-9_-]+)(\/login|\/me|\/refresh|\/pool)?$/);
  if (m) {
    const acc = getAccount(m[1]);
    if (!acc) return sendJson(res, 404, { error: 'account not found' });
    if (m[2] === '/login' && req.method === 'POST') {
      try { await authenticate(acc); } catch (e) { return sendJson(res, 502, { error: e.message }); }
      return sendJson(res, 200, { data: listAccounts().find((a) => a.id === acc.id) });
    }
    if ((m[2] === '/me' || m[2] === '/refresh') && req.method === 'POST') {
      try { await ensureToken(acc); await refreshAccountInfo(acc); } catch (e) { return sendJson(res, 502, { error: e.message }); }
      return sendJson(res, 200, { data: listAccounts().find((a) => a.id === acc.id) });
    }
    if (m[2] === '/pool' && req.method === 'POST') {
      const b = await readJson(req);
      if (!['main', 'reserve', 'spent'].includes(b.pool)) return sendJson(res, 400, { error: 'pool must be main|reserve|spent' });
      setPool(acc, b.pool);
      return sendJson(res, 200, { data: listAccounts().find((a) => a.id === acc.id) });
    }
    if (!m[2] && req.method === 'PATCH') {
      const b = await readJson(req);
      if (b.enabled !== undefined) acc.enabled = !!b.enabled;
      if (b.notes !== undefined) acc.notes = b.notes;
      if (b.pool !== undefined && ['main', 'reserve', 'spent'].includes(b.pool)) acc.pool = b.pool;
      if (b.proxy !== undefined) acc.proxy = b.proxy || null;
      if (b.password) { acc.password = b.password; acc.access_token = null; acc.refresh_token = null; }
      acc.updated_at = Date.now();
      saveDb();
      return sendJson(res, 200, { data: listAccounts().find((a) => a.id === acc.id) });
    }
    if (!m[2] && req.method === 'DELETE') {
      db.accounts = db.accounts.filter((a) => a.id !== acc.id);
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- pool overview / registrar / replenisher ----
  if (path === '/pool/stats' && req.method === 'GET') {
    return sendJson(res, 200, { data: { pools: poolStats(), registrar: registrarStats() } });
  }
  if (path === '/register' && req.method === 'POST') {
    const b = await readJson(req);
    const n = Math.min(Math.max(parseInt(b.count || '1', 10) || 1, 1), 20);
    const s = replSettings();
    const settings = { ...s, register_into: ['main', 'reserve'].includes(b.into) ? b.into : (s.register_into || 'reserve') };
    const r = n === 1
      ? { ok: [await registerOne(settings)], failed: [] }
      : await registerBatch(n, settings);
    return sendJson(res, 200, {
      data: {
        registered: r.ok.map((a) => ({ id: a.id, username: a.username, pool: a.pool, quota: a.me?.remaining_bulk_videos ?? null })),
        failed: r.failed,
        pools: poolStats(),
      },
    });
  }
  if (path === '/replenisher' && req.method === 'GET') return sendJson(res, 200, { data: replStatus() });
  if (path === '/replenisher' && req.method === 'PUT') {
    const b = await readJson(req);
    const s = replSettings();
    for (const k of ['enabled', 'interval_sec', 'main_min', 'main_target', 'reserve_target',
      'batch_size', 'daily_cap', 'min_interval_ms', 'jitter_ms', 'register_into',
      'email_domains', 'tempmail_hub_url', 'proxy_url', 'proxies', 'refresh_stale_sec']) {
      if (b[k] !== undefined) s[k] = b[k];
    }
    saveDb();
    return sendJson(res, 200, { data: replStatus() });
  }
  if (path === '/replenish' && req.method === 'POST') {
    const r = await replenishCycle({ force: true });
    return sendJson(res, 200, { data: r });
  }

  // ---- api keys ----
  if (path === '/keys' && req.method === 'GET') return sendJson(res, 200, { data: db.apikeys.map(pubKey) });
  if (path === '/keys' && req.method === 'POST') {
    const b = await readJson(req);
    const isAdmin = !!b.admin;
    const raw = (isAdmin ? 'vg-admin-' : 'vg-') + crypto.randomBytes(20).toString('base64url');
    const key = {
      id: 'key_' + crypto.randomBytes(8).toString('hex'),
      key_hash: crypto.createHash('sha256').update(raw).digest('hex'),
      key_preview: raw.slice(0, 12) + '…' + raw.slice(-4),
      name: b.name || 'default', enabled: true, admin: isAdmin,
      models: Array.isArray(b.models) && b.models.length ? b.models : null,
      created_at: Date.now(), last_used_at: null, usage_count: 0,
    };
    db.apikeys.push(key);
    saveDb();
    return sendJson(res, 200, { data: { ...pubKey(key), key: raw } });
  }
  m = path.match(/^\/keys\/([A-Za-z0-9_-]+)$/);
  if (m) {
    const key = db.apikeys.find((k) => k.id === m[1]);
    if (!key) return sendJson(res, 404, { error: 'key not found' });
    if (req.method === 'PATCH') {
      const b = await readJson(req);
      if (b.enabled !== undefined) key.enabled = !!b.enabled;
      if (b.name !== undefined) key.name = b.name;
      if (b.admin !== undefined) key.admin = !!b.admin;
      if (b.models !== undefined) key.models = Array.isArray(b.models) && b.models.length ? b.models : null;
      saveDb();
      return sendJson(res, 200, { data: pubKey(key) });
    }
    if (req.method === 'DELETE') {
      db.apikeys = db.apikeys.filter((k) => k.id !== key.id);
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- models ----
  if (path === '/models' && req.method === 'GET') return sendJson(res, 200, { data: listModels(db) });
  m = path.match(/^\/models\/([^/]+)$/);
  if (m && req.method === 'PATCH') {
    const b = await readJson(req);
    const id = decodeURIComponent(m[1]);
    if (!MODELS[id]) return sendJson(res, 404, { error: 'model not found' });
    db.models[id] = { ...(db.models[id] || {}), enabled: b.enabled !== false };
    saveDb();
    return sendJson(res, 200, { data: listModels(db).find((x) => x.id === id) });
  }
  if (path === '/models/bulk' && req.method === 'PATCH') {
    const b = await readJson(req);
    for (const id of Object.keys(MODELS)) {
      if (b.enabled !== undefined) db.models[id] = { ...(db.models[id] || {}), enabled: !!b.enabled };
    }
    saveDb();
    return sendJson(res, 200, { data: listModels(db) });
  }

  // ---- jobs ----
  if (path === '/jobs' && req.method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    return sendJson(res, 200, { data: db.jobs.slice(0, limit).map(pubJob) });
  }
  m = path.match(/^\/jobs\/([A-Za-z0-9_-]+)(\/sync)?$/);
  if (m && req.method === 'GET') {
    const job = db.jobs.find((j) => j.id === m[1] || j.upstream_uuid === m[1]);
    if (!job) return sendJson(res, 404, { error: 'job not found' });
    if (m[2] === '/sync' && job.upstream_uuid) {
      const acc = getAccount(job.account_id);
      if (acc) {
        try {
          await ensureToken(acc);
          const hist = await getHistory(acc, job.upstream_uuid);
          return sendJson(res, 200, { data: pubJob(job), upstream: hist });
        } catch (e) { return sendJson(res, 502, { error: e.message }); }
      }
    }
    return sendJson(res, 200, { data: pubJob(job) });
  }

  // ---- logs ----
  if (path === '/logs' && req.method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    return sendJson(res, 200, { data: db.logs.slice(-limit).reverse() });
  }
  if (path === '/logs' && req.method === 'DELETE') {
    db.logs = [];
    saveDbNow();
    return sendJson(res, 200, { ok: true });
  }

  // ---- manual turnstile token inbox ----
  if (path === '/turnstile' && req.method === 'POST') {
    const b = await readJson(req);
    if (!b.token) return sendJson(res, 400, { error: 'token required' });
    submitManualToken(String(b.token));
    log('info', 'manual turnstile token submitted');
    return sendJson(res, 200, { ok: true });
  }

  // ---- upstream service prices (passthrough for UI reference) ----
  if (path === '/prices' && req.method === 'GET') {
    const prices = await getServicePrices().catch(() => null);
    return sendJson(res, prices ? 200 : 502, { data: prices });
  }

  return sendJson(res, 404, { error: 'not found' });
}
