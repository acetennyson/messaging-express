import { defineConfig } from 'vitest/config';
import path from 'path';

// Lets tests import route handlers that use the `@/` alias from tsconfig.json (and the server package by name).
export default defineConfig({
  resolve: {
    alias: [
      // The server core is a workspace package; tests use its source directly (no build step).
      { find: /^@messaging-express\/server$/, replacement: path.resolve(__dirname, 'packages/server/src/index.ts') },
      { find: /^@messaging-express\/server\/(.*)$/, replacement: path.resolve(__dirname, 'packages/server/src') + '/$1' },
      { find: /^@\//, replacement: path.resolve(__dirname) + '/' },
    ],
  },
  // The SDK packages have their own vitest config and scripts (npm run test:sdk): they must not run inside the server's setup. packages/server's tests DO run here.
  test: { exclude: ['**/node_modules/**', '**/dist/**', 'packages/client/**', 'packages/client-crypto/**'] },
});
