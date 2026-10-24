import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Match Tauri's engine family; Playwright does not run the system WebView itself.
const browser = process.platform === 'win32' ? 'chromium' : 'webkit';

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: { '@': resolve(import.meta.dirname, './src') },
  },
  test: {
    reporters: [
      'default',
      {
        async onTestRunStart() {
          // Keep only this run's diagnostic attachments, including in watch mode.
          await rm(resolve(import.meta.dirname, '.vitest/attachments'), {
            recursive: true,
            force: true,
          });
        },
      },
    ],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.tauri.test.ts', 'src/**/*.browser.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'component',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          exclude: ['src/**/*.browser.test.tsx'],
          setupFiles: ['./src/test/component-setup.ts'],
        },
      },
      {
        extends: true,
        plugins: [react(), tailwindcss()],
        test: {
          name: 'browser',
          include: ['src/**/*.browser.test.{ts,tsx}'],
          setupFiles: ['./src/test/browser-setup.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser }],
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'tauri',
          environment: 'jsdom',
          include: ['src/**/*.tauri.test.ts'],
          setupFiles: ['./src/test/tauri-setup.ts'],
        },
      },
    ],
  },
});
