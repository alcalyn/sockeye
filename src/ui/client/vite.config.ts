import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// The footer shows which version of the dashboard is running; take it from the manifest
// that gets published, so the two can never drift.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export default defineConfig({
  // The config does not sit at the package root, so point vite at the SPA explicitly.
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Assets are referenced relatively, so the SPA works under any mount path.
  base: './',
  plugins: [vue()],
  define: {
    __SOCKEYE_VERSION__: JSON.stringify(version),
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    // `pnpm dev:client` talks to an app that mounted the dashboard on /sockeye.
    proxy: {
      '/api': {
        target: 'http://localhost:3000/sockeye',
        changeOrigin: true,
      },
    },
  },
});
