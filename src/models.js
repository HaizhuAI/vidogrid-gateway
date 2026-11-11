// Upstream model registry — extracted from the vidogrid.ai Nuxt bundle (B7QkMere.js store actions).
// ratio: 'orientation' → {portrait,landscape,square}; 'aspect_ratio' → {"16:9","9:16","1:1",...}
// ref: 'files' single-file field | 'ref_images' multi-field | none
export const MODELS = {
  'muse-ai-video': {
    endpoint: '/video-gen/meta', provider: 'muse', label: 'Muse AI Video',
    ratio: 'orientation', ratios: ['portrait', 'landscape', 'square'],
    durations: [10], defaultDuration: 10, resolutions: [],
    ref: 'files', maxRef: 1, cost: 1.0,
  },
  'vela-ai': {
    endpoint: '/video-gen/vela', provider: 'vela', label: 'Vela AI Video',
    ratio: 'orientation', ratios: ['portrait', 'landscape', 'square'],
    durations: [5, 10, 15], defaultDuration: 10, resolutions: [],
    ref: 'files', maxRef: 1, cost: 1.0,
  },
  'vela-ai-video': {
    endpoint: '/video-gen/vela', provider: 'vela', label: 'Vela AI Video',
    ratio: 'orientation', ratios: ['portrait', 'landscape', 'square'],
    durations: [5, 10, 15], defaultDuration: 10, resolutions: [],
    ref: 'files', maxRef: 1, cost: 1.0, aliasOf: 'vela-ai',
  },
  'grok-imagine-video-1.5': {
    endpoint: '/video-gen/grok-imagine-video-1.5', provider: 'xai', label: 'Grok Imagine 1.5',
    ratio: 'aspect_ratio', ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    durations: [6, 10, 15], defaultDuration: 10, resolutions: ['480p', '720p', '1080p'],
    ref: 'files', maxRef: 5, sse: true,
  },
  'grok-imagine-video-1.5-lite': {
    endpoint: '/video-gen/grok-imagine-video-1.5-lite', provider: 'xai', label: 'Grok Imagine 1.5 Lite',
    ratio: 'aspect_ratio', ratios: ['16:9', '9:16'],
    durations: [6, 10, 15], defaultDuration: 10, resolutions: ['480p', '720p', '1080p'],
    ref: 'files', maxRef: 1, sse: true,
  },
  'grok-video': {
    endpoint: '/video-gen/grok-stream', provider: 'xai', label: 'Grok Video',
    ratio: 'aspect_ratio', ratios: ['16:9', '9:16'],
    durations: [6, 10, 15], defaultDuration: 10, resolutions: ['480p', '720p', '1080p'],
    ref: 'files', maxRef: 5, sse: true,
  },
  'veo-2': { endpoint: '/video-gen/veo', provider: 'veo', label: 'Veo 2', ratio: 'aspect_ratio', ratios: ['16:9', '9:16'], durations: [8], defaultDuration: 8, resolutions: ['720p'], ref: 'ref_images', maxRef: 3 },
  'veo-3': { endpoint: '/video-gen/veo', provider: 'veo', label: 'Veo 3', ratio: 'aspect_ratio', ratios: ['16:9', '9:16'], durations: [8], defaultDuration: 8, resolutions: ['720p', '1080p'], ref: 'ref_images', maxRef: 3 },
  'veo-3-fast': { endpoint: '/video-gen/veo', provider: 'veo', label: 'Veo 3 Fast', ratio: 'aspect_ratio', ratios: ['16:9', '9:16'], durations: [8], defaultDuration: 8, resolutions: ['720p', '1080p'], ref: 'ref_images', maxRef: 3 },
  'veo-3.1': { endpoint: '/video-gen/veo', provider: 'veo', label: 'Veo 3.1', ratio: 'aspect_ratio', ratios: ['16:9', '9:16'], durations: [8], defaultDuration: 8, resolutions: ['720p', '1080p'], ref: 'ref_images', maxRef: 3 },
  'veo-3.1-fast': { endpoint: '/video-gen/veo', provider: 'veo', label: 'Veo 3.1 Fast', ratio: 'aspect_ratio', ratios: ['16:9', '9:16'], durations: [8], defaultDuration: 8, resolutions: ['720p', '1080p'], ref: 'ref_images', maxRef: 3 },
  'veo-3.1-lite': { endpoint: '/video-gen/veo', provider: 'veo', label: 'Veo 3.1 Lite', ratio: 'aspect_ratio', ratios: ['16:9', '9:16'], durations: [8], defaultDuration: 8, resolutions: ['720p', '1080p'], ref: 'ref_images', maxRef: 3 },
  'sora-2': { endpoint: '/video-gen/sora', provider: 'openai', label: 'Sora 2', ratio: 'aspect_ratio', ratios: ['16:9', '9:16'], durations: [10, 15], defaultDuration: 10, resolutions: ['720p'], ref: 'files', maxRef: 1 },
  'sora-2-pro': { endpoint: '/video-gen/sora', provider: 'openai', label: 'Sora 2 Pro', ratio: 'aspect_ratio', ratios: ['16:9', '9:16'], durations: [10, 15, 25], defaultDuration: 10, resolutions: ['720p'], ref: 'files', maxRef: 1 },
  'sora-2-pro-hd': { endpoint: '/video-gen/sora', provider: 'openai', label: 'Sora 2 Pro HD', ratio: 'aspect_ratio', ratios: ['16:9', '9:16'], durations: [10, 15], defaultDuration: 10, resolutions: ['1080p'], ref: 'files', maxRef: 1 },
  'sd-2': { endpoint: '/video-gen/seedance', provider: 'bytedance', label: 'Seedance 2', ratio: 'aspect_ratio', ratios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'], durations: [5, 10, 15], defaultDuration: 10, resolutions: ['720p'], ref: 'ref_images', maxRef: 4 },
  'sd-2.5': { endpoint: '/video-gen/seedance', provider: 'bytedance', label: 'Seedance 2.5', ratio: 'aspect_ratio', ratios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'], durations: [5, 10, 30], defaultDuration: 10, resolutions: ['720p'], ref: 'ref_images', maxRef: 14 },
  'seedance-2-mini': { endpoint: '/video-gen/seedance', provider: 'bytedance', label: 'Seedance 2 Mini', ratio: 'aspect_ratio', ratios: ['16:9', '9:16', '1:1'], durations: [5, 10], defaultDuration: 10, resolutions: ['720p'], ref: 'ref_images', maxRef: 4 },
  'seedance-2-omni': { endpoint: '/video-gen/seedance', provider: 'bytedance', label: 'Seedance 2 Omni', ratio: 'aspect_ratio', ratios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'], durations: [5, 10, 15], defaultDuration: 10, resolutions: ['720p', '1080p'], ref: 'ref_images', maxRef: 14 },
  'seedance-2-5-omni': { endpoint: '/video-gen/seedance', provider: 'bytedance', label: 'Seedance 2.5 Omni', ratio: 'aspect_ratio', ratios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'], durations: [5, 10, 30], defaultDuration: 10, resolutions: ['720p', '1080p'], ref: 'ref_images', maxRef: 14 },
  'kling-video-3-0': { endpoint: '/video-gen/kling', provider: 'kling', label: 'Kling 3.0', ratio: 'aspect_ratio', ratios: ['16:9', '9:16', '1:1'], durations: [5, 10], defaultDuration: 10, resolutions: ['720p', '1080p', '4K'], ref: 'ref_images', maxRef: 4, modes: ['standard', 'professional'] },
  'kling-video-2-6': { endpoint: '/video-gen/kling', provider: 'kling', label: 'Kling 2.6', ratio: 'aspect_ratio', ratios: ['16:9', '9:16', '1:1'], durations: [5, 10], defaultDuration: 10, resolutions: ['720p'], ref: 'ref_images', maxRef: 4, modes: ['standard', 'professional'] },
  'kling-video-2-5': { endpoint: '/video-gen/kling', provider: 'kling', label: 'Kling 2.5', ratio: 'aspect_ratio', ratios: ['16:9', '9:16', '1:1'], durations: [5, 10], defaultDuration: 10, resolutions: ['720p'], ref: 'ref_images', maxRef: 4, modes: ['relax', 'standard', 'professional'] },
  'kling-video-2-1-5s': { endpoint: '/video-gen/kling', provider: 'kling', label: 'Kling 2.1 5s', ratio: 'aspect_ratio', ratios: ['16:9', '9:16', '1:1'], durations: [5], defaultDuration: 5, resolutions: ['720p'], ref: 'ref_images', maxRef: 4, modes: ['standard', 'professional'] },
  'kling-video-2-1-10s': { endpoint: '/video-gen/kling', provider: 'kling', label: 'Kling 2.1 10s', ratio: 'aspect_ratio', ratios: ['16:9', '9:16', '1:1'], durations: [10], defaultDuration: 10, resolutions: ['720p'], ref: 'ref_images', maxRef: 4, modes: ['standard', 'professional'] },
  'minimax-h3': { endpoint: '/video-gen/minimax', provider: 'minimax', label: 'MiniMax H3', ratio: 'aspect_ratio', ratios: ['16:9', '9:16', '1:1'], durations: [6, 10], defaultDuration: 6, resolutions: ['720p', '1080p'], ref: 'ref_images', maxRef: 4 },
  'flux-3': { endpoint: '/video-gen/flux', provider: 'bfl', label: 'Flux 3', ratio: 'aspect_ratio', ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'], durations: [5, 10], defaultDuration: 5, resolutions: ['720p', '1080p'], ref: 'ref_images', maxRef: 4 },
};

// ---------------------------------------------------------------------------
// Image models — free tier also grants ~20 images/day/account
// (remaining_free_daily_images in /api/user/quota/image-gen).
// kind 'gen': POST /generate_image (generic); dedicated: /imagen/*.
// ---------------------------------------------------------------------------
export const IMAGE_MODELS = {
  // generic /generate_image
  'nano-banana-2.1': { type: 'image', endpoint: '/generate_image', label: 'Nano Banana 2.1', ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'], resolutions: ['1K', '2K', '4K'], ref: 'files', maxRef: 4, cost: 3 },
  'nano-banana-2': { type: 'image', endpoint: '/generate_image', label: 'Nano Banana 2', upstream_model: 'nano-banana-2.1', ratios: ['1:1', '16:9', '9:16'], resolutions: ['1K', '2K', '4K'], ref: 'files', maxRef: 4, cost: 3 },
  'nano-banana-2-lite': { type: 'image', endpoint: '/generate_image', label: 'Nano Banana 2 Lite', ratios: ['1:1', '16:9', '9:16'], resolutions: ['1K', '2K'], ref: 'files', maxRef: 4, cost: 1 },
  'nano-banana-pro': { type: 'image', endpoint: '/generate_image', label: 'Nano Banana Pro', ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'], resolutions: ['1K', '2K', '4K'], ref: 'files', maxRef: 4, cost: 3 },
  'imagen-4-fast': { type: 'image', endpoint: '/generate_image', label: 'Imagen 4 Fast', ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'], resolutions: ['1K'], ref: 'files', maxRef: 4, cost: 1 },
  'imagen-4-ultra': { type: 'image', endpoint: '/generate_image', label: 'Imagen 4 Ultra', ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'], resolutions: ['1K'], ref: 'files', maxRef: 4, cost: 4 },
  'imagen-flash': { type: 'image', endpoint: '/generate_image', label: 'Imagen Flash', ratios: ['16:9', '1:1', '9:16', '4:3', '3:4'], resolutions: ['1K'], ref: 'files', maxRef: 4, cost: 3 },
  'gemini-2.5-flash-exp-image-generation': { type: 'image', endpoint: '/generate_image', label: 'Gemini 2.5 Flash Image (exp)', ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'], resolutions: ['1K', '2K'], ref: 'files', maxRef: 4, cost: 0 },
  // dedicated /imagen/*
  'grok-imagine-image': { type: 'image', endpoint: '/imagen/grok', label: 'Grok Imagine Image', ratio: 'orientation', ratios: ['landscape', 'portrait', 'square'], resolutions: [], ref: 'ref_images', maxRef: 5, cost: 0 },
  'gpt-image-2': { type: 'image', endpoint: '/imagen/gpt-image-2', label: 'GPT Image 2', ratios: ['1:1', '3:2', '2:3', '16:9', '9:16'], resolutions: ['1K', '2K'], ref: 'files', maxRef: 4, cost: 0 },
  'gpt-image-2.5': { type: 'image', endpoint: '/imagen/gpt-image-2.5', label: 'GPT Image 2.5', ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'], resolutions: [], ref: 'files', maxRef: 4, cost: 0 },
  'gpt-image-2-lower': { type: 'image', endpoint: '/imagen/gpt-image-2.5', label: 'GPT Image 2 (lower)', upstream_model: 'gpt-image-2.5', ratios: ['1:1', '16:9', '9:16'], resolutions: [], ref: 'files', maxRef: 4, cost: 0 },
};

export const ALL_MODELS = { ...MODELS, ...IMAGE_MODELS };

// OpenAI size → aspect ratio; quality → upstream resolution bucket
const SIZE_TO_AR = { '1024x1024': '1:1', '1792x1024': '16:9', '1024x1792': '9:16', '1536x1024': '3:2', '1024x1536': '2:3', '1280x720': '16:9', '720x1280': '9:16' };
const QUALITY_TO_RES = { low: '1K', standard: '1K', medium: '2K', high: '2K', hd: '4K', '1k': '1K', '2k': '2K', '4k': '4K' };

// Normalize an OpenAI images/generations request into upstream form fields.
export function buildImageForm(model, p, files) {
  const spec = IMAGE_MODELS[model];
  if (!spec) throw Object.assign(new Error(`unknown image model: ${model}`), { status: 400 });
  const fields = [];
  const put = (n, v) => { if (v !== undefined && v !== null && v !== '') fields.push({ name: n, value: String(v) }); };

  put('prompt', p.prompt);
  const upModel = spec.upstream_model || model;
  if (spec.endpoint === '/generate_image') {
    put('model', p.upstream_model || upModel);
    const ar = p.aspect_ratio || (p.size && (SIZE_TO_AR[p.size] || p.size)) || spec.ratios[0];
    put('aspect_ratio', ar);
    put('resolution', p.resolution || (p.quality && (QUALITY_TO_RES[String(p.quality).toLowerCase()] || p.quality)) || spec.resolutions[0]);
    put('output_format', p.output_format || 'png');
    for (const k of ['style', 'service_mode']) if (p[k]) put(k, p[k]);
    for (const u of p.file_urls || []) put('file_urls', u);
    for (const h of p.ref_histories || []) put('ref_histories', h);
  } else if (spec.endpoint === '/imagen/grok') {
    const ar = p.aspect_ratio || (p.size && (SIZE_TO_AR[p.size] || p.size)) || 'landscape';
    put('orientation', ORIENT_FROM_RATIO[ar] || ar);
    put('num_result', p.num_result ?? p.n ?? 1);
    if (p.mode && !(files || []).length) put('mode', p.mode);
  } else {
    // /imagen/gpt-image-2(.5)
    put('aspect_ratio', p.aspect_ratio || (p.size && (SIZE_TO_AR[p.size] || p.size)) || spec.ratios[0]);
    if (spec.endpoint === '/imagen/gpt-image-2') {
      put('mode', p.mode || 'standard');
      put('resolution', p.resolution || spec.resolutions[0]);
      put('background', p.background || 'auto');
    }
  }
  put('turnstile_token', p.turnstile_token || 'skip');

  const fileField = spec.ref === 'ref_images' ? 'ref_images' : 'files';
  const fileParts = [];
  for (const f of (files || []).slice(0, spec.maxRef)) fileParts.push({ field: fileField, ...f });
  for (const s of (p.ref_images || []).slice(0, spec.maxRef)) {
    if (typeof s === 'string' && !s.startsWith('data:') && !/^https?:/.test(s)) put(fileField, s);
  }
  return { endpoint: spec.endpoint, fields, fileParts, spec };
}

const ORIENT_FROM_RATIO = { '16:9': 'landscape', '9:16': 'portrait', '1:1': 'square', '3:2': 'landscape', '2:3': 'portrait', '4:3': 'landscape', '3:4': 'portrait', landscape: 'landscape', portrait: 'portrait', square: 'square' };
const SIZE_TO_RATIO = {
  '1280x720': '16:9', '1920x1080': '16:9', '720x1280': '9:16', '1080x1920': '9:16',
  '1024x1024': '1:1', '960x1280': '3:4', '1280x960': '4:3', '1792x768': '21:9',
};

// Normalize client params into upstream form fields per model spec.
// Returns { endpoint, fields: [{name,value}] , files: [{field,data,filename,type}] }
export function buildUpstreamForm(model, p, files) {
  const spec = MODELS[model];
  if (!spec) throw Object.assign(new Error(`unknown model: ${model}`), { status: 400 });
  const fields = [];
  const put = (n, v) => { if (v !== undefined && v !== null && v !== '') fields.push({ name: n, value: String(v) }); };

  put('prompt', p.prompt);
  put('model', spec.provider === 'muse' ? 'muse-ai-video' : model);

  // duration
  const duration = p.duration ?? p.seconds ?? spec.defaultDuration;
  put('duration', duration);

  // aspect ratio / orientation / size
  let ratio = p.aspect_ratio || p.orientation || (p.size && (SIZE_TO_RATIO[p.size] || p.size)) || spec.ratios[0];
  if (spec.ratio === 'orientation') {
    ratio = ORIENT_FROM_RATIO[ratio] || ratio;
    put('orientation', spec.ratios.includes(ratio) ? ratio : spec.ratios[0]);
  } else {
    put('aspect_ratio', spec.ratios.includes(ratio) ? ratio : ratio);
  }

  // resolution
  const resolution = p.resolution || (spec.resolutions[0] ?? undefined);
  put('resolution', resolution);

  // passthrough extras the upstream forms accept
  for (const k of ['mode', 'provider', 'negative_prompt', 'enhance_prompt', 'service_mode',
    'mode_image', 'num_videos', 'voice_media_id', 'skip_audio', 'use_credits', 'ref_videos',
    'ref_audios', 'provider_model', 'storyboard', 'seed', 'web_search']) {
    if (p[k] !== undefined && p[k] !== null && p[k] !== '') put(k, p[k] === true ? 'true' : p[k]);
  }

  // turnstile: premium upstream accounts bypass with literal "skip"
  put('turnstile_token', p.turnstile_token || 'skip');

  // reference inputs
  const fileField = spec.ref === 'ref_images' ? 'ref_images' : 'files';
  const fileParts = [];
  const refs = [...(files || [])];
  if (p.ref_history) put('ref_history', p.ref_history);
  if (p.ref_item_uuid) put('files', p.ref_item_uuid);
  for (const f of refs.slice(0, spec.maxRef)) fileParts.push({ field: fileField, ...f });
  // string refs (uuid/url) the upstream accepts in the same field
  for (const s of (p.ref_images || []).slice(0, spec.maxRef)) {
    if (typeof s === 'string' && !s.startsWith('data:') && !/^https?:/.test(s)) put(fileField, s);
  }

  return { endpoint: spec.endpoint, fields, fileParts, spec };
}

export function listModels(db) {
  return Object.entries(ALL_MODELS).map(([id, s]) => ({
    id,
    object: 'model',
    created: 0,
    owned_by: 'vidogrid',
    enabled: db.models[id]?.enabled !== false,
    type: s.type || 'video',
    label: s.label,
    provider: s.provider,
    endpoint: s.endpoint,
    ratios: s.ratios,
    durations: s.durations,
    resolutions: s.resolutions,
    max_reference_images: s.maxRef,
    modes: s.modes || null,
    cost_credits: s.cost ?? null,
  }));
}
