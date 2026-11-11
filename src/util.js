import crypto from 'node:crypto';

export const randId = (prefix, bytes = 16) => `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;
export const randToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Requested-With',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    ...headers,
  });
  res.end(body);
}

export function openaiError(res, status, message, type = 'invalid_request_error', code = null) {
  sendJson(res, status, { error: { message, type, code } });
}

export async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
}

// Minimal multipart/form-data parser: returns { fields: {name: string}, files: [{name, filename, type, data}] }
export function parseMultipart(req, boundary) {
  return readBody(req).then((buf) => {
    const delim = Buffer.from('--' + boundary);
    const out = { fields: {}, files: [] };
    let pos = buf.indexOf(delim);
    while (pos !== -1) {
      const start = pos + delim.length;
      if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // "--" end
      let s = start;
      if (buf[s] === 0x0d && buf[s + 1] === 0x0a) s += 2;
      const headEnd = buf.indexOf('\r\n\r\n', s);
      if (headEnd === -1) break;
      const head = buf.slice(s, headEnd).toString('utf8');
      const next = buf.indexOf(delim, headEnd + 4);
      if (next === -1) break;
      const data = buf.slice(headEnd + 4, next - 2); // strip trailing CRLF
      const name = /name="([^"]*)"/.exec(head)?.[1];
      const filename = /filename="([^"]*)"/.exec(head)?.[1];
      const type = /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim();
      if (filename !== undefined && filename !== '') {
        out.files.push({ name, filename, type: type || 'application/octet-stream', data });
      } else if (name) {
        out.fields[name] = data.toString('utf8');
      }
      pos = next;
    }
    return out;
  });
}

export const bearerToken = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

export const parseCookies = (req) => {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
};

// Resolve an "image" input (URL, data URI, or {url}/{b64_json} object) to bytes.
export async function resolveImageInput(input, timeout = 30000) {
  if (!input) return null;
  if (Buffer.isBuffer(input)) return { data: input, filename: 'image.png', type: 'image/png' };
  if (typeof input === 'object' && input.b64_json) {
    return { data: Buffer.from(input.b64_json, 'base64'), filename: input.filename || 'image.png', type: input.type || 'image/png' };
  }
  const url = typeof input === 'string' ? input : input.url;
  if (!url) return null;
  if (url.startsWith('data:')) {
    const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) return null;
    const type = m[1] || 'image/png';
    const data = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    return { data, filename: 'image.' + (type.split('/')[1] || 'png'), type };
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if (!r.ok) throw Object.assign(new Error(`failed to fetch image: HTTP ${r.status}`), { status: 400 });
  const type = r.headers.get('content-type')?.split(';')[0] || 'image/png';
  const ext = (url.split('?')[0].split('.').pop() || type.split('/')[1] || 'png').slice(0, 8);
  return { data: Buffer.from(await r.arrayBuffer()), filename: `image.${ext}`, type };
}
