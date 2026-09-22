import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '@sockeye-js/store-memory';
import { BINARY, attachWsMonitor, type WsMonitorOptions } from '../src/index.js';

async function until<T>(check: () => T | Promise<T>, timeout = 3000): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

const running: Array<() => Promise<void>> = [];

async function setup(options: WsMonitorOptions = {}, monitors = 1) {
  const store = new MemoryStore();
  const wss = new WebSocketServer({ port: 0 });
  for (let i = 0; i < monitors; i++) attachWsMonitor(wss, store, options);

  await new Promise<void>((resolve) => wss.on('listening', resolve));
  const { port } = wss.address() as AddressInfo;

  const serverSocketPromise = new Promise<WebSocket>((resolve) => wss.on('connection', resolve));
  const client = new WebSocket(`ws://localhost:${port}/chat`);
  await new Promise<void>((resolve) => client.on('open', () => resolve()));
  const serverSocket = await serverSocketPromise;

  running.push(
    async () => {
      client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  );

  return { store, client, serverSocket };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((stop) => stop()));
});

describe('attachWsMonitor (ws)', () => {
  it('names JSON frames from their type field and measures the frame size', async () => {
    const { store, client } = await setup();
    const frame = JSON.stringify({ type: 'chat:send', text: 'hello' });
    client.send(frame);

    const stats = await until(async () => {
      const [found] = await store.getMessageStats('chat:send', { direction: 'in' });
      expect(found).toBeDefined();
      return found;
    });

    expect(stats.count).toBe(1);
    expect(stats.totalBytes).toBe(Buffer.byteLength(frame));
  });

  it('accepts a custom name extractor', async () => {
    const { store, client } = await setup({
      nameOf: (data) => String(data).split('|')[0],
    });
    client.send('MOVE|3,4');

    await until(async () => {
      expect(await store.getMessageStats('MOVE', { direction: 'in' })).toHaveLength(1);
    });
  });

  it('records outgoing frames sent by the server', async () => {
    const { store, serverSocket } = await setup();
    const frame = JSON.stringify({ type: 'chat:new', text: 'hi' });
    serverSocket.send(frame);

    const stats = await until(async () => {
      const [found] = await store.getMessageStats('chat:new', { direction: 'out' });
      expect(found).toBeDefined();
      return found;
    });

    expect(stats.totalBytes).toBe(Buffer.byteLength(frame));
  });

  it('labels binary frames', async () => {
    const { store, client } = await setup();
    client.send(Buffer.alloc(512));

    const stats = await until(async () => {
      const [found] = await store.getMessageStats(BINARY, { direction: 'in' });
      expect(found).toBeDefined();
      return found;
    });

    expect(stats.totalBytes).toBe(512);
  });

  it('derives the namespace from the upgrade request', async () => {
    const { store, client } = await setup({
      namespaceOf: (request) => request.url,
    });
    client.send(JSON.stringify({ type: 'hello' }));

    const stats = await until(async () => {
      const [found] = await store.getMessageStats('hello', { direction: 'in' });
      expect(found).toBeDefined();
      return found;
    });

    expect(stats.namespace).toBe('/chat');
  });

  it('still delivers frames when the name extractor throws', async () => {
    const { store, client, serverSocket } = await setup({
      nameOf: () => {
        throw new Error('bad parser');
      },
      onError: () => {},
    });

    const received = new Promise<string>((resolve) =>
      serverSocket.on('message', (data) => resolve(String(data))),
    );
    client.send('anything');

    expect(await received).toBe('anything');
    await until(async () => {
      expect(await store.listMessages()).toHaveLength(1);
    });
  });

  it('counts a message once when the monitor is attached twice', async () => {
    const { store, client } = await setup({}, 2);
    client.send(JSON.stringify({ type: 'chat:send', text: 'hello' }));

    const stats = await until(async () => {
      const [found] = await store.getMessageStats('chat:send', { direction: 'in' });
      expect(found).toBeDefined();
      return found;
    });

    expect(stats.count).toBe(1);
  });
});
