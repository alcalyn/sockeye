import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  // The config does not sit at the package root, so point vite at the SPA explicitly.
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Assets are referenced relatively, so the SPA works under any mount path.
  base: './',
  plugins: [vue()],
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
