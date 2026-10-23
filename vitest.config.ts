import { defineConfig } from 'vitest/config';
import path from 'path';

// Lets tests import route handlers that use the `@/` alias from tsconfig.json.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname) } },
});
