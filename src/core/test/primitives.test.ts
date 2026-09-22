import { describe, expect, it, vi } from 'vitest';
import { Collector, UNNAMED } from '../src/collector.js';
import { StatsAggregator } from '../src/aggregator.js';
import { applyListOptions } from '../src/query.js';
import { describeArgs, measureArgs, measureSize } from '../src/size.js';
import { TopN } from '../src/top-n.js';
import type { MessageEvent, MessageStats } from '../src/types.js';

const event = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  name: 'ping',
  direction: 'in',
  bytes: 10,
  timestamp: 1000,
  namespace: '/',
  ...over,
});

describe('measureSize', () => {
  it('measures strings, buffers and objects', () => {
    expect(measureSize('hello')).toBe(5);
    expect(measureSize('héllo')).toBe(6);
    expect(measureSize(Buffer.alloc(128))).toBe(128);
    expect(measureSize(new Uint8Array(64))).toBe(64);
    expect(measureSize({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length);
    expect(measureSize(undefined)).toBe(0);
    expect(measureSize(null)).toBe(0);
  });

  it('returns 0 instead of throwing on circular payloads', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(measureSize(circular)).toBe(0);
  });

  it('ignores trailing callbacks in an argument list', () => {
    expect(measureArgs(['ab', { a: 1 }, () => {}])).toBe(2 + JSON.stringify({ a: 1 }).length);
  });
});

describe('describeArgs', () => {
  it('measures and captures in one pass', () => {
    const { bytes, sample } = describeArgs([{ text: 'hello' }]);
    expect(bytes).toBe(JSON.stringify({ text: 'hello' }).length);
    expect(sample).toBe('{"text":"hello"}');
  });

  it('truncates a big payload but still measures all of it', () => {
    const big = 'x'.repeat(50_000);
    const { bytes, sample } = describeArgs([big], 64);

    expect(bytes).toBe(50_000);
    expect(sample).toHaveLength(65);
    expect(sample.endsWith('…')).toBe(true);
  });

  it('describes binary payloads instead of dumping them', () => {
    const { bytes, sample } = describeArgs([Buffer.alloc(2048)]);
    expect(bytes).toBe(2048);
    expect(sample).toBe('<binary 2048 bytes>');
  });

  it('captures nothing when the limit is zero', () => {
    expect(describeArgs([{ a: 1 }], 0).sample).toBe('');
  });
});

describe('TopN', () => {
  it('keeps the highest scores, sorted', () => {
    const top = new TopN<number>(3, (n) => n);
    for (const n of [5, 1, 9, 3, 7, 2]) top.push(n);
    expect(top.items()).toEqual([9, 7, 5]);
  });

  it('ignores entries with no score', () => {
    const top = new TopN<{ latency?: number }>(3, (e) => e.latency ?? Number.NaN);
    top.push({});
    top.push({ latency: 5 });
    expect(top.items()).toEqual([{ latency: 5 }]);
  });
});

describe('StatsAggregator', () => {
  it('tracks counts, bandwidth and both distributions', () => {
    const aggregator = new StatsAggregator('ping', 'in', '/');
    aggregator.add(event({ bytes: 10, latencyMs: 5, timestamp: 100 }));
    aggregator.add(event({ bytes: 30, latencyMs: 15, timestamp: 300 }));
    aggregator.add(event({ bytes: 20, timestamp: 200 }));

    const stats = aggregator.toStats();
    expect(stats.count).toBe(3);
    expect(stats.totalBytes).toBe(60);
    expect(stats.bytes.avg).toBe(20);
    expect(stats.bytes.max).toBe(30);
    expect(stats.firstSeen).toBe(100);
    expect(stats.lastSeen).toBe(300);

    // Only two of the three messages carried a latency.
    expect(stats.latency?.count).toBe(2);
    expect(stats.latency?.avg).toBe(10);
    expect(stats.latency?.max).toBe(15);
  });

  it('reports no latency at all when none was ever measured', () => {
    const aggregator = new StatsAggregator('ping', 'out', '/');
    aggregator.add(event({ direction: 'out' }));
    expect(aggregator.toStats().latency).toBeNull();
  });
});

describe('applyListOptions', () => {
  const stats = (over: Partial<MessageStats>): MessageStats => {
    const base: MessageStats = {
      name: 'a',
      direction: 'in',
      namespace: '/',
      count: 1,
      totalBytes: 1,
      sentCount: 1,
      sentBytes: 1,
      firstSeen: 0,
      lastSeen: 0,
      bytes: { count: 1, total: 1, avg: 1, p50: 1, p95: 1, p99: 1, max: 1 },
      latency: null,
      ...over,
    };
    // Unless a test says otherwise, a message went to exactly one client.
    return {
      ...base,
      sentCount: over.sentCount ?? base.count,
      sentBytes: over.sentBytes ?? base.totalBytes,
    };
  };

  const list = [
    stats({ name: 'small', count: 100, totalBytes: 1000 }),
    stats({ name: 'big', count: 2, totalBytes: 50_000 }),
    stats({ name: 'slow', count: 5, totalBytes: 500, latency: { count: 5, total: 5000, avg: 1000, p50: 900, p95: 1200, p99: 1300, max: 1400 } }),
    stats({ name: 'out-only', direction: 'out', count: 7, totalBytes: 70 }),
  ];

  it('sorts by count, bandwidth and latency', () => {
    expect(applyListOptions(list, { sort: 'count' })[0].name).toBe('small');
    expect(applyListOptions(list, { sort: 'bandwidth' })[0].name).toBe('big');
    expect(applyListOptions(list, { sort: 'latency' })[0].name).toBe('slow');
  });

  it('sorts on the recipients, not on the number of emits', () => {
    // One broadcast to 500 clients against a unicast message sent 100 times.
    const fanout = [
      stats({ name: 'unicast', count: 100, totalBytes: 1000 }),
      stats({ name: 'broadcast', count: 2, totalBytes: 200, sentCount: 1000, sentBytes: 100_000 }),
    ];

    expect(applyListOptions(fanout, { sort: 'count' })[0].name).toBe('broadcast');
    expect(applyListOptions(fanout, { sort: 'bandwidth' })[0].name).toBe('broadcast');
  });

  it('filters by direction and limits', () => {
    expect(applyListOptions(list, { direction: 'out' })).toHaveLength(1);
    expect(applyListOptions(list, { limit: 2 })).toHaveLength(2);
  });
});

describe('Collector', () => {
  it('fills in defaults and forwards to the store', () => {
    const record = vi.fn();
    const collector = new Collector({ record }, { namespace: '/chat', now: () => 777 });

    collector.record({ name: 'hello', direction: 'in', bytes: 12 });

    expect(record).toHaveBeenCalledWith({
      name: 'hello',
      direction: 'in',
      bytes: 12,
      timestamp: 777,
      namespace: '/chat',
    });
  });

  it('falls back to a placeholder name', () => {
    const record = vi.fn();
    new Collector({ record }).record({ name: '', direction: 'in', bytes: 1 });
    expect(record.mock.calls[0][0].name).toBe(UNNAMED);
  });

  it('skips ignored messages', () => {
    const record = vi.fn();
    const collector = new Collector({ record }, { ignore: ['heartbeat'] });
    collector.record({ name: 'heartbeat', direction: 'in', bytes: 1 });
    collector.record({ name: 'chat', direction: 'in', bytes: 1 });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('captures a truncated payload alongside the size', () => {
    const record = vi.fn();
    const collector = new Collector({ record });

    const described = collector.describe([{ text: 'hello' }], 'chat');
    expect(described).toEqual({ bytes: 16, sample: '{"text":"hello"}' });
  });

  it('captures nothing when payload capture is off', () => {
    const collector = new Collector({ record: vi.fn() }, { capturePayload: false });
    expect(collector.describe([{ secret: 'token' }])).toEqual({ bytes: 18 });
  });

  it('honours a capture length and a redaction hook', () => {
    const collector = new Collector(
      { record: vi.fn() },
      { capturePayload: 8, redactSample: (sample) => sample.replace(/secret/g, '***') },
    );

    // Truncated to 8 characters first, then redacted.
    const { sample } = collector.describe([{ secret: 1 }], 'login');
    expect(sample).toBe('{"***…');
  });

  it('skips capture when a custom sizer decides what a payload weighs', () => {
    const collector = new Collector({ record: vi.fn() }, { sizeOf: () => 42 });
    expect(collector.describe([{ a: 1 }])).toEqual({ bytes: 42 });
  });

  it('never lets a broken store reach the host app', () => {
    const onError = vi.fn();
    const collector = new Collector(
      {
        record() {
          throw new Error('store is down');
        },
      },
      { onError },
    );

    expect(() => collector.record({ name: 'a', direction: 'in', bytes: 1 })).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('refuses a store that cannot write', () => {
    expect(() => new Collector({} as never)).toThrow(/StoreWriterInterface/);
  });
});
