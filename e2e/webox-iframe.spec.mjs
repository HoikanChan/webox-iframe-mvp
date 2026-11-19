import { test, expect } from '@playwright/test';

test.describe('WEBOX iframe 沙箱 MVP 完整 E2E 验收', () => {
  /** @type {string[]} */
  let pageErrors;
  /** @type {string[]} */
  let consoleErrors;
  /** @type {Array<{ url: string, status: number }>} */
  let failedRequests;

  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    consoleErrors = [];
    failedRequests = [];

    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        failedRequests.push({ url: res.url(), status: res.status() });
      }
    });

    await page.goto('/');
    // 等待自动化验收面板全部 12 项渲染完毕
    await expect(page.locator('#check-results .check-item.pass')).toHaveCount(12);
  });

  test.afterEach(async ({ page }) => {
    expect(pageErrors, '不应有未捕获的 pageerror').toEqual([]);
    expect(consoleErrors, '不应有 console.error').toEqual([]);
    expect(failedRequests, '不应有 4xx/5xx 网络请求').toEqual([]);

    const weboxErrors = await page.evaluate(() =>
      window.WEBOX ? window.WEBOX.getErrors({ level: 'error' }) : []
    );
    expect(weboxErrors, 'WEBOX errorReporter 不应有 ERROR 记录').toEqual([]);
  });

  test('1. 宿主与多子应用 window 全局变量完全隔离，交互修改互不污染', async ({ page }) => {
    // 初始值断言
    const initial = await page.evaluate(() => {
      const rWin = window.WEBOX.getApp('react-app').iframeWindow;
      const jWin = window.WEBOX.getApp('jquery-mpa').iframeWindow;
      return {
        host: {
          token: window.__GLOBAL_TOKEN__,
          appName: window.APP_NAME,
          sharedCounter: window.sharedCounter,
          dollar: typeof window.$,
          reactCounter: typeof window.reactAppCounter,
        },
        react: {
          token: rWin.__GLOBAL_TOKEN__,
          appName: rWin.APP_NAME,
          reactCounter: rWin.reactAppCounter,
          sharedCounter: typeof rWin.sharedCounter,
          letCheck: rWin.__LET_IN_WINDOW_CHECK__,
        },
        jquery: {
          token: jWin.__GLOBAL_TOKEN__,
          appName: jWin.APP_NAME,
          dollar: typeof jWin.$,
          sharedCounter: typeof jWin.sharedCounter,
          reactCounter: typeof jWin.reactAppCounter,
        },
      };
    });

    expect(initial.host).toEqual({
      token: 'HOST_SECRET_TOKEN',
      appName: 'WEBOX_HOST',
      sharedCounter: 100,
      dollar: 'undefined',
      reactCounter: 'undefined',
    });
    expect(initial.react).toEqual({
      token: 'REACT_APP_TOKEN_001',
      appName: 'REACT_SPA',
      reactCounter: 1,
      sharedCounter: 'undefined',
      letCheck: true,
    });
    expect(initial.jquery).toEqual({
      token: 'JQUERY_MPA_TOKEN_999',
      appName: 'JQUERY_MPA',
      dollar: 'function',
      sharedCounter: 'undefined',
      reactCounter: 'undefined',
    });

    // 交互修改 React 的 window.reactAppCounter 与 jQuery 的 window.__GLOBAL_TOKEN__
    await page.locator('#slot-react #btn-inc-win').click();
    await page.locator('#slot-react #btn-inc-win').click();
    await page.locator('#slot-jquery #jq-btn-toggle').click();

    const afterMutate = await page.evaluate(() => {
      const rWin = window.WEBOX.getApp('react-app').iframeWindow;
      const jWin = window.WEBOX.getApp('jquery-mpa').iframeWindow;
      return {
        hostToken: window.__GLOBAL_TOKEN__,
        reactToken: rWin.__GLOBAL_TOKEN__,
        reactCounter: rWin.reactAppCounter,
        jqueryToken: jWin.__GLOBAL_TOKEN__,
      };
    });

    expect(afterMutate.hostToken).toBe('HOST_SECRET_TOKEN');
    expect(afterMutate.reactToken).toBe('REACT_APP_TOKEN_001');
    expect(afterMutate.reactCounter).toBe(3);
    expect(afterMutate.jqueryToken).toMatch(/^JQUERY_MUTATED_\d+$/);
  });

  test('2. 动态 <script> chunk 路由回 iframe 执行，不逃逸到宿主或其他子应用', async ({ page }) => {
    await page.locator('#slot-react #btn-load-chunk').click();

    await expect
      .poll(async () =>
        page.evaluate(() => ({
          host: window.__ASYNC_CHUNK_LOADED__,
          react: window.WEBOX.getApp('react-app').iframeWindow.__ASYNC_CHUNK_LOADED__,
          jquery: window.WEBOX.getApp('jquery-mpa').iframeWindow.__ASYNC_CHUNK_LOADED__,
        }))
      )
      .toEqual({
        host: undefined,
        react: 'REACT_IFRAME_CHUNK_OK',
        jquery: undefined,
      });
  });

  test('3. ShadowDOM 样式隔离、相对路径资源改写、主题变量穿透与 Portal 弹窗', async ({ page }) => {
    // 宿主定义了 .btn { background: #dc2626 !important }，ShadowDOM 内 .btn 应不受污染而保持主题色 #2563eb
    const btnBg = await page
      .locator('#slot-react #btn-inc-win')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(btnBg).toBe('rgb(37, 99, 235)');

    // 相对路径 <img src="./badge.svg"> 应被改写为 /febs-proxy/react-app/badge.svg 且加载成功
    const imgInfo = await page.locator('#slot-react img.logo').evaluate((img) => ({
      src: img.getAttribute('src'),
      complete: img.complete,
      naturalWidth: img.naturalWidth,
    }));
    expect(imgInfo.src).toBe('/febs-proxy/react-app/badge.svg');
    expect(imgInfo.complete).toBe(true);
    expect(imgInfo.naturalWidth).toBeGreaterThan(0);

    // 打开 Portal 弹窗：挂载在 ShadowDOM 内而非宿主 document.body
    await page.locator('#slot-react #btn-portal').click();
    await expect(page.locator('#slot-react .portal-dialog')).toBeVisible();
    const hostPortalCount = await page.evaluate(() => document.body.querySelectorAll('.portal-mask').length);
    expect(hostPortalCount).toBe(0);

    // 关闭 Portal 弹窗
    await page.locator('#slot-react #close-portal').click();
    await expect(page.locator('#slot-react .portal-dialog')).toHaveCount(0);
  });

  test('4. 同源 Storage 前缀隔离（localStorage / sessionStorage 互不覆盖）', async ({ page }) => {
    const storageCheck = await page.evaluate(() => {
      const rWin = window.WEBOX.getApp('react-app').iframeWindow;
      const jWin = window.WEBOX.getApp('jquery-mpa').iframeWindow;

      rWin.localStorage.setItem('only_in_react', 'yes');
      jWin.localStorage.removeItem('only_in_react');

      return {
        hostDemo: window.localStorage.getItem('demo_key'),
        reactDemo: rWin.localStorage.getItem('demo_key'),
        jqueryDemo: jWin.localStorage.getItem('demo_key'),
        reactOnly: rWin.localStorage.getItem('only_in_react'),
        jquerySeesReactOnly: jWin.localStorage.getItem('only_in_react'),
        hostSeesReactOnly: window.localStorage.getItem('only_in_react'),
      };
    });

    expect(storageCheck).toEqual({
      hostDemo: 'HOST_STORAGE_VALUE',
      reactDemo: 'REACT_STORAGE_VALUE',
      jqueryDemo: 'JQUERY_STORAGE_VALUE',
      reactOnly: 'yes',
      jquerySeesReactOnly: null,
      hostSeesReactOnly: null,
    });
  });

  test('5. 视口代理与 ResizeObserver 转发（视口尺寸变化同步到 iframe）', async ({ page }) => {
    const before = await page.evaluate(() => {
      const rWin = window.WEBOX.getApp('react-app').iframeWindow;
      rWin.__E2E_RESIZE_COUNT__ = 0;
      rWin.addEventListener('resize', () => {
        rWin.__E2E_RESIZE_COUNT__ += 1;
      });
      return {
        width: rWin.innerWidth,
        height: rWin.innerHeight,
        raf: rWin.__RAF_TRIGGERED__,
        matchDesktop: rWin.matchMedia('(min-width: 768px)').matches,
      };
    });

    expect(before.width).toBeGreaterThan(200);
    expect(before.height).toBeGreaterThan(200);
    expect(before.raf).toBe(true);
    expect(before.matchDesktop).toBe(true);

    // 调整浏览器窗口宽度，验证 iframe 收到 resize 事件且 innerWidth 发生变化
    await page.setViewportSize({ width: 960, height: 800 });

    await expect
      .poll(async () =>
        page.evaluate(() => window.WEBOX.getApp('react-app').iframeWindow.__E2E_RESIZE_COUNT__)
      )
      .toBeGreaterThan(0);

    const after = await page.evaluate(() => {
      const rWin = window.WEBOX.getApp('react-app').iframeWindow;
      return { resizeCount: rWin.__E2E_RESIZE_COUNT__, width: rWin.innerWidth };
    });
    expect(after.resizeCount).toBeGreaterThan(0);
    expect(after.width).toBeLessThan(before.width);
  });

  test('6. 网络代理、SAML 302+Cookie 与 fetch/XHR roarand Header 注入', async ({ page, context }) => {
    // 先清掉 SAML cookie，验证完整的 302 → saml-callback → Set-Cookie → 重定向回数据接口流程
    await context.clearCookies();

    await page.locator('#slot-react #btn-fetch-root').click();
    await page.locator('#slot-react #btn-fetch-saml').click();
    await page.locator('#slot-react #btn-post-roarand').click();
    await page.locator('#slot-jquery #jq-btn-xhr-get').click();
    await page.locator('#slot-jquery #jq-btn-xhr-post').click();

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const rWin = window.WEBOX.getApp('react-app').iframeWindow;
          const jWin = window.WEBOX.getApp('jquery-mpa').iframeWindow;
          return {
            rootCluster: rWin.__LAST_API_DATA__?.cluster,
            samlAuth: rWin.__LAST_SAML_DATA__?.authenticated,
            samlCookie: rWin.__LAST_SAML_DATA__?.cookiePresent,
            fetchRoarand: rWin.__LAST_POST_DATA__?.receivedRoarand,
            xhrItemsLen: jWin.__LAST_XHR_GET__?.items?.length,
            xhrRoarand: jWin.__LAST_XHR_POST__?.receivedRoarand,
          };
        })
      )
      .toEqual({
        rootCluster: 'react-app',
        samlAuth: true,
        samlCookie: true,
        fetchRoarand: 'mvp-roarand-token-react',
        xhrItemsLen: 3,
        xhrRoarand: 'mvp-roarand-token-jquery',
      });
  });

  test('7. SPA 路由同步到宿主 URL Query 且刷新浏览器可恢复', async ({ page }) => {
    await page.locator('#slot-react button[data-route="/febs-proxy/react-app/view/orders"]').click();

    // 验证宿主 URL query 参数已同步
    await expect(page).toHaveURL(/react-app=%2Ffebs-proxy%2Freact-app%2Fview%2Forders/);
    await expect(page.locator('#slot-react #route-view')).toContainText('/febs-proxy/react-app/view/orders');

    // 刷新整个浏览器页面，验证 React 子应用自动恢复到 /view/orders
    await page.reload();
    await expect(page.locator('#check-results .check-item.pass')).toHaveCount(12);
    await expect(page.locator('#slot-react #route-view')).toContainText('/febs-proxy/react-app/view/orders');
  });

  test('8. jQuery MPA <a> 链接拦截跳转 detail.html 并可返回 index.html', async ({ page }) => {
    const originBefore = new URL(page.url()).origin;
    const pathnameBefore = new URL(page.url()).pathname;

    // 点击相对路径 <a> 跳转 detail.html
    await page.locator('#slot-jquery a.jq-link').click();
    await expect(page.locator('#slot-jquery h2')).toContainText('详情页 (detail.html)');

    // 宿主页面未发生整页跳转，仅 query 同步更新
    const urlAfterDetail = new URL(page.url());
    expect(urlAfterDetail.origin).toBe(originBefore);
    expect(urlAfterDetail.pathname).toBe(pathnameBefore);
    expect(urlAfterDetail.searchParams.get('jquery-mpa')).toBe('/febs-proxy/jquery-mpa/detail.html');

    // 点击返回列表页 ./index.html
    await page.locator('#slot-jquery a.jq-link').click();
    await expect(page.locator('#slot-jquery h2')).toContainText('列表页');
    expect(new URL(page.url()).searchParams.get('jquery-mpa')).toBe('/febs-proxy/jquery-mpa/index.html');
  });

  test('9. 跨应用 postMessage 通信与子应用卸载重装（无 iframe 泄漏）', async ({ page }) => {
    // 宿主广播 → React 与 jQuery 均收到
    await page.locator('#btn-host-broadcast').click();
    await expect(page.locator('#slot-react #net-status')).toContainText('Message from WEBOX Host');
    await expect(page.locator('#slot-jquery #jq-log')).toContainText('Message from WEBOX Host');

    // jQuery 广播 → React 收到
    await page.locator('#slot-jquery #jq-btn-broadcast').click();
    await expect(page.locator('#slot-react #net-status')).toContainText('Hello from jQuery MPA!');

    // 卸载并重装 React 子应用，验证旧 iframe 被彻底清理，不泄漏重复节点
    await page.locator('#btn-remount-react').click();
    await expect(page.locator('#slot-react #win-status')).toContainText('REACT_APP_TOKEN_001');

    const iframeCount = await page.evaluate(
      () => document.querySelectorAll('iframe#_webox_iframe_react-app').length
    );
    expect(iframeCount).toBe(1);
  });

  test('10. 历史稳定性痛点回归（document.evaluate / @import / //cdn URL / 错误不吞没）', async ({ page }) => {
    // 10.1 document.evaluate：原生 iframe 具备该 API，不报 undefined 且可正常执行 XPath 求值
    const evalResult = await page.evaluate(() => {
      const rWin = window.WEBOX.getApp('react-app').iframeWindow;
      const fnType = typeof rWin.document.evaluate;
      const xpathRes = rWin.document.evaluate(
        './/h2',
        rWin.document.body,
        null,
        rWin.XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      return {
        fnType,
        matchedText: xpathRes.singleNodeValue ? xpathRes.singleNodeValue.textContent.trim() : null,
      };
    });
    expect(evalResult.fnType).toBe('function');
    expect(evalResult.matchedText).toContain('React SPA 子应用');

    // 10.2 @import "./theme.css"：ShadowDOM 注入的 <style> 文本已改写为 /febs-proxy/react-app/theme.css 且样式生效
    const importCheck = await page.evaluate(() => {
      const reactApp = window.WEBOX.getApp('react-app');
      const styleTexts = Array.from(reactApp.shadowHead.querySelectorAll('style')).map((s) => s.textContent || '');
      const card = reactApp.renderRoot.querySelector('.card');
      return {
        hasRewrittenImport: styleTexts.some((t) => t.includes('@import "/febs-proxy/react-app/theme.css"')),
        cardBoxShadow: card ? getComputedStyle(card).boxShadow : 'none',
      };
    });
    expect(importCheck.hasRewrittenImport).toBe(true);
    expect(importCheck.cardBoxShadow).not.toBe('none');

    // 10.3 协议相对 URL //cdn.example.com/x：resolveToCurrent 与 XHR 拦截均不误拼接 /febs-proxy/
    const protoRelativeCheck = await page.evaluate(() => {
      const rWin = window.WEBOX.getApp('react-app').iframeWindow;
      const resolvedBySdk = window.WEBOX.resolveToCurrent('/febs-proxy/react-app', '//cdn.example.com/x.js');
      const rewrittenCss = window.WEBOX.rewriteCssUrls(
        '@import "//cdn.example.com/a.css"; .x { background: url(//cdn.example.com/bg.png); }',
        '/febs-proxy/react-app'
      );
      const xhr = new rWin.XMLHttpRequest();
      xhr.open('GET', '//cdn.example.com/api/ping');
      return {
        resolvedBySdk,
        rewrittenCss,
        xhrResolvedUrl: xhr._wbxUrl,
      };
    });
    expect(protoRelativeCheck.resolvedBySdk).toBe('//cdn.example.com/x.js');
    expect(protoRelativeCheck.rewrittenCss).toContain('@import "//cdn.example.com/a.css"');
    expect(protoRelativeCheck.rewrittenCss).toContain('url(//cdn.example.com/bg.png)');
    expect(protoRelativeCheck.xhrResolvedUrl).toBe('//cdn.example.com/api/ping');

    // 10.4 错误可观测性（不 silent fail）：故意在子应用内触发未捕获 Promise rejection，验证 errorReporter 捕获
    await page.evaluate(async () => {
      const rWin = window.WEBOX.getApp('react-app').iframeWindow;
      window.WEBOX.clearErrors();
      // 在 iframe 上下文内触发一个真实 unhandledrejection
      rWin.Promise.reject(new rWin.Error('INTENTIONAL_E2E_REJECTION'));
      await new Promise((r) => setTimeout(r, 50));
    });

    const capturedErrors = await page.evaluate(() =>
      window.WEBOX.getErrors({ module: 'iframe', op: 'unhandledrejection', appId: 'react-app' })
    );
    expect(capturedErrors.length).toBeGreaterThanOrEqual(1);
    expect(capturedErrors[0].message).toContain('INTENTIONAL_E2E_REJECTION');

    // 清理本次刻意触发的测试错误，确保 afterEach 零意外错误校验继续生效
    await page.evaluate(() => window.WEBOX.clearErrors());
    consoleErrors = consoleErrors.filter((msg) => !msg.includes('INTENTIONAL_E2E_REJECTION'));
    pageErrors = pageErrors.filter((msg) => !msg.includes('INTENTIONAL_E2E_REJECTION'));
  });
});
