import { defineConfig } from 'vitest/config';
import path from 'path';

// Lets tests import route handlers that use the `@/` alias from tsconfig.json.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname) } },
  // The SDK has its own vitest config and scripts (npm run test:sdk): it must not run inside the server's setup.
  test: { exclude: ['**/node_modules/**', '**/dist/**', 'packages/**'] },
});
