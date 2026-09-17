/**
 * Demo app: a socket.io server with a handful of deliberately different message profiles,
 * monitored by sockeye, with the dashboard mounted on /sockeye.
 *
 *   npm start                  # in-memory store, traffic generator included
 *   STORE=redis npm start      # same, but metrics go to Redis
 *   TRAFFIC=0 npm start        # no generated traffic, drive it yourself
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { sockeye } from '@sockeye/collect-socketio';
import { createMemoryStore } from '@sockeye/store-memory';
import { dashboard } from '@sockeye/ui';

const PORT = Number(process.env.PORT ?? 3000);

async function createStore() {
  if (process.env.STORE !== 'redis') return createMemoryStore();

  const { default: Redis } = await import('ioredis');
  const { createRedisStore } = await import('@sockeye/store-redis');
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/14');
  console.log('[demo] using the Redis store');
  return createRedisStore(redis, { prefix: 'sockeye-demo', flushIntervalMs: 500 });
}

const store = await createStore();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// 1. Collect.
io.use(sockeye(store));

// 2. Expose the dashboard.
app.use('/sockeye', dashboard(store));

app.get('/', (_req, res) => {
  res.type('html').send(
    '<h1>sockeye demo</h1><p>Dashboard: <a href="/sockeye/">/sockeye/</a></p>',
  );
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

io.on('connection', (socket) => {
  // Small, frequent, answered immediately.
  socket.on('chat:send', async (message, ack) => {
    await sleep(randomInt(1, 8));
    ack?.({ id: randomInt(1, 1e6), receivedAt: Date.now() });
    socket.broadcast.emit('chat:new', message);
  });

  // Tiny and very frequent, no acknowledgement at all.
  socket.on('cursor:move', () => {});

  // Big payload in, small answer out.
  socket.on('file:upload', async (file, ack) => {
    await sleep(randomInt(20, 120));
    ack?.({ ok: true, stored: file?.chunk?.length ?? 0 });
  });

  // The slow one: this is what should top the "slowest responses" list.
  socket.on('report:generate', async (request, ack) => {
    await sleep(randomInt(300, 1500));
    ack?.({ rows: randomInt(100, 5000), request });
  });
});

// A periodic broadcast, to show outgoing traffic nobody asked for.
setInterval(() => {
  io.emit('presence:update', {
    online: io.engine.clientsCount,
    at: Date.now(),
  });
}, 3000).unref();

httpServer.listen(PORT, () => {
  console.log(`[demo] app          http://localhost:${PORT}/`);
  console.log(`[demo] dashboard    http://localhost:${PORT}/sockeye/`);

  if (process.env.TRAFFIC !== '0') {
    const traffic = spawn(process.execPath, ['traffic.js'], {
      stdio: 'inherit',
      env: { ...process.env, PORT: String(PORT) },
    });
    process.on('exit', () => traffic.kill());
    process.on('SIGINT', () => {
      traffic.kill();
      process.exit(0);
    });
  }
});
