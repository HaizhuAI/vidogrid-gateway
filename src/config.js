import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// .env loader (no deps)
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

export const config = {
  port: parseInt(process.env.PORT || '8188', 10),
  host: process.env.HOST || '0.0.0.0',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  // independent management bearer — full /admin/api + /v1 access
  masterKey: process.env.MASTER_KEY || '',
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  upstreamBase: (process.env.UPSTREAM_BASE || 'https://api.vidogrid.ai/api').replace(/\/$/, ''),
  healthUrl: (process.env.UPSTREAM_BASE || 'https://api.vidogrid.ai/api').replace(/\/api\/?$/, '') + '/health',
  // reverse-engineered from vidogrid.ai web bundle (D0sjclYU.js / DBHG8pRd.js)
  antibotSalt: process.env.ANTIBOT_SALT || '&vTQm0&u',
  antibotKey: process.env.ANTIBOT_KEY || '45NPBH$&',
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '120000', 10),
  sessionTtlMs: parseInt(process.env.SESSION_TTL_MS || '86400000', 10),
  userAgent: process.env.UPSTREAM_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

fs.mkdirSync(config.dataDir, { recursive: true });
