import { config } from './config.js';
import { guardId, syncServerTime } from './antibot.js';
import { dispatcherFor } from './proxy.js';

// Thin client for api.vidogrid.ai — mirrors the web app's apiService axios instance:
// every request carries  Authorization: Bearer <jwt>  +  x-guard-id: <antibot token>.

export class UpstreamError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status || 502;
    this.data = data;
  }
}

function authHeaders(account, path, method, extra = {}) {
  return {
    Authorization: `Bearer ${account.access_token}`,
    'x-guard-id': guardId(path, method, { stableId: account.stable_id, domFp: account.dom_fp }),
    'User-Agent': config.userAgent,
    Accept: 'application/json',
    ...extra,
  };
}

// path must be the API path WITHOUT the /api prefix, e.g. '/video-gen/meta'
async function upstreamFetch(account, path, { method = 'GET', body, headers = {}, timeout, dispatcher } = {}) {
  await syncServerTime();
  const signedPath = `/api${path}`;
  const d = dispatcher || dispatcherFor(account); // sticky per-account egress
  const res = await fetch(`${config.upstreamBase}${path}`, {
    method,
    headers: authHeaders(account, signedPath, method, headers),
    body,
    signal: AbortSignal.timeout(timeout ?? config.requestTimeout),
    ...(d ? { dispatcher: d } : {}),
  });
  return res;
}

async function upstreamJson(account, path, opts = {}) {
  const res = await upstreamFetch(account, path, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
  if (!res.ok) {
    const detail = data?.detail;
    const msg = detail?.error_message || detail?.error_code || data?.message || `upstream HTTP ${res.status}`;
    throw new UpstreamError(msg, res.status, data);
  }
  return data;
}

// POST /api/signup {email,full_name,password} — no captcha, no email
// verification gate; returns {access_token, refresh_token:null}.
// Hard IP rate limit (~1/3h): pass a per-attempt proxy dispatcher to scale.
// Re-login via /login-v2 afterwards to obtain a refresh_token.
export async function signup(email, fullName, password, extra = {}, { dispatcher } = {}) {
  await syncServerTime();
  const res = await fetch(`${config.upstreamBase}/signup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-guard-id': guardId('/api/signup', 'post', { stableId: 'gw' + Math.random().toString(36).slice(2, 21), domFp: '0'.repeat(64) }),
      'User-Agent': config.userAgent,
      Accept: 'application/json',
    },
    body: JSON.stringify({ email, full_name: fullName, password, ...extra }),
    signal: AbortSignal.timeout(30000),
    ...(dispatcher ? { dispatcher } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data?.detail;
    const msg = Array.isArray(d) ? d.map((x) => `${x.loc?.join('.')}:${x.msg}`).join('; ')
      : (d?.error_message || d?.error_code || `signup failed HTTP ${res.status}`);
    const err = new UpstreamError(msg, res.status, data);
    const ra = res.headers.get('retry-after') || d?.retry_after;
    if (ra && /^\d+$/.test(ra)) err.retry_after_ms = parseInt(ra, 10) * 1000;
    throw err;
  }
  return data; // {access_token, refresh_token}
}

export async function login(username, password, { dispatcher } = {}) {
  await syncServerTime();
  // login is unauthenticated but still guard-signed (signed path = '/api/login-v2')
  const body = JSON.stringify({ username, password, remember_me: true, platform: 'WEB' });
  const res = await fetch(`${config.upstreamBase}/login-v2`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-guard-id': guardId('/api/login-v2', 'post', { stableId: 'gw' + Math.random().toString(36).slice(2, 21), domFp: '0'.repeat(64) }),
      'User-Agent': config.userAgent,
      Accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(30000),
    ...(dispatcher ? { dispatcher } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data?.detail;
    throw new UpstreamError(d?.error_message || d?.error_code || `login failed HTTP ${res.status}`, res.status, data);
  }
  return data; // {access_token, refresh_token, ...}
}

export async function refreshToken(account, { dispatcher } = {}) {
  const d = dispatcher || dispatcherFor(account);
  const res = await fetch(`${config.upstreamBase}/refresh-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-guard-id': guardId('/api/refresh-token', 'post', { stableId: account.stable_id, domFp: account.dom_fp }),
      'User-Agent': config.userAgent,
      Accept: 'application/json',
    },
    body: JSON.stringify({ refresh_token: account.refresh_token }),
    signal: AbortSignal.timeout(30000),
    ...(d ? { dispatcher: d } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data?.detail;
    throw new UpstreamError(d?.error_message || d?.error_code || `refresh failed HTTP ${res.status}`, res.status, data);
  }
  return data;
}

export const getMe = (account, opts = {}) => upstreamJson(account, '/me', opts);

export const getHistory = (account, uuid) => upstreamJson(account, `/history/${uuid}`);

export const getServicePrices = () =>
  fetch(`${config.upstreamBase}/service-prices`, { signal: AbortSignal.timeout(20000) })
    .then((r) => (r.ok ? r.json() : []));

// fields: [{name, value}], fileParts: [{field, data, filename, type}]
export async function generateVideo(account, endpoint, fields, fileParts, timeout) {
  const form = new FormData();
  for (const f of fields) form.append(f.name, f.value);
  for (const fp of fileParts || []) {
    form.append(fp.field, new Blob([fp.data], { type: fp.type || 'application/octet-stream' }), fp.filename || 'image.png');
  }
  const res = await upstreamFetch(account, endpoint, { method: 'POST', body: form, timeout: timeout ?? 180000 });
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('text/event-stream')) {
    const text = await res.text();
    return { sse: true, status: res.status, events: parseSse(text), raw: text };
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
  if (!res.ok) {
    const detail = data?.detail;
    const msg = detail?.error_message || detail?.error_code || data?.message ||
      `upstream HTTP ${res.status} ${text.slice(0, 200)}`;
    throw new UpstreamError(msg, res.status, data);
  }
  return data;
}

export function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = 'message';
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    const raw = dataLines.join('\n');
    let data = raw;
    try { data = JSON.parse(raw); } catch { /* keep raw */ }
    events.push({ event, data });
  }
  return events;
}
