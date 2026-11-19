/**
 * WEBOX iframe 沙箱 MVP 入口
 */

export { addApp, removeApp, navigateApp, getApp, getApps, broadcast, subscribe } from './application.js';
export { loadApp, updateApp } from './lifecycle.js';
export {
  createIframeSandbox,
  destroyIframeSandbox,
  executeScriptInIframe,
  registerContainer,
  unregisterContainer,
} from './iframeSandbox.js';
export { resolveToCurrent, rewriteCssUrls, isAbsoluteURL, shouldRewriteUrl } from './resolveUrl.js';
export { getErrors, clearErrors, reportWeboxError, ERROR_LEVELS } from './errorReporter.js';
export { getSyncedSubAppUrl, syncUrlToHostWindow, clearSyncedHostUrl } from './routeSync.js';
