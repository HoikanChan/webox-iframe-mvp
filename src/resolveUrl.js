/**
 * URL 与 CSS 资源路径改写工具
 * 对齐 WEBOX resolveUrl.js 语义，并补齐协议相对 URL、CSS @import / url() 改写
 */

/**
 * 判断是否为绝对 URL（含 http(s)://、//cdn...、data:、blob:、mailto: 等）
 * @param {string} url
 * @returns {boolean}
 */
export function isAbsoluteURL(url) {
  if (!url || typeof url !== 'string') return false;
  return /^(?:[a-zA-Z][a-zA-Z\d+\-.]*:|\/\/)/.test(url.trim());
}

/**
 * 判断 URL 是否需要改写到 contextRoot（/febs-proxy/{clusterName}/...）
 * @param {string} url
 * @param {string} [contextRoot]
 * @returns {boolean}
 */
export function shouldRewriteUrl(url, contextRoot = '') {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (isAbsoluteURL(trimmed)) return false;
  if (trimmed.startsWith('#') || trimmed.startsWith('javascript:')) return false;
  if (trimmed.startsWith('/febs-proxy/')) return false;
  if (contextRoot) {
    const cleanRoot = contextRoot.replace(/\/+$/, '');
    if (cleanRoot && (trimmed === cleanRoot || trimmed.startsWith(cleanRoot + '/'))) {
      return false;
    }
  }
  return true;
}

/**
 * 将相对路径或根路径 URL 解析为 /febs-proxy/{clusterName}/...
 * 支持：
 *   - 根路径：/api/data → /febs-proxy/{cluster}/api/data
 *   - 相对路径：./a.js、../img/a.png、a.css → 基于 baseUrl/contextRoot 规范化解析
 *   - 绝对 URL / 协议相对 URL / data: / blob: / 已代理路径 → 原样返回
 *
 * @param {string} contextRoot 例如 "/febs-proxy/react-app"
 * @param {string} url 子应用内原始 URL
 * @param {string} [currentBasePath] 当前子应用页面或 CSS 文件所在目录（用于正确解析 ../）
 * @returns {string}
 */
export function resolveToCurrent(contextRoot, url, currentBasePath) {
  if (!shouldRewriteUrl(url, contextRoot)) return url;

  const trimmed = url.trim();
  const normalizedRoot = (contextRoot || '').replace(/\/+$/, '');
  if (!normalizedRoot) return trimmed;

  // 根路径 URL：/api/data → /febs-proxy/{cluster}/api/data
  if (trimmed.startsWith('/')) {
    return normalizedRoot + trimmed;
  }

  // 相对 URL：利用 URL 标准算法解析 ./ 和 ../
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  const baseDir = currentBasePath
    ? currentBasePath.endsWith('/')
      ? currentBasePath
      : currentBasePath.replace(/[^/]*$/, '')
    : normalizedRoot + '/';

  try {
    const resolved = new URL(trimmed, origin + (baseDir.startsWith('/') ? baseDir : '/' + baseDir));
    let pathname = resolved.pathname;
    // 防止 ../ 越出 contextRoot 边界
    if (!pathname.startsWith(normalizedRoot + '/') && pathname !== normalizedRoot) {
      pathname = normalizedRoot + '/' + pathname.replace(/^\/+/, '');
    }
    return pathname + resolved.search + resolved.hash;
  } catch {
    const cleanPath = trimmed.replace(/^(\.?\/)+/, '');
    return normalizedRoot + '/' + cleanPath;
  }
}

/**
 * 改写 CSS 文本中的 url(...) 与 @import 路径
 * 解决 ShadowDOM 内样式不认 iframe <base> 标签的问题
 *
 * @param {string} cssText
 * @param {string} contextRoot
 * @param {string} [cssFileUrl] CSS 文件自身 URL，用于解析相对路径
 * @returns {string}
 */
export function rewriteCssUrls(cssText, contextRoot, cssFileUrl) {
  if (!cssText || typeof cssText !== 'string') return cssText;

  // 1. 改写 @import "x.css" / @import 'x.css'（不带 url() 的形式）
  let result = cssText.replace(
    /(@import\s+)(['"])([^'"]+)\2/gi,
    (match, prefix, quote, rawUrl) => {
      if (!shouldRewriteUrl(rawUrl, contextRoot)) return match;
      return `${prefix}${quote}${resolveToCurrent(contextRoot, rawUrl, cssFileUrl)}${quote}`;
    }
  );

  // 2. 改写 url(...)
  result = result.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (match, quote, rawUrl) => {
      const trimmed = rawUrl.trim();
      if (!shouldRewriteUrl(trimmed, contextRoot)) return match;
      const resolved = resolveToCurrent(contextRoot, trimmed, cssFileUrl);
      return `url(${quote}${resolved}${quote})`;
    }
  );

  return result;
}
