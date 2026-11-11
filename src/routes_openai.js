import crypto from 'node:crypto';
import { loadDb, saveDb, log } from './store.js';
import { MODELS, IMAGE_MODELS, ALL_MODELS, buildUpstreamForm, buildImageForm, listModels } from './models.js';
import { pickReadyAccount, ensureToken, getAccount, markResult, markSpent, isQuotaError } from './pool.js';
import { generateVideo, getHistory, UpstreamError } from './upstream.js';
import { getTurnstileToken, setSiteCredentials, submitGenerationViaSite } from './turnstile.js';
import { sendJson, openaiError, readJson, parseMultipart, bearerToken, resolveImageInput, randId } from './util.js';
import { config } from './config.js';

const keyOf = (req) => bearerToken(req);

function validateKey(req) {
  const k = keyOf(req);
  if (!k) return null;
  if (config.masterKey && k === config.masterKey) {
    return { id: 'master', name: 'MASTER_KEY', admin: true, enabled: true, models: null };
  }
  const db = loadDb();
  const hash = crypto.createHash('sha256').update(k).digest('hex');
  const key = db.apikeys.find((x) => x.key_hash === hash && x.enabled);
  if (key) {
    key.last_used_at = Date.now();
    key.usage_count = (key.usage_count || 0) + 1;
    saveDb();
  }
  return key || null;
}

const UPSTATUS = { 0: 'queued', 1: 'in_progress', 2: 'completed', 3: 'failed', 4: 'failed' };

function extractVideoUrl(hist) {
  if (!hist || typeof hist !== 'object') return null;
  const gv = hist.generated_video;
  if (Array.isArray(gv)) {
    for (let i = gv.length - 1; i >= 0; i--) if (gv[i]?.video_url) return gv[i].video_url;
  }
  for (const k of ['video_url', 'result_url', 'output_url', 'url']) {
    if (typeof hist[k] === 'string' && hist[k].startsWith('http')) return hist[k];
  }
  return extractImageUrl(hist);
}

function extractImageUrl(hist) {
  if (!hist || typeof hist !== 'object') return null;
  const gi = hist.generated_image;
  if (Array.isArray(gi)) {
    for (let i = gi.length - 1; i >= 0; i--) {
      const u = gi[i]?.image_url || gi[i]?.url;
      if (typeof u === 'string' && u.startsWith('http')) return u;
    }
  }
  for (const k of ['image_url', 'result_url', 'output_url']) {
    if (typeof hist[k] === 'string' && hist[k].startsWith('http')) return hist[k];
  }
  return null;
}

// OpenAI images response: {created, data:[{url}|{b64_json}]}
function jobToOpenaiImage(job, hist) {
  const status = job.status === 'completed' ? 'completed'
    : job.status === 'failed' ? 'failed'
    : (UPSTATUS[job.upstream_status] || 'in_progress');
  const url = job.video_url || extractImageUrl(hist);
  const b64 = job.b64 || hist?.base64_images || null;
  const done = status === 'completed' && (url || b64);
  const out = {
    created: Math.floor(job.created_at / 1000),
    data: done ? [{ ...(b64 ? { b64_json: b64 } : { url }) }] : [],
    id: job.id,
    model: job.model,
    status,
    progress: hist?.progress ?? job.progress ?? (status === 'completed' ? 100 : 0),
    upstream_uuid: job.upstream_uuid,
  };
  if (status === 'failed') out.error = { message: job.error || extractError(hist) || 'generation failed' };
  return out;
}

function extractError(hist) {
  if (!hist || typeof hist !== 'object') return null;
  return hist.error_message || hist.fail_reason || hist.error || hist.detail?.error_message || null;
}

function extractUuid(resp) {
  if (!resp || typeof resp !== 'object') return null;
  if (resp.uuid) return resp.uuid;
  if (resp.data?.uuid) return resp.data.uuid;
  for (const v of Object.values(resp)) {
    if (v && typeof v === 'object' && v.uuid) return v.uuid;
  }
  return null;
}

function jobToOpenai(job, hist) {
  const status = job.status === 'completed' ? 'completed'
    : job.status === 'failed' ? 'failed'
    : (UPSTATUS[job.upstream_status] || 'in_progress');
  const videoUrl = job.video_url || extractVideoUrl(hist);
  const out = {
    id: job.id,
    object: 'video',
    model: job.model,
    status,
    progress: hist?.progress ?? (status === 'completed' ? 100 : job.progress || 0),
    created_at: Math.floor(job.created_at / 1000),
    completed_at: job.completed_at ? Math.floor(job.completed_at / 1000) : null,
    expires_at: null,
    error: job.error ? { message: job.error } : (status === 'failed' ? { message: extractError(hist) || 'generation failed' } : null),
    seconds: String(job.params?.duration ?? job.params?.seconds ?? ''),
    size: job.params?.size || job.params?.aspect_ratio || job.params?.orientation || null,
    upstream_uuid: job.upstream_uuid,
    video_url: videoUrl || undefined,
    data: videoUrl ? [{ url: videoUrl }] : undefined,
  };
  return out;
}

async function pollUpstream(job) {
  if (!job.upstream_uuid || ['completed', 'failed'].includes(job.status)) return job;
  const acc = getAccount(job.account_id);
  if (!acc) { job.status = 'failed'; job.error = 'upstream account removed'; saveDb(); return job; }
  try {
    await ensureToken(acc);
    const hist = await getHistory(acc, job.upstream_uuid);
    job.upstream_status = hist?.status ?? job.upstream_status;
    job.progress = hist?.progress ?? job.progress;
    const url = extractVideoUrl(hist);
    if (url) job.video_url = url;
    if (job.upstream_status === 2) { job.status = 'completed'; job.completed_at = Date.now(); markResult(acc, true); }
    else if ([3, 4].includes(job.upstream_status)) { job.status = 'failed'; job.error = extractError(hist) || 'upstream generation failed'; markResult(acc, false); }
    job.updated_at = Date.now();
    saveDb();
  } catch (e) {
    job.poll_error = e.message;
    saveDb();
  }
  return job;
}

async function waitForTerminal(job, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !['completed', 'failed'].includes(job.status)) {
    await new Promise((r) => setTimeout(r, 4000));
    await pollUpstream(job);
  }
  return job;
}

export async function handleOpenai(req, res, url) {
  const key = validateKey(req);
  if (!key) return openaiError(res, 401, 'missing or invalid API key', 'authentication_error', 'invalid_api_key');

  // GET /v1/models
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const db = loadDb();
    let models = listModels(db).filter((m) => m.enabled);
    if (Array.isArray(key.models) && key.models.length) models = models.filter((m) => key.models.includes(m.id));
    return sendJson(res, 200, { object: 'list', data: models });
  }

  // POST /v1/videos  (also accepts /v1/video/generations)
  if (req.method === 'POST' && ['/v1/videos', '/v1/video/generations', '/v1/videos/generations'].includes(url.pathname)) {
    let p;
    const ctype = req.headers['content-type'] || '';
    if (ctype.includes('multipart/form-data')) {
      const mp = await parseMultipart(req, ctype.split('boundary=')[1]);
      p = { ...mp.fields };
      if (mp.files.length) p._files = mp.files.map((f) => ({ data: f.data, filename: f.filename, type: f.type }));
    } else {
      p = await readJson(req);
    }
    const model = p.model || 'muse-ai-video';
    if (!MODELS[model]) return openaiError(res, 400, `unknown video model '${model}' — see GET /v1/models`);
    const db = loadDb();
    if (db.models[model]?.enabled === false) return openaiError(res, 403, `model '${model}' is disabled by admin`, 'permission_error');
    if (Array.isArray(key.models) && key.models.length && !key.models.includes(model)) {
      return openaiError(res, 403, `API key not permitted for model '${model}'`, 'permission_error');
    }
    if (!p.prompt || typeof p.prompt !== 'string') return openaiError(res, 400, 'prompt is required');

    // resolve reference images: files / input_reference / image / images / ref_images(urls)
    let fileInputs = p._files || [];
    const imgInputs = [];
    for (const k of ['input_reference', 'image', 'ref']) if (p[k]) imgInputs.push(p[k]);
    if (Array.isArray(p.images)) imgInputs.push(...p.images);
    if (Array.isArray(p.ref_images)) imgInputs.push(...p.ref_images.filter((s) => typeof s !== 'string' || s.startsWith('data:') || /^https?:/.test(s)));
    for (const inp of imgInputs) {
      const f = await resolveImageInput(inp).catch((e) => { throw Object.assign(e, { status: 400 }); });
      if (f) fileInputs.push(f);
    }

    const { endpoint, fields, fileParts } = buildUpstreamForm(model, p, fileInputs);

    let acc = null, upstream = null, lastErr = null;
    const triedAccs = new Set();

    const doGenerate = async (account, f) => {
      // upstream is flaky — transient 500 SYSTEM_ERRORs recover on retry
      for (let i = 0; i < 4; i++) {
        try { return await generateVideo(account, endpoint, f, fileParts); }
        catch (e) {
          if (e instanceof UpstreamError && e.status === 500 && i < 3) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          throw e;
        }
      }
    };

    // quota/limit failure → retire the account and fail over to the next one
    for (let hop = 0; hop < 3; hop++) {
      try { acc = await pickReadyAccount(triedAccs); }
      catch (e) { if (!lastErr) return openaiError(res, 503, `no healthy upstream accounts: ${e.message}`, 'upstream_error'); break; }
      try {
        upstream = await doGenerate(acc, fields);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (isQuotaError(e)) {
          markSpent(acc, e.message);
          markResult(acc, false);
          log('warn', `quota exhausted on ${acc.username} — failing over`);
          triedAccs.add(acc.id);
          continue;
        }
        break;
      }
    }
    if (!upstream && lastErr) {
      const e = lastErr;
      // free-tier endpoints demand a real CF turnstile token.
      // muse: drive the site's OWN page flow — genuine browser submits
      //       /api/video-gen/meta itself (real turnstile + x-guard-id);
      //       we just capture the {uuid} response. Nothing to replay.
      // others: mint a token via browser/solver/manual and retry once.
      if (e instanceof UpstreamError && e.data?.detail?.error_code === 'TURNSTILE_INVALID') {
        try {
          if (endpoint === '/video-gen/meta') {
            log('info', `turnstile required on ${endpoint} — site-flow submission for ${acc.username}`);
            upstream = await submitGenerationViaSite(acc, {
              prompt: fields.find((f) => f.name === 'prompt')?.value,
              orientation: fields.find((f) => f.name === 'orientation')?.value,
              fileParts,
            });
          } else {
            log('info', `turnstile required on ${endpoint} for ${acc.username} — minting token`);
            const token = await getTurnstileToken(acc);
            const fields2 = fields.map((f) => f.name === 'turnstile_token' ? { ...f, value: token } : f);
            if (!fields2.some((f) => f.name === 'turnstile_token')) fields2.push({ name: 'turnstile_token', value: token });
            upstream = await doGenerate(acc, fields2);
          }
        } catch (e2) {
          markResult(acc, false);
          return openaiError(res, e2.status || 502, `upstream error after turnstile: ${e2.message}`, 'upstream_error', e2.data?.detail?.error_code || null);
        }
      } else {
        markResult(acc, false);
        if (e instanceof UpstreamError && e.status === 401) {
          acc.token_exp = 0; // force re-auth next pick
        }
        log('warn', `generation failed on ${acc.username}: ${e.message}`, { status: e.status });
        return openaiError(res, e.status || 502, `upstream error: ${e.message}`, 'upstream_error', e.data?.detail?.error_code || null);
      }
    }

    const job = {
      id: randId('vg'),
      key_id: key.id,
      account_id: acc.id,
      upstream_uuid: null,
      model,
      params: p,
      status: 'in_progress',
      upstream_status: 1,
      progress: 0,
      video_url: null,
      error: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    if (upstream.sse) {
      // grok endpoints stream events; mine them for uuid/status
      for (const ev of upstream.events) {
        const d = ev.data;
        if (d && typeof d === 'object') {
          const u = d.uuid || d.history_uuid || d.data?.uuid;
          if (u && !job.upstream_uuid) job.upstream_uuid = u;
          if (typeof d.status === 'number') job.upstream_status = d.status;
          if (typeof d.progress === 'number') job.progress = d.progress;
        }
      }
      if (!job.upstream_uuid) {
        const m = upstream.raw.match(/"uuid"\s*:\s*"([0-9a-f-]{36})"/);
        if (m) job.upstream_uuid = m[1];
      }
      if (upstream.status >= 400) {
        markResult(acc, false);
        return openaiError(res, upstream.status, 'upstream SSE error', 'upstream_error');
      }
    } else {
      job.upstream_uuid = extractUuid(upstream);
      if (typeof upstream.status === 'number') job.upstream_status = upstream.status;
      const direct = extractVideoUrl(upstream);
      if (direct) job.video_url = direct;
      if (job.upstream_status === 2 || (direct && job.upstream_status !== 3)) {
        job.status = direct ? 'completed' : job.status;
        if (direct) job.completed_at = Date.now();
      }
      if (job.upstream_status === 3) { job.status = 'failed'; job.error = extractError(upstream) || 'upstream failed'; }
    }

    db.jobs.unshift(job);
    if (db.jobs.length > 1000) db.jobs.length = 1000;
    saveDb();
    log('info', `job ${job.id} created model=${model} acc=${acc.username} uuid=${job.upstream_uuid}`);

    if (p.wait === true || p.wait === 'true' || url.searchParams.get('wait') === '1') {
      await waitForTerminal(job, Math.min(parseInt(p.wait_timeout || '300', 10) * 1000, 600000));
    } else if (job.upstream_uuid && !['completed', 'failed'].includes(job.status)) {
      pollUpstream(job); // fire-and-forget first poll
    }
    return sendJson(res, job.status === 'failed' ? 500 : 200, jobToOpenai(job));
  }

  // POST /v1/images/generations — OpenAI image API over upstream imagen endpoints.
  // Synchronous by default (polls /history until the image is ready); pass
  // wait:false for an async job id usable on GET /v1/videos/{id}.
  if (req.method === 'POST' && ['/v1/images/generations', '/v1/images'].includes(url.pathname)) {
    let p;
    const ctype = req.headers['content-type'] || '';
    if (ctype.includes('multipart/form-data')) {
      const mp = await parseMultipart(req, ctype.split('boundary=')[1]);
      p = { ...mp.fields };
      if (mp.files.length) p._files = mp.files.map((f) => ({ data: f.data, filename: f.filename, type: f.type }));
    } else {
      p = await readJson(req);
    }
    const model = p.model || 'gemini-2.5-flash-exp-image-generation';
    if (!IMAGE_MODELS[model]) return openaiError(res, 400, `unknown image model '${model}' — see GET /v1/models`);
    const db = loadDb();
    if (db.models[model]?.enabled === false) return openaiError(res, 403, `model '${model}' is disabled by admin`, 'permission_error');
    if (Array.isArray(key.models) && key.models.length && !key.models.includes(model)) {
      return openaiError(res, 403, `API key not permitted for model '${model}'`, 'permission_error');
    }
    if (!p.prompt || typeof p.prompt !== 'string') return openaiError(res, 400, 'prompt is required');

    let fileInputs = p._files || [];
    const imgInputs = [];
    for (const k of ['input_reference', 'image', 'ref']) if (p[k]) imgInputs.push(p[k]);
    if (Array.isArray(p.images)) imgInputs.push(...p.images);
    if (Array.isArray(p.ref_images)) imgInputs.push(...p.ref_images.filter((s) => typeof s !== 'string' || s.startsWith('data:') || /^https?:/.test(s)));
    for (const inp of imgInputs) {
      const f = await resolveImageInput(inp).catch((e) => { throw Object.assign(e, { status: 400 }); });
      if (f) fileInputs.push(f);
    }

    const { endpoint, fields, fileParts } = buildImageForm(model, p, fileInputs);

    let acc = null, upstream = null, lastErr = null;
    const triedAccs = new Set();
    const doGen = async (account, f) => {
      for (let i = 0; i < 3; i++) {
        try { return await generateVideo(account, endpoint, f, fileParts); }
        catch (e) {
          if (e instanceof UpstreamError && e.status === 500 && i < 2) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          throw e;
        }
      }
    };
    for (let hop = 0; hop < 3; hop++) {
      try { acc = await pickReadyAccount(triedAccs); }
      catch (e) { if (!lastErr) return openaiError(res, 503, `no healthy upstream accounts: ${e.message}`, 'upstream_error'); break; }
      try {
        upstream = await doGen(acc, fields);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (isQuotaError(e)) {
          markSpent(acc, e.message);
          markResult(acc, false);
          triedAccs.add(acc.id);
          continue;
        }
        break;
      }
    }
    if (!upstream && lastErr) {
      const e = lastErr;
      if (e instanceof UpstreamError && e.data?.detail?.error_code === 'TURNSTILE_INVALID') {
        try {
          const token = await getTurnstileToken(acc);
          const fields2 = fields.map((f) => f.name === 'turnstile_token' ? { ...f, value: token } : f);
          if (!fields2.some((f) => f.name === 'turnstile_token')) fields2.push({ name: 'turnstile_token', value: token });
          upstream = await doGen(acc, fields2);
        } catch (e2) {
          markResult(acc, false);
          return openaiError(res, e2.status || 502, `upstream error after turnstile: ${e2.message}`, 'upstream_error', e2.data?.detail?.error_code || null);
        }
      } else {
        markResult(acc, false);
        if (e instanceof UpstreamError && e.status === 401) acc.token_exp = 0;
        log('warn', `image generation failed on ${acc.username}: ${e.message}`, { status: e.status });
        return openaiError(res, e.status || 502, `upstream error: ${e.message}`, 'upstream_error', e.data?.detail?.error_code || null);
      }
    }
    if (!upstream) return openaiError(res, 503, 'no upstream accounts available', 'upstream_error');

    const job = {
      id: randId('vgimg'), kind: 'image', key_id: key.id, account_id: acc.id,
      upstream_uuid: extractUuid(upstream), model, params: p,
      status: 'in_progress', upstream_status: 1, progress: 0,
      video_url: extractImageUrl(upstream) || null,
      b64: upstream.base64_images || null,
      error: null, created_at: Date.now(), updated_at: Date.now(),
    };
    if (job.video_url || job.b64) { job.status = 'completed'; job.completed_at = Date.now(); job.upstream_status = 2; }
    db.jobs.unshift(job);
    if (db.jobs.length > 1000) db.jobs.length = 1000;
    saveDb();
    log('info', `image job ${job.id} model=${model} acc=${acc.username} uuid=${job.upstream_uuid}`);

    if (job.status !== 'completed' && (p.wait !== false && p.wait !== 'false')) {
      await waitForTerminal(job, Math.min(parseInt(p.wait_timeout || '120', 10) * 1000, 300000));
    }
    return sendJson(res, job.status === 'failed' ? 500 : 200, jobToOpenaiImage(job));
  }

  // GET /v1/videos/{id}
  const mGet = url.pathname.match(/^\/v1\/videos\/([A-Za-z0-9_-]+)(\/content)?$/) ||
               url.pathname.match(/^\/v1\/images\/([A-Za-z0-9_-]+)(\/content)?$/) ||
               url.pathname.match(/^\/v1\/video\/generations\/([A-Za-z0-9_-]+)(\/content)?$/);
  if (req.method === 'GET' && mGet) {
    const db = loadDb();
    const job = db.jobs.find((j) => j.id === mGet[1] || j.upstream_uuid === mGet[1]);
    if (!job) return openaiError(res, 404, 'generation not found', 'not_found');
    await pollUpstream(job);
    if (job.kind === 'image' && !mGet[2]) return sendJson(res, 200, jobToOpenaiImage(job));
    if (mGet[2]) {
      const u = job.video_url;
      if (!u && job.b64) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(Buffer.from(job.b64, 'base64'));
      }
      if (!u) return openaiError(res, 409, `content not ready (status=${job.status})`, 'conflict');
      if (url.searchParams.get('proxy') === '1') {
        const r = await fetch(u);
        if (!r.ok) return openaiError(res, 502, `content fetch failed HTTP ${r.status}`, 'upstream_error');
        res.writeHead(200, {
          'Content-Type': r.headers.get('content-type') || 'video/mp4',
          'Content-Length': r.headers.get('content-length') || undefined,
        });
        return res.end(Buffer.from(await r.arrayBuffer()));
      }
      res.writeHead(302, { Location: u });
      return res.end();
    }
    return sendJson(res, 200, jobToOpenai(job));
  }

  // GET /v1/videos — list this gateway's jobs
  if (req.method === 'GET' && url.pathname === '/v1/videos') {
    const db = loadDb();
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
    const jobs = (key.admin ? db.jobs : db.jobs.filter((j) => j.key_id === key.id)).slice(0, limit);
    return sendJson(res, 200, { object: 'list', data: jobs.map((j) => jobToOpenai(j)) });
  }

  return openaiError(res, 404, `unknown route ${req.method} ${url.pathname}`, 'not_found');
}
