import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { loadDb } from './store.js';
import { syncServerTime } from './antibot.js';
import { handleOpenai } from './routes_openai.js';
import { handleAdmin } from './routes_admin.js';
import { startReplenisher } from './replenisher.js';
import { sendJson } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBUI = fs.readFileSync(path.join(__dirname, 'webui.html'));

loadDb();
syncServerTime(true).then((o) => console.log(`[antibot] time offset ${o}ms`));
setInterval(() => syncServerTime(true), 4 * 60 * 1000);
startReplenisher();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'OPTIONS') return sendJson(res, 200, {});

    if (url.pathname === '/' || url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, service: 'vidogrid-gateway', time: Date.now() });
    }
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(WEBUI);
    }
    if (url.pathname.startsWith('/admin/api')) return await handleAdmin(req, res, url);
    if (url.pathname.startsWith('/v1/')) return await handleOpenai(req, res, url);

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e.status || 500;
    sendJson(res, status, { error: { message: e.message, type: status >= 500 ? 'server_error' : 'invalid_request_error' } });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`vidogrid-gateway listening on http://${config.host}:${config.port}`);
  console.log(`  WebUI  → http://localhost:${config.port}/admin`);
  console.log(`  OpenAI → http://localhost:${config.port}/v1/videos`);
});
