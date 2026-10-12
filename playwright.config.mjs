import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const port = Number(process.env.WARDROBE_BROWSER_PORT || 5198);
const artifacts = resolve(process.env.WARDROBE_BROWSER_ARTIFACTS || `/tmp/wardrobe-browser-${Date.now()}`);

export default defineConfig({
  testDir: './tests/browser',
  outputDir: artifacts,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1365, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    env: {
      WARDROBE_DATA_DIR: resolve(artifacts, 'fixture-data'),
      WARDROBE_MODEL_REFERENCE: resolve(artifacts, 'fixture-data/model-reference.png'),
      OPENAI_API_KEY: '',
    },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
