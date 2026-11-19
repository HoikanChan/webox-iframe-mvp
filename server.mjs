/**
 * 零依赖本地模拟服务器（宿主 + FEBService /febs-proxy/* 代理模拟）
 *
 * 启动方式：node webox-iframe-mvp/server.mjs
 * 访问地址：http://localhost:3456
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3456);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function serveStaticFile(res, filePath, extraHeaders = {}) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 Not Found: ${filePath}`);
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    ...extraHeaders,
  });
  fs.createReadStream(filePath).pipe(res);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  // 1. 宿主入口与 favicon
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (pathname === '/' || pathname === '/index.html') {
    return serveStaticFile(res, path.join(__dirname, 'demo', 'index.html'));
  }

  // 2. SDK 源码与宿主脚本
  if (pathname.startsWith('/src/') || pathname.startsWith('/demo/')) {
    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    return serveStaticFile(res, path.join(__dirname, safePath));
  }

  // 3. 模拟 FEBService /febs-proxy/{clusterName}/*
  const proxyMatch = pathname.match(/^\/febs-proxy\/([^/]+)(\/.*)?$/);
  if (proxyMatch) {
    const cluster = proxyMatch[1];
    const subPath = proxyMatch[2] || '/index.html';

    // 3.1 模拟 API：GET /api/data
    if (subPath === '/api/data') {
      return sendJson(
        res,
        200,
        {
          ok: true,
          cluster,
          path: pathname,
          message: `来自 FEBService 代理 (${cluster}) 的数据`,
          ts: Date.now(),
        },
        { 'X-HOFS-Cache': 'MISS' }
      );
    }

    // 3.2 模拟 API：GET /api/items（jQuery MPA XHR）
    if (subPath === '/api/items') {
      return sendJson(res, 200, {
        ok: true,
        cluster,
        items: ['Item A', 'Item B', 'Item C'],
      });
    }

    // 3.3 模拟 SAML 302 重定向 + Set-Cookie 认证流
    if (subPath === '/api/saml-protected') {
      const cookie = req.headers.cookie || '';
      if (!cookie.includes('bspsession-webox=valid-session')) {
        res.writeHead(302, {
          Location: `/febs-proxy/${cluster}/saml-callback`,
        });
        res.end();
        return;
      }
      return sendJson(res, 200, {
        authenticated: true,
        cookiePresent: true,
        cluster,
        user: 'webox-saml-user',
      });
    }

    if (subPath === '/saml-callback') {
      res.writeHead(302, {
        'Set-Cookie': 'bspsession-webox=valid-session; Path=/; SameSite=Lax',
        Location: `/febs-proxy/${cluster}/api/saml-protected`,
      });
      res.end();
      return;
    }

    // 3.4 模拟 POST /api/submit（校验 roarand header）
    if (subPath === '/api/submit' && req.method === 'POST') {
      const rawBody = await readBody(req);
      let parsed = rawBody;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        // ignore
      }
      return sendJson(res, 200, {
        ok: true,
        cluster,
        receivedRoarand: req.headers['roarand'] || null,
        echo: parsed,
      });
    }

    // 3.5 React SPA 虚拟路由 fallback（仅对无扩展名的前端路由生效，排除 .js/.css 等静态资源）
    if (cluster === 'react-app' && subPath.startsWith('/view/') && !path.extname(subPath)) {
      return serveStaticFile(res, path.join(__dirname, 'subapps', 'react-app', 'index.html'), {
        'X-HOFS-Cache': 'HIT',
      });
    }

    // 3.6 静态资源（模拟 HOFS 缓存命中）
    const relFile = subPath === '/' ? 'index.html' : subPath.replace(/^\/+/, '');
    const filePath = path.join(__dirname, 'subapps', cluster, relFile);
    return serveStaticFile(res, filePath, { 'X-HOFS-Cache': 'HIT' });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`404 Not Found: ${pathname}`);
});

server.listen(PORT, () => {
  console.log(`[WEBOX MVP Server] running at http://localhost:${PORT}`);
  console.log(`  - Host Demo:  http://localhost:${PORT}/`);
  console.log(`  - React SPA:  http://localhost:${PORT}/febs-proxy/react-app/index.html`);
  console.log(`  - jQuery MPA: http://localhost:${PORT}/febs-proxy/jquery-mpa/index.html`);
});
