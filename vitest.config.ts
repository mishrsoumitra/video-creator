import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const slow = ['**/*.media.test.ts', '**/*.render.test.ts'];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'apps/server/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', ...slow],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/src/**/*.test.{ts,tsx}', 'packages/composition/src/**/*.test.tsx'],
          exclude: ['**/node_modules/**', ...slow],
          setupFiles: ['./apps/web/src/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'media',
          environment: 'node',
          include: ['**/*.media.test.ts'],
          exclude: ['**/node_modules/**'],
          testTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'render',
          environment: 'node',
          include: ['**/*.render.test.ts'],
          exclude: ['**/node_modules/**'],
          testTimeout: 900_000,
          hookTimeout: 900_000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/test/**',
        '**/testing/**',
        '**/*.d.ts',
        '**/main.ts',
        '**/main.tsx',
      ],
      reporter: ['text-summary', 'html'],
    },
  },
});
