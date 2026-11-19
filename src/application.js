/**
 * WEBOX 应用管理与跨应用通信模块（MVP）
 * 对齐 WEBOX 方案中的 src/application.ts + communication.js
 */

import { loadApp, updateApp } from './lifecycle.js';
import { destroyIframeSandbox } from './iframeSandbox.js';

let autoId = 1;
const apps = Object.create(null);
const hostSubscribers = new Map();

/**
 * 全局广播：通知宿主订阅者 + 转发给所有已挂载的 iframe 子应用
 * @param {string} topic
 * @param {any} message
 * @param {string} [sender='host']
 */
export function broadcast(topic, message, sender = 'host') {
  // 1. 通知宿主侧订阅者
  const handlers = hostSubscribers.get(topic);
  if (handlers) {
    handlers.forEach((fn) => {
      try {
        fn(message, sender);
      } catch (e) {
        console.error(`[WEBOX:comm] host subscriber error on "${topic}":`, e);
      }
    });
  }

  // 2. 转发给所有 iframe 子应用（不回传给发送方自身）
  Object.values(apps).forEach((app) => {
    if (app.id === sender) return;
    if (app.iframeWindow) {
      app.iframeWindow.postMessage(
        {
          __webox: true,
          type: 'subscribe',
          appId: app.id,
          topic,
          message,
          sender,
        },
        '*'
      );
    }
  });
}

/**
 * 宿主侧订阅主题
 * @param {string} topic
 * @param {(message: any, sender: string) => void} handler
 * @returns {() => void} unsubscribe
 */
export function subscribe(topic, handler) {
  if (!hostSubscribers.has(topic)) {
    hostSubscribers.set(topic, new Set());
  }
  hostSubscribers.get(topic).add(handler);
  return () => hostSubscribers.get(topic)?.delete(handler);
}

/**
 * 注册并加载子应用
 * @param {import('./types.d.ts').AddAppOptions} options
 * @returns {Promise<import('./types.d.ts').WeboxApp>}
 */
export async function addApp({
  id = `isolatedApp${autoId++}`,
  url,
  target,
  contextRoot,
  externalRoot,
  roarand = '',
  sandboxMode = 'iframe',
  syncRoute = true,
  onRouteChange,
}) {
  if (!url) throw new Error('[WEBOX] addApp requires `url`');
  if (!target) throw new Error('[WEBOX] addApp requires `target`');

  // 若同 id 已存在，先卸载
  if (apps[id]) {
    await removeApp(id);
  }

  // 自动推导 contextRoot（如 /febs-proxy/react-app/index.html → /febs-proxy/react-app）
  const derivedRoot =
    contextRoot ||
    (() => {
      const m = url.match(/^(\/febs-proxy\/[^/]+)/);
      return m ? m[1] : '';
    })();

  const app = {
    id,
    url,
    target,
    contextRoot: derivedRoot,
    externalRoot: externalRoot || derivedRoot,
    roarand,
    sandboxMode,
    syncRoute,
    onRouteChange,
    broadcast: (topic, message) => broadcast(topic, message, id),
    _emitBroadcast: (topic, message, sender) => broadcast(topic, message, sender),
  };

  apps[id] = app;
  await loadApp(app);
  return app;
}

/**
 * 卸载并清理子应用
 * @param {string} id
 */
export async function removeApp(id) {
  const app = apps[id];
  if (!app) return;

  if (app.sandboxMode === 'iframe') {
    destroyIframeSandbox(app);
  }

  if (app.container && app.container.parentNode) {
    app.container.parentNode.removeChild(app.container);
  }

  delete apps[id];
}

/**
 * 更新已挂载子应用的页面 URL
 * @param {string} id
 * @param {string} url
 */
export async function navigateApp(id, url) {
  const app = apps[id];
  if (!app) throw new Error(`[WEBOX] App "${id}" not found`);
  return updateApp(id, url, app);
}

/**
 * 获取单个子应用实例
 * @param {string} id
 */
export function getApp(id) {
  return apps[id];
}

/**
 * 获取全部已挂载子应用实例映射
 */
export function getApps() {
  return { ...apps };
}
