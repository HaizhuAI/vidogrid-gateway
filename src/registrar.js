import crypto from 'node:crypto';
import { loadDb, saveDb, log } from './store.js';
import { signup, login, getMe } from './upstream.js';
import { newStableId, newDomFp } from './antibot.js';
import { agentFor, pickProxy } from './proxy.js';

// ---------------------------------------------------------------------------
// Account registrar — POST /api/signup takes {email, full_name, password} and
// returns a live access_token: no captcha, no email verification gate. That
// makes account supply a pure HTTP loop. Identities are synthetic; optionally
// a tempmail-hub (see TEMPMAIL_HUB_URL) can vend real inboxes for the address.
// ---------------------------------------------------------------------------

const FIRST = ['alex','ben','chris','dan','eli','finn','gabe','hugo','ivan','jack','kai','leo','max','noah','owen','paul','quentin','ryan','sam','tom','uma','victor','will','xander','yuri','zack','anna','bella','cora','dina','emma','fiona','gina','hana','iris','jane','kate','lily','mia','nina','olivia','petra','rosa','sara','tina','vera','wanda','yara','zoe'];
const LAST = ['adler','baker','carter','doyle','evans','fisher','grant','hayes','ingram','jones','keller','lewis','moore','norris','owens','parker','quinn','reed','stone','turner','urban','vance','walker','young','zimmer'];
const DOMAINS_DEFAULT = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'proton.me', 'icloud.com'];

const rnd = (arr) => arr[crypto.randomInt(arr.length)];
const rndStr = (n, alpha = 'abcdefghijklmnopqrstuvwxyz0123456789') =>
  Array.from({ length: n }, () => alpha[crypto.randomInt(alpha.length)]).join('');

export function genIdentity(domains) {
  const doms = Array.isArray(domains) && domains.length ? domains : DOMAINS_DEFAULT;
  const first = rnd(FIRST), last = rnd(LAST);
  const local = `${first}${last}${rndStr(4)}`.toLowerCase();
  return {
    email: `${local}@${rnd(doms)}`,
    full_name: `${first[0].toUpperCase()}${first.slice(1)} ${last[0].toUpperCase()}${last.slice(1)}`,
    password: `Vg!${rndStr(10)}x${crypto.randomInt(90) + 10}`,
  };
}

// Optional real-inbox source: a tempmail-hub instance (see D:\Devin\tempmail-hub)
// exposes POST /api/inboxes {provider:"auto"} → {id, address}.
export async function tempmailAddress(hubUrl) {
  const r = await fetch(`${hubUrl.replace(/\/$/, '')}/api/inboxes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'auto' }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`tempmail-hub HTTP ${r.status}`);
  const d = await r.json();
  const addr = d.address || d.email || d.data?.address;
  if (!addr) throw new Error('tempmail-hub: no address in response');
  return { address: addr, inbox_id: d.id || d.inbox_id || null };
}

let lastRegisterAt = 0;
let dayStamp = new Date().toDateString();
let dayCount = 0;
export function registerNextAllowedAt() {
  return loadDb().settings.register_next_at || 0;
}
function setRegisterCooldown(ms) {
  const db = loadDb();
  db.settings.register_next_at = Date.now() + ms;
  saveDb();
}

export function registrarStats() {
  if (new Date().toDateString() !== dayStamp) { dayStamp = new Date().toDateString(); dayCount = 0; }
  return { today: dayCount, last_at: lastRegisterAt || null, next_allowed_at: registerNextAllowedAt() || null };
}

// Register ONE upstream account end-to-end: signup → login (refresh token) → /me.
// Returns the stored account row. Throws UpstreamError on failure.
export async function registerOne(settings = {}) {
  const dailyCap = settings.daily_cap ?? 200;
  if (new Date().toDateString() !== dayStamp) { dayStamp = new Date().toDateString(); dayCount = 0; }
  if (dayCount >= dailyCap) throw Object.assign(new Error(`daily registration cap reached (${dailyCap})`), { status: 429 });
  const nextAt = registerNextAllowedAt();
  if (Date.now() < nextAt && !settings.proxy_url && !(settings.proxies || []).length) {
    throw Object.assign(new Error(`upstream signup rate-limited until ${new Date(nextAt).toISOString()} — configure proxies to bypass`), { status: 429 });
  }

  const gap = settings.min_interval_ms ?? 3000;
  const wait = gap - (Date.now() - lastRegisterAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  let inbox = null;
  let id;
  if (settings.tempmail_hub_url) {
    try {
      inbox = await tempmailAddress(settings.tempmail_hub_url);
      id = genIdentity(settings.email_domains);
      id.email = inbox.address;
    } catch (e) {
      log('warn', `tempmail-hub failed (${e.message}) — synthetic address`);
      id = genIdentity(settings.email_domains);
    }
  } else {
    id = genIdentity(settings.email_domains);
  }

  const proxy = pickProxy(settings);          // sticky egress IP for this account
  const dispatcher = agentFor(proxy);
  let res;
  try {
    res = await signup(id.email, id.full_name, id.password, {}, { dispatcher });
  } catch (e) {
    if (e.status === 429 && e.retry_after_ms) {
      setRegisterCooldown(e.retry_after_ms);
      log('warn', `signup rate-limited — next attempt after ${new Date(registerNextAllowedAt()).toISOString()} (proxies bypass this)`);
    }
    throw e;
  }
  lastRegisterAt = Date.now();
  dayCount++;

  const db = loadDb();
  const acc = {
    id: 'acc_' + crypto.randomBytes(8).toString('hex'),
    username: id.email,
    password: id.password,
    enabled: true,
    notes: inbox?.inbox_id ? `tempmail:${inbox.inbox_id}` : 'auto-registered',
    pool: settings.register_into || 'reserve',
    proxy: proxy || null,
    access_token: res.access_token || null,
    refresh_token: res.refresh_token || null,
    token_exp: res.access_token ? jwtExp(res.access_token) : 0,
    stable_id: newStableId(),
    dom_fp: newDomFp(),
    me: null,
    last_error: null,
    stats: { requests: 0, failures: 0 },
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  db.accounts.push(acc);
  saveDb();

  // signup's refresh_token is null → do a full login for a durable session.
  // keep the whole flow on the same egress IP to avoid account linking.
  try {
    const l = await login(acc.username, acc.password, { dispatcher });
    acc.access_token = l.access_token;
    acc.refresh_token = l.refresh_token || acc.refresh_token;
    acc.token_exp = jwtExp(l.access_token) || acc.token_exp;
  } catch (e) {
    acc.last_error = `post-signup login: ${e.message}`;
  }
  try { acc.me = await getMe(acc, { dispatcher }); } catch { /* non-fatal */ }
  acc.updated_at = Date.now();
  saveDb();

  log('info', `registered upstream account ${acc.username} (pool=${acc.pool}, quota=${quotaOf(acc)})`);
  return acc;
}

const jwtExp = (t) => {
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp * 1000; }
  catch { return 0; }
};

export const quotaOf = (acc) => {
  const v = acc?.me?.remaining_bulk_videos;
  return typeof v === 'number' ? v : null;
};

// Register N accounts with jitter between attempts; continues past single
// failures and reports per-account results.
export async function registerBatch(n, settings = {}) {
  const out = { ok: [], failed: [] };
  for (let i = 0; i < n; i++) {
    try {
      out.ok.push(await registerOne(settings));
    } catch (e) {
      out.failed.push(e.message);
      log('warn', `register ${i + 1}/${n} failed: ${e.message}`);
      if (/cap reached/i.test(e.message)) break;
      // 429 with proxies configured → only that exit burned; try next proxy.
      // 429 direct → upstream says retry_after hours out; stop the batch.
      const hasProxy = !!(settings.proxy_url || (settings.proxies || []).length);
      if (e.status === 429 && !hasProxy) break;
      await new Promise((r) => setTimeout(r, 5000 + crypto.randomInt(5000)));
      continue;
    }
    if (i + 1 < n) await new Promise((r) => setTimeout(r, (settings.jitter_ms ?? 4000) + crypto.randomInt(4000)));
  }
  return out;
}
