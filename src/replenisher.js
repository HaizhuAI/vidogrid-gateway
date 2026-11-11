import { loadDb, saveDb, log } from './store.js';
import { config } from './config.js';
import { registerBatch, registrarStats, quotaOf, registerNextAllowedAt } from './registrar.js';
import { ensureToken, refreshAccountInfo, isHealthy, poolOf, markSpent, setPool, poolStats } from './pool.js';

// ---------------------------------------------------------------------------
// Replenisher — keeps the main pool stocked:
//   every interval: refresh stale /me quota → spent-out exhausted mains →
//   promote healthy reserves → register new accounts into reserve/main until
//   thresholds hold. Reserve is topped to reserve_target for burst cover.
// All knobs live in db.settings.replenisher (editable from the WebUI).
// ---------------------------------------------------------------------------

export const REPL_DEFAULTS = {
  enabled: process.env.REPL_ENABLED === '1',
  interval_sec: 120,
  main_min: 3,          // alert/trigger threshold
  main_target: 5,       // top main up to this many healthy accounts
  reserve_target: 10,   // keep this many healthy standbys
  batch_size: 3,        // max registrations per cycle
  daily_cap: 200,
  min_interval_ms: 3000,
  jitter_ms: 4000,
  register_into: 'reserve',
  email_domains: ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com'],
  tempmail_hub_url: process.env.TEMPMAIL_HUB_URL || '', // optional real-inbox source
  proxy_url: '',        // single rotating-gateway proxy (e.g. http://user:pass@gw:port)
  proxies: [],          // static proxy list, rotated per registration
  refresh_stale_sec: 900,
};

export function replSettings() {
  const db = loadDb();
  db.settings.replenisher = { ...REPL_DEFAULTS, ...(db.settings.replenisher || {}) };
  return db.settings.replenisher;
}

let timer = null;
let running = false;

const stale = (acc, ms) => !acc.updated_at || Date.now() - acc.updated_at > ms || !acc.me;

async function refreshQuotas(settings) {
  const db = loadDb();
  const ms = (settings.refresh_stale_sec ?? 900) * 1000;
  const due = db.accounts.filter((a) => poolOf(a) !== 'spent' && a.enabled && stale(a, ms)).slice(0, 8);
  for (const acc of due) {
    try {
      await ensureToken(acc);
      await refreshAccountInfo(acc);
      const q = quotaOf(acc);
      if (q === 0) markSpent(acc, 'quota 0 (me refresh)');
    } catch (e) {
      acc.last_error = e.message;
      saveDb();
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

export async function replenishCycle({ force = false } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  const settings = replSettings();
  const db = loadDb();
  const result = { promoted: 0, registered: 0, retired: 0, failed: [] };
  try {
    await refreshQuotas(settings);
    let stats = poolStats();

    // promote healthy reserves into main until target
    const needMain = Math.max(0, (settings.main_target ?? 5) - stats.main.healthy);
    if (needMain > 0) {
      const res = db.accounts.filter((a) => poolOf(a) === 'reserve' && isHealthy(a)).slice(0, needMain);
      for (const acc of res) { setPool(acc, 'main'); result.promoted++; }
      stats = poolStats();
    }

    // register to hit main target, then to fill reserve
    let deficit = Math.max(0, (settings.main_target ?? 5) - stats.main.healthy)
                + Math.max(0, (settings.reserve_target ?? 10) - stats.reserve.healthy);
    const belowMin = stats.main.healthy < (settings.main_min ?? 3);
    const hasProxy = !!(settings.proxy_url || (settings.proxies || []).length);
    const cooling = Date.now() < registerNextAllowedAt();
    if (cooling && !hasProxy) result.cooling_until = new Date(registerNextAllowedAt()).toISOString();
    if (deficit > 0 && (belowMin || force || stats.reserve.healthy < (settings.reserve_target ?? 10)) && !(cooling && !hasProxy)) {
      const n = Math.min(deficit, settings.batch_size ?? 3);
      log('info', `replenish: main ${stats.main.healthy}/${settings.main_target} reserve ${stats.reserve.healthy}/${settings.reserve_target} → registering ${n}`);
      const r = await registerBatch(n, settings);
      result.registered = r.ok.length;
      result.failed = r.failed;
      // fresh regs that still can't cover main → promote immediately
      stats = poolStats();
      const stillNeed = Math.max(0, (settings.main_target ?? 5) - stats.main.healthy);
      if (stillNeed > 0) {
        const res2 = db.accounts.filter((a) => poolOf(a) === 'reserve' && isHealthy(a)).slice(0, stillNeed);
        for (const acc of res2) { setPool(acc, 'main'); result.promoted++; }
      }
    }
    result.stats = poolStats();
    return result;
  } finally {
    running = false;
    saveDb();
  }
}

let lastRun = 0;

export function startReplenisher() {
  const tick = async () => {
    const s = replSettings();
    if (!s.enabled) return;
    if (Date.now() - lastRun < (s.interval_sec ?? 120) * 1000) return;
    lastRun = Date.now();
    try { await replenishCycle(); } catch (e) { log('warn', `replenisher cycle failed: ${e.message}`); }
  };
  timer = setInterval(tick, 15000);
  tick();
}

export function replStatus() {
  return { settings: replSettings(), stats: poolStats(), registrar: registrarStats(), running };
}
