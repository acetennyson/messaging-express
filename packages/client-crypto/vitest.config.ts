import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Tests drive the REAL core client against the mock server. Alias it to its source so CI needs no build of the client first.
const coreClient = fileURLToPath(new URL('../client/src/index.ts', import.meta.url));

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
  resolve: { alias: { '@messaging-express/client': coreClient } },
});
