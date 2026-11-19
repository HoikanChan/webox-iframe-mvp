(function () {
  // ====== 1. 写入子应用专属 window 全局变量（用于验证与宿主、其他子应用完全隔离） ======
  window.__GLOBAL_TOKEN__ = 'REACT_APP_TOKEN_001';
  window.APP_NAME = 'REACT_SPA';
  window.reactAppCounter = 1;

  // 验证没有 with(proxy) 的 has 陷阱语义偏差
  let localLetVar = 'block-scoped';
  window.__LET_IN_WINDOW_CHECK__ = ('localLetVar' in window) === false && localLetVar === 'block-scoped';

  // 验证 Storage 隔离（与宿主和其他子应用同名 key 互不覆盖）
  window.localStorage.setItem('demo_key', 'REACT_STORAGE_VALUE');
  window.sessionStorage.setItem('session_key', 'REACT_SESSION_VALUE');

  // 验证 requestAnimationFrame 在隐藏 iframe 下通过宿主代理正常触发
  window.__RAF_TRIGGERED__ = false;
  window.requestAnimationFrame(function () {
    window.__RAF_TRIGGERED__ = true;
    renderWindowStatus();
  });

  function renderWindowStatus() {
    var box = document.getElementById('win-status');
    if (!box) return;
    var mq = window.matchMedia('(min-width: 768px)');
    box.textContent = [
      'window.__GLOBAL_TOKEN__ = ' + JSON.stringify(window.__GLOBAL_TOKEN__),
      'window.APP_NAME         = ' + JSON.stringify(window.APP_NAME),
      'window.reactAppCounter  = ' + window.reactAppCounter,
      'window.sharedCounter    = ' + String(window.sharedCounter) + '  (宿主为 100，子应用隔离应为 undefined)',
      'let x; "x" in window    = ' + String(!window.__LET_IN_WINDOW_CHECK__) + '  (原生 iframe 无 with 偏差)',
      'window.innerWidth/Height= ' + window.innerWidth + ' x ' + window.innerHeight + ' (代理自宿主容器)',
      'matchMedia(>=768px)     = ' + mq.matches,
      'rAF triggered           = ' + window.__RAF_TRIGGERED__,
      'localStorage.demo_key   = ' + JSON.stringify(window.localStorage.getItem('demo_key')),
      'asyncChunk              = ' + JSON.stringify(window.__ASYNC_CHUNK_LOADED__ || '未加载'),
    ].join('\n');
  }

  function renderRoute() {
    var view = document.getElementById('route-view');
    if (!view) return;
    view.textContent =
      '当前 iframe location.pathname = ' +
      window.location.pathname +
      '\n提示：点击上方按钮切换 SPA 路由后，观察浏览器地址栏 ?react-app=... 并尝试刷新页面！';
  }

  function appendNetLog(line) {
    var box = document.getElementById('net-status');
    if (!box) return;
    var prefix = '[' + new Date().toLocaleTimeString() + '] ';
    box.textContent = prefix + line + '\n' + (box.textContent === '等待请求...' ? '' : box.textContent);
  }

  // 动态加载 chunk（模拟 Webpack __webpack_require__.l）
  function loadAsyncChunk() {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = '/async-chunk.js';
      s.onload = function () {
        renderWindowStatus();
        appendNetLog('动态 chunk 加载完成: window.__ASYNC_CHUNK_LOADED__ = ' + window.__ASYNC_CHUNK_LOADED__);
        resolve();
      };
      document.head.appendChild(s);
    });
  }

  // 事件绑定
  document.getElementById('btn-inc-win').addEventListener('click', function () {
    window.reactAppCounter += 1;
    renderWindowStatus();
  });

  document.getElementById('btn-load-chunk').addEventListener('click', loadAsyncChunk);

  document.getElementById('btn-portal').addEventListener('click', function () {
    var mask = document.createElement('div');
    mask.className = 'portal-mask';
    mask.innerHTML =
      '<div class="portal-dialog">' +
      '<h4>React Portal 弹窗</h4>' +
      '<p style="font-size:13px;color:#475569;">通过 document.body.appendChild 挂载，实际渲染在 ShadowDOM 内，且样式隔离。</p>' +
      '<button class="btn" id="close-portal">关闭弹窗</button>' +
      '</div>';
    mask.querySelector('#close-portal').addEventListener('click', function () {
      mask.remove();
    });
    document.body.appendChild(mask);
  });

  document.querySelectorAll('.route-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var next = btn.getAttribute('data-route');
      window.history.pushState({ from: 'react-app' }, '', next);
      renderRoute();
    });
  });

  document.getElementById('btn-fetch-root').addEventListener('click', function () {
    fetch('/api/data')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        window.__LAST_API_DATA__ = data;
        appendNetLog('GET /api/data 成功 → ' + JSON.stringify(data));
      });
  });

  document.getElementById('btn-fetch-saml').addEventListener('click', function () {
    fetch('./api/saml-protected', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        window.__LAST_SAML_DATA__ = data;
        appendNetLog('SAML 302+Cookie 成功 → ' + JSON.stringify(data));
      });
  });

  document.getElementById('btn-post-roarand').addEventListener('click', function () {
    fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'react-app', counter: window.reactAppCounter }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        window.__LAST_POST_DATA__ = data;
        appendNetLog('POST /api/submit (roarand) 成功 → ' + JSON.stringify(data));
      });
  });

  document.getElementById('btn-broadcast').addEventListener('click', function () {
    if (window.webox) {
      window.webox.broadcast('ping', {
        text: 'Hello from React SPA! counter=' + window.reactAppCounter,
      });
      appendNetLog('已广播 topic="ping"');
    }
  });

  if (window.webox) {
    window.webox.subscribe('ping', function (msg, sender) {
      window.__LAST_RECEIVED_MSG__ = { msg: msg, sender: sender };
      appendNetLog('收到来自 [' + sender + '] 的广播: ' + JSON.stringify(msg));
    });
  }

  window.addEventListener('resize', function () {
    renderWindowStatus();
  });

  window.addEventListener('popstate', renderRoute);

  renderWindowStatus();
  renderRoute();

  // 暴露给自动化验收脚本触发
  window.__triggerAsyncChunk__ = loadAsyncChunk;
})();
