import { describe, expect, it, beforeEach } from 'vitest';
import type { MessageEvent, StoreInterface } from '../src/index.js';

export interface ContractContext {
  /** Fresh, empty store. `now` lets the window tests drive the clock. */
  create(options?: { now?: () => number }): Promise<StoreInterface> | StoreInterface;
  /** Make sure everything written is visible to the reader (no-op for in-memory stores). */
  settle?(store: StoreInterface): Promise<void>;
  /** Called once the suite is done with a store. */
  teardown?(store: StoreInterface): Promise<void>;
}

const event = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  name: 'ping',
  direction: 'in',
  bytes: 10,
  timestamp: 1_700_000_000_000,
  namespace: '/',
  ...over,
});

/**
 * Behaviour every store must exhibit, whatever its backend. Running the exact same suite
 * against memory and Redis is what guarantees the dashboard shows the same numbers.
 */
export function describeStoreContract(label: string, context: ContractContext): void {
  describe(`${label} (store contract)`, () => {
    let store: StoreInterface;

    const settle = async () => {
      if (context.settle) await context.settle(store);
    };

    const write = async (...events: MessageEvent[]) => {
      for (const e of events) store.record(e);
      await settle();
    };

    beforeEach(async () => {
      store = await context.create();
      if (store.reset) await store.reset();
      return async () => {
        if (context.teardown) await context.teardown(store);
      };
    });

    it('starts empty', async () => {
      const overview = await store.getOverview();
      expect(overview.totalMessages).toBe(0);
      expect(overview.totalBytes).toBe(0);
      expect(overview.firstSeen).toBeNull();
      expect(await store.listMessages()).toEqual([]);
      expect(await store.getTop('slowest')).toEqual([]);
    });

    it('aggregates counts and bandwidth per message and direction', async () => {
      await write(
        event({ name: 'chat', bytes: 100 }),
        event({ name: 'chat', bytes: 300 }),
        event({ name: 'chat', direction: 'out', bytes: 50 }),
        event({ name: 'cursor', bytes: 8 }),
      );

      const list = await store.listMessages({ sort: 'bandwidth' });
      expect(list.map((s) => `${s.name}:${s.direction}`)).toEqual(['chat:in', 'chat:out', 'cursor:in']);

      const chatIn = list[0];
      expect(chatIn.count).toBe(2);
      expect(chatIn.totalBytes).toBe(400);
      expect(chatIn.bytes.avg).toBe(200);
      expect(chatIn.bytes.max).toBe(300);
    });

    it('sums an overview across every series', async () => {
      await write(
        event({ name: 'a', bytes: 10 }),
        event({ name: 'b', direction: 'out', bytes: 90, timestamp: 1_700_000_005_000 }),
      );

      const overview = await store.getOverview();
      expect(overview.totalMessages).toBe(2);
      expect(overview.totalBytes).toBe(100);
      expect(overview.messageTypes).toBe(2);
      expect(overview.in).toEqual({ count: 1, bytes: 10, sentCount: 1, sentBytes: 10 });
      expect(overview.out).toEqual({ count: 1, bytes: 90, sentCount: 1, sentBytes: 90 });
      expect(overview.firstSeen).toBe(1_700_000_000_000);
      expect(overview.lastSeen).toBe(1_700_000_005_000);
    });

    it('counts a message once per emit and once per recipient', async () => {
      await write(
        event({ name: 'announce', direction: 'out', bytes: 100, recipients: 4 }),
        event({ name: 'announce', direction: 'out', bytes: 100, recipients: 6 }),
      );

      const [announce] = await store.getMessageStats('announce', { direction: 'out' });
      expect(announce.count).toBe(2);
      expect(announce.totalBytes).toBe(200);
      expect(announce.sentCount).toBe(10);
      expect(announce.sentBytes).toBe(1000);
      // The payload distribution describes one message, so the fan-out must not inflate it.
      expect(announce.bytes.avg).toBe(100);
      expect(announce.bytes.max).toBe(100);

      const overview = await store.getOverview();
      expect(overview.totalMessages).toBe(2);
      expect(overview.totalBytes).toBe(200);
      expect(overview.totalSent).toBe(10);
      expect(overview.totalSentBytes).toBe(1000);
    });

    it('treats an unknown recipient count as one', async () => {
      await write(event({ name: 'ping', direction: 'in', bytes: 12 }));

      const [ping] = await store.getMessageStats('ping', { direction: 'in' });
      expect(ping.sentCount).toBe(ping.count);
      expect(ping.sentBytes).toBe(ping.totalBytes);
    });

    it('keeps a message emitted to nobody, with nothing sent', async () => {
      await write(event({ name: 'void', direction: 'out', bytes: 500, recipients: 0 }));

      const [emitted] = await store.getMessageStats('void', { direction: 'out' });
      expect(emitted.count).toBe(1);
      expect(emitted.totalBytes).toBe(500);
      expect(emitted.sentCount).toBe(0);
      expect(emitted.sentBytes).toBe(0);
    });

    it('only reports latency for messages that had one measured', async () => {
      await write(
        event({ name: 'slow', direction: 'out', bytes: 5, latencyMs: 400 }),
        event({ name: 'slow', direction: 'out', bytes: 5, latencyMs: 600 }),
        event({ name: 'fireAndForget', direction: 'out', bytes: 5 }),
      );

      const [slow] = await store.getMessageStats('slow');
      expect(slow.latency).not.toBeNull();
      expect(slow.latency?.count).toBe(2);
      expect(slow.latency?.avg).toBe(500);
      expect(slow.latency?.max).toBe(600);

      const [fire] = await store.getMessageStats('fireAndForget');
      expect(fire.latency).toBeNull();
    });

    it('returns percentiles close to the real distribution', async () => {
      const events: MessageEvent[] = [];
      for (let i = 1; i <= 1000; i++) {
        events.push(event({ name: 'load', direction: 'out', bytes: i, latencyMs: i }));
      }
      await write(...events);

      const [stats] = await store.getMessageStats('load', { direction: 'out' });
      expect(stats.latency?.p50).toBeGreaterThan(480);
      expect(stats.latency?.p50).toBeLessThan(520);
      expect(stats.latency?.p95).toBeGreaterThan(930);
      expect(stats.latency?.p95).toBeLessThan(970);
      expect(stats.latency?.max).toBe(1000);
      expect(stats.bytes.p50).toBeGreaterThan(480);
      expect(stats.bytes.p50).toBeLessThan(520);
    });

    it('keeps payload examples for every message, not just the global top', async () => {
      // One huge message from another type, so `chat` never reaches the global top list.
      await write(
        event({ name: 'upload', bytes: 5_000_000, sample: '{"file":"big"}' }),
        event({ name: 'chat', bytes: 30, sample: '{"text":"medium"}' }),
        event({ name: 'chat', bytes: 90, sample: '{"text":"the biggest one"}' }),
        event({ name: 'chat', bytes: 10, sample: '{"text":"tiny"}' }),
      );

      expect((await store.getTop('heaviest')).map((e) => e.name)).toContain('upload');

      const [chat] = await store.getMessageStats('chat');
      expect(chat.samples.map((sample) => sample.bytes)).toEqual([90, 30, 10]);
      expect(chat.samples[0].sample).toBe('{"text":"the biggest one"}');
    });

    it('caps how many payload examples a message keeps', async () => {
      const events: MessageEvent[] = [];
      for (let i = 1; i <= 20; i++) {
        events.push(event({ name: 'chat', bytes: i, sample: `{"n":${i}}` }));
      }
      await write(...events);

      const [chat] = await store.getMessageStats('chat');
      expect(chat.samples).toHaveLength(5);
      expect(chat.samples[0].bytes).toBe(20);
    });

    it('exposes histograms on the detail view', async () => {
      await write(event({ name: 'chat', bytes: 10, latencyMs: 3 }));

      const [detail] = await store.getMessageStats('chat');
      expect(detail.bytesHistogram).toEqual([{ from: 10, to: 11, count: 1 }]);
      expect(detail.latencyHistogram).toEqual([{ from: 3, to: 4, count: 1 }]);
    });

    it('ranks the slowest and the heaviest messages', async () => {
      await write(
        event({ name: 'fast', direction: 'out', bytes: 10, latencyMs: 5 }),
        event({ name: 'slow', direction: 'out', bytes: 10, latencyMs: 2000 }),
        event({ name: 'medium', direction: 'out', bytes: 10, latencyMs: 300 }),
        event({ name: 'huge', bytes: 1_000_000 }),
        event({ name: 'small', bytes: 3 }),
      );

      const slowest = await store.getTop('slowest');
      expect(slowest.map((e) => e.name)).toEqual(['slow', 'medium', 'fast']);
      expect(slowest[0].latencyMs).toBe(2000);

      const heaviest = await store.getTop('heaviest');
      expect(heaviest[0]).toMatchObject({ name: 'huge', bytes: 1_000_000 });
    });

    it('keeps the captured payload on the top entries', async () => {
      await write(
        event({ name: 'upload', bytes: 900_000, sample: '{"file":"capture.bin"}' }),
        event({ name: 'slow', direction: 'out', bytes: 5, latencyMs: 900, sample: '{"rows":42}' }),
      );

      expect((await store.getTop('heaviest'))[0].sample).toBe('{"file":"capture.bin"}');
      expect((await store.getTop('slowest'))[0].sample).toBe('{"rows":42}');
    });

    it('leaves the sample out when the collector captured none', async () => {
      await write(event({ name: 'quiet', bytes: 10 }));
      expect((await store.getTop('heaviest'))[0].sample).toBeUndefined();
    });

    it('caps the top lists', async () => {
      const events: MessageEvent[] = [];
      for (let i = 0; i < 50; i++) {
        events.push(event({ name: `m${i}`, direction: 'out', bytes: i, latencyMs: i }));
      }
      await write(...events);

      const slowest = await store.getTop('slowest');
      expect(slowest).toHaveLength(10);
      expect(slowest[0].latencyMs).toBe(49);
      expect(slowest[9].latencyMs).toBe(40);
      expect(await store.getTop('heaviest', { limit: 3 })).toHaveLength(3);
    });

    it('filters, sorts and limits the message list', async () => {
      await write(
        event({ name: 'chatty', bytes: 1 }),
        event({ name: 'chatty', bytes: 1 }),
        event({ name: 'chatty', bytes: 1 }),
        event({ name: 'rare', direction: 'out', bytes: 5000 }),
      );

      expect((await store.listMessages({ sort: 'count' }))[0].name).toBe('chatty');
      expect((await store.listMessages({ direction: 'out' })).map((s) => s.name)).toEqual(['rare']);
      expect(await store.listMessages({ limit: 1 })).toHaveLength(1);
      expect((await store.listMessages({ sort: 'name' })).map((s) => s.name)).toEqual(['chatty', 'rare']);
    });

    it('keeps namespaces apart', async () => {
      await write(
        event({ name: 'join', namespace: '/chat', bytes: 10 }),
        event({ name: 'join', namespace: '/admin', bytes: 20 }),
      );

      const all = await store.getMessageStats('join');
      expect(all).toHaveLength(2);
      expect((await store.listMessages({ namespace: '/admin' }))[0].totalBytes).toBe(20);
    });

    it('returns nothing for an unknown message', async () => {
      expect(await store.getMessageStats('nope')).toEqual([]);
    });

    describe('time windows', () => {
      // A round timestamp: exactly on a minute, hour and day boundary.
      const NOW = 1_700_006_400_000;
      const MINUTE = 60_000;
      const HOUR = 60 * MINUTE;
      const DAY = 24 * HOUR;

      let windowed: StoreInterface;

      beforeEach(async () => {
        windowed = await context.create({ now: () => NOW });
        if (windowed.reset) await windowed.reset();

        for (const [name, at] of [
          ['justNow', NOW - 30_000],
          ['tenMinutesAgo', NOW - 10 * MINUTE],
          ['threeHoursAgo', NOW - 3 * HOUR],
          ['threeDaysAgo', NOW - 3 * DAY],
        ] as const) {
          windowed.record(event({ name, direction: 'out', bytes: 100, latencyMs: 50, timestamp: at }));
        }
        if (context.settle) await context.settle(windowed);

        return async () => {
          if (context.teardown) await context.teardown(windowed);
        };
      });

      const names = async (window: string) =>
        (await windowed.listMessages({ window })).map((stats) => stats.name).sort();

      it('narrows the message list to the requested period', async () => {
        expect(await names('5m')).toEqual(['justNow']);
        expect(await names('1h')).toEqual(['justNow', 'tenMinutesAgo']);
        expect(await names('24h')).toEqual(['justNow', 'tenMinutesAgo', 'threeHoursAgo']);
        expect(await names('7d')).toEqual([
          'justNow',
          'tenMinutesAgo',
          'threeDaysAgo',
          'threeHoursAgo',
        ]);
        expect(await names('all')).toHaveLength(4);
      });

      it('narrows the overview to the requested period', async () => {
        const lastHour = await windowed.getOverview({ window: '1h' });
        expect(lastHour.totalMessages).toBe(2);
        expect(lastHour.totalBytes).toBe(200);

        expect((await windowed.getOverview({ window: 'all' })).totalMessages).toBe(4);
      });

      it('sums an overview timeline across every message type', async () => {
        const { timeline, totalMessages, totalBytes } = await windowed.getOverview({
          window: '1h',
        });

        // One bucket per minute, and every message of the period accounted for exactly once.
        expect(timeline.length).toBeGreaterThanOrEqual(60);
        expect(timeline.reduce((total, bucket) => total + bucket.count, 0)).toBe(totalMessages);
        expect(timeline.reduce((total, bucket) => total + bucket.bytes, 0)).toBe(totalBytes);

        // The two messages of the last hour land in two different buckets.
        expect(timeline.filter((bucket) => bucket.count > 0)).toHaveLength(2);
      });

      it('carries the recipient counts into the timeline', async () => {
        windowed.record(
          event({
            name: 'announce',
            direction: 'out',
            bytes: 10,
            recipients: 7,
            timestamp: NOW - 30_000,
          }),
        );
        if (context.settle) await context.settle(windowed);

        const overview = await windowed.getOverview({ window: '1h' });
        // The two plain messages of the last hour, plus one broadcast to seven clients.
        expect(overview.totalMessages).toBe(3);
        expect(overview.totalSent).toBe(9);
        expect(overview.totalBytes).toBe(210);
        expect(overview.totalSentBytes).toBe(270);

        const sum = (key: 'count' | 'bytes' | 'sentCount' | 'sentBytes') =>
          overview.timeline.reduce((total, bucket) => total + bucket[key], 0);
        expect(sum('count')).toBe(overview.totalMessages);
        expect(sum('bytes')).toBe(overview.totalBytes);
        expect(sum('sentCount')).toBe(overview.totalSent);
        expect(sum('sentBytes')).toBe(overview.totalSentBytes);
      });

      it('says what period the numbers actually cover', async () => {
        const { window } = await windowed.getOverview({ window: '1h' });
        expect(window).not.toBeNull();
        expect(window!.key).toBe('1h');
        expect(window!.resolutionMs).toBe(MINUTE);
        // Whole buckets ending with the one still filling up, so the period is shifted
        // forward rather than reaching a full hour back.
        expect(window!.to).toBeGreaterThanOrEqual(NOW);
        expect(window!.to - window!.from).toBe(60 * MINUTE);

        expect((await windowed.getOverview({ window: 'all' })).window).toBeNull();
      });

      it('reports a bucket-by-bucket history for a message', async () => {
        const { timeline } = (await windowed.getMessageStats('tenMinutesAgo', { window: '15m' }))[0];

        // One bucket per quarter-minute over the period, the newest still filling up.
        expect(timeline.length).toBeGreaterThanOrEqual(60);
        expect(timeline[0].to - timeline[0].from).toBe(MINUTE / 4);
        expect(timeline.reduce((total, bucket) => total + bucket.count, 0)).toBe(1);

        // Quiet buckets are reported rather than skipped, so a chart shows the gaps.
        expect(timeline.filter((bucket) => bucket.count === 0).length).toBeGreaterThan(10);

        const busy = timeline.find((bucket) => bucket.count > 0);
        expect(busy).toBeDefined();
        expect(busy!.bytes).toBe(100);
        expect(busy!.from).toBeLessThanOrEqual(NOW - 10 * MINUTE);
        expect(busy!.to).toBeGreaterThan(NOW - 10 * MINUTE);
      });

      it('falls back to the coarsest resolution for the whole history', async () => {
        const { timeline } = (await windowed.getMessageStats('threeDaysAgo', { window: 'all' }))[0];
        expect(timeline[0].to - timeline[0].from).toBe(4 * HOUR);
        expect(timeline.reduce((total, bucket) => total + bucket.count, 0)).toBe(1);
      });

      it('narrows a message detail to the requested period', async () => {
        expect(await windowed.getMessageStats('threeDaysAgo', { window: '1h' })).toEqual([]);
        expect(await windowed.getMessageStats('threeDaysAgo', { window: '7d' })).toHaveLength(1);
      });

      it('narrows the top lists to the requested period', async () => {
        const recent = await windowed.getTop('slowest', { window: '1h' });
        expect(recent.map((entry) => entry.name).sort()).toEqual(['justNow', 'tenMinutesAgo']);

        const everything = await windowed.getTop('slowest', { window: 'all' });
        expect(everything).toHaveLength(4);
      });

      it('grows the `auto` window with the history it has', async () => {
        // Three days of history: the finest period that does not fit in it yet.
        const grown = await windowed.getOverview({ window: 'auto' });
        expect(grown.window?.key).toBe('7d');
        expect(grown.totalMessages).toBe(4);
        expect(await names('auto')).toHaveLength(4);

        // A store that just started stays on the finest period instead of showing a week
        // of empty buckets.
        const fresh = await context.create({ now: () => NOW });
        if (fresh.reset) await fresh.reset();
        fresh.record(event({ name: 'justNow', bytes: 10, timestamp: NOW - 30_000 }));
        if (context.settle) await context.settle(fresh);

        const young = await fresh.getOverview({ window: 'auto' });
        expect(young.window?.key).toBe('1m');
        expect(young.totalMessages).toBe(1);

        if (context.teardown) await context.teardown(fresh);
      });

      it('falls back to the whole history on an unknown window', async () => {
        expect(await windowed.listMessages({ window: 'nope' })).toHaveLength(4);
      });

      it('advertises the periods it can answer', async () => {
        const windows = await windowed.getWindows?.();
        expect(windows).toBeDefined();
        const keys = (windows ?? []).map((w) => (typeof w === 'string' ? w : w.key));
        expect(keys).toContain('5m');
        expect(keys).toContain('24h');
        expect(keys).toContain('all');
      });
    });

    it('forgets everything on reset', async () => {
      await write(event({ name: 'chat', bytes: 10, latencyMs: 10 }));
      await store.reset?.();
      await settle();

      expect((await store.getOverview()).totalMessages).toBe(0);
      expect(await store.listMessages()).toEqual([]);
      expect(await store.getTop('heaviest')).toEqual([]);
    });
  });
}
