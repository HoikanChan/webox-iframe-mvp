# WEBOX iframe 沙箱 MVP（对标 wujie 修正版）

零依赖、纯 ES Module JS 实现的 WEBOX `sandboxMode: 'iframe'` 最小可行性验证模块。核心源码（`src/`）可直接移植回 WEBOX 工程，并自带本地模拟宿主、模拟 FEBService（`/febs-proxy/*`）以及 React SPA + jQuery MPA 两个验证子应用。

## 快速启动

```bash
node webox-iframe-mvp/server.mjs
```

浏览器打开：`http://localhost:3456`

页面加载后会自动挂载 `react-app` 与 `jquery-mpa` 两个子应用，并在顶部面板自动运行 **12 项全量验收**。

## 运行 Playwright E2E 测试

```bash
cd webox-iframe-mvp
pnpm run test:e2e
# 有头模式观察运行过程：
pnpm run test:e2e:headed
```

## 目录结构

```text
webox-iframe-mvp/
├── server.mjs               # 零依赖 Node 服务（模拟宿主 + FEBService /febs-proxy/* + SAML 302 + roarand）
├── src/                     # 可直接移植进 WEBOX 的核心模块（纯 ES Module）
│   ├── index.js             # 对外 API 出口
│   ├── application.js       # addApp / removeApp / navigateApp / broadcast / subscribe
│   ├── lifecycle.js         # loadApp / updateApp 分流 + MPA <a> 点击拦截
│   ├── iframeSandbox.js     # iframe 沙箱 + ShadowDOM 节点分流 + 视口代理 + 网络拦截
│   ├── resolveUrl.js        # URL 改写 + CSS url()/@import 改写
│   ├── storage.js           # 同源 iframe localStorage/sessionStorage 前缀隔离
│   ├── routeSync.js         # 对标 wujie：同源 URL 初始化 + 宿主 query 路由同步
│   ├── errorReporter.js     # 分级错误上报（getErrors / clearErrors）
│   └── types.d.ts           # TypeScript 类型声明
├── demo/
│   ├── index.html           # 宿主验证台（含冲突样式、宿主 window 变量、12 项自动验收面板）
│   └── host.js              # 宿主逻辑与自动验收脚本
└── subapps/
    ├── react-app/           # React SPA 模拟（window 变量、动态 script chunk、Portal、SPA 路由、CSS @import/url()、SAML/roarand）
    └── jquery-mpa/          # jQuery MPA 模拟（同名 window 变量与 window.$、内联脚本、XHR、MPA <a> 跳 detail.html）
```

## 相对初版方案文档的 5 项关键修正（参考 wujie）

1. **动态 `<script>` 逃逸修复（对标 `wujie/effect.ts`）**：劫持 ShadowDOM `shadowHead` / `renderRoot` 的 `appendChild` / `insertBefore`，将子应用动态插入的 `<script>`（如 Webpack 异步 chunk）拦截并路由回 iframe 真实 DOM 执行，避免污染宿主 `window`。
2. **ShadowDOM 静态资源与 CSS 路径改写**：ShadowDOM 挂在宿主文档下，不认 iframe 内的 `<base>`。本 MVP 对 `<link rel="stylesheet">` 拉取后统一改写 `url(...)` 与 `@import` 并转为 `<style>` 注入 ShadowDOM，同时修正 `<img>` 等相对 `src`。
3. **同源 URL 初始化与路由同步（对标 `wujie/sync.ts`）**：避免 `about:blank` 下 `history.pushState` 抛 `SecurityError`，初始化时通过 `history.replaceState` 对齐同源路径，并把子应用路由同步到宿主 URL query（`?react-app=...`），刷新浏览器可恢复。
4. **同源 Storage 逻辑隔离**：带 `allow-same-origin` 的同源 iframe 与宿主共享 `localStorage`/`sessionStorage`，通过 `storage.js` 按 `[webox:${appId}]:` 前缀自动隔离。
5. **宿主 CSS 变量注入到 ShadowDOM `:host`**：确保宿主主题变量穿透进入 ShadowDOM 生效。
