// 模拟 Webpack 动态异步 chunk（通过 document.head.appendChild(script) 加载）
// 如果沙箱未拦截动态 script，这里会污染宿主 window！
// 正确拦截后，这里会在 React 子应用的 iframe window 内执行。
window.__ASYNC_CHUNK_LOADED__ = 'REACT_IFRAME_CHUNK_OK';
window.__ASYNC_CHUNK_TIME__ = new Date().toLocaleTimeString();
