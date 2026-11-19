/**
 * WEBOX iframe 沙箱核心实现（MVP - 对标 wujie 修正版）
 *
 * 相比初版方案文档的核心修正：
 * 1. 同源 URL 初始化：通过 history.replaceState 替代裸 about:blank，避免 pushState 报 SecurityError
 * 2. 动态节点分流（对标 wujie effect.ts）：劫持 ShadowDOM head/body 的 appendChild/insertBefore，
 *    将动态 <script> 路由回 iframe 真实 DOM 执行，防止 Webpack chunk 逃逸到宿主 window
 * 3. ShadowDOM 资源路径改写：解决 ShadowDOM 不受 iframe <base> 影响的问题
 * 4. Storage 逻辑隔离：同源 iframe 共享 localStorage/sessionStorage，改用 [webox:appId] 前缀隔离
 * 5. 宿主主题变量注入到 ShadowDOM :host，确保样式穿透到 ShadowDOM 内部
 */

import { reportWeboxError, ERROR_LEVELS } from './errorReporter.js';
import { resolveToCurrent, rewriteCssUrls, shouldRewriteUrl } from './resolveUrl.js';
import { patchIframeStorage } from './storage.js';
import { initIframeLocation, patchIframeHistoryAndSync, clearSyncedHostUrl } from './routeSync.js';

/**
 * 注册宿主容器引用，供 iframe 内 patchIframeViewport 取用
 * @param {Object} app
 * @param {HTMLElement} container
 */
export function registerContainer(app, container) {
  if (!window.__WEBOX_CONTAINERS__) window.__WEBOX_CONTAINERS__ = {};
  window.__WEBOX_CONTAINERS__[app.id] = container;
  app.container = container;
}

/**
 * 注销容器引用
 * @param {Object} app
 */
export function unregisterContainer(app) {
  if (window.__WEBOX_CONTAINERS__) {
    delete window.__WEBOX_CONTAINERS__[app.id];
  }
}

/**
 * 收集宿主 documentElement 上的 CSS 变量，并注入到 ShadowDOM :host
 * @param {ShadowRoot} shadowRoot
 */
function injectHostThemeToShadow(shadowRoot) {
  const computed = window.getComputedStyle(document.documentElement);
  const varNames = new Set();

  try {
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.style) {
            for (let i = 0; i < rule.style.length; i++) {
              const prop = rule.style[i];
              if (prop.startsWith('--')) varNames.add(prop);
            }
          }
        }
      } catch {
        // 跨域 stylesheet 跳过
      }
    }
  } catch {
    ['--primary-color', '--bg-color', '--text-color', '--font-size-base', '--border-radius'].forEach((v) =>
      varNames.add(v)
    );
  }

  const vars = [];
  for (const name of varNames) {
    const val = computed.getPropertyValue(name).trim();
    if (val) vars.push(`${name}: ${val};`);
  }

  if (vars.length > 0) {
    const style = document.createElement('style');
    style.setAttribute('data-webox-theme', 'true');
    style.textContent = `:host { ${vars.join(' ')} }`;
    shadowRoot.insertBefore(style, shadowRoot.firstChild);
  }
}

/**
 * 在 iframe 内原生执行脚本（绕过被重定向的 document.head/body）
 * @param {Object} app
 * @param {{ src?: string, content?: string, type?: string, originalScript?: HTMLScriptElement }} options
 * @returns {Promise<HTMLScriptElement>}
 */
export function executeScriptInIframe(app, options) {
  const { src, content, type, originalScript } = options;
  const iframeDoc = app.iframeDocument;
  const realHead = app._rawIframeHead || app.iframe.contentDocument.head;

  return new Promise((resolve) => {
    const script = iframeDoc.createElement('script');
    if (type) script.type = type;

    if (src) {
      const resolvedSrc = resolveToCurrent(app.contextRoot, src, app.currentUrl);
      script.src = resolvedSrc;
      script.setAttribute('data-original-src', src);
      script.onload = (ev) => {
        if (originalScript) {
          dispatchSyntheticEvent(originalScript, 'load');
        }
        resolve(script);
      };
      script.onerror = () => {
        reportWeboxError(
          'iframe',
          'loadScript',
          new Error(`Failed to load script: ${resolvedSrc}`),
          { appId: app.id, url: resolvedSrc },
          ERROR_LEVELS.ERROR
        );
        if (originalScript) {
          dispatchSyntheticEvent(originalScript, 'error');
        }
        resolve(script);
      };
      app._rawAppendChild.call(realHead, script);
    } else if (content && content.trim()) {
      script.textContent = content;
      app._rawAppendChild.call(realHead, script);
      if (originalScript) {
        dispatchSyntheticEvent(originalScript, 'load');
      }
      resolve(script);
    } else {
      resolve(script);
    }
  });
}

/**
 * 在元素上派发 load / error 事件（用于通知 Webpack/动态脚本加载器）
 */
function dispatchSyntheticEvent(el, eventName) {
  try {
    const ev = new Event(eventName);
    if (typeof el[`on${eventName}`] === 'function') {
      el[`on${eventName}`](ev);
    } else {
      el.dispatchEvent(ev);
    }
  } catch (e) {
    console.warn(`[WEBOX:iframe] dispatchSyntheticEvent ${eventName} failed:`, e);
  }
}

/**
 * 修正单个元素及其子树中的相对资源路径（img/source/a 等）
 * @param {Node} node
 * @param {Object} app
 */
export function rewriteElementResources(node, app) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
  const el = /** @type {Element} */ (node);

  const fixAttr = (target, attr) => {
    const val = target.getAttribute(attr);
    if (val && shouldRewriteUrl(val, app.contextRoot)) {
      target.setAttribute(attr, resolveToCurrent(app.contextRoot, val, app.currentUrl));
    }
  };

  const tag = el.tagName;
  if (tag === 'IMG' || tag === 'SOURCE' || tag === 'AUDIO' || tag === 'VIDEO') {
    fixAttr(el, 'src');
  } else if (tag === 'LINK') {
    fixAttr(el, 'href');
  }

  // 递归处理子树
  if (el.querySelectorAll) {
    el.querySelectorAll('img[src], source[src], audio[src], video[src]').forEach((child) =>
      fixAttr(child, 'src')
    );
  }
}

/**
 * 异步拉取外部 CSS，改写其中 url() / @import 后以 <style> 形式注入 ShadowDOM
 * 解决 ShadowDOM 不受 iframe <base> 影响导致样式图片/字体 404 的问题
 *
 * @param {HTMLLinkElement} linkEl
 * @param {HTMLElement} targetContainer
 * @param {Object} app
 * @param {Node|null} [refNode]
 */
export async function loadAndRewriteStylesheet(linkEl, targetContainer, app, refNode = null) {
  const rawHref = linkEl.getAttribute('href');
  if (!rawHref) return;
  const resolvedHref = resolveToCurrent(app.contextRoot, rawHref, app.currentUrl);

  const placeholder = document.createComment(`webox-link:${resolvedHref}`);
  if (refNode && refNode.parentNode === targetContainer) {
    app._rawShadowInsertBefore.call(targetContainer, placeholder, refNode);
  } else {
    app._rawShadowAppendChild.call(targetContainer, placeholder);
  }

  try {
    const res = await fetch(resolvedHref);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cssText = await res.text();
    const rewritten = rewriteCssUrls(cssText, app.contextRoot, resolvedHref);

    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-webox-href', resolvedHref);
    styleEl.textContent = rewritten;

    if (placeholder.parentNode === targetContainer) {
      app._rawShadowInsertBefore.call(targetContainer, styleEl, placeholder);
    } else {
      app._rawShadowAppendChild.call(targetContainer, styleEl);
    }
    dispatchSyntheticEvent(linkEl, 'load');
  } catch (err) {
    reportWeboxError('iframe', 'loadLink', err, { appId: app.id, url: resolvedHref }, ERROR_LEVELS.ERROR);
    // 降级：保留解析后的 link 标签
    const fallbackLink = document.createElement('link');
    fallbackLink.rel = 'stylesheet';
    fallbackLink.href = resolvedHref;
    if (placeholder.parentNode === targetContainer) {
      app._rawShadowInsertBefore.call(targetContainer, fallbackLink, placeholder);
    } else {
      app._rawShadowAppendChild.call(targetContainer, fallbackLink);
    }
    dispatchSyntheticEvent(linkEl, 'error');
  }
}

/**
 * 对标 wujie effect.ts：劫持 ShadowDOM head / body 的 appendChild / insertBefore
 * - 动态 <script> → 拦截并路由到 iframe 真实文档执行（防止 Webpack chunk 逃逸到宿主）
 * - 动态 <link rel="stylesheet"> → 拉取改写 CSS 路径后注入 ShadowDOM
 * - 动态 <style> → 改写 CSS 内 url()/@import 路径
 * - 其他元素 → 修正相对 src 后正常插入 ShadowDOM
 */
function patchShadowDomInsertion(app, shadowHead, renderRoot) {
  const rawAppendChild = Node.prototype.appendChild;
  const rawInsertBefore = Node.prototype.insertBefore;
  app._rawShadowAppendChild = rawAppendChild;
  app._rawShadowInsertBefore = rawInsertBefore;

  const createHijackedInserter = (targetEl, isInsertBefore) => {
    return function (child, refNode) {
      if (!child) return child;

      // 1. 拦截动态 <script>：路由回 iframe 真实 DOM 执行
      if (child.tagName === 'SCRIPT') {
        const src = child.getAttribute('src');
        const content = child.textContent;
        const type = child.getAttribute('type') || undefined;
        const placeholder = document.createComment(`webox-script:${src || 'inline'}`);

        if (isInsertBefore && refNode && refNode.parentNode === targetEl) {
          rawInsertBefore.call(targetEl, placeholder, refNode);
        } else {
          rawAppendChild.call(targetEl, placeholder);
        }

        executeScriptInIframe(app, { src, content, type, originalScript: child });
        return child;
      }

      // 2. 拦截动态 <link rel="stylesheet">：拉取并改写 CSS 相对路径
      if (child.tagName === 'LINK' && (child.getAttribute('rel') || '').toLowerCase() === 'stylesheet') {
        loadAndRewriteStylesheet(child, targetEl, app, isInsertBefore ? refNode : null);
        return child;
      }

      // 3. 拦截动态 <style>：改写 CSS 内 url() / @import
      if (child.tagName === 'STYLE') {
        if (child.textContent) {
          child.textContent = rewriteCssUrls(child.textContent, app.contextRoot, app.currentUrl);
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        // 4. 修正普通元素及子树中的相对资源路径
        rewriteElementResources(child, app);
      }

      if (isInsertBefore) {
        return rawInsertBefore.call(targetEl, child, refNode);
      }
      return rawAppendChild.call(targetEl, child);
    };
  };

  [shadowHead, renderRoot].forEach((containerEl) => {
    containerEl.appendChild = createHijackedInserter(containerEl, false);
    containerEl.insertBefore = createHijackedInserter(containerEl, true);
  });
}

/**
 * 注入网络拦截器（fetch / XMLHttpRequest / window.open）
 * 处理根路径 /api/xxx 改写到 /febs-proxy/{cluster}/api/xxx 以及 roarand/csrf header 注入
 */
function injectNetworkInterceptors(app, iframeDocument) {
  const roarand = JSON.stringify(app.roarand || '');
  const hasRoarand = app.roarand ? 'true' : 'false';
  const contextRoot = JSON.stringify(app.contextRoot || '');
  const externalRoot = JSON.stringify(app.externalRoot || app.contextRoot || '');

  const script = iframeDocument.createElement('script');
  script.setAttribute('data-webox-inject', 'network');
  script.textContent = `
    (function() {
      var hasRoarand = ${hasRoarand};
      var roarand = ${roarand};
      var contextRoot = ${contextRoot};
      var externalRoot = ${externalRoot};

      function isAbsoluteURL(url) {
        return /^(?:[a-zA-Z][a-zA-Z\\d+\\-.]*:|\\/\\/)/.test(String(url || '').trim());
      }

      function shouldRewrite(url) {
        if (!url || typeof url !== 'string') return false;
        var trimmed = url.trim();
        if (!trimmed) return false;
        if (isAbsoluteURL(trimmed)) return false;
        if (trimmed.indexOf('#') === 0 || trimmed.indexOf('javascript:') === 0) return false;
        if (trimmed.indexOf('/febs-proxy/') === 0) return false;
        var cleanRoot = contextRoot.replace(/\\/+$/, '');
        if (cleanRoot && (trimmed === cleanRoot || trimmed.indexOf(cleanRoot + '/') === 0)) return false;
        return true;
      }

      function resolveToCurrent(url) {
        if (!shouldRewrite(url)) return url;
        var cleanRoot = contextRoot.replace(/\\/+$/, '');
        var trimmed = url.trim();
        if (trimmed.indexOf('/') === 0) {
          return cleanRoot + trimmed;
        }
        var cleanPath = trimmed.replace(/^(\\.?\\/)+/, '');
        return cleanRoot + '/' + cleanPath;
      }

      // ====== fetch 拦截 ======
      var originalFetch = window.fetch;
      window.fetch = function(resource, options) {
        options = options ? Object.assign({}, options) : {};

        if (typeof resource === 'string') {
          resource = resolveToCurrent(resource);
        } else if (resource instanceof Request) {
          var oldUrl = resource.url;
          var newUrl = resolveToCurrent(oldUrl);
          if (newUrl !== oldUrl) {
            resource = new Request(newUrl, resource);
          }
        }

        var method = (options.method || (resource instanceof Request ? resource.method : 'GET')).toLowerCase();
        if (hasRoarand && method !== 'get') {
          if (!options.headers) options.headers = {};
          if (options.headers instanceof Headers) {
            if (!options.headers.has('roarand')) options.headers.set('roarand', roarand);
          } else {
            options.headers = Object.assign({}, options.headers);
            if (!options.headers.roarand && !options.headers.Roarand) {
              options.headers.roarand = roarand;
            }
          }
        }
        return originalFetch.call(window, resource, options);
      };

      // ====== XMLHttpRequest 拦截 ======
      var OrigXHR = window.XMLHttpRequest;
      var origOpen = OrigXHR.prototype.open;
      var origSend = OrigXHR.prototype.send;
      var origSetHeader = OrigXHR.prototype.setRequestHeader;

      OrigXHR.prototype.open = function(method, url, asyn, user, pwd) {
        this._wbxMethod = method;
        this._wbxOriginalUrl = url;
        var resolvedUrl = resolveToCurrent(url);
        this._wbxUrl = resolvedUrl;
        return origOpen.call(this, method, resolvedUrl, asyn === undefined ? true : asyn, user, pwd);
      };

      OrigXHR.prototype.setRequestHeader = function(name, value) {
        var lower = String(name).toLowerCase();
        if (hasRoarand && (lower === 'roarand' || lower === 'x-uni-crsf-token')) {
          return origSetHeader.call(this, lower + '-sub', value);
        }
        return origSetHeader.call(this, name, value);
      };

      OrigXHR.prototype.send = function() {
        if (hasRoarand && this._wbxMethod && this._wbxMethod.toLowerCase() !== 'get') {
          origSetHeader.call(this, 'roarand', roarand);
        }
        return origSend.apply(this, arguments);
      };

      // ====== window.open 拦截 ======
      var origWindowOpen = window.open;
      window.open = function(url, target, features) {
        if (typeof url === 'string' && shouldRewrite(url)) {
          url = (externalRoot || contextRoot).replace(/\\/+$/, '') + '/' + url.replace(/^(\\.?\\/)+/, '');
        }
        return origWindowOpen.call(window, url, target, features);
      };
    })();
  `;
  app._rawAppendChild.call(app._rawIframeHead, script);
}

/**
 * 注入通信 API（window.webox.broadcast / subscribe）
 */
function injectCommunicationAPI(app, iframeDocument) {
  const script = iframeDocument.createElement('script');
  script.setAttribute('data-webox-inject', 'communication');
  script.textContent = `
    (function() {
      var appId = ${JSON.stringify(app.id)};
      window._weboxSubscribers = {};
      window.webox = {
        id: appId,
        broadcast: function(topic, message) {
          window.parent.postMessage({
            __webox: true,
            type: 'broadcast',
            appId: appId,
            topic: topic,
            message: message
          }, '*');
        },
        subscribe: function(topic, handler) {
          window._weboxSubscribers[topic] = window._weboxSubscribers[topic] || [];
          window._weboxSubscribers[topic].push(handler);
        }
      };

      window.addEventListener('message', function(event) {
        if (!event.data || !event.data.__webox) return;
        if (event.data.type === 'subscribe' && event.data.appId === appId) {
          var subs = window._weboxSubscribers[event.data.topic];
          if (subs) {
            subs.forEach(function(handler) {
              try { handler(event.data.message, event.data.sender); } catch (e) { console.error(e); }
            });
          }
        }
      });
    })();
  `;
  app._rawAppendChild.call(app._rawIframeHead, script);
}

/**
 * patch iframe document：将 DOM 查询与挂载点重定向到 ShadowDOM
 */
function patchIframeDocument(app) {
  const iframeDoc = app.iframeDocument;
  const shadowRoot = app.shadowRoot;
  const renderRoot = shadowRoot.querySelector('#_root') || shadowRoot;

  let shadowHead = shadowRoot.querySelector('.webox-head');
  if (!shadowHead) {
    shadowHead = document.createElement('div');
    shadowHead.classList.add('webox-head');
    shadowRoot.insertBefore(shadowHead, renderRoot);
  }
  app.shadowHead = shadowHead;
  app.renderRoot = renderRoot;

  // 劫持 ShadowDOM 内的 appendChild / insertBefore，防止动态 script 逃逸
  patchShadowDomInsertion(app, shadowHead, renderRoot);

  // 重定向 body → ShadowDOM renderRoot
  try {
    Object.defineProperty(iframeDoc, 'body', {
      get: () => renderRoot,
      configurable: true,
    });
  } catch (e) {
    reportWeboxError('iframe', 'patchDocument.body', e, { appId: app.id });
  }

  // 重定向 head → ShadowDOM shadowHead
  try {
    Object.defineProperty(iframeDoc, 'head', {
      get: () => shadowHead,
      configurable: true,
    });
  } catch (e) {
    reportWeboxError('iframe', 'patchDocument.head', e, { appId: app.id });
  }

  // 重定向 documentElement → shadowRoot.host
  try {
    Object.defineProperty(iframeDoc, 'documentElement', {
      get: () => shadowRoot.host,
      configurable: true,
    });
  } catch (e) {
    reportWeboxError('iframe', 'patchDocument.documentElement', e, { appId: app.id });
  }

  // DOM 查询重定向到 ShadowDOM
  iframeDoc.querySelector = function (selector) {
    if (selector === 'head') return shadowHead;
    if (selector === 'body') return renderRoot;
    return renderRoot.querySelector(selector) || shadowHead.querySelector(selector);
  };

  iframeDoc.querySelectorAll = function (selector) {
    const results = [];
    renderRoot.querySelectorAll(selector).forEach((el) => results.push(el));
    shadowHead.querySelectorAll(selector).forEach((el) => results.push(el));
    return results;
  };

  iframeDoc.getElementById = function (id) {
    if (!id) return null;
    const escaped = window.CSS && window.CSS.escape ? window.CSS.escape(id) : id;
    return renderRoot.querySelector('#' + escaped) || shadowHead.querySelector('#' + escaped);
  };

  iframeDoc.getElementsByTagName = function (tagname) {
    if (String(tagname).toLowerCase() === 'head') return [shadowHead];
    if (String(tagname).toLowerCase() === 'body') return [renderRoot];
    return renderRoot.getElementsByTagName(tagname);
  };

  iframeDoc.getElementsByClassName = function (name) {
    return renderRoot.getElementsByClassName(name);
  };

  iframeDoc.getElementsByName = function (name) {
    return renderRoot.querySelectorAll(`[name="${name}"]`);
  };

  // 事件监听分流：文档生命周期事件留在 iframe，DOM 交互事件挂到 ShadowDOM
  const origAddEventListener = iframeDoc.addEventListener.bind(iframeDoc);
  const origRemoveEventListener = iframeDoc.removeEventListener.bind(iframeDoc);
  const docEvents = new Set(['DOMContentLoaded', 'readystatechange', 'visibilitychange', 'fullscreenchange']);

  iframeDoc.addEventListener = function (type, listener, options) {
    if (docEvents.has(type)) {
      return origAddEventListener(type, listener, options);
    }
    return renderRoot.addEventListener(type, listener, options);
  };

  iframeDoc.removeEventListener = function (type, listener, options) {
    if (docEvents.has(type)) {
      return origRemoveEventListener(type, listener, options);
    }
    return renderRoot.removeEventListener(type, listener, options);
  };

  // readyState
  try {
    Object.defineProperty(iframeDoc, 'readyState', {
      get: () => app._readyState || 'interactive',
      configurable: true,
    });
  } catch (e) {
    reportWeboxError('iframe', 'patchDocument.readyState', e, { appId: app.id });
  }

  // cookie 透传（配合 FEBService SAML 认证）
  try {
    Object.defineProperty(iframeDoc, 'cookie', {
      get: () => document.cookie,
      set: (v) => {
        document.cookie = v;
      },
      configurable: true,
    });
  } catch (e) {
    reportWeboxError('iframe', 'patchDocument.cookie', e, { appId: app.id });
  }

  // activeElement 基于 ShadowDOM
  try {
    Object.defineProperty(iframeDoc, 'activeElement', {
      get: () => app.shadowRoot.activeElement || renderRoot,
      configurable: true,
    });
  } catch (e) {
    reportWeboxError('iframe', 'patchDocument.activeElement', e, { appId: app.id });
  }
}

/**
 * patch iframe 视口/尺寸/滚动/rAF/matchMedia/resize 到宿主 ShadowDOM 容器
 */
function patchIframeViewport(app) {
  const appId = JSON.stringify(app.id);
  const script = app.iframeDocument.createElement('script');
  script.setAttribute('data-webox-inject', 'viewport');
  script.textContent = `
    (function() {
      var hostWindow = window.parent;
      var containers = hostWindow.__WEBOX_CONTAINERS__;
      var container = containers && containers[${appId}];
      if (!container) return;

      function rect() {
        return container.getBoundingClientRect();
      }

      var sizeProps = {
        innerWidth:       function() { return Math.round(rect().width); },
        innerHeight:      function() { return Math.round(rect().height); },
        outerWidth:       function() { return Math.round(rect().width); },
        outerHeight:      function() { return Math.round(rect().height); },
        scrollX:          function() { return container.scrollLeft; },
        pageXOffset:      function() { return container.scrollLeft; },
        scrollY:          function() { return container.scrollTop; },
        pageYOffset:      function() { return container.scrollTop; },
        devicePixelRatio: function() { return hostWindow.devicePixelRatio; },
        screenLeft:       function() { return rect().left; },
        screenTop:        function() { return rect().top; },
        screenX:          function() { return rect().left; },
        screenY:          function() { return rect().top; },
      };

      Object.keys(sizeProps).forEach(function(prop) {
        try {
          Object.defineProperty(window, prop, {
            get: sizeProps[prop],
            configurable: true,
          });
        } catch (e) {}
      });

      window.scrollTo = function(x, y) {
        if (typeof x === 'object' && x !== null) {
          container.scrollTo(x);
        } else {
          container.scrollTo(x || 0, y || 0);
        }
      };
      window.scrollBy = function(dx, dy) {
        container.scrollBy(dx || 0, dy || 0);
      };
      window.scroll = window.scrollTo;

      window.matchMedia = function(query) {
        return hostWindow.matchMedia(query);
      };
      window.getComputedStyle = function(el, pseudo) {
        return hostWindow.getComputedStyle(el, pseudo);
      };
      window.requestAnimationFrame = function(cb) {
        return hostWindow.requestAnimationFrame(cb);
      };
      window.cancelAnimationFrame = function(id) {
        hostWindow.cancelAnimationFrame(id);
      };

      try {
        Object.defineProperty(window, 'screen', {
          get: function() { return hostWindow.screen; },
          configurable: true,
        });
      } catch (e) {}

      if (hostWindow.visualViewport) {
        try {
          Object.defineProperty(window, 'visualViewport', {
            get: function() { return hostWindow.visualViewport; },
            configurable: true,
          });
        } catch (e) {}
      }

      var resizeTimer = null;
      function dispatchResize() {
        if (resizeTimer) return;
        resizeTimer = setTimeout(function() {
          resizeTimer = null;
          window.dispatchEvent(new Event('resize'));
        }, 16);
      }

      function onContainerScroll() {
        window.dispatchEvent(new Event('scroll'));
      }

      hostWindow.addEventListener('resize', dispatchResize);
      container.addEventListener('scroll', onContainerScroll);

      var ro = null;
      if (hostWindow.ResizeObserver) {
        ro = new hostWindow.ResizeObserver(dispatchResize);
        ro.observe(container);
      }

      window.__weboxViewportCleanup = function() {
        if (ro) { ro.disconnect(); ro = null; }
        hostWindow.removeEventListener('resize', dispatchResize);
        container.removeEventListener('scroll', onContainerScroll);
      };
    })();
  `;
  app._rawAppendChild.call(app._rawIframeHead, script);
}

/**
 * 创建 iframe 沙箱
 * @param {Object} app
 * @returns {{ iframeWindow: Window, initialUrl: string }}
 */
export function createIframeSandbox(app) {
  // 1. 创建隐藏同源 iframe
  const iframe = document.createElement('iframe');
  iframe.setAttribute(
    'style',
    'display:none;width:0;height:0;border:0;position:absolute;left:-9999px;top:-9999px'
  );
  iframe.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads'
  );
  iframe.id = `_webox_iframe_${app.id}`;
  document.body.appendChild(iframe);

  const iframeWindow = iframe.contentWindow;
  const iframeDocument = iframeWindow.document;

  // 2. 初始化 iframe 文档结构
  iframeDocument.open();
  iframeDocument.write('<!DOCTYPE html><html><head></head><body><div id="_webox_root"></div></body></html>');
  iframeDocument.close();

  // 保存真实原生节点与方法（在 patchDocument 之前！）
  app.iframe = iframe;
  app.iframeWindow = iframeWindow;
  app.iframeDocument = iframeDocument;
  app.windowProxy = iframeWindow;
  app._rawIframeHead = iframeDocument.head;
  app._rawIframeBody = iframeDocument.body;
  app._rawIframeDocEl = iframeDocument.documentElement;
  app._rawAppendChild = iframeWindow.Node.prototype.appendChild;

  // 3. 初始化真实同源 URL（避免 about:blank 下 pushState 报 SecurityError）
  const initialUrl = initIframeLocation(app);
  app.currentUrl = initialUrl;

  // 4. 设置 <base>（辅助 iframe 内原生相对请求解析）
  const base = iframeDocument.createElement('base');
  base.href = app.contextRoot.endsWith('/') ? app.contextRoot : app.contextRoot + '/';
  app._rawAppendChild.call(app._rawIframeHead, base);

  // 5. 注入宿主主题 CSS 变量到 ShadowDOM :host
  injectHostThemeToShadow(app.shadowRoot);

  // 6. 注入网络拦截器（URL 改写 + roarand header）
  injectNetworkInterceptors(app, iframeDocument);

  // 7. Storage 前缀隔离（修复同源 iframe 共享 localStorage/sessionStorage 问题）
  patchIframeStorage(iframeWindow, app.id);

  // 8. 注入通信 API（postMessage 桥接）
  injectCommunicationAPI(app, iframeDocument);

  // 9. patch iframe viewport（尺寸/滚动/matchMedia/rAF/resize 重定向到宿主容器）
  patchIframeViewport(app);

  // 10. patch iframe document（DOM 查询/挂载重定向到 ShadowDOM + 动态 script 分流）
  patchIframeDocument(app);

  // 11. 路由同步（history.pushState/replaceState + popstate/hashchange → 宿主 query 参数）
  patchIframeHistoryAndSync(app);

  // 12. 宿主侧 postMessage 桥接监听
  app._onHostMessage = (event) => {
    if (!event.data || !event.data.__webox || event.data.appId !== app.id) return;
    if (event.data.type === 'broadcast' && typeof app._emitBroadcast === 'function') {
      app._emitBroadcast(event.data.topic, event.data.message, app.id);
    }
  };
  window.addEventListener('message', app._onHostMessage);

  // 13. iframe 内全局错误捕获
  iframeWindow.addEventListener('error', (event) => {
    reportWeboxError(
      'iframe',
      'window.error',
      event.error || new Error(event.message),
      {
        appId: app.id,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
      ERROR_LEVELS.ERROR
    );
  });

  iframeWindow.addEventListener('unhandledrejection', (event) => {
    reportWeboxError('iframe', 'unhandledrejection', event.reason, { appId: app.id }, ERROR_LEVELS.ERROR);
  });

  // 14. 页面卸载前清理
  app._iframeBeforeUnload = () => destroyIframeSandbox(app);
  window.addEventListener('beforeunload', app._iframeBeforeUnload);

  return { iframeWindow, initialUrl };
}

/**
 * 销毁 iframe 沙箱并释放全部资源
 * @param {Object} app
 */
export function destroyIframeSandbox(app) {
  if (app._iframeBeforeUnload) {
    window.removeEventListener('beforeunload', app._iframeBeforeUnload);
    app._iframeBeforeUnload = null;
  }
  if (app._onHostMessage) {
    window.removeEventListener('message', app._onHostMessage);
    app._onHostMessage = null;
  }
  if (app._routeCleanup) {
    app._routeCleanup();
    app._routeCleanup = null;
  }
  if (app._mpaClickCleanup) {
    app._mpaClickCleanup();
    app._mpaClickCleanup = null;
  }
  if (app.iframeWindow && typeof app.iframeWindow.__weboxViewportCleanup === 'function') {
    try {
      app.iframeWindow.__weboxViewportCleanup();
    } catch {
      // ignore
    }
  }

  unregisterContainer(app);
  if (app.syncRoute) {
    clearSyncedHostUrl(app.id);
  }

  if (app.iframe) {
    try {
      app.iframeWindow.location.href = 'about:blank';
    } catch {
      // ignore
    }
    app.iframe.parentNode?.removeChild(app.iframe);
    app.iframe = null;
    app.iframeWindow = null;
    app.iframeDocument = null;
    app.windowProxy = null;
  }
}
