import { defineConfig } from 'tsup';

export default defineConfig({
  // `realtime` is its own entry so that REST-only customers never import (or have to resolve) socket.io-client.
  entry: ['src/index.ts', 'src/realtime.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  // No server-only code may end up here (pg, next, ...). Nothing is bundled from node_modules.
  external: ['socket.io-client'],
  splitting: false,
});
