import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: { '@': resolve(import.meta.dirname, './src') },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.tauri.test.ts'],
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
