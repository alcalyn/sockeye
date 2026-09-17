import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./src/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sockeye-js/core': pkg('core'),
      '@sockeye-js/store-memory': pkg('store-memory'),
      '@sockeye-js/collect-websocket': pkg('collect-websocket'),
      '@sockeye-js/collect-socketio': pkg('collect-socketio'),
      '@sockeye-js/collect-ws': pkg('collect-ws'),
      '@sockeye-js/store-redis': pkg('store-redis'),
      '@sockeye-js/ui': pkg('ui'),
    },
  },
  test: {
    include: ['src/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
});
