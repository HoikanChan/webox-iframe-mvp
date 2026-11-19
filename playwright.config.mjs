import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 3457);

/**
 * 优先复用本机已缓存的 ms-playwright Chromium（避免不同小版本重复下载），
 * 若未找到则交由 Playwright 默认路径处理。
 */
function resolveLocalChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const cacheDir =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')
      : path.join(os.homedir(), '.cache', 'ms-playwright');

  if (!fs.existsSync(cacheDir)) return undefined;

  const entries = fs
    .readdirSync(cacheDir)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));

  for (const dir of entries) {
    const candidates = [
      path.join(cacheDir, dir, 'chrome-win64', 'chrome.exe'),
      path.join(cacheDir, dir, 'chrome-win', 'chrome.exe'),
      path.join(cacheDir, dir, 'chrome-linux', 'chrome'),
      path.join(cacheDir, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];
    for (const exe of candidates) {
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

const executablePath = resolveLocalChromium();

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 860 },
    trace: 'on-first-retry',
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: `node server.mjs`,
    port: PORT,
    env: {
      PORT: String(PORT),
    },
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
