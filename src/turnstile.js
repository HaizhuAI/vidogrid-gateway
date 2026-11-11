import puppeteer from 'puppeteer-core';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './store.js';

// ---------- solver-service providers (Capsolver / 2captcha) ----------
// Set CAPSOLVER_KEY or TWOCAPTCHA_KEY in env/.env — tokens cost ~$0.003.
const SITEKEY = '0x4AAAAAAFP77FGFA7z9m71b';
const SOLVE_ORIGIN = process.env.TURNSTILE_ORIGIN || 'https://vidogrid.ai';

async function solveViaCapsolver(key) {
  const create = await fetch('https://api.capsolver.com/createTask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: key,
      task: { type: 'AntiTurnstileTaskProxyLess', websiteURL: SOLVE_ORIGIN + '/', websiteKey: SITEKEY },
    }),
  }).then((r) => r.json());
  if (create.errorId) throw new Error(`capsolver createTask: ${create.errorCode} ${create.errorDescription}`);
  const taskId = create.taskId;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch('https://api.capsolver.com/getTaskResult', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: key, taskId }),
    }).then((r) => r.json());
    if (res.status === 'ready') return res.solution.token;
    if (res.status === 'failed' || res.errorId) throw new Error(`capsolver failed: ${res.errorCode || ''} ${res.errorDescription || ''}`);
  }
  throw new Error('capsolver timeout');
}

async function solveVia2Captcha(key) {
  const q = new URLSearchParams({
    key, method: 'turnstile', sitekey: SITEKEY, pageurl: SOLVE_ORIGIN + '/', json: '1',
  });
  const create = await fetch(`https://2captcha.com/in.php?${q}`).then((r) => r.json());
  if (create.status !== 1) throw new Error(`2captcha in.php: ${create.request}`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`https://2captcha.com/res.php?key=${key}&action=get&id=${create.request}&json=1`).then((r) => r.json());
    if (res.status === 1) return res.request;
    if (res.request !== 'CAPCHA_NOT_READY') throw new Error(`2captcha: ${res.request}`);
  }
  throw new Error('2captcha timeout');
}

// ---------- manual token inbox ----------
// admin pastes a token minted in their own browser → consumed by pending mints
const manualTokens = [];
export function submitManualToken(token) { manualTokens.push({ token, at: Date.now() }); }
function popManualToken() {
  while (manualTokens.length) {
    const t = manualTokens.shift();
    if (Date.now() - t.at < 4 * 60 * 1000) return t.token; // tokens live ~5min
  }
  return null;
}

// Mints real Cloudflare Turnstile tokens by driving vidogrid.ai's OWN flow:
//   log in via the site UI → open the muse page → fill prompt → click
//   "GENERATE VIDEO" → the site renders its own turnstile modal → we
//   hook turnstile.render's callback to capture the token, and abort the
//   site's outbound /api/video-gen/* request so the token stays unconsumed.
// Interactive checkboxes get a CDP mouse click at the widget's checkbox.
// Token validity ~5min, single use — minted on demand per generation.

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ORIGIN = process.env.TURNSTILE_ORIGIN || 'https://vidogrid.ai';
const PAGE_URL = `${ORIGIN}/app/video-gen/muse`;
const TIMEOUT = parseInt(process.env.TURNSTILE_TIMEOUT_MS || '180000', 10);
const HEADFUL = process.env.TURNSTILE_HEADLESS !== '1';

let browser = null;
let page = null;
let launching = null;
let queue = Promise.resolve();
let creds = null; // {username, password} for site login
let allowGenRequests = false; // site-flow submission gate

export function setSiteCredentials(username, password) {
  creds = { username, password };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  // CDP connect mode: attach to a real Chrome started with
  //   chrome.exe --remote-debugging-port=9222
  // uses the user's real browser reputation → much higher CF pass rate
  const cdp = process.env.TURNSTILE_CDP_URL;
  if (cdp) {
    browser = await puppeteer.connect({ browserURL: cdp, defaultViewport: null });
    page = await browser.newPage();
    await setupPage(page);
    log('info', 'turnstile attached to CDP browser ' + cdp);
    return;
  }
  // use the machine's HTTP proxy (Clash etc.) — direct connections land on a
  // fake-IP TUN path where the CF challenge iframe never finishes loading
  // TURNSTILE_NET=direct → all traffic direct (bypasses the flagged proxy
  // exit IP); otherwise api.vidogrid.ai goes DIRECT and the rest via proxy
  // (that host 500s when proxied)
  let proxy = process.env.TURNSTILE_PROXY;
  if (proxy === undefined) {
    try {
      const { execSync } = await import('node:child_process');
      const out = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
        { encoding: 'utf8' }
      );
      const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/.test(execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        { encoding: 'utf8' }
      ));
      if (enabled && m) proxy = 'http://' + m[1];
    } catch {}
  }

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !HEADFUL,
    userDataDir: './data/chrome-profile',  // persistent: keeps cf_clearance + site session
    args: [
      // NOTE: no --disable-gpu — it kills the WebGL/canvas fingerprint and is
      // one of CF's strongest bot signals
      '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1100,850', '--window-position=40,40',
      '--lang=en-US,en',
      // local net runs through a fake-IP TUN proxy — QUIC/UDP dies → force TCP
      '--disable-quic',
      ...(proxy ? [`--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(
        `function FindProxyForURL(url,host){` +
        (process.env.TURNSTILE_NET === 'direct'
          ? `return"DIRECT";`
          : `if(host==="api.vidogrid.ai"||host==="supabase.vidogrid.ai")return"DIRECT";` +
            `return"PROXY ${proxy.replace(/^https?:\/\//, '')}";`) +
        `}`).toString('base64')}`] : []),
      ...(process.env.TURNSTILE_PIN_CF === '1'
        ? ['--host-resolver-rules=MAP challenges.cloudflare.com 104.18.94.41']
        : []),
    ],
  });
  if (proxy) log('info', 'turnstile browser using proxy ' + proxy);
  page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  await setupPage(page);
}

// ---------- site-flow generation ----------
// Runs the REAL site end-to-end in the browser: fill prompt, click
// GENERATE VIDEO, let the site's own JS solve turnstile + sign x-guard-id +
// submit /api/video-gen/*. We capture the response json ({uuid}) as the
// result — no token replay, nothing for CF to flag beyond the typing/click.

const pendingGens = new Map(); // response url suffix -> resolver

async function setupPage(page) {
  // capture generation responses (the site's own submissions)
  page.on('response', async (res) => {
    try {
      const u = res.url();
      if (!u.includes('/api/video-gen/')) return;
      for (const [suffix, r] of pendingGens) {
        if (u.includes(suffix)) {
          pendingGens.delete(suffix);
          try { r.resolve(await res.json()); } catch { r.resolve(await res.text()); }
        }
      }
    } catch {}
  });

  // minimal footprint: only hide webdriver. Heavy spoofing (fake plugins/
  // chrome runtime/turnstile hooks injected before api.js) makes CF's api.js
  // bail before assigning window.turnstile — learned the hard way.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // abort the site's generation calls during TOKEN MINTING (keeps tokens
  // unconsumed); when doing a real site-flow submission we let it through
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if ((u.includes('/api/video-gen/') || u.includes('/api/video-extend/')) && !allowGenRequests) r.abort();
    else r.continue();
  });
  page.on('requestfailed', (r) => {
    if (r.url().includes('cloudflare') || r.url().includes('turnstile'))
      log('warn', 'CF req failed: ' + r.url().slice(0, 120) + ' ' + (r.failure()?.errorText || ''));
  });
  page.on('response', (r) => {
    if (r.url().includes('challenges.cloudflare.com'))
      log('info', 'CF ' + r.status() + ' ' + r.url().slice(0, 130));
  });

  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
}

async function ensureBrowser() {
  if (page && !page.isClosed() && browser?.connected) return;
  if (!launching) launching = launch().finally(() => { launching = null; });
  await launching;
}

async function isLoggedIn() {
  try {
    return await page.evaluate(() => {
      const s = localStorage.getItem('authStore');
      return !!(s && JSON.parse(s).access_token);
    });
  } catch { return false; }
}

async function siteLogin() {
  if (!creds) throw new Error('no site credentials for turnstile browser');
  await page.goto(ORIGIN + '/auth/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('input', { timeout: 30000 });
  await sleep(1200);
  const filled = await page.evaluate(({ u, p }) => {
    const ins = [...document.querySelectorAll('input')];
    const userIn = ins.find(i => /email|user|name|account/i.test(i.type + ' ' + (i.name || '') + ' ' + (i.placeholder || ''))) || ins.find(i => i.type === 'text' || i.type === 'email');
    const passIn = ins.find(i => i.type === 'password');
    if (!userIn || !passIn) return false;
    const set = (el, v) => {
      const proto = el.constructor === HTMLInputElement ? HTMLInputElement.prototype : Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(userIn, u); set(passIn, p);
    const btn = [...document.querySelectorAll('button')].find(b => /log ?in|sign ?in|登录/i.test(b.textContent));
    if (btn) btn.click(); else passIn.closest('form')?.submit();
    return true;
  }, { u: creds.username, p: creds.password });
  if (!filled) throw new Error('login form not found');

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await isLoggedIn()) { log('info', 'site login ok'); return; }
    await sleep(800);
  }
  throw new Error('site login timed out');
}

async function clickCheckboxIn() {
  // locate the actual CF iframe inside the turnstile modal and click its
  // checkbox (left edge, vertically centered)
  const box = await page.evaluate(() => {
    const ifr = [...document.querySelectorAll('iframe')]
      .find(f => (f.src || '').includes('challenges.cloudflare.com'));
    const r = ifr?.getBoundingClientRect();
    return r && r.width ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  });
  if (!box) return false;
  const cx = box.x + 28, cy = box.y + box.h / 2;
  await page.mouse.move(cx - 50 + Math.random() * 25, cy - 25 + Math.random() * 18, { steps: 10 });
  await sleep(250);
  await page.mouse.move(cx, cy, { steps: 6 });
  await sleep(200);
  await page.mouse.click(cx, cy);
  return true;
}

async function mintToken() {
  await ensureBrowser();
  if (!(await isLoggedIn())) await siteLogin();

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => { window.__tsTokens = []; });
  await sleep(2000);

  // dismiss overlays (discord popup, cookie banners, announcements)
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => {
      // close anything that looks like a modal/popup close control
      const sels = [
        'button[aria-label*="close" i]', '[role="dialog"] button',
      ];
      for (const s of sels) for (const b of document.querySelectorAll(s)) {
        if (/close|✕|×|ok|don.t show/i.test(b.getAttribute('aria-label') || '') ||
            /^\s*(ok|✕|×|close|don.t show.*)\s*$/i.test(b.textContent || '')) b.click();
      }
      // text-based fallbacks
      for (const b of [...document.querySelectorAll('button, [role="button"], a')]) {
        const t = (b.textContent || '').trim();
        if (/^(ok|✕|×|got it|close|don.t show again)$/i.test(t) && b.offsetParent) b.click();
      }
    });
    await sleep(600);
  }

  // fill the prompt textarea then hit GENERATE VIDEO
  await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    if (ta) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, 'a cat walking in the rain');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await sleep(500);
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => /generate\s*video|生成/i.test(b.textContent) && !b.disabled);
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!clicked) throw new Error('generate button not found');

  // site should now open its turnstile modal; wait for token / click checkbox.
  // token capture: lazy render-wrapper + hidden cf-turnstile-response input.
  // after ~35s also inject a backup widget on the same origin — whichever
  // mints first wins (sitekey-only, tokens aren't request-bound)
  const deadline = Date.now() + TIMEOUT;
  const t0 = Date.now();
  let lastClick = 0;
  let backupRendered = false;
  while (Date.now() < deadline) {
    const tok = await page.evaluate(() => {
      window.__tsTokens = window.__tsTokens || [];
      if (window.turnstile && !window.turnstile.__gwWrapped) {
        try {
          const orig = window.turnstile.render.bind(window.turnstile);
          window.turnstile.render = (el, opts) => orig(el, {
            ...(opts || {}),
            callback: (t, ...a) => { window.__tsTokens.push(t); return opts?.callback?.(t, ...a); },
          });
        } catch {}
        window.turnstile.__gwWrapped = true;
      }
      return window.__tsTokens[0]
        || document.querySelector('input[name="cf-turnstile-response"]')?.value
        || null;
    });
    if (tok) return tok;

    if (!backupRendered && Date.now() - t0 > 35000) {
      backupRendered = true;
      await page.evaluate(() => {
        const d = document.createElement('div');
        d.id = 'ts-gw-backup';
        d.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999';
        document.body.appendChild(d);
        try { window.turnstile.render('#ts-gw-backup', { sitekey: '0x4AAAAAAFP77FGFA7z9m71b' }); } catch {}
      }).catch(() => {});
    }

    // after ~8s keep clicking the CF iframe checkbox every ~6s —
    // widget only accepts the click once it finishes the JS challenge stage
    if (Date.now() - t0 > 8000 && Date.now() - lastClick > 6000) {
      lastClick = Date.now();
      await clickCheckboxIn();
    }
    await sleep(600);
  }
  throw new Error('turnstile mint timeout');
}

// ---------- site-flow generation submission ----------
// Drives the real muse page end-to-end and captures the upstream response.
// opts: { prompt, orientation, fileParts: [{data, filename, type}] }
export async function submitGenerationViaSite(acc, opts = {}) {
  if (acc) setSiteCredentials(acc.username, acc.password);
  const job = queue.then(async () => {
    await ensureBrowser();
    if (!(await isLoggedIn())) await siteLogin();
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);
    await dismissOverlays();
    await setPrompt(opts.prompt || 'a cat walking in the rain');
    await setOrientation(opts.orientation);
    await uploadRefs(opts.fileParts || []);

    // arm response capture BEFORE clicking generate
    const suffix = '/video-gen/meta';
    const respP = new Promise((resolve, reject) => {
      pendingGens.set(suffix, { resolve, reject });
      setTimeout(() => { pendingGens.delete(suffix); reject(new Error('site-flow response timeout')); }, TIMEOUT);
    });

    allowGenRequests = true;
    try {
      const clicked = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
          .find(b => /generate\s*video|生成/i.test(b.textContent) && !b.disabled);
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!clicked) throw new Error('generate button not found');

      // keep the CF checkbox clickable for auto+human attempts while waiting
      const wait = (async () => {
        const t0 = Date.now();
        let lastClick = 0;
        while (true) {
          if (Date.now() - t0 > TIMEOUT) throw new Error('site-flow timeout');
          if (Date.now() - t0 > 3000 && Date.now() - lastClick > 4000) {
            lastClick = Date.now();
            await clickCheckboxIn().catch(() => {});
          }
          await sleep(500);
        }
      })();
      const res = await Promise.race([respP, wait]);
      log('info', 'site-flow generation submitted: ' + JSON.stringify(res).slice(0, 200));
      return res;
    } catch (e) {
      await dumpDiag('siteflow');
      throw e;
    } finally {
      allowGenRequests = false;
    }
  });
  queue = job.catch(() => {});
  return job;
}

async function dumpDiag(tag) {
  try {
    await page.screenshot({ path: `ts-${tag}-fail.png` });
    const st = await page.evaluate(() => ({
      url: location.href,
      iframes: [...document.querySelectorAll('iframe')].map((f) => (f.src || '').slice(0, 120)),
      ta: document.querySelector('textarea')?.value?.slice(0, 60) || null,
      modalText: [...document.querySelectorAll('div')].filter((d) => /verify you.re human|security check/i.test(d.textContent || '') && d.children.length < 8).map((d) => d.textContent.slice(0, 120)).slice(0, 3),
      turnstileType: typeof window.turnstile,
      tokens: window.__tsTokens?.length || 0,
      buttons: [...document.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => (b.textContent || '').trim().slice(0, 40)).slice(0, 15),
    })).catch((e) => ({ evalErr: e.message }));
    log('warn', `${tag} diag: ` + JSON.stringify(st).slice(0, 900));
  } catch (e) {
    log('warn', `${tag} diag failed: ${e.message}`);
  }
}

async function dismissOverlays() {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => {
      for (const b of [...document.querySelectorAll('button, [role="button"], a')]) {
        const t = (b.textContent || '').trim();
        if (/^(ok|✕|×|got it|close|don.t show again)$/i.test(t) && b.offsetParent) b.click();
      }
    }).catch(() => {});
    await sleep(600);
  }
}

async function setPrompt(prompt) {
  await page.evaluate((p) => {
    const ta = document.querySelector('textarea');
    if (!ta) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, p);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, prompt);
  await sleep(400);
}

// portrait→9:16, landscape→16:9, square→1:1 — click matching ratio control
async function setOrientation(orientation) {
  if (!orientation) return;
  const ratio = { portrait: '9:16', landscape: '16:9', square: '1:1' }[orientation];
  const labels = ratio ? [ratio, orientation] : [orientation];
  await page.evaluate((cands) => {
    const els = [...document.querySelectorAll('button, [role="button"], [role="radio"], [role="option"], label, a')];
    const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
    for (const c of cands) {
      const el = els.find((e) => {
        const t = norm(e.textContent);
        return e.offsetParent && t.length <= 18 && (t === norm(c) || t.includes(norm(c)));
      });
      if (el) { el.click(); return; }
    }
    // select dropdown fallback
    for (const sel of document.querySelectorAll('select')) {
      for (const o of sel.options) {
        if (cands.some((c) => (o.textContent || '').trim() === c || o.value === c)) {
          sel.value = o.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    }
  }, labels);
  await sleep(300);
}

async function uploadRefs(fileParts) {
  if (!fileParts.length) return;
  const inputs = await page.$$('input[type="file"]');
  if (!inputs.length) { log('warn', 'site-flow: no file input on muse page, refs skipped'); return; }
  mkdirSync('./data/ts-tmp', { recursive: true });
  for (let i = 0; i < Math.min(fileParts.length, inputs.length); i++) {
    const fp = fileParts[i];
    const tmp = join(process.cwd(), 'data/ts-tmp', `ref${i}-${fp.filename || 'image.png'}`);
    writeFileSync(tmp, fp.data);
    await inputs[i].uploadFile(tmp).catch((e) => log('warn', 'site-flow uploadFile: ' + e.message));
    await sleep(800);
  }
}

// provider chain: capsolver → 2captcha → manual inbox → local browser
export async function getTurnstileToken(acc) {
  if (acc) setSiteCredentials(acc.username, acc.password);
  const job = queue.then(async () => {
    const manual = popManualToken();
    if (manual) { log('info', 'turnstile token from manual inbox'); return manual; }
    if (process.env.CAPSOLVER_KEY) {
      try {
        const t = await solveViaCapsolver(process.env.CAPSOLVER_KEY);
        log('info', 'turnstile token via capsolver');
        return t;
      } catch (e) { log('warn', 'capsolver failed: ' + e.message); }
    }
    if (process.env.TWOCAPTCHA_KEY) {
      try {
        const t = await solveVia2Captcha(process.env.TWOCAPTCHA_KEY);
        log('info', 'turnstile token via 2captcha');
        return t;
      } catch (e) { log('warn', '2captcha failed: ' + e.message); }
    }
    const t = await mintToken();
    log('info', 'turnstile token minted via site flow');
    return t;
  }).catch(async (e) => {
    log('warn', 'turnstile mint failed: ' + e.message);
    try { await page?.screenshot({ path: 'ts-fail.png' }); } catch {}
    throw e;
  });
  queue = job.catch(() => {});
  return job;
}

export async function closeBrowser() {
  try { await browser?.close(); } catch {}
  browser = null; page = null;
}
