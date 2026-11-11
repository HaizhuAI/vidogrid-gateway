import crypto from 'node:crypto';
import { config } from './config.js';

// Port of vidogrid.ai's antibot guard-token generator (recovered from DBHG8pRd.js):
//   payload = ver(1B) || sha256hex(key:stableId)[0:16B] || timeBucket(4B BE)
//             || sha256hex(path:METHOD:c:tb:key)(32B) || domFp(32B)
//   x-guard-id = base64url(payload, no padding)

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hexToBytes = (h) => Buffer.from(h, 'hex');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

let timeOffsetMs = 0;
let lastSync = 0;

export function serverNow() {
  return Date.now() + timeOffsetMs;
}

// Mirror of the site's bootstrap time-sync: GET /health, read X-Server-Time or Date.
export async function syncServerTime(force = false) {
  if (!force && Date.now() - lastSync < 5 * 60 * 1000) return timeOffsetMs;
  try {
    const t0 = Date.now();
    const r = await fetch(config.healthUrl, { method: 'GET', signal: AbortSignal.timeout(10000) });
    const rttEnd = Date.now();
    const xs = r.headers.get('x-server-time');
    let serverMs = null;
    if (xs) serverMs = parseInt(xs, 10);
    else {
      const d = r.headers.get('date');
      if (d) serverMs = new Date(d).getTime();
    }
    if (serverMs && Number.isFinite(serverMs)) {
      timeOffsetMs = serverMs - Math.floor((t0 + rttEnd) / 2);
      lastSync = Date.now();
    }
  } catch {
    // keep local clock
  }
  return timeOffsetMs;
}

export function newStableId() {
  // 22-char base64url, matching [A-Za-z0-9_-]{22} validated by the client
  return b64url(crypto.randomBytes(17)).slice(0, 22);
}

export function newDomFp() {
  // browsers produce a 64-char hex DOM fingerprint; any stable 64-hex works
  return sha256hex('domfp:' + crypto.randomBytes(16).toString('hex'));
}

export function guardId(path, method, { stableId, domFp }) {
  const key = config.antibotKey;
  const c = sha256hex(`${key}:${stableId}`).slice(0, 32);
  const tb = Math.floor(serverNow() / 60000);
  const l = sha256hex(`${path}:${String(method).toUpperCase()}:${c}:${tb}:${key}`);
  const tbBytes = Buffer.alloc(4);
  tbBytes.writeUInt32BE(tb >>> 0);
  return b64url(Buffer.concat([
    Buffer.from([1]),
    hexToBytes(c),
    tbBytes,
    hexToBytes(l),
    hexToBytes((domFp || '').padEnd(64, '0').slice(0, 64)),
  ]));
}
