import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '@sockeye/store-memory';
import { createApiHandler, dashboard } from '../src/index.js';

const NOW = 1_700_006_400_000;

function seed(): MemoryStore {
  const store = new MemoryStore({ now: () => NOW });
  const base = { timestamp: NOW - 30_000, namespace: '/' };
  store.record({ ...base, name: 'chat:send', direction: 'in', bytes: 120 });
  store.record({ ...base, name: 'chat:send', direction: 'in', bytes: 80 });
  store.record({ ...base, name: 'chat:send', direction: 'out', bytes: 20, latencyMs: 250 });
  store.record({ ...base, name: 'upload', direction: 'in', bytes: 900_000 });
  return store;
}

describe('createApiHandler', () => {
  const handle = createApiHandler(seed());

  it('serves the whole dashboard in one request', async () => {
    const response = await handle({ method: 'GET', path: '/dashboard' });
    const body = response.body as any;

    expect(response.status).toBe(200);
    expect(body.overview.totalMessages).toBe(4);
    expect(body.messages).toHaveLength(3);
    expect(body.top.heaviest[0].name).toBe('upload');
    expect(body.top.slowest[0].latencyMs).toBe(250);
  });

  it('serves the overview', async () => {
    const { body } = await handle({ method: 'GET', path: '/overview' });
    expect((body as any).totalBytes).toBe(900_220);
  });

  it('sorts, filters and limits the message list', async () => {
    const byBandwidth = await handle({ method: 'GET', path: '/messages', query: { sort: 'bandwidth' } });
    expect((byBandwidth.body as any[])[0].name).toBe('upload');

    const outgoing = await handle({ method: 'GET', path: '/messages', query: { direction: 'out' } });
    expect(outgoing.body).toHaveLength(1);

    const limited = await handle({ method: 'GET', path: '/messages', query: { limit: '1' } });
    expect(limited.body).toHaveLength(1);
  });

  it('serves a message detail with its histograms', async () => {
    const { body } = await handle({ method: 'GET', path: '/messages/chat%3Asend' });
    const details = body as any[];

    expect(details).toHaveLength(2);
    expect(details[0].bytesHistogram.length).toBeGreaterThan(0);
  });

  it('narrows every figure to the requested period', async () => {
    const store = seed();
    // An old message, outside any recent window.
    store.record({
      name: 'ancient',
      direction: 'in',
      bytes: 10,
      timestamp: NOW - 30 * 24 * 60 * 60_000,
      namespace: '/',
    });
    const withWindow = createApiHandler(store);

    const recent = await withWindow({ method: 'GET', path: '/dashboard', query: { window: '5m' } });
    const body = recent.body as any;

    expect(body.messages.map((m: any) => m.name)).not.toContain('ancient');
    expect(body.overview.window.key).toBe('5m');
    expect(body.overview.window.resolutionMs).toBe(60_000);

    const all = await withWindow({ method: 'GET', path: '/dashboard' });
    expect((all.body as any).messages.map((m: any) => m.name)).toContain('ancient');
    expect((all.body as any).overview.window).toBeNull();
  });

  it('lists the periods the store can answer', async () => {
    const { body } = await handle({ method: 'GET', path: '/windows' });
    expect((body as any[]).map((w) => w.key)).toContain('24h');

    const dashboard = await handle({ method: 'GET', path: '/dashboard' });
    expect((dashboard.body as any).windows.length).toBeGreaterThan(0);
  });

  it('offers no period at all for a store without history', async () => {
    const readOnly = createApiHandler({
      getOverview: async () => ({}) as any,
      listMessages: async () => [],
      getMessageStats: async () => [],
      getTop: async () => [],
    });

    expect(await (await readOnly({ method: 'GET', path: '/windows' })).body).toEqual([]);
  });

  it('404s on an unknown message and an unknown route', async () => {
    expect((await handle({ method: 'GET', path: '/messages/nope' })).status).toBe(404);
    expect((await handle({ method: 'GET', path: '/nope' })).status).toBe(404);
    expect((await handle({ method: 'GET', path: '/top/fastest' })).status).toBe(404);
  });

  it('rejects writes on a read-only store', async () => {
    const readOnly = createApiHandler({
      getOverview: async () => ({}) as any,
      listMessages: async () => [],
      getMessageStats: async () => [],
      getTop: async () => [],
    });

    expect((await readOnly({ method: 'POST', path: '/reset' })).status).toBe(405);
    expect((await readOnly({ method: 'PUT', path: '/messages' })).status).toBe(405);
  });

  it('turns a store failure into a 500 instead of throwing', async () => {
    const broken = createApiHandler({
      getOverview: async () => {
        throw new Error('redis is down');
      },
      listMessages: async () => [],
      getMessageStats: async () => [],
      getTop: async () => [],
    });

    const response = await broken({ method: 'GET', path: '/overview' });
    expect(response.status).toBe(500);
    expect((response.body as any).error).toBe('redis is down');
  });
});

describe('dashboard() middleware', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function listen(store = seed()): Promise<string> {
    const middleware = dashboard(store);
    server = createServer((req, res) => middleware(req, res));
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    return `http://localhost:${(server!.address() as AddressInfo).port}`;
  }

  it('answers the API over HTTP', async () => {
    const base = await listen();
    const response = await fetch(`${base}/api/overview`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(((await response.json()) as any).totalMessages).toBe(4);
  });

  it('serves the built SPA at the mount point', async () => {
    const base = await listen();
    const response = await fetch(`${base}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<div id="app">');
  });

  it('resets through the API', async () => {
    const store = seed();
    const base = await listen(store);

    expect((await fetch(`${base}/api/reset`, { method: 'POST' })).status).toBe(200);
    expect((await store.getOverview()).totalMessages).toBe(0);
  });

  it('passes non-API requests along when not serving the SPA', async () => {
    const middleware = dashboard(seed(), { serveClient: false });
    server = createServer((req, res) => {
      middleware(req, res, () => {
        res.statusCode = 418;
        res.end('handled by the app');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const base = `http://localhost:${(server!.address() as AddressInfo).port}`;

    expect((await fetch(`${base}/`)).status).toBe(418);
    expect((await fetch(`${base}/api/overview`)).status).toBe(200);
  });
});
