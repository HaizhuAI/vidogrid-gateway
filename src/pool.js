import crypto from 'node:crypto';
import { loadDb, saveDb, log } from './store.js';
import { login, refreshToken, getMe } from './upstream.js';
import { newStableId, newDomFp } from './antibot.js';
import { quotaOf } from './registrar.js';
import { dispatcherFor } from './proxy.js';

// ---------------------------------------------------------------------------
// Account pools — three tiers:
//   main    : online, serves generation requests (round-robin)
//   reserve : warm standby; promoted to main by the replenisher / admin
//   spent   : quota-exhausted or dead; kept for audit, never picked
// Health = enabled && authenticated && quota != 0 (null quota = unknown = ok).
// ---------------------------------------------------------------------------

const jwtExp = (t) => {
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp * 1000; }
  catch { return 0; }
};

let rr = 0;

export const poolOf = (a) => a.pool || 'main';
export const isHealthy = (a) => a.enabled && poolOf(a) !== 'spent' && (quotaOf(a) === null || quotaOf(a) > 0);

export function poolStats() {
  const db = loadDb();
  const s = { main: { total: 0, enabled: 0, healthy: 0, quota: 0 }, reserve: { total: 0, enabled: 0, healthy: 0, quota: 0 }, spent: { total: 0, enabled: 0, healthy: 0, quota: 0 } };
  for (const a of db.accounts) {
    const p = s[poolOf(a)] || s.main;
    p.total++;
    if (a.enabled) p.enabled++;
    if (isHealthy(a)) p.healthy++;
    const q = quotaOf(a);
    if (q > 0) p.quota += q;
  }
  return s;
}

export function listAccounts() {
  return loadDb().accounts.map((a) => ({
    id: a.id, username: a.username, enabled: a.enabled, pool: poolOf(a),
    proxy: a.proxy ? a.proxy.replace(/\/\/[^@/]*@/, '//***@') : null,
    authenticated: !!a.access_token,
    token_exp: a.token_exp, credit: a.me?.user_credit ?? a.me?.credit ?? null,
    quota: quotaOf(a),
    plan: a.me?.user_plan?.product?.name || a.me?.user_plan?.product?.id || null,
    is_premium: a.me?.user_plan?.product?.id === 'PP0001',
    is_free: a.me?.user_plan?.product?.id === 'FP0001',
    last_error: a.last_error || null,
    stats: a.stats || { requests: 0, failures: 0 },
    created_at: a.created_at, updated_at: a.updated_at,
  }));
}

export async function addAccount({ username, password, enabled = true, notes, pool = 'main' }) {
  const db = loadDb();
  const acc = {
    id: 'acc_' + crypto.randomBytes(8).toString('hex'),
    username: username.trim(), password,
    enabled, notes: notes || '', pool,
    access_token: null, refresh_token: null, token_exp: 0,
    stable_id: newStableId(), dom_fp: newDomFp(),
    me: null, last_error: null,
    stats: { requests: 0, failures: 0 },
    created_at: Date.now(), updated_at: Date.now(),
  };
  db.accounts.push(acc);
  saveDb();
  await authenticate(acc).catch((e) => { acc.last_error = e.message; saveDb(); });
  return acc;
}

export async function authenticate(acc) {
  const data = await login(acc.username, acc.password, { dispatcher: dispatcherFor(acc) });
  acc.access_token = data.access_token;
  acc.refresh_token = data.refresh_token;
  acc.token_exp = jwtExp(data.access_token) || Date.now() + 3600e3;
  acc.last_error = null;
  acc.updated_at = Date.now();
  saveDb();
  try { acc.me = await getMe(acc); } catch { /* non-fatal */ }
  saveDb();
  log('info', `account ${acc.username} authenticated`);
  return acc;
}

export async function ensureToken(acc) {
  if (acc.access_token && acc.token_exp - Date.now() > 120000) return acc;
  if (!acc.refresh_token) return authenticate(acc);
  try {
    const data = await refreshToken(acc);
    acc.access_token = data.access_token;
    if (data.refresh_token) acc.refresh_token = data.refresh_token;
    acc.token_exp = jwtExp(data.access_token) || Date.now() + 3600e3;
    acc.last_error = null;
  } catch (e) {
    // refresh dead → full re-login
    await authenticate(acc);
  }
  acc.updated_at = Date.now();
  saveDb();
  return acc;
}

// Round-robin over healthy MAIN accounts; transparently falls back to reserve
// when main is empty (the replenisher will promote/refill anyway).
export async function pickReadyAccount(exclude) {
  const db = loadDb();
  const pools = ['main', 'reserve'];
  for (const pname of pools) {
    const candidates = db.accounts.filter((a) => poolOf(a) === pname && isHealthy(a) && !(exclude && exclude.has(a.id)));
    const start = rr;
    for (let i = 0; i < candidates.length; i++) {
      const acc = candidates[(start + i) % candidates.length];
      try {
        await ensureToken(acc);
        rr = (start + i + 1) % Math.max(candidates.length, 1);
        return acc;
      } catch (e) {
        acc.last_error = e.message;
        saveDb();
        log('warn', `account ${acc.username} auth failed: ${e.message}`);
      }
    }
  }
  throw Object.assign(new Error('no healthy upstream accounts in pool'), { status: 503 });
}

export function getAccount(id) {
  return loadDb().accounts.find((a) => a.id === id) || null;
}

export async function refreshAccountInfo(acc) {
  try { acc.me = await getMe(acc); acc.last_error = null; }
  catch (e) { acc.last_error = e.message; }
  acc.updated_at = Date.now();
  saveDb();
  return acc;
}

export function markResult(acc, ok) {
  acc.stats = acc.stats || { requests: 0, failures: 0 };
  acc.stats.requests++;
  if (!ok) acc.stats.failures++;
  saveDb();
}

// quota exhausted / account dead → retire into the spent pool
export function markSpent(acc, reason) {
  acc.pool = 'spent';
  acc.enabled = false;
  acc.last_error = reason || 'quota exhausted';
  acc.updated_at = Date.now();
  saveDb();
  log('info', `account ${acc.username} retired to spent (${acc.last_error})`);
}

export function setPool(acc, pool) {
  acc.pool = pool;
  if (pool !== 'spent') acc.enabled = true;
  acc.updated_at = Date.now();
  saveDb();
  log('info', `account ${acc.username} moved to ${pool}`);
}

// Detect quota/limit errors from upstream payloads.
export function isQuotaError(e) {
  const code = e?.data?.detail?.error_code || e?.data?.error_code || '';
  const msg = `${code} ${e?.message || ''}`.toLowerCase();
  return /quota|insufficient|credit|limit|exceed|daily/.test(msg) && !/rate.?limit/i.test(code);
}
