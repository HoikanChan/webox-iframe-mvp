import * as WEBOX from '/src/index.js';

// ====== 1. 宿主设置自己的 window 全局变量和 localStorage（验证不被子应用污染） ======
window.__GLOBAL_TOKEN__ = 'HOST_SECRET_TOKEN';
window.APP_NAME = 'WEBOX_HOST';
window.sharedCounter = 100;
window.localStorage.setItem('demo_key', 'HOST_STORAGE_VALUE');
window.WEBOX = WEBOX;

const hostLogs = [];

function renderHostState() {
  const el = document.getElementById('host-state');
  if (!el) return;
  el.textContent = [
    `window.__GLOBAL_TOKEN__      = ${JSON.stringify(window.__GLOBAL_TOKEN__)}`,
    `window.APP_NAME              = ${JSON.stringify(window.APP_NAME)}`,
    `window.sharedCounter         = ${window.sharedCounter}`,
    `window.$                     = ${String(window.$)}  (jQuery 子应用的 $ 不应泄漏)`,
    `window.reactAppCounter       = ${String(window.reactAppCounter)}  (React 子应用变量不应泄漏)`,
    `window.__ASYNC_CHUNK_LOADED__= ${String(window.__ASYNC_CHUNK_LOADED__)}  (动态 chunk 不应泄漏)`,
    `localStorage.demo_key        = ${JSON.stringify(window.localStorage.getItem('demo_key'))}`,
    `WEBOX.getErrors(error)       = ${WEBOX.getErrors({ level: 'error' }).length} 条`,
    hostLogs.length ? `最近广播: ${hostLogs[0]}` : '最近广播: 无',
  ].join('\n');
}

WEBOX.subscribe('ping', (msg, sender) => {
  hostLogs.unshift(`[${new Date().toLocaleTimeString()}] 来自 ${sender}: ${JSON.stringify(msg)}`);
  renderHostState();
});

async function mountReactApp() {
  return WEBOX.addApp({
    id: 'react-app',
    url: '/febs-proxy/react-app/index.html',
    contextRoot: '/febs-proxy/react-app',
    target: document.getElementById('slot-react'),
    roarand: 'mvp-roarand-token-react',
    sandboxMode: 'iframe',
    syncRoute: true,
    onRouteChange: (href) => {
      const badge = document.getElementById('react-route-badge');
      if (badge) badge.textContent = new URL(href).pathname;
    },
  });
}

async function mountJqueryApp() {
  return WEBOX.addApp({
    id: 'jquery-mpa',
    url: '/febs-proxy/jquery-mpa/index.html',
    contextRoot: '/febs-proxy/jquery-mpa',
    target: document.getElementById('slot-jquery'),
    roarand: 'mvp-roarand-token-jquery',
    sandboxMode: 'iframe',
    syncRoute: true,
    onRouteChange: (href) => {
      const badge = document.getElementById('jquery-route-badge');
      if (badge) badge.textContent = new URL(href).pathname;
    },
  });
}

async function runAllChecks() {
  const resultsEl = document.getElementById('check-results');
  const reactApp = WEBOX.getApp('react-app');
  const jqueryApp = WEBOX.getApp('jquery-mpa');
  const rWin = reactApp?.iframeWindow;
  const jWin = jqueryApp?.iframeWindow;

  // 触发动态 chunk、网络请求（根路径 / SAML 302 / roarand）、广播
  if (rWin && typeof rWin.__triggerAsyncChunk__ === 'function') {
    await rWin.__triggerAsyncChunk__();
  }

  let fetchRootRes = null;
  let fetchSamlRes = null;
  let fetchPostRes = null;
  if (rWin) {
    fetchRootRes = await rWin.fetch('/api/data').then((r) => r.json());
    fetchSamlRes = await rWin.fetch('./api/saml-protected', { credentials: 'include' }).then((r) => r.json());
    fetchPostRes = await rWin
      .fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: true }),
      })
      .then((r) => r.json());
  }

  let xhrPostRes = null;
  if (jWin) {
    xhrPostRes = await new Promise((resolve) => {
      const xhr = new jWin.XMLHttpRequest();
      xhr.open('POST', '/api/submit');
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = () => resolve(JSON.parse(xhr.responseText));
      xhr.send(JSON.stringify({ from: 'auto-check' }));
    });
  }

  // 跨应用通信
  if (rWin?.webox) {
    rWin.webox.broadcast('ping', { autoCheck: true });
    await new Promise((r) => setTimeout(r, 50));
  }

  const checks = [
    {
      name: '1. 宿主 window 变量零污染',
      pass:
        window.__GLOBAL_TOKEN__ === 'HOST_SECRET_TOKEN' &&
        window.APP_NAME === 'WEBOX_HOST' &&
        window.sharedCounter === 100 &&
        window.$ === undefined &&
        window.reactAppCounter === undefined,
    },
    {
      name: '2. 子应用间 window 变量完全隔离',
      pass:
        rWin?.__GLOBAL_TOKEN__ === 'REACT_APP_TOKEN_001' &&
        jWin?.__GLOBAL_TOKEN__ === 'JQUERY_MPA_TOKEN_999' &&
        rWin?.sharedCounter === undefined &&
        jWin?.reactAppCounter === undefined,
    },
    {
      name: '3. 原生 iframe 无 with(proxy) has 语义偏差',
      pass: rWin?.__LET_IN_WINDOW_CHECK__ === true,
    },
    {
      name: '4. 动态 <script> chunk 在 iframe 执行且不泄漏宿主',
      pass:
        rWin?.__ASYNC_CHUNK_LOADED__ === 'REACT_IFRAME_CHUNK_OK' &&
        window.__ASYNC_CHUNK_LOADED__ === undefined,
    },
    {
      name: '5. Storage 前缀隔离（宿主/React/jQuery 互不覆盖）',
      pass:
        window.localStorage.getItem('demo_key') === 'HOST_STORAGE_VALUE' &&
        rWin?.localStorage.getItem('demo_key') === 'REACT_STORAGE_VALUE' &&
        jWin?.localStorage.getItem('demo_key') === 'JQUERY_STORAGE_VALUE',
    },
    {
      name: '6. 视口代理生效（innerWidth/Height > 0 & rAF 触发）',
      pass: rWin?.innerWidth > 0 && rWin?.innerHeight > 0 && rWin?.__RAF_TRIGGERED__ === true,
    },
    {
      name: '7. 根路径 fetch("/api/data") 走 /febs-proxy/react-app',
      pass: fetchRootRes?.cluster === 'react-app',
    },
    {
      name: '8. SAML 302 重定向自动跟随 + Cookie 携带',
      pass: fetchSamlRes?.authenticated === true && fetchSamlRes?.cookiePresent === true,
    },
    {
      name: '9. fetch POST 自动注入 roarand header',
      pass: fetchPostRes?.receivedRoarand === 'mvp-roarand-token-react',
    },
    {
      name: '10. XHR POST 自动注入 roarand header',
      pass: xhrPostRes?.receivedRoarand === 'mvp-roarand-token-jquery',
    },
    {
      name: '11. 跨应用 postMessage 广播桥接生效',
      pass: jWin?.__LAST_RECEIVED_MSG__?.sender === 'react-app',
    },
    {
      name: '12. errorReporter 零 ERROR 级报错',
      pass: WEBOX.getErrors({ level: 'error' }).length === 0,
    },
  ];

  resultsEl.innerHTML = '';
  checks.forEach((c) => {
    const item = document.createElement('div');
    item.className = `check-item ${c.pass ? 'pass' : 'fail'}`;
    item.textContent = `${c.pass ? '✅' : '❌'} ${c.name}`;
    resultsEl.appendChild(item);
  });

  renderHostState();
  return checks;
}

document.getElementById('btn-run-checks').addEventListener('click', runAllChecks);
document.getElementById('btn-refresh-host-state').addEventListener('click', renderHostState);
document.getElementById('btn-host-broadcast').addEventListener('click', () => {
  WEBOX.broadcast('ping', { text: 'Message from WEBOX Host', ts: Date.now() }, 'host');
});
document.getElementById('btn-remount-react').addEventListener('click', async () => {
  await WEBOX.removeApp('react-app');
  await mountReactApp();
  renderHostState();
});

// 页面初始化：并行挂载两个子应用并自动运行一次验收
(async function bootstrap() {
  renderHostState();
  await Promise.all([mountReactApp(), mountJqueryApp()]);
  renderHostState();
  // 等待首帧 rAF 后自动跑一次验收
  setTimeout(() => {
    runAllChecks();
  }, 150);
})();
