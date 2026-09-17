import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@sockeye-js/store-memory';
import { createMonitor } from '../src/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('SocketMonitor', () => {
  it('records received and sent messages', async () => {
    const store = new MemoryStore();
    const monitor = createMonitor(store);

    monitor.received('chat:send', { text: 'hello' });
    monitor.sent('chat:new', { text: 'hello' });

    const [incoming] = await store.getMessageStats('chat:send', { direction: 'in' });
    expect(incoming.count).toBe(1);
    expect(incoming.totalBytes).toBe(JSON.stringify({ text: 'hello' }).length);
    expect((await store.getMessageStats('chat:new', { direction: 'out' }))[0].count).toBe(1);
  });

  it('accepts an explicit frame size', async () => {
    const store = new MemoryStore();
    createMonitor(store).received('binary:blob', undefined, { bytes: 4096 });

    expect((await store.getMessageStats('binary:blob', { direction: 'in' }))[0].totalBytes).toBe(4096);
  });

  it('times a request and its response', async () => {
    const store = new MemoryStore();
    const monitor = createMonitor(store);

    const pending = monitor.start('job:run', { id: 7 });
    await sleep(40);
    pending.end({ ok: true });

    // The request is recorded immediately, without a latency.
    const [request] = await store.getMessageStats('job:run', { direction: 'in' });
    expect(request.count).toBe(1);
    expect(request.latency).toBeNull();

    // The response carries the round-trip time and its own payload size.
    const [response] = await store.getMessageStats('job:run', { direction: 'out' });
    expect(response.latency?.count).toBe(1);
    expect(response.latency?.max).toBeGreaterThanOrEqual(30);
    expect(response.totalBytes).toBe(JSON.stringify({ ok: true }).length);
  });

  it('records the request even when the response never comes', async () => {
    const store = new MemoryStore();
    createMonitor(store).start('job:lost', { id: 1 });

    expect((await store.getMessageStats('job:lost', { direction: 'in' }))[0].count).toBe(1);
    expect(await store.getMessageStats('job:lost', { direction: 'out' })).toEqual([]);
  });

  it('ends only once and can be cancelled', async () => {
    const store = new MemoryStore();
    const monitor = createMonitor(store);

    const pending = monitor.start('a', {});
    pending.end({});
    pending.end({});
    expect((await store.getMessageStats('a', { direction: 'out' }))[0].count).toBe(1);

    const cancelled = monitor.start('b', {});
    cancelled.cancel();
    cancelled.end({});
    expect(await store.getMessageStats('b', { direction: 'out' })).toEqual([]);
  });

  it('uses the configured namespace', async () => {
    const store = new MemoryStore();
    createMonitor(store, { namespace: '/game' }).received('move', { x: 1 });

    expect((await store.getMessageStats('move'))[0].namespace).toBe('/game');
  });
});
