/**
 * WEBOX 生命周期与加载分流模块（MVP）
 * 对应方案中的 src/lifecycle.js
 */

import {
  createIframeSandbox,
  registerContainer,
  executeScriptInIframe,
  rewriteElementResources,
  loadAndRewriteStylesheet,
} from './iframeSandbox.js';
import { resolveToCurrent, rewriteCssUrls, isAbsoluteURL } from './resolveUrl.js';
import { syncUrlToHostWindow } from './routeSync.js';
import { reportWeboxError, ERROR_LEVELS } from './errorReporter.js';

/**
 * 按 sandboxMode 分流加载子应用
 * @param {Object} app
 */
export async function loadApp(app) {
  if (app.sandboxMode === 'iframe') {
    return loadAppInIframe(app);
  }
  throw new Error(`[WEBOX MVP] sandboxMode="${app.sandboxMode}" not implemented in MVP; use "iframe".`);
}

/**
 * 按 sandboxMode 分流更新子应用（用于 MPA 跳转或宿主主动切换子应用页面）
 * @param {string} id
 * @param {string} url
 * @param {Object} app
 */
export async function updateApp(id, url, app) {
  if (app.sandboxMode === 'iframe') {
    return updateAppInIframe(id, url, app);
  }
  throw new Error(`[WEBOX MVP] sandboxMode="${app.sandboxMode}" not implemented in MVP.`);
}

/**
 * 拉取子应用 HTML
 * @param {string} url
 */
async function fetchHtml(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`Failed to fetch HTML (${res.status}): ${url}`);
  }
  return res.text();
}

/**
 * 在 ShadowDOM 内拦截 MPA 相对路径 <a> 标签点击，转为子应用内 updateApp
 * 避免点击 <a href="./detail.html"> 直接把整个宿主页面跳走
 * @param {Object} app
 */
function bindMpaLinkInterception(app) {
  const renderRoot = app.renderRoot;
  if (!renderRoot) return;

  const onClick = (event) => {
    // 使用 composedPath 穿透 ShadowDOM 精准找到被点击的 <a>
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    const anchor = path.find((node) => node && node.tagName === 'A');
    if (!anchor) return;

    const rawHref = anchor.getAttribute('href');
    const targetAttr = anchor.getAttribute('target');
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) return;
    if (targetAttr === '_blank' || isAbsoluteURL(rawHref)) return;
    if (anchor.hasAttribute('data-webox-spa-link')) return;

    event.preventDefault();
    const nextUrl = resolveToCurrent(app.contextRoot, rawHref, app.currentUrl);
    updateAppInIframe(app.id, nextUrl, app);
  };

  renderRoot.addEventListener('click', onClick);
  app._mpaClickCleanup = () => renderRoot.removeEventListener('click', onClick);
}

/**
 * 将解析后的 HTML 样式、DOM 与脚本加载到 iframe + ShadowDOM
 * @param {Object} app
 * @param {string} targetUrl
 */
async function renderHtmlIntoSandbox(app, targetUrl) {
  app._readyState = 'loading';
  app.currentUrl = targetUrl;

  // 同步 iframe location 与宿主 URL query
  try {
    const parsedUrl = new URL(targetUrl, window.location.origin);
    app.iframeWindow.history.replaceState(null, '', parsedUrl.pathname + parsedUrl.search + parsedUrl.hash);
    syncUrlToHostWindow(app);
  } catch {
    // ignore
  }

  let htmlText;
  try {
    htmlText = await fetchHtml(targetUrl);
  } catch (err) {
    reportWeboxError('lifecycle', 'fetchHtml', err, { appId: app.id, url: targetUrl }, ERROR_LEVELS.ERROR);
    throw err;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText, 'text/html');

  // 1. 提取 head/body 中的样式 → 改写路径后挂载到 ShadowDOM shadowHead
  const styleNodes = doc.querySelectorAll('style, link[rel="stylesheet"]');
  const stylePromises = [];
  styleNodes.forEach((node) => {
    if (node.tagName === 'LINK') {
      stylePromises.push(loadAndRewriteStylesheet(node, app.shadowHead, app));
    } else if (node.tagName === 'STYLE') {
      const styleEl = document.createElement('style');
      styleEl.textContent = rewriteCssUrls(node.textContent || '', app.contextRoot, targetUrl);
      app._rawShadowAppendChild.call(app.shadowHead, styleEl);
    }
  });
  await Promise.all(stylePromises);

  // 2. 提取脚本列表（从 body 移除 script 避免 innerHTML 重复）
  const scripts = Array.from(doc.querySelectorAll('script'));
  scripts.forEach((s) => s.parentNode && s.parentNode.removeChild(s));

  // 3. 写入 body DOM 到 ShadowDOM renderRoot，并修正静态图片等相对路径
  app.renderRoot.innerHTML = doc.body ? doc.body.innerHTML : '';
  rewriteElementResources(app.renderRoot, app);

  app._readyState = 'interactive';

  // 4. 按文档顺序在 iframe 内原生执行脚本（同步外部脚本 / 内联脚本 / defer 脚本）
  const deferredScripts = [];
  for (const script of scripts) {
    const src = script.getAttribute('src');
    const type = script.getAttribute('type') || undefined;
    const isDefer = script.hasAttribute('defer') && !script.hasAttribute('async');

    if (isDefer) {
      deferredScripts.push({ src, content: script.textContent, type });
      continue;
    }

    await executeScriptInIframe(app, {
      src: src || undefined,
      content: src ? undefined : script.textContent,
      type,
    });
  }

  // 执行 defer 脚本
  for (const def of deferredScripts) {
    await executeScriptInIframe(app, def);
  }

  // 5. 触发 DOMContentLoaded & load
  app._readyState = 'complete';
  try {
    app.iframeDocument.dispatchEvent(new app.iframeWindow.Event('DOMContentLoaded', { bubbles: true }));
    app.iframeWindow.dispatchEvent(new app.iframeWindow.Event('load'));
  } catch (e) {
    reportWeboxError('lifecycle', 'dispatchLoadEvents', e, { appId: app.id });
  }
}

/**
 * iframe 模式首次加载子应用
 * @param {Object} app
 */
async function loadAppInIframe(app) {
  const { target } = app;

  // 1. 创建宿主容器（撑满挂载点、可滚动、作为子应用视口基准）
  const container = document.createElement('div');
  container.id = `_webox_container_${app.id}`;
  container.style.cssText = 'width:100%;height:100%;overflow:auto;position:relative;box-sizing:border-box;';
  target.innerHTML = '';
  target.appendChild(container);

  // 2. 创建 ShadowDOM 渲染容器
  const shadowRoot = container.attachShadow({ mode: 'open' });
  const renderRoot = document.createElement('div');
  renderRoot.id = '_root';
  renderRoot.style.cssText = 'min-height:100%;box-sizing:border-box;';
  shadowRoot.appendChild(renderRoot);
  app.shadowRoot = shadowRoot;

  // 3. 注册容器引用
  registerContainer(app, container);

  // 4. 创建 iframe 沙箱（初始化真实同源 URL + 网络/存储/视口/DOM/路由补丁）
  const { initialUrl } = createIframeSandbox(app);

  // 5. 绑定 MPA <a> 点击拦截
  bindMpaLinkInterception(app);

  // 6. 拉取并渲染 HTML + 执行脚本
  await renderHtmlIntoSandbox(app, initialUrl);
}

/**
 * iframe 模式更新子应用（MPA 整页跳转或宿主主动切页）
 * @param {string} id
 * @param {string} url
 * @param {Object} app
 */
async function updateAppInIframe(id, url, app) {
  const resolvedUrl = resolveToCurrent(app.contextRoot, url, app.currentUrl);

  // 清空旧的 ShadowDOM 样式和内容
  if (app.shadowHead) app.shadowHead.innerHTML = '';
  if (app.renderRoot) app.renderRoot.innerHTML = '';

  await renderHtmlIntoSandbox(app, resolvedUrl);
}
