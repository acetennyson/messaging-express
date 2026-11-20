import { defineConfig } from 'tsup';

// Builds the publishable package into pkg/dist (see scripts/build-package.mjs, which adds the manifest, README and LICENSE).
// Everything in package.json "dependencies" and "peerDependencies" stays external, so the consumer's package manager
// resolves them (pg, jsonwebtoken, zod, socket.io, sharp are real dependencies; the rest are optional peers loaded on demand).
export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  outDir: 'pkg/dist',
  format: ['esm', 'cjs'],
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  clean: true,
  target: 'node20',
  platform: 'node',
  splitting: true,
  tsconfig: 'tsconfig.build.json',
});
