import { defineConfig } from 'tsup';

export default defineConfig({
  // The IndexedDB store is its own entry so Node users never bundle browser-only code.
  entry: ['src/index.ts', 'src/stores/indexeddb.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  // The core client is a peer; the @noble libraries are real dependencies and stay external (resolved by the consumer's package manager,
  // so a security fix in @noble reaches users without a re-release of this package).
  external: ['@messaging-express/client', /^@noble\//],
  splitting: false,
});
