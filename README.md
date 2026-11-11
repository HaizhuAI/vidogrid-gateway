# VidoGrid Gateway

vidogrid.ai 逆向 → **OpenAI 兼容 API 网关**。

- 27 个上游视频模型（muse / vela / grok / veo / sora / seedance / kling / minimax / flux）
- 12 个上游图像模型（nano-banana / imagen-4 / imagen-flash / gemini-exp / gpt-image-2.x / grok-imagine-image）
- **三级号池**：`main` 主池（在线轮询）→ `reserve` 冗余池（待命）→ `spent` 退役池（配额耗尽自动退役）
- **自动注册机**：`POST /api/signup` 无验证码、无邮箱验证，纯 HTTP 批量开号
- **补给器**：配额周期刷新 → 主池低于阈值先提拔冗余、不够就自动注册；冗余池保持目标水位
- 配额错误**自动切号重试**（最多 3 跳），退役号永不复用
- 注册 IP 限流（~3h/号/IP）→ 支持**轮换代理网关 / 静态代理池**，每号绑定固定出口 IP
- `x-guard-id` 反爬签名已逆向（salt/key 内置），自动对时
- 免费号命中 CF Turnstile 时自动走：真实浏览器站点流 / Capsolver / 2captcha / 手动 token 收件箱
- API Keys 管理：`vg-` 业务 key（可限模型）+ `vg-admin-` 管理 key + `MASTER_KEY` 环境变量
- 管理 WebUI（概览/号池/补给/KEY/模型/任务/日志）

## 快速开始

```bash
npm install
cp .env.example .env        # 改 ADMIN_PASSWORD，建议设 MASTER_KEY
node src/server.js          # Node >= 20
```

- 管理面板： http://localhost:8188/admin
- API 端点： http://localhost:8188/v1

## 使用流程

1. 面板 → **账号池** → 添加 vidogrid.ai 账号，或点「注册 N 号」让注册机自动开号。
2. 面板 → **补给** → 打开自动补给，设 `main_min`（阈值）/`main_target`/`reserve_target`，配代理池。
3. 面板 → **API Keys** → 创建 `vg-` 业务 key（可限定模型）或 `vg-admin-` 管理 key。
4. 客户端按 OpenAI 方式调用。

## API

### `POST /v1/videos`

```
Authorization: Bearer vg-xxxx
Content-Type: application/json   （也支持 multipart/form-data 直接传图）

{
  "model": "muse-ai-video",
  "prompt": "a cat walking in the rain, cinematic",
  "aspect_ratio": "16:9",          // 或 orientation: portrait|landscape|square；muse/vela 自动映射
  "duration": 10,                  // 秒（muse 固定 10）
  "resolution": "720p",
  "input_reference": "https://…/ref.jpg",   // 参考图：URL / data URI / b64_json / multipart 文件
  "ref_images": ["..."],           // 多参考图（seedance/kling 等走 ref_images 字段）
  "negative_prompt": "...",        // veo 支持
  "mode": "standard",              // kling: standard|professional|relax
  "turnstile_token": "skip",       // 默认 skip；免费账号若被拦自动走打码链路
  "wait": true,                    // 阻塞至完成（默认异步）
  "wait_timeout": 300
}
```

返回 OpenAI 风格 video 对象：`{id, object:"video", status, progress, video_url, upstream_uuid, ...}`。
status：`queued → in_progress → completed | failed`。

### `POST /v1/images/generations`

```
{
  "model": "nano-banana-2.1",      // 或 imagen-4-ultra / gpt-image-2.5 / grok-imagine-image ...
  "prompt": "a red apple on white background",
  "size": "1024x1024",             // 自动映射 aspect_ratio；或直接传 aspect_ratio
  "quality": "2K",                 // → resolution 1K/2K/4K
  "n": 1,                          // grok-imagine-image → num_result
  "image": "https://…/ref.jpg",    // 参考图（同视频接口的取图规则）
  "wait": true                     // 默认同步等待出图（最长 wait_timeout 秒）
}
```

完成时返回 `{created, data:[{url}]} `或 `{data:[{b64_json}]}`。

### `GET /v1/videos/{id}` / `GET /v1/images/{id}` — 轮询状态
### `GET /v1/videos/{id}/content` — 302 跳转资源 URL，`?proxy=1` 走网关代理
### `GET /v1/videos` — 任务列表
### `GET /v1/models` — 全部模型清单（type: video|image，含比例/时长/分辨率/参考图上限）

别名：`/v1/video/generations`、`/v1/videos/generations`。

## 号池与"无限调用"原理

免费计划（FP0001）每号：**~100 条视频额度**（`remaining_bulk_videos`）+ **20 张图/天**（`remaining_free_daily_images`）。

```
注册机（/api/signup，无验证码）→ 冗余池 ──提拔──→ 主池（轮询供业务）
     ↑ 代理轮换（每号独立出口 IP）                    │配额耗尽
     └────────── 退役池 ←─────────────────────────┘
```

- **阈值自动补**：主池健康数 < `main_min`（或低于 `main_target`）→ 提拔冗余 → 仍缺按 `batch_size` 注册
- **冗余池**：始终维持 `reserve_target` 个健康备胎，应对突发流量
- **手动兜底**：面板「注册 N 号」/ `POST /admin/api/register {count, into}`
- **限流现实**：上游 `/signup` 单 IP ~3h/号 → 必须配 `proxy_url`（轮换住宅代理）或 `proxies` 静态池才能真·无限
- 可选 `tempmail_hub_url`：接 tempmail-hub 拿真实收件箱（注册邮箱更像真人）

## 管理 API（Bearer = MASTER_KEY 或 vg-admin- key）

```
GET  /admin/api/overview                总览（含 pools 统计）
GET  /admin/api/pool/stats              三池健康/配额 + 注册统计
POST /admin/api/register                {count:5, into:"reserve"}
GET  /admin/api/replenisher             补给器状态+设置
PUT  /admin/api/replenisher             改设置（见下）
POST /admin/api/replenish               立即补给一轮
POST /admin/api/accounts/{id}/pool      {pool:"main|reserve|spent"}
POST /admin/api/turnstile               {token}  手动喂 token
GET/POST/PATCH/DELETE /admin/api/accounts|keys|models|jobs|logs
```

补给器设置项：`enabled, interval_sec, main_min, main_target, reserve_target, batch_size, daily_cap, min_interval_ms, jitter_ms, register_into, email_domains[], tempmail_hub_url, proxy_url, proxies[], refresh_stale_sec`

## 模型 → 上游端点映射（视频）

| 模型 | 端点 | 比例字段 | 时长 | 分辨率 | 参考图 |
|---|---|---|---|---|---|
| muse-ai-video | /video-gen/meta | orientation | 固定10s | — | files×1 |
| vela-ai | /video-gen/vela | orientation | 5/10/15 | — | files×1 |
| grok-imagine-video-1.5(-lite), grok-video | /video-gen/grok-* (SSE) | aspect_ratio | 6/10/15 | 480p/720p/1080p | files |
| veo-2/3/3-fast/3.1/3.1-fast/3.1-lite | /video-gen/veo | aspect_ratio | 8 | 720p/1080p | ref_images |
| sora-2/2-pro/2-pro-hd | /video-gen/sora | aspect_ratio | 10/15/25 | 720p/1080p | files |
| sd-2, sd-2.5, seedance-2-* | /video-gen/seedance | aspect_ratio | 5/10/15/30 | 720p/1080p | ref_images |
| kling-video-* | /video-gen/kling | aspect_ratio | 5/10 | 720p/1080p/4K | ref_images |
| minimax-h3 | /video-gen/minimax | aspect_ratio | 6/10 | 720p/1080p | ref_images |
| flux-3 | /video-gen/flux | aspect_ratio | 5/10 | 720p/1080p | ref_images |

图像模型：`nano-banana-*`, `imagen-4-fast/ultra`, `imagen-flash`, `gemini-2.5-flash-exp-image-generation` → `/generate_image`；`grok-imagine-image` → `/imagen/grok`；`gpt-image-2` → `/imagen/gpt-image-2`；`gpt-image-2.5(-lower)` → `/imagen/gpt-image-2.5`。

透传字段（原样转发）：`mode provider negative_prompt enhance_prompt service_mode mode_image num_videos voice_media_id skip_audio use_credits ref_history ref_item_uuid ref_videos ref_audios provider_model storyboard seed web_search file_urls ref_histories num_result style output_format background`。

## 反爬说明

每个上游请求自动带 `Authorization: Bearer <jwt>` + `x-guard-id`（站点自研签名：
`ver‖SHA256(key:stableId)[0:16]‖timeBucket[4B]‖SHA256(path:METHOD:c:tb:key)[32]‖domFp[32]`，base64url）。
salt/key 内置于 `config.js`，每账号独立 stableId/domFp，`/health` 自动对时。

## 数据

`data/db.json` — 账号（含池/配额/代理）、key（sha256）、任务、日志、补给器设置。删除即重置。

## Turnstile

免费号在部分端点会吃 `TURNSTILE_INVALID`。网关按序尝试：
1. `/video-gen/meta` → 真实 Chrome 跑站点自有流程（puppeteer，`data/chrome-profile` 持久化 cf_clearance）
2. 其他端点 → 打码出 token 重放：浏览器 mint → `CAPSOLVER_KEY`/`TWOCAPTCHA_KEY` → `/admin/api/turnstile` 手动喂
浏览器网络：`TURNSTILE_CDP_URL` 接管真实 Chrome 最稳；`TURNSTILE_PROXY`/`TURNSTILE_NET=direct` 控制出口。
