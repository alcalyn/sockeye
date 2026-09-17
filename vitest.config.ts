import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./src/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sockeye/core': pkg('core'),
      '@sockeye/store-memory': pkg('store-memory'),
      '@sockeye/collect-websocket': pkg('collect-websocket'),
      '@sockeye/collect-socketio': pkg('collect-socketio'),
      '@sockeye/collect-ws': pkg('collect-ws'),
      '@sockeye/store-redis': pkg('store-redis'),
      '@sockeye/ui': pkg('ui'),
    },
  },
  test: {
    include: ['src/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
});
