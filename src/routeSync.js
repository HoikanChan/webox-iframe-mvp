/**
 * 对标 wujie sync.ts 的路由同步模块
 *
 * 核心能力：
 * 1. 初始化同源 iframe URL（避免 about:blank 下 history.pushState 报 SecurityError）
 * 2. 将子应用路由编码同步到宿主 URL query 参数（?{appId}={encodedPath}），刷新可恢复
 * 3. 拦截 iframe history.pushState / replaceState / popstate / hashchange 并同步宿主
 */

import { resolveToCurrent } from './resolveUrl.js';

/**
 * 从宿主 URL query 参数中读取指定子应用的已同步路径
 * @param {string} appId
 * @returns {string|null}
 */
export function getSyncedSubAppUrl(appId) {
  try {
    const params = new URLSearchParams(window.location.search);
    const val = params.get(appId);
    return val ? val : null;
  } catch {
    return null;
  }
}

/**
 * 将子应用当前路由同步写入宿主 URL query 参数（不刷新宿主页面）
 * @param {Object} app
 */
export function syncUrlToHostWindow(app) {
  if (!app.syncRoute || !app.iframeWindow) return;

  try {
    const loc = app.iframeWindow.location;
    const subPath = loc.pathname + loc.search + loc.hash;
    const urlObj = new URL(window.location.href);

    if (urlObj.searchParams.get(app.id) !== subPath) {
      urlObj.searchParams.set(app.id, subPath);
      window.history.replaceState(window.history.state, '', urlObj.pathname + urlObj.search + urlObj.hash);
    }
  } catch (e) {
    console.warn(`[WEBOX:routeSync] syncUrlToHostWindow failed for ${app.id}:`, e);
  }
}

/**
 * 清理宿主 URL query 参数中已卸载子应用的路由参数
 * @param {string} appId
 */
export function clearSyncedHostUrl(appId) {
  try {
    const urlObj = new URL(window.location.href);
    if (urlObj.searchParams.has(appId)) {
      urlObj.searchParams.delete(appId);
      const nextUrl = urlObj.pathname + (urlObj.search ? urlObj.search : '') + urlObj.hash;
      window.history.replaceState(window.history.state, '', nextUrl);
    }
  } catch {
    // ignore
  }
}

/**
 * 初始化 iframe 的真实同源路径（必须在执行子应用脚本前调用）
 * 若宿主 URL 上有 ?{appId}=... 同步参数，则优先恢复该路径
 *
 * @param {Object} app
 * @returns {string} 最终加载的子应用 URL
 */
export function initIframeLocation(app) {
  const synced = app.syncRoute ? getSyncedSubAppUrl(app.id) : null;
  const initialUrl = synced || resolveToCurrent(app.contextRoot, app.url);

  try {
    const targetUrl = new URL(initialUrl, window.location.origin);
    const pathWithQuery = targetUrl.pathname + targetUrl.search + targetUrl.hash;
    app.iframeWindow.history.replaceState(null, '', pathWithQuery);
  } catch (e) {
    console.warn(`[WEBOX:routeSync] initIframeLocation failed for ${app.id}:`, e);
  }

  return initialUrl;
}

/**
 * 劫持 iframe history.pushState / replaceState 及监听 popstate / hashchange
 * @param {Object} app
 */
export function patchIframeHistoryAndSync(app) {
  const iframeWindow = app.iframeWindow;
  const history = iframeWindow.history;

  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);

  const normalizeStateUrl = (url) => {
    if (url === undefined || url === null) return url;
    const str = String(url);
    // 如果是相对路径或根路径，保持同源路径，防止跨域 SecurityError
    if (/^https?:\/\//i.test(str)) {
      try {
        const parsed = new URL(str);
        return parsed.pathname + parsed.search + parsed.hash;
      } catch {
        return str;
      }
    }
    return str;
  };

  history.pushState = function (state, title, url) {
    const normalized = normalizeStateUrl(url);
    const res = origPushState(state, title, normalized);
    syncUrlToHostWindow(app);
    if (typeof app.onRouteChange === 'function') {
      app.onRouteChange(iframeWindow.location.href, 'pushState');
    }
    return res;
  };

  history.replaceState = function (state, title, url) {
    const normalized = normalizeStateUrl(url);
    const res = origReplaceState(state, title, normalized);
    syncUrlToHostWindow(app);
    if (typeof app.onRouteChange === 'function') {
      app.onRouteChange(iframeWindow.location.href, 'replaceState');
    }
    return res;
  };

  const onPopState = () => {
    syncUrlToHostWindow(app);
    if (typeof app.onRouteChange === 'function') {
      app.onRouteChange(iframeWindow.location.href, 'popstate');
    }
  };

  const onHashChange = () => {
    syncUrlToHostWindow(app);
    if (typeof app.onRouteChange === 'function') {
      app.onRouteChange(iframeWindow.location.href, 'hashchange');
    }
  };

  iframeWindow.addEventListener('popstate', onPopState);
  iframeWindow.addEventListener('hashchange', onHashChange);

  app._routeCleanup = () => {
    iframeWindow.removeEventListener('popstate', onPopState);
    iframeWindow.removeEventListener('hashchange', onHashChange);
  };
}
