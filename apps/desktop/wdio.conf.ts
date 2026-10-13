import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TauriServiceOptions } from '@wdio/tauri-service';
import type {} from '@wdio/types';

const artifacts = fileURLToPath(
  new URL('./test-results/desktop/', import.meta.url),
);
if (!process.env.WORKRUN_E2E_DATA_DIR || !process.env.WORKRUN_E2E_BINARY) {
  throw new Error(
    'Run pnpm --filter workrun test:e2e to use an isolated workspace.',
  );
}

export const config: WebdriverIO.Config = {
  tsConfigPath: './tsconfig.e2e.json',
  runner: 'local',
  specs: ['./test/e2e/**/*.spec.ts'],
  maxInstances: 1,
  capabilities: [{ browserName: 'tauri' }],
  services: [
    [
      '@wdio/tauri-service',
      {
        appBinaryPath: process.env.WORKRUN_E2E_BINARY,
        driverProvider: 'embedded',
        captureBackendLogs: true,
        captureFrontendLogs: true,
        env: { WORKRUN_E2E_DATA_DIR: process.env.WORKRUN_E2E_DATA_DIR },
      } satisfies TauriServiceOptions,
    ],
  ],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: 'info',
  outputDir: artifacts,
  waitforTimeout: 15000,
  connectionRetryCount: 0,
  mochaOpts: { timeout: 60000 },
  async afterTest(test, _context, { passed }) {
    if (passed) return;
    await mkdir(artifacts, { recursive: true });
    const name = `${Date.now()}-${test.title.replace(/[^a-z0-9]+/gi, '-')}`;
    const { browser } = await import('@wdio/globals');
    await browser.saveScreenshot(join(artifacts, `${name}.png`));
  },
};
