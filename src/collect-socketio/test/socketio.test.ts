import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, type Socket } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '@sockeye-js/store-memory';
import { monitorSocketIo, sockeye, type SocketIoMonitorOptions } from '../src/index.js';

/** Retry until `check` passes, so tests never rely on an arbitrary delay. */
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

interface Harness {
  io: Server;
  store: MemoryStore;
  client: ClientSocket;
  serverSocket: Socket;
  /** So a test can bring more clients in, to broadcast to several of them. */
  connect(): Promise<Socket>;
}

const running: Array<() => Promise<void>> = [];

/** Boot an http + socket.io server with the monitor installed, and connect one client. */
async function setup(
  install: (io: Server, store: MemoryStore) => void = (io, store) => io.use(sockeye(store)),
): Promise<Harness> {
  const store = new MemoryStore();
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  install(io, store);

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;

  const connected = new Promise<Socket>((resolve) => io.on('connection', resolve));
  const client = connect(`http://localhost:${port}`, { transports: ['websocket'] });
  const serverSocket = await connected;
  await new Promise<void>((resolve) => client.on('connect', () => resolve()));

  running.push(async () => {
    client.disconnect();
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const connectMore = async (): Promise<Socket> => {
    const joined = new Promise<Socket>((resolve) => io.once('connection', resolve));
    const extra = connect(`http://localhost:${port}`, { transports: ['websocket'] });
    const extraServerSocket = await joined;
    await new Promise<void>((resolve) => extra.on('connect', () => resolve()));
    running.push(async () => extra.disconnect());
    return extraServerSocket;
  };

  return { io, store, client, serverSocket, connect: connectMore };
}

const withOptions = (options: SocketIoMonitorOptions) => (io: Server, store: MemoryStore) =>
  void io.use(sockeye(store, options));

afterEach(async () => {
  await Promise.all(running.splice(0).map((stop) => stop()));
});

describe('sockeye (socket.io)', () => {
  it('records incoming events with their payload size', async () => {
    const { client, serverSocket, store } = await setup();
    serverSocket.on('chat:send', () => {});

    const payload = { text: 'hello' };
    client.emit('chat:send', payload);

    const stats = await until(async () => {
      const [found] = await store.getMessageStats('chat:send', { direction: 'in' });
      expect(found).toBeDefined();
      return found;
    });

    expect(stats.count).toBe(1);
    expect(stats.totalBytes).toBe(JSON.stringify(payload).length);
    expect(stats.latency).toBeNull();
  });

  it('times acknowledgements and records the reply', async () => {
    const { client, serverSocket, store } = await setup();
    serverSocket.on('slow:job', async (_payload, ack) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      ack({ ok: true });
    });

    expect(await client.emitWithAck('slow:job', { id: 1 })).toEqual({ ok: true });

    const stats = await until(async () => {
      const [found] = await store.getMessageStats('slow:job', { direction: 'out' });
      expect(found?.latency).toBeTruthy();
      return found;
    });

    // The response time lives on the reply, along with the size of the ack payload.
    expect(stats.latency?.count).toBe(1);
    expect(stats.latency?.max).toBeGreaterThanOrEqual(50);
    expect(stats.totalBytes).toBe(JSON.stringify({ ok: true }).length);

    // The incoming message is recorded right away, so it is never lost if the ack never comes.
    const [incoming] = await store.getMessageStats('slow:job', { direction: 'in' });
    expect(incoming.count).toBe(1);
    expect(incoming.latency).toBeNull();

    const slowest = await store.getTop('slowest');
    expect(slowest[0].name).toBe('slow:job');
    expect(slowest[0].latencyMs).toBeGreaterThanOrEqual(50);
  });

  it('times acknowledgements the server asks for', async () => {
    const { client, serverSocket, store } = await setup();
    client.on('ping:client', (_payload, ack) => setTimeout(() => ack('pong'), 40));

    await new Promise<void>((resolve) => serverSocket.emit('ping:client', { n: 1 }, () => resolve()));

    const stats = await until(async () => {
      const [found] = await store.getMessageStats('ping:client', { direction: 'in' });
      expect(found?.latency).toBeTruthy();
      return found;
    });

    expect(stats.latency?.max).toBeGreaterThanOrEqual(30);
  });

  it('keeps a preview of the payload on the top entries', async () => {
    const { client, serverSocket, store } = await setup();
    serverSocket.on('file:upload', () => {});
    client.emit('file:upload', { name: 'capture.bin', chunk: 'x'.repeat(50_000) });

    const heaviest = await until(async () => {
      const [found] = await store.getTop('heaviest');
      expect(found).toBeDefined();
      return found;
    });

    expect(heaviest.bytes).toBeGreaterThan(50_000);
    expect(heaviest.sample).toContain('"name":"capture.bin"');
    // The preview is truncated: the store never holds the whole payload.
    expect(heaviest.sample!.length).toBeLessThan(1100);
  });

  it('captures no payload when asked not to', async () => {
    const { client, serverSocket, store } = await setup(withOptions({ capturePayload: false }));
    serverSocket.on('secret', () => {});
    client.emit('secret', { token: 'do-not-store-me' });

    const entry = await until(async () => {
      const [found] = await store.getTop('heaviest');
      expect(found).toBeDefined();
      return found;
    });

    expect(entry.sample).toBeUndefined();
  });

  it('records direct emits to a socket', async () => {
    const { serverSocket, store } = await setup();
    serverSocket.emit('news', { title: 'hello' });

    const stats = await until(async () => {
      const [found] = await store.getMessageStats('news', { direction: 'out' });
      expect(found).toBeDefined();
      return found;
    });

    expect(stats.count).toBe(1);
    expect(stats.totalBytes).toBe(JSON.stringify({ title: 'hello' }).length);
  });

  it('records broadcasts made through the adapter', async () => {
    const { io, serverSocket, store } = await setup();

    io.emit('announce', { msg: 'everyone' });
    serverSocket.broadcast.emit('announce', { msg: 'others' });
    serverSocket.to('room').emit('announce', { msg: 'room' });

    await until(async () => {
      const [found] = await store.getMessageStats('announce', { direction: 'out' });
      expect(found?.count).toBe(3);
    });
  });

  it('counts how many clients a broadcast reaches', async () => {
    const { io, serverSocket, store, connect: connectMore } = await setup();
    const second = await connectMore();
    await connectMore();

    // Two of the three clients are in the room.
    serverSocket.join('room');
    second.join('room');

    io.to('room').emit('toRoom', { msg: 'hi' });
    io.emit('toEveryone', { msg: 'hi' });
    serverSocket.broadcast.emit('toOthers', { msg: 'hi' });
    io.to('nobody').emit('toNobody', { msg: 'hi' });

    const sent = async (name: string) => {
      const [found] = await store.getMessageStats(name, { direction: 'out' });
      expect(found).toBeDefined();
      return found;
    };

    await until(async () => {
      expect((await sent('toRoom')).sentCount).toBe(2);
      expect((await sent('toEveryone')).sentCount).toBe(3);
      // The emitter is excluded from its own broadcast.
      expect((await sent('toOthers')).sentCount).toBe(2);
      // Emitted into the void: one call, and not a single byte on the wire.
      const nobody = await sent('toNobody');
      expect(nobody.count).toBe(1);
      expect(nobody.sentCount).toBe(0);
      expect(nobody.sentBytes).toBe(0);
    });

    // Each broadcast is still a single emit, whoever received it.
    expect((await sent('toRoom')).count).toBe(1);
    expect((await sent('toRoom')).sentBytes).toBe((await sent('toRoom')).totalBytes * 2);
  });

  it('counts one recipient per broadcast when asked not to count them', async () => {
    const { io, store, connect: connectMore } = await setup(withOptions({ countRecipients: false }));
    await connectMore();

    io.emit('announce', { msg: 'to two clients' });

    await until(async () => {
      const [found] = await store.getMessageStats('announce', { direction: 'out' });
      expect(found?.count).toBe(1);
      expect(found?.sentCount).toBe(1);
    });
  });

  it('counts a direct emit as a single recipient', async () => {
    const { serverSocket, store } = await setup();
    serverSocket.emit('welcome', { msg: 'hi' });

    await until(async () => {
      const [found] = await store.getMessageStats('welcome', { direction: 'out' });
      expect(found?.sentCount).toBe(1);
    });
  });

  it('ignores broadcasts when asked to', async () => {
    const { io, store } = await setup(withOptions({ broadcasts: false }));
    io.emit('announce', { msg: 'nobody is watching' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await store.getMessageStats('announce', { direction: 'out' })).toEqual([]);
  });

  it('counts each message once when the same middleware is installed twice', async () => {
    const { serverSocket, store } = await setup((io, memoryStore) => {
      const middleware = sockeye(memoryStore);
      io.use(middleware);
      io.use(middleware);
    });

    serverSocket.emit('once', { a: 1 });

    await until(async () => {
      const [found] = await store.getMessageStats('once', { direction: 'out' });
      expect(found?.count).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await store.getMessageStats('once', { direction: 'out' }))[0].count).toBe(1);
  });

  it('skips ignored events', async () => {
    const { serverSocket, store } = await setup(withOptions({ ignore: ['heartbeat'] }));

    serverSocket.emit('heartbeat');
    serverSocket.emit('real');

    await until(async () => {
      expect(await store.getMessageStats('real', { direction: 'out' })).toHaveLength(1);
    });
    expect(await store.getMessageStats('heartbeat', { direction: 'out' })).toEqual([]);
  });

  it('keeps delivering messages when the store throws', async () => {
    const { client, serverSocket } = await setup((io) => {
      io.use(
        sockeye(
          {
            record() {
              throw new Error('store down');
            },
          },
          { onError: () => {} },
        ),
      );
    });

    const received = new Promise<unknown>((resolve) => serverSocket.on('still:works', resolve));
    client.emit('still:works', { ok: true });

    expect(await received).toEqual({ ok: true });
  });
});

describe('monitorSocketIo', () => {
  it('covers namespaces created after installation', async () => {
    const { io, store } = await setup((server, memoryStore) => monitorSocketIo(server, memoryStore));

    const adminNsp = io.of('/admin');
    const { port } = (io.httpServer as HttpServer).address() as AddressInfo;

    const connected = new Promise<Socket>((resolve) => adminNsp.on('connection', resolve));
    const adminClient = connect(`http://localhost:${port}/admin`, { transports: ['websocket'] });
    const adminSocket = await connected;
    running.push(async () => void adminClient.disconnect());

    adminSocket.emit('admin:stat', { cpu: 1 });

    const stats = await until(async () => {
      const [found] = await store.getMessageStats('admin:stat', { direction: 'out' });
      expect(found).toBeDefined();
      return found;
    });

    expect(stats.namespace).toBe('/admin');
  });
});
