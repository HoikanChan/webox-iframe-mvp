/**
 * 分级错误上报与可观测性模块
 * 对应 WEBOX 方案中的 src/errorReporter.js
 */

export const ERROR_LEVELS = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};

const MAX_ERROR_RECORDS = 200;
const errorStore = [];

/**
 * 上报 WEBOX 内部错误
 * @param {string} module 模块名（如 'iframe', 'lifecycle', 'network'）
 * @param {string} op 操作名（如 'window.error', 'loadScript', 'patchDocument.body'）
 * @param {Error|any} err 错误对象
 * @param {Record<string, any>} [meta] 附加上下文
 * @param {string} [level] 错误级别
 */
export function reportWeboxError(module, op, err, meta = {}, level = ERROR_LEVELS.WARN) {
  const record = {
    timestamp: Date.now(),
    module,
    op,
    level,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    meta,
  };

  errorStore.push(record);
  if (errorStore.length > MAX_ERROR_RECORDS) {
    errorStore.shift();
  }

  const logMethod = level === ERROR_LEVELS.ERROR ? 'error' : level === ERROR_LEVELS.WARN ? 'warn' : 'info';
  if (typeof console !== 'undefined' && console[logMethod]) {
    console[logMethod](`[WEBOX:${module}:${op}]`, record.message, meta);
  }

  return record;
}

/**
 * 查询已记录的错误
 * @param {{ module?: string, op?: string, level?: string, appId?: string }} [filter]
 */
export function getErrors(filter = {}) {
  return errorStore.filter((item) => {
    if (filter.module && item.module !== filter.module) return false;
    if (filter.op && item.op !== filter.op) return false;
    if (filter.level && item.level !== filter.level) return false;
    if (filter.appId && item.meta?.appId !== filter.appId) return false;
    return true;
  });
}

/**
 * 清空错误记录
 */
export function clearErrors() {
  errorStore.length = 0;
}
