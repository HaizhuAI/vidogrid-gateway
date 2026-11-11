import { ProxyAgent } from 'undici';

// Proxy helpers — per-account sticky egress IPs.
// cache: proxy url string -> ProxyAgent (reused across requests)

const agentCache = new Map();

export function agentFor(url) {
  if (!url) return null;
  if (!agentCache.has(url)) {
    try { agentCache.set(url, new ProxyAgent(url)); }
    catch { return null; }
  }
  return agentCache.get(url);
}

// pick the next proxy from settings (single gateway URL wins, else list RR)
let proxyRr = 0;
export function pickProxy(settings) {
  if (settings?.proxy_url) return settings.proxy_url;
  const list = Array.isArray(settings?.proxies) ? settings.proxies.filter(Boolean) : [];
  if (!list.length) return null;
  proxyRr = (proxyRr + 1) % list.length;
  return list[proxyRr];
}

// sticky egress for an account: registration records acc.proxy, all its later
// calls reuse the same exit IP so upstream sees a consistent session origin.
export function dispatcherFor(acc, settings) {
  if (acc?.proxy) return agentFor(acc.proxy);
  return null;
}
