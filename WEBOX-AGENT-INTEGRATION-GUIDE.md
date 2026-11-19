# WEBOX `sandboxMode: 'iframe'` 集成操作指南（面向内部 Coding Agent）

> **用途：** 本文档用于指导 WEBOX 仓库内的 Coding Agent，将已通过 10/10 Playwright E2E 验证的 `webox-iframe-mvp/src/` 模块平滑集成到内部 WEBOX 工程中。
> **核心原则：** 增量引入 `sandboxMode: 'iframe'`，**默认保持 `strict` 模式零改动**，支持一键降级；不破坏 WEBOX 现有 4 大能力（`/febs-proxy/*` 跨域代理、HOFS 缓存、前端隔离、SAML 认证）。

---

## 一、开始前必读：硬约束与 5 个防踩坑红线

在动手修改任何代码前，请严格遵守以下 5 条架构红线（这些均已在 MVP 中验证修复，**切勿退回初版方案的写法**）：

1. **禁止让动态 `<script>` 逃逸到宿主 window**
   - 在 `patchIframeDocument` 之前，必须先保存 iframe 真实的 `head`、`body` 和 `Node.prototype.appendChild`。
   - 必须劫持 ShadowDOM 内 `shadowHead` 和 `renderRoot` 的 `appendChild` / `insertBefore`：凡是动态插入的 `<script>`（例如 Webpack 异步 chunk），必须拦截并路由回 **iframe 真实 `head`** 执行，并在 ShadowDOM 原位留注释占位符，同时在原 `<script>` 上派发 `load` / `error` 事件。
2. **不要指望 iframe `<base>` 解析 ShadowDOM 内的资源**
   - ShadowDOM 挂在宿主文档下，不受 iframe `<base href>` 影响。
   - 必须拉取 `<link rel="stylesheet">` 内容，经 `rewriteCssUrls` 改写 `url(...)` 与 `@import "..."` 后以 `<style>` 注入 ShadowDOM，并对 DOM 节点内的 `<img src>` / `<source src>` 执行 `resolveToCurrent`。
3. **禁止让 iframe 停留在 `about:blank`**
   - 浏览器在 `about:blank` 下调用 `history.pushState` 会抛 `SecurityError`。
   - 创建 iframe 后、执行任何子应用脚本前，必须通过 `iframeWindow.history.replaceState(null, '', initialSameOriginPath)` 初始化真实同源路径。
4. **同源 iframe 不会自动隔离 `localStorage` / `sessionStorage`**
   - 因为 iframe 必须携带 `allow-same-origin`（否则 SAML Cookie 无法携带且无法访问容器），同源 iframe 与宿主共享 Storage。必须挂载 `patchIframeStorage` 按 `[webox:${appId}]:` 前缀做逻辑隔离。
5. **宿主 CSS 变量必须注入到 ShadowDOM `:host`**
   - 仅注入 iframe `<head>` 的 `:root` 无法作用于 ShadowDOM 渲染树，必须注入到 `shadowRoot` 的 `:host { ... }` 中。

---

## 二、前置摸底（Agent 第一步只读检查）

在写代码前，先读取 WEBOX 仓库中以下文件，确认现有函数签名与 `app` 实例字段：

1. `src/types.ts`（或类型定义文件）：查看 `AddAppOptions`、`WeboxApp` 定义。
2. `src/application.ts`：查看 `addApp`、`removeApp`、`apps` 注册表以及 `window.proxies` 清理逻辑。
3. `src/lifecycle.js`：查看 `loadApp`、`updateApp`、`fetchUrl`、`app.context.attachApplication`、`mountToTarget` / `trackPosition` 调用方式。
4. `src/resolveUrl.js`：查看 `isAbsoluteURL` 和 `resolveToCurrent` 的现有实现与参数顺序。
5. `src/communication.js`：查看 `app.broadcast` / `app.subscribe` 的真实签名。
6. `src/locationAndHistory.js`（如有）：查看 `locationProxy` 同步接口（如 `weboxLocationChangedModifierApply`）。

---

## 三、文件映射与改动清单

将 `webox-iframe-mvp/src/` 中的代码按以下映射集成到 WEBOX：

| MVP 源文件 | WEBOX 目标文件 | 操作类型 | 说明 |
| :--- | :--- | :---: | :--- |
| `src/errorReporter.js` | `src/errorReporter.js` | **新增** | 分级错误上报（`reportWeboxError` / `getErrors` / `clearErrors` / `ERROR_LEVELS`） |
| `src/routeSync.js` | `src/routeSync.js` | **新增** | 同源 URL 初始化 + 对标 wujie 的宿主 URL query 路由同步与刷新恢复 |
| `src/storage.js` | `src/iframeStorage.js`（或复用现有 `storage.js`） | **新增/复用** | 若 WEBOX 现有 `storage.js` 已实现 `[app.id]` 前缀 Proxy，可直接复用；否则拷贝 `src/storage.js` |
| `src/iframeSandbox.js` | `src/iframeSandbox.js` | **新增** | iframe 沙箱核心（DOM 分流、视口代理、网络拦截、通信桥接、错误捕获、销毁清理） |
| `src/resolveUrl.js` | `src/resolveUrl.js` | **增量修改** | 1) 修复 `isAbsoluteURL` 支持协议相对 URL `//cdn.example.com/x`；2) 新增导出 `rewriteCssUrls(cssText, contextRoot, cssFileUrl)`（同时支持 `url()` 与 `@import`） |
| `src/lifecycle.js` | `src/lifecycle.js` | **增量修改** | `loadApp` / `updateApp` 按 `app.sandboxMode === 'iframe'` 分流；现有逻辑重命名为 `loadAppInProxy` / `updateAppInProxy` 保持原样 |
| `src/application.ts` | `src/application.ts` | **增量修改** | `addApp` 新增 `sandboxMode = 'strict'`、`syncRoute = true`；`removeApp` 在 `iframe` 模式下调用 `destroyIframeSandbox(app)` |
| `src/types.ts` | `src/types.ts` | **增量修改** | 新增 `SandboxMode = 'strict' | 'iframe'` 及 `iframe`/`iframeWindow`/`iframeDocument`/`syncRoute` 等字段 |
| `src/index.ts` | `src/index.ts` | **增量修改** | 额外导出 `getErrors`、`clearErrors` |

> **注意：** `FEBService` 侧路由转发、HOFS、SAML 认证**无需修改**。唯一需向业务方/后端确认的是：若 FEBService 的 `JsPerprocessor.modifyJs` / `CssPerprocessor.modifyCss` 注入了旧 Proxy 沙箱专用改写（如重写 `window` 引用），需对走 `iframe` 模式的子应用关闭或移除该改写，直接返回原始静态资源。

---

## 四、分步改造指令

### Step 1：补强 `src/resolveUrl.js`

1. 确保 `isAbsoluteURL(url)` 匹配协议相对 URL（以 `//` 开头）：
   ```js
   export function isAbsoluteURL(url) {
     if (!url || typeof url !== 'string') return false;
     return /^(?:[a-zA-Z][a-zA-Z\d+\-.]*:|\/\/)/.test(url.trim());
   }
   ```
2. 从 MVP 的 `src/resolveUrl.js` 迁入 `shouldRewriteUrl` 与 `rewriteCssUrls`，保留 WEBOX 原有 `resolveToCurrent` 导出签名兼容（确保 `//cdn.example.com/x`、`data:`、`blob:`、`#`、`javascript:`、`/febs-proxy/` 均原样透传）。

### Step 2：新增 `errorReporter.js`、`routeSync.js`、`iframeSandbox.js`

1. 直接拷贝 `webox-iframe-mvp/src/errorReporter.js`、`src/routeSync.js`、`src/iframeSandbox.js` 到 WEBOX `src/`。
2. 在 `src/iframeSandbox.js` 中对齐 WEBOX 现有依赖：
   - **网络请求头钩子**：在 `injectNetworkInterceptors` 的 `XHR.prototype.setRequestHeader` 中，若 WEBOX 宿主存在自定义 `requestHeaderModifier`，保持原有透传逻辑（参考 MVP 第 468 行及原方案 3.3.1）。
   - **通信桥接**：将 `app._emitBroadcast` 对接到 WEBOX 现有 `communication.js` 的 `app.broadcast` / `subscribe` 主题总线，确保宿主与 Proxy 模式子应用、iframe 模式子应用三方互通。
   - **路由回调**：如果 WEBOX 仍需通知 `app.locationProxy`，在 `routeSync.js` 的 `onRouteChange` 回调中同步调用 `app.locationProxy` 更新方法。

### Step 3：改造 `src/types.ts`、`src/application.ts`、`src/index.ts`

1. `src/types.ts` 补充：
   ```ts
   export type SandboxMode = 'strict' | 'iframe';

   export interface AddAppOptions {
     // ...保留现有全部字段
     sandboxMode?: SandboxMode; // 默认 'strict'
     syncRoute?: boolean;       // 默认 true（仅 iframe 模式生效）
   }
   ```
2. `src/application.ts`：
   - `addApp` 解构新增 `sandboxMode = 'strict'`、`syncRoute = true`，挂载到 `app` 实例上。
   - `removeApp(id)` 在移除 DOM 节点前增加：
     ```ts
     if (app.sandboxMode === 'iframe') {
       destroyIframeSandbox(app);
     }
     ```
3. `src/index.ts`：导出 `getErrors`、`clearErrors`。

### Step 4：改造 `src/lifecycle.js`

1. 将现有 `loadApp` 重命名为 `loadAppInProxy`，现有 `updateApp` 重命名为 `updateAppInProxy`（**一行不改**，确保 `strict` 模式 100% 回归安全）。
2. 新增分流入口：
   ```js
   export async function loadApp(app) {
     if (app.sandboxMode === 'iframe') {
       return loadAppInIframe(app);
     }
     return loadAppInProxy(app);
   }

   export async function updateApp(id, url, app) {
     if (app.sandboxMode === 'iframe') {
       return updateAppInIframe(id, url, app);
     }
     return updateAppInProxy(id, url, app);
   }
   ```
3. 迁入 MVP `src/lifecycle.js` 中的 `loadAppInIframe`、`updateAppInIframe`、`renderHtmlIntoSandbox`、`bindMpaLinkInterception`，并衔接 WEBOX 特有逻辑：
   - HTML 拉取复用 WEBOX 现有的 `fetchUrl(targetUrl)`（若已内置重试/鉴权逻辑）。
   - 加载完成后保留 `if (app.context) app.context.attachApplication(app);`。
   - 若 `!app.mountToTarget`，保留 WEBOX 现有的 `trackPosition(app.container, app.renderRoot, app)` 定位追踪逻辑。

---

## 五、验收清单（Agent 集成完成后必须逐项验证）

请将 `webox-iframe-mvp/e2e/webox-iframe.spec.mjs` 适配迁入 WEBOX 仓库的 `test/compat/iframe/`，并确保以下 **11 项全部通过**：

### A. 向后兼容（必须零回归）
- [ ] **0. `strict` 模式零回归**：不传 `sandboxMode` 或传 `sandboxMode: 'strict'` 时，WEBOX 现有单测与老子应用行为 100% 不变。

### B. `iframe` 模式核心能力（对应 E2E Test 1~10）
- [ ] **1. `window` 变量隔离**：宿主与多个 `iframe` 子应用各自读写同名全局变量互不污染，且 `let x = 1; 'x' in window === false`。
- [ ] **2. 动态 `<script>` 防逃逸**：子应用执行 `document.head.appendChild(script)` 加载异步 chunk，脚本在 iframe 内执行且不污染宿主 `window`。
- [ ] **3. ShadowDOM 样式与 Portal**：宿主冲突样式不穿透；宿主 CSS 变量穿透到 `:host`；Portal 弹窗挂载在 ShadowDOM 内。
- [ ] **4. Storage 前缀隔离**：宿主与各子应用读写同名 `localStorage`/`sessionStorage` key 互不覆盖。
- [ ] **5. 视口与原生 API**：`innerWidth`/`innerHeight` > 0、`matchMedia`、`document.evaluate`、`requestAnimationFrame`、`ResizeObserver` 转发 `resize` 均正常。
- [ ] **6. 跨域代理与 SAML / `roarand`**：根路径 `fetch('/api/...')` & XHR 改写到 `/febs-proxy/{cluster}/...`；SAML 302 自动跟随并携带 Cookie；非 GET 请求自动注入 `roarand`。
- [ ] **7. CSS `@import` 与协议相对 URL**：`@import "./theme.css"` 改写并生效；`//cdn.example.com/x` 不被误拼 `/febs-proxy/`。
- [ ] **8. SPA 路由同步与刷新恢复**：`history.pushState` 同步到宿主 URL Query，整页刷新后子应用恢复到对应路由。
- [ ] **9. MPA `<a>` 链接拦截**：点击相对路径 `<a href="./detail.html">` 在子应用内切换，宿主不发生整页跳转。
- [ ] **10. 通信、卸载与错误可观测性**：跨应用 `broadcast`/`subscribe` 正常；`removeApp` 后 DOM 中无残留 iframe、`ResizeObserver` 已 disconnect；子应用抛异常时 `WEBOX.getErrors()` 正常捕获（无 silent fail）。

---

## 六、接入真实业务子应用后的二期加固点（按需实施）

MVP 已覆盖核心主链路，若试点接入**真实 React 17/18 + AntD 或老旧 jQuery MPA** 时遇到以下边缘场景，按优先级参考 `wujie-core` 增量补齐：

1. **跨 realm `instanceof` 失败**（AntD/rc-util/ECharts 报类型校验错误）：参考 `wujie-core/src/iframe.ts` 使用 `Symbol.hasInstance` 修补 `HTMLElement`、`Node`、`Event` 等构造器。
2. **ShadowDOM 内图标字体变方块 / `:root` 变量不生效**：参考 `wujie-core/src/shadow.ts` 将 `@font-face` 提取到宿主 `<head>`，并将子应用 CSS 中的 `:root` 替换为 `:host`。
3. **AntD v5 CSS-in-JS 动态规则丢失**：参考 `wujie-core/src/effect.ts` 劫持 `<style>` 的 `sheet.insertRule`、`textContent` setter 与 `insertAdjacentElement`。
4. **jQuery MPA 通过 `window.location.href = ...` 或 `<form action="...">` 跳转**：拦截 `form` 的 `submit` 事件并视需要引入 `location` Proxy 劫持 `href` 赋值。
