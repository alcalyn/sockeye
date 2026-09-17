import { describe, expect, it } from 'vitest';
import { describeStoreContract } from '../../core/test/store-contract.js';
import { ALL_TIME, DEFAULT_WINDOWS } from '@sockeye/core';
import { MemoryStore, OTHER, createMemoryStore } from '../src/index.js';

describeStoreContract('MemoryStore', {
  create: (options) => new MemoryStore(options),
});

describe('MemoryStore specifics', () => {
  it('merges extra message types into a single bucket past the cardinality cap', async () => {
    const store = createMemoryStore({ maxMessageTypes: 3 });

    for (let i = 0; i < 20; i++) {
      store.record({
        name: `job:${i}`,
        direction: 'in',
        bytes: 10,
        timestamp: Date.now(),
        namespace: '/',
      });
    }

    // The three first names get their own series, everything after lands in `<other>`.
    const list = await store.listMessages();
    expect(list).toHaveLength(4);
    expect(list.filter((s) => s.name !== OTHER)).toHaveLength(3);

    const other = list.find((s) => s.name === OTHER);
    expect(other?.count).toBe(17);
  });

  it('offers exactly the configured periods', async () => {
    // A day, in 20-minute steps.
    const windows = [
      { key: '1d', label: 'Last day', ms: 24 * 60 * 60_000, slots: 72 },
      ALL_TIME,
    ];
    const store = createMemoryStore({ windows, now: () => 1_700_006_400_000 });

    const offered = await store.getWindows();
    expect(offered.map((window) => window.key)).toEqual(['1d', 'all']);
    expect(offered[0].resolutionMs).toBe(20 * 60_000);
  });

  it('keeps the curated periods when the windows are left alone', async () => {
    const store = createMemoryStore({ now: () => 1_700_006_400_000 });
    expect((await store.getWindows()).map((w) => w.key)).toEqual([
      '1m',
      '5m',
      '15m',
      '1h',
      '6h',
      '24h',
      '7d',
      'all',
    ]);
    expect(DEFAULT_WINDOWS).toHaveLength(8);
  });

  it('answers a custom period', async () => {
    const NOW = 1_700_006_400_000;
    const store = createMemoryStore({
      windows: [
        { key: '20m', label: 'Last 20 minutes', ms: 20 * 60_000, slots: 20 },
        { key: '1d', label: 'Last day', ms: 24 * 60 * 60_000, slots: 72 },
        ALL_TIME,
      ],
      now: () => NOW,
    });

    store.record({ name: 'recent', direction: 'in', bytes: 10, timestamp: NOW - 60_000, namespace: '/' });
    store.record({
      name: 'older',
      direction: 'in',
      bytes: 10,
      timestamp: NOW - 5 * 60 * 60_000,
      namespace: '/',
    });

    expect((await store.listMessages({ window: '20m' })).map((s) => s.name)).toEqual(['recent']);
    expect((await store.listMessages({ window: '1d' })).map((s) => s.name).sort()).toEqual([
      'older',
      'recent',
    ]);
  });

  it('honours a custom top limit', async () => {
    const store = createMemoryStore({ topLimit: 2 });
    for (const bytes of [1, 2, 3, 4]) {
      store.record({ name: 'm', direction: 'in', bytes, timestamp: Date.now(), namespace: '/' });
    }
    expect(await store.getTop('heaviest')).toHaveLength(2);
  });
});
