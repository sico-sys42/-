/* ============================================================
   RIDE SCORE · Service Worker
   作用：
     1) 让页面满足「可安装」条件（Android / 桌面 Chrome、Edge）
     2) 离线也能打开、录入、评分（数据本来就存在本地）
     3) 预缓存 ECharts 与页面外壳，第二次打开完全不走网络
   说明：
     - Service Worker 只在 https:// 或 http://localhost 下生效，
       用 file:// 双击打开时不会注册（页面本身仍可正常使用）。
     - 更新策略：页面走「网络优先」（并绕过 HTTP 缓存），
       保证一联网就能拿到最新版本；静态资源走「缓存优先 + 后台更新」。
     - 新版本不会自动接管：会等页面弹出「发现新版本」提示，
       用户点「立即刷新」后发 SKIP_WAITING 消息，新版本才接管并重载。
     - ECharts 已经自托管（同目录 echarts.common.min.js），
       不再依赖国外 CDN；若该文件缺失，页面会自动回退到 CDN。
   ============================================================ */

const VERSION = 'v4';
const SHELL_CACHE = 'ridescore-shell-' + VERSION;
const RUNTIME_CACHE = 'ridescore-runtime-' + VERSION;

/* 应用外壳：安装时预缓存，离线时的兜底 */
const SHELL = [
  './',
  './ridescore.html',
  './manifest.webmanifest',
  './echarts.common.min.js',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    /* 逐个缓存，任何一个 404 都不影响整体安装 */
    await Promise.all(SHELL.map(url =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
    ));
    /* 这里故意不调用 skipWaiting()：
       新版本先「待命」，由页面弹出「发现新版本」提示，
       用户点了刷新（或关掉所有页面）之后才真正接管。
       否则用户可能正录到一半，页面就被换成新版本了。 */
  })());
});

/* 页面点「立即刷新」后会发来这条消息，这时才让新版本接管 */
self.addEventListener('message', event => {
  const data = event.data;
  if (data && data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* 页面导航：网络优先，断网回退缓存 */
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
    return;
  }

  /* 静态资源 / CDN：缓存优先，后台静默更新 */
  event.respondWith(staleWhileRevalidate(req));
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);

  let res = null;
  try {
    /* 页面导航一律绕过 HTTP 缓存：有些主机把 HTML 设成长期缓存，
       那样「部署了新版本」也永远刷不出来。我们自己在 SW 里缓存，够用。
       断网时这里会直接抛错，下面立即回退缓存，不会卡等待。 */
    res = await fetch(req, { cache: 'no-store' });
  } catch (e) {
    res = null;
  }

  /* 网络成功才更新缓存 */
  if (res && res.ok) {
    cache.put(req, res.clone()).catch(() => {});
    return res;
  }

  /* 断网、超时、或服务端 5xx：一律回退到缓存，别把空白页丢给用户 */
  const hit =
    (await cache.match(req)) ||
    (await cache.match('./ridescore.html')) ||
    (await cache.match('./'));
  if (hit) return hit;

  if (res) return res;
  return offlineFallback();
}

function offlineFallback() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="margin:0;background:#0D1110;color:#E9F1EC;font:16px/1.9 system-ui,sans-serif;' +
    'padding:64px 24px;text-align:center">' +
    '<h2 style="color:#C8F04A;margin:0 0 14px">暂时离线</h2>' +
    '<p>先联网打开一次本页，之后就能离线使用了。<br>你已有的骑行记录一直在本机，不会丢。</p>' +
    '<p style="color:#6E8076;font-size:13px">重新联网后刷新即可恢复。</p></body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = await cache.match(req);

  const network = fetch(req).then(res => {
    /* 同源响应、CORS 响应、以及不透明的跨域响应都可以存 */
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  }).catch(() => null);

  if (hit) return hit;

  const res = await network;
  if (res) return res;
  return new Response('', { status: 504, statusText: 'Offline' });
}
