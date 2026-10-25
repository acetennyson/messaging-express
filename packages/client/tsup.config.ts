import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  // No server-only code may end up here (pg, next, ...). Nothing is bundled from node_modules: there are no runtime dependencies.
  splitting: false,
});
