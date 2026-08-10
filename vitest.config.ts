import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', '.output', '.wxt', 'jobtracker-backend/node_modules'],
    setupFiles: ['./tests/setup.ts'],
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts', 'jobtracker-backend/utils.ts'],
      exclude: ['node_modules', '**/*.test.ts'],
    },
  },
  resolve: {
    alias: {
      'wxt/storage': path.resolve(__dirname, 'node_modules/wxt/dist/utils/storage.mjs'),
      'wxt/browser': path.resolve(__dirname, 'node_modules/wxt/dist/browser.mjs'),
      '~': path.resolve(__dirname, '.'),
      '@prisma/client': path.resolve(__dirname, 'jobtracker-backend/node_modules/@prisma/client'),
      'ioredis': path.resolve(__dirname, 'jobtracker-backend/node_modules/ioredis'),
      'bullmq': path.resolve(__dirname, 'jobtracker-backend/node_modules/bullmq'),
    },
  },
});
