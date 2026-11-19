/**
 * 同源 iframe Storage 隔离代理
 *
 * 背景：带 allow-same-origin 的同源 iframe 与宿主共享同一份 localStorage / sessionStorage。
 * 通过代理为每个子应用的 key 自动加上 `[webox:${appId}]:` 前缀，实现逻辑隔离。
 */

/**
 * 创建带前缀隔离的 Storage 代理
 * @param {Storage} rawStorage 宿主的 localStorage 或 sessionStorage
 * @param {string} appId
 * @returns {Storage}
 */
export function createScopedStorage(rawStorage, appId) {
  const prefix = `[webox:${appId}]:`;

  const getOwnKeys = () => {
    const keys = [];
    for (let i = 0; i < rawStorage.length; i++) {
      const k = rawStorage.key(i);
      if (k && k.startsWith(prefix)) {
        keys.push(k.slice(prefix.length));
      }
    }
    return keys;
  };

  const storageImpl = {
    get length() {
      return getOwnKeys().length;
    },
    key(index) {
      const keys = getOwnKeys();
      return index >= 0 && index < keys.length ? keys[index] : null;
    },
    getItem(key) {
      return rawStorage.getItem(prefix + String(key));
    },
    setItem(key, value) {
      rawStorage.setItem(prefix + String(key), String(value));
    },
    removeItem(key) {
      rawStorage.removeItem(prefix + String(key));
    },
    clear() {
      const keys = getOwnKeys();
      keys.forEach((k) => rawStorage.removeItem(prefix + k));
    },
  };

  return new Proxy(storageImpl, {
    get(target, prop, receiver) {
      if (prop in target) {
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
      }
      if (typeof prop === 'string') {
        const val = rawStorage.getItem(prefix + prop);
        return val === null ? undefined : val;
      }
      return undefined;
    },
    set(target, prop, value) {
      if (typeof prop === 'string' && !(prop in target)) {
        rawStorage.setItem(prefix + prop, String(value));
        return true;
      }
      return Reflect.set(target, prop, value);
    },
    deleteProperty(target, prop) {
      if (typeof prop === 'string' && !(prop in target)) {
        rawStorage.removeItem(prefix + prop);
        return true;
      }
      return true;
    },
    has(target, prop) {
      if (prop in target) return true;
      if (typeof prop === 'string') {
        return rawStorage.getItem(prefix + prop) !== null;
      }
      return false;
    },
    ownKeys() {
      return getOwnKeys();
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && rawStorage.getItem(prefix + prop) !== null) {
        return {
          enumerable: true,
          configurable: true,
          value: rawStorage.getItem(prefix + prop),
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

/**
 * 将隔离后的 localStorage / sessionStorage 挂载到 iframeWindow
 * @param {Window} iframeWindow
 * @param {string} appId
 */
export function patchIframeStorage(iframeWindow, appId) {
  try {
    const scopedLocal = createScopedStorage(window.localStorage, appId);
    Object.defineProperty(iframeWindow, 'localStorage', {
      get: () => scopedLocal,
      configurable: true,
    });
  } catch (e) {
    console.warn(`[WEBOX:storage] Failed to patch localStorage for ${appId}:`, e);
  }

  try {
    const scopedSession = createScopedStorage(window.sessionStorage, appId);
    Object.defineProperty(iframeWindow, 'sessionStorage', {
      get: () => scopedSession,
      configurable: true,
    });
  } catch (e) {
    console.warn(`[WEBOX:storage] Failed to patch sessionStorage for ${appId}:`, e);
  }
}
