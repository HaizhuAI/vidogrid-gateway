import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const DB_FILE = path.join(config.dataDir, 'db.json');

const DEFAULT_DB = {
  accounts: [],      // {id, username, password, enabled, access_token, refresh_token, token_exp, stable_id, dom_fp, me, last_error, created_at, updated_at}
  apikeys: [],       // {id, key_hash, key_preview, name, enabled, models:[]|null, created_at, last_used_at, usage_count}
  models: {},        // {modelName: {enabled}}
  jobs: [],          // {id, key_id, account_id, upstream_uuid, model, params, status, upstream_status, video_url, error, created_at, updated_at}
  logs: [],          // {ts, level, msg, meta}
  sessions: {},      // {token: exp}
  settings: {},      // {default_turnstile_token}
};

let db = null;
let saveTimer = null;

export function loadDb() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    db = structuredClone(DEFAULT_DB);
  }
  for (const k of Object.keys(DEFAULT_DB)) if (db[k] === undefined) db[k] = structuredClone(DEFAULT_DB[k]);
  return db;
}

function writeDb() {
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    // Windows: transient EPERM when a reader holds the file — write direct
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1)); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

export function saveDb() {
  if (!db) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeDb, 150);
}

export function saveDbNow() {
  if (!db) return;
  clearTimeout(saveTimer);
  writeDb();
}

export function log(level, msg, meta = null) {
  const d = loadDb();
  d.logs.push({ ts: Date.now(), level, msg, meta });
  if (d.logs.length > 500) d.logs.splice(0, d.logs.length - 500);
  saveDb();
}
