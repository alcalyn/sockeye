import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { describeStoreContract } from '../../core/test/store-contract.js';
import { RedisStore } from '../src/index.js';

/**
 * These tests need a Redis on `REDIS_URL`, or on localhost. They are skipped when none is
 * reachable, so `pnpm test` stays green on a bare checkout.
 */
const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/15';

async function probe(): Promise<Redis | null> {
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}

const redis = await probe();

afterAll(() => {
  redis?.disconnect();
});

if (!redis) {
  describe.skip('RedisStore (no Redis reachable)', () => {
    it('skipped', () => {});
  });
} else {
  const stores: RedisStore[] = [];

  describeStoreContract('RedisStore', {
    create(options) {
      // A prefix per store keeps parallel test files from stepping on each other.
      const store = new RedisStore(redis, {
        prefix: `sockeye-test:${Math.random().toString(36).slice(2, 10)}`,
        flushIntervalMs: 0,
        ...options,
      });
      stores.push(store);
      return store;
    },
    settle: (store) => (store as RedisStore).flush(),
    teardown: async (store) => {
      await store.reset?.();
      await (store as RedisStore).close();
    },
  });

  describe('RedisStore specifics', () => {
    const prefix = `sockeye-test:${Math.random().toString(36).slice(2, 10)}`;
    const store = new RedisStore(redis, { prefix, flushIntervalMs: 0 });

    afterAll(async () => {
      await store.reset();
      await store.close();
    });

    const event = (over = {}) => ({
      name: 'chat',
      direction: 'in' as const,
      bytes: 10,
      timestamp: 1_700_000_000_000,
      namespace: '/',
      ...over,
    });

    it('does not touch Redis until it is flushed', async () => {
      store.record(event());
      expect((await store.getOverview()).totalMessages).toBe(0);

      await store.flush();
      expect((await store.getOverview()).totalMessages).toBe(1);
    });

    it('merges what several writers report into the same counters', async () => {
      await store.reset();

      const other = new RedisStore(redis, { prefix, flushIntervalMs: 0 });
      store.record(event({ name: 'shared', bytes: 100, latencyMs: 50 }));
      other.record(event({ name: 'shared', bytes: 300, latencyMs: 250 }));
      await Promise.all([store.flush(), other.flush()]);
      await other.close();

      const [stats] = await store.getMessageStats('shared', { direction: 'in' });
      expect(stats.count).toBe(2);
      expect(stats.totalBytes).toBe(400);
      expect(stats.bytes.max).toBe(300);
      expect(stats.latency?.count).toBe(2);
      expect(stats.latency?.avg).toBe(150);
      expect(stats.latency?.max).toBe(250);
    });

    it('writes only known fields into a time slice', async () => {
      await store.reset();
      store.record(event({ name: 'sliced', bytes: 128, latencyMs: 20, recipients: 3 }));
      await store.flush();

      const [sliceKey] = await redis!.keys(`${prefix}:w:*:*sliced`);
      expect(sliceKey).toBeDefined();

      // The slice script takes its histogram buckets from a variable-length tail, so a new
      // fixed argument that forgets to move the tail shows up as a junk field right here.
      const fields = Object.keys(await redis!.hgetall(sliceKey)).sort();
      const known = /^(count|bytes|scount|sbytes|bmax|lcount|lsumUs|lmax|first|last|b\d+|l\d+)$/;
      expect(fields.filter((field) => !known.test(field))).toEqual([]);
      expect(fields).toContain('scount');
    });

    it('keeps fractional latencies accurate through Redis integer counters', async () => {
      await store.reset();

      store.record(event({ name: 'precise', direction: 'out', bytes: 1, latencyMs: 0.125 }));
      store.record(event({ name: 'precise', direction: 'out', bytes: 1, latencyMs: 0.375 }));
      await store.flush();

      const [stats] = await store.getMessageStats('precise', { direction: 'out' });
      expect(stats.latency?.avg).toBeCloseTo(0.25, 3);
    });

    it('stops recording once closed', async () => {
      const closable = new RedisStore(redis, { prefix: `${prefix}:closed`, flushIntervalMs: 0 });
      await closable.close();
      closable.record(event({ name: 'after-close' }));
      await closable.flush();

      expect(await closable.getMessageStats('after-close')).toEqual([]);
      await closable.reset();
    });
  });
}
