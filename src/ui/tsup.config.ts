import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  // Never wipe dist/client, which `vite build` produced just before.
  clean: false,
  sourcemap: true,
  target: 'node18',
});
