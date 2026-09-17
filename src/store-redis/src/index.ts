import {
  StatsAggregator,
  TopN,
  DEFAULT_WINDOWS,
  applyListOptions,
  AUTO,
  autoWindow,
  bucketMs,
  coarsestWindow,
  coveredRange,
  histogram,
  parseSeriesKey,
  resolveWindow,
  seriesKey,
  windowRanges,
  type ListMessagesOptions,
  type MessageDetail,
  type MessageEvent,
  type MessageStats,
  type MessageStatsOptions,
  type Overview,
  type StoreInterface,
  type TimelineBucket,
  type TopEntry,
  type TopKind,
  type TopOptions,
  type WindowOptions,
  type WindowRange,
  type WindowSpec,
} from '@sockeye-js/core';

/**
 * Minimal shape of an `ioredis` client. Typed structurally so this package never forces
 * an ioredis version, and so any compatible client can be passed in.
 *
 * Only commands available since Redis 3.0 are used.
 */
export interface RedisLike {
  pipeline(): RedisPipeline;
  smembers(key: string): Promise<string[]>;
  hgetall(key: string): Promise<Record<string, string>>;
  zrange(key: string, start: number, stop: number, ...args: any[]): Promise<string[]>;
  zrevrange(key: string, start: number, stop: number, ...args: any[]): Promise<string[]>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}

export interface RedisPipeline {
  sadd(key: string, ...members: string[]): RedisPipeline;
  smembers(key: string): RedisPipeline;
  hgetall(key: string): RedisPipeline;
  hincrby(key: string, field: string, increment: number): RedisPipeline;
  zadd(key: string, ...args: any[]): RedisPipeline;
  zrevrange(key: string, start: number, stop: number, ...args: any[]): RedisPipeline;
  zremrangebyrank(key: string, start: number, stop: number): RedisPipeline;
  expire(key: string, seconds: number): RedisPipeline;
  eval(script: string, numKeys: number, ...args: any[]): RedisPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export const OTHER = '<other>';

export interface RedisStoreOptions {
  /** Key prefix, so several apps can share one Redis. Defaults to `sockeye`. */
  prefix?: string;
  /**
   * How often buffered metrics are pushed to Redis, in milliseconds. Defaults to 1000.
   * Set to 0 to disable the timer and flush by hand.
   */
  flushIntervalMs?: number;
  /** How many entries each top list keeps. Defaults to 10. */
  topLimit?: number;
  /**
   * How many payload examples are kept per message type (the biggest ones seen), so the
   * detail view can show what a message actually carries. Defaults to 5, `0` disables it.
   */
  samplesPerMessage?: number;
  /** Expire the all-time keys after this many seconds of inactivity. Off by default. */
  ttlSeconds?: number;
  /** Cardinality guard, like the memory store. Defaults to 1000. */
  maxMessageTypes?: number;
  /**
   * Periods the dashboard may ask for, each cut into `slots` buckets. Defaults to a set
   * going from the last minute to the last week. Each slice expires on its own, so
   * changing this needs no migration.
   */
  windows?: readonly WindowSpec[];
  /** Clock override, for tests. */
  now?: () => number;
  /** Called when a flush fails. Defaults to a `console.warn`. */
  onError?: (error: unknown) => void;
}

interface TopCandidate extends TopEntry {
  score: number;
  /** Series this message belongs to, so its payload examples are filed correctly. */
  series: string;
}

/** One buffered batch: a series, within one bucket of the finest resolution. */
interface BufferedSlice {
  key: string;
  /** Absolute bucket index at the finest resolution. Coarser ones are derived from it. */
  slot: number;
  aggregator: StatsAggregator;
}

/**
 * Applies "keep the lowest/highest value ever seen" to the four bound ZSETs in one go.
 *
 * Doing it server-side is what makes several app instances safe to write concurrently:
 * a read-modify-write from Node would lose updates, and `ZADD GT/LT` needs Redis 6.2.
 */
const BOUNDS_SCRIPT = `
local member = ARGV[1]
local function bound(key, raw, keepHighest)
  if raw == '' then return end
  local value = tonumber(raw)
  local current = redis.call('ZSCORE', key, member)
  if not current then
    redis.call('ZADD', key, value, member)
    return
  end
  current = tonumber(current)
  if keepHighest then
    if value > current then redis.call('ZADD', key, value, member) end
  elseif value < current then
    redis.call('ZADD', key, value, member)
  end
end
bound(KEYS[1], ARGV[2], true)
bound(KEYS[2], ARGV[3], true)
bound(KEYS[3], ARGV[4], false)
bound(KEYS[4], ARGV[5], true)
return 1
`;

/**
 * Folds one batch into a time slice: counters, bounds, histogram buckets and the expiry,
 * in a single round-trip. Slices are named after an absolute bucket index and expire on
 * their own, so nothing has to be pruned.
 */
const SLICE_SCRIPT = `
local key = KEYS[1]
local members = KEYS[2]
local ttl = tonumber(ARGV[1])
local function bound(field, raw, keepHighest)
  if raw == '' then return end
  local value = tonumber(raw)
  local current = redis.call('HGET', key, field)
  if not current then
    redis.call('HSET', key, field, raw)
    return
  end
  current = tonumber(current)
  if keepHighest then
    if value > current then redis.call('HSET', key, field, raw) end
  elseif value < current then
    redis.call('HSET', key, field, raw)
  end
end
redis.call('HINCRBY', key, 'count', ARGV[2])
redis.call('HINCRBY', key, 'bytes', ARGV[3])
bound('bmax', ARGV[4], true)
if ARGV[5] ~= '0' then
  redis.call('HINCRBY', key, 'lcount', ARGV[5])
  redis.call('HINCRBY', key, 'lsumUs', ARGV[6])
  bound('lmax', ARGV[7], true)
end
bound('first', ARGV[8], false)
bound('last', ARGV[9], true)
for i = 11, #ARGV, 2 do
  redis.call('HINCRBY', key, ARGV[i], ARGV[i + 1])
end
redis.call('EXPIRE', key, ttl)
redis.call('SADD', members, ARGV[10])
redis.call('EXPIRE', members, ttl)
return 1
`;

/**
 * Stores metrics in Redis, so several instances of your app feed a single dashboard.
 *
 * Messages are aggregated in memory and pushed in one pipeline per interval: recording a
 * message costs no network round-trip. Because the histogram layout is a pure function of
 * the value, concurrent writers can increment the same counters and still yield correct
 * percentiles.
 */
export class RedisStore implements StoreInterface {
  private readonly prefix: string;
  private readonly topLimit: number;
  private readonly samplesPerMessage: number;
  private readonly ttlSeconds: number | undefined;
  private readonly maxMessageTypes: number;
  private readonly windows: readonly WindowSpec[];
  /** Bucket sizes to maintain, finest first, and how long each slice must live. */
  private readonly buckets: Array<{ ms: number; ttlSeconds: number }>;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;

  private buffer = new Map<string, BufferedSlice>();
  private bufferedSeries = new Set<string>();
  private topCandidates: TopCandidate[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly redis: RedisLike,
    options: RedisStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'sockeye';
    this.topLimit = options.topLimit ?? 10;
    this.samplesPerMessage = options.samplesPerMessage ?? 5;
    this.ttlSeconds = options.ttlSeconds;
    this.maxMessageTypes = options.maxMessageTypes ?? 1000;
    this.windows = options.windows ?? DEFAULT_WINDOWS;
    this.buckets = bucketsFor(this.windows);
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? ((error) => console.warn('[sockeye] redis flush failed:', error));

    const interval = options.flushIntervalMs ?? 1000;
    if (interval > 0) {
      this.timer = setInterval(() => void this.flush().catch(this.onError), interval);
      // Never hold the process open just to report metrics.
      this.timer.unref?.();
    }
  }

  // --- keys -------------------------------------------------------------------------

  private seriesSetKey(): string {
    return `${this.prefix}:series`;
  }

  private hashKey(key: string): string {
    return `${this.prefix}:m:${key}`;
  }

  private maxKey(field: 'bytes' | 'latency'): string {
    return `${this.prefix}:max:${field}`;
  }

  private seenKey(field: 'first' | 'last'): string {
    return `${this.prefix}:${field}`;
  }

  private topKey(kind: TopKind): string {
    return `${this.prefix}:top:${kind}`;
  }

  /** The heaviest messages seen for one series, kept apart from the global top lists. */
  private samplesKey(key: string): string {
    return `${this.prefix}:s:${key}`;
  }

  /** One time slice of one series. `slot` is an absolute bucket index. */
  private sliceKey(ms: number, slot: number, key: string): string {
    return `${this.prefix}:w:${ms}:${slot}:${key}`;
  }

  /** Which series appear in a given slice, so reads never probe empty combinations. */
  private sliceMembersKey(ms: number, slot: number): string {
    return `${this.prefix}:ws:${ms}:${slot}`;
  }

  private sliceTopKey(kind: TopKind, ms: number, slot: number): string {
    return `${this.prefix}:tw:${kind}:${ms}:${slot}`;
  }

  // --- writing ----------------------------------------------------------------------

  record(event: MessageEvent): void {
    if (this.closed) return;

    let name = event.name;
    let key = seriesKey(event.namespace, event.direction, name);

    if (!this.bufferedSeries.has(key) && this.bufferedSeries.size >= this.maxMessageTypes) {
      name = OTHER;
      key = seriesKey(event.namespace, event.direction, name);
    }
    this.bufferedSeries.add(key);

    // Buffering per bucket of the finest resolution keeps a batch that straddles a minute
    // boundary from landing entirely in the wrong slice.
    const finest = this.buckets[0];
    const slot = finest ? Math.floor(event.timestamp / finest.ms) : 0;
    const bufferKey = `${key}|${slot}`;

    let buffered = this.buffer.get(bufferKey);
    if (!buffered) {
      buffered = { key, slot, aggregator: new StatsAggregator(name, event.direction, event.namespace) };
      this.buffer.set(bufferKey, buffered);
    }
    const aggregator = buffered.aggregator;
    aggregator.add(event);

    const entry: TopCandidate = {
      name: event.name,
      direction: event.direction,
      namespace: event.namespace,
      bytes: event.bytes,
      timestamp: event.timestamp,
      score: event.bytes,
      series: key,
    };
    if (event.latencyMs !== undefined) entry.latencyMs = event.latencyMs;
    if (event.sample !== undefined) entry.sample = event.sample;
    this.topCandidates.push(entry);
  }

  /** Push everything buffered to Redis. Safe to call concurrently. */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.size === 0 && this.topCandidates.length === 0) return;

    const buffer = this.buffer;
    const candidates = this.topCandidates;
    this.buffer = new Map();
    this.bufferedSeries = new Set();
    this.topCandidates = [];

    this.flushing = this.writeBatch(buffer, candidates).finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async writeBatch(
    buffer: Map<string, BufferedSlice>,
    candidates: TopCandidate[],
  ): Promise<void> {
    const pipeline = this.redis.pipeline();
    const touched: string[] = [];
    const finest = this.buckets[0];

    for (const { key, slot: finestSlot, aggregator } of buffer.values()) {
      const hash = this.hashKey(key);
      touched.push(hash);

      pipeline.sadd(this.seriesSetKey(), key);
      pipeline.hincrby(hash, 'count', aggregator.count);
      pipeline.hincrby(hash, 'bytes', aggregator.bytesTotal);
      incrementBuckets(pipeline, hash, 'b', aggregator.bytesHistogram);

      if (aggregator.latencyCount > 0) {
        pipeline.hincrby(hash, 'lcount', aggregator.latencyCount);
        // Latency is fractional; keep microseconds so the sum stays an integer.
        pipeline.hincrby(hash, 'lsumUs', Math.round(aggregator.latencyTotal * 1000));
        incrementBuckets(pipeline, hash, 'l', aggregator.latencyHistogram);
      }

      pipeline.eval(
        BOUNDS_SCRIPT,
        4,
        this.maxKey('bytes'),
        this.maxKey('latency'),
        this.seenKey('first'),
        this.seenKey('last'),
        key,
        String(aggregator.bytesMax),
        aggregator.latencyCount > 0 ? String(aggregator.latencyMax) : '',
        String(aggregator.firstSeen),
        String(aggregator.lastSeen),
      );

      // The same batch also lands in the matching bucket of every resolution.
      const sliceStart = finest ? finestSlot * finest.ms : aggregator.lastSeen;
      for (const bucket of this.buckets) {
        const slot = Math.floor(sliceStart / bucket.ms);
        const bucketArgs: string[] = [];
        for (const [index, count] of aggregator.bytesHistogram) {
          bucketArgs.push(`b${index}`, String(count));
        }
        for (const [index, count] of aggregator.latencyHistogram) {
          bucketArgs.push(`l${index}`, String(count));
        }

        pipeline.eval(
          SLICE_SCRIPT,
          2,
          this.sliceKey(bucket.ms, slot, key),
          this.sliceMembersKey(bucket.ms, slot),
          String(bucket.ttlSeconds),
          String(aggregator.count),
          String(aggregator.bytesTotal),
          String(aggregator.bytesMax),
          String(aggregator.latencyCount),
          String(Math.round(aggregator.latencyTotal * 1000)),
          aggregator.latencyCount > 0 ? String(aggregator.latencyMax) : '',
          String(aggregator.firstSeen),
          String(aggregator.lastSeen),
          key,
          ...bucketArgs,
        );
      }
    }

    for (const candidate of candidates) {
      const member = JSON.stringify({
        name: candidate.name,
        direction: candidate.direction,
        namespace: candidate.namespace,
        bytes: candidate.bytes,
        latencyMs: candidate.latencyMs,
        timestamp: candidate.timestamp,
        sample: candidate.sample,
        // Keeps two identical messages from collapsing into one ZSET member.
        n: Math.random().toString(36).slice(2, 10),
      });

      this.pushTop(pipeline, 'heaviest', candidate.bytes, member, candidate.timestamp);
      if (candidate.latencyMs !== undefined) {
        this.pushTop(pipeline, 'slowest', candidate.latencyMs, member, candidate.timestamp);
      }

      if (this.samplesPerMessage > 0) {
        const key = this.samplesKey(candidate.series);
        pipeline.zadd(key, candidate.bytes, member);
        pipeline.zremrangebyrank(key, 0, -(this.samplesPerMessage + 1));
        if (this.ttlSeconds !== undefined) pipeline.expire(key, this.ttlSeconds);
      }
    }

    if (this.ttlSeconds !== undefined) {
      for (const key of [
        ...touched,
        this.seriesSetKey(),
        this.maxKey('bytes'),
        this.maxKey('latency'),
        this.seenKey('first'),
        this.seenKey('last'),
        this.topKey('heaviest'),
        this.topKey('slowest'),
      ]) {
        pipeline.expire(key, this.ttlSeconds);
      }
    }

    await pipeline.exec();
  }

  private pushTop(
    pipeline: RedisPipeline,
    kind: TopKind,
    score: number,
    member: string,
    timestamp: number,
  ): void {
    pipeline.zadd(this.topKey(kind), score, member);
    pipeline.zremrangebyrank(this.topKey(kind), 0, -(this.topLimit + 1));

    for (const bucket of this.buckets) {
      const slot = Math.floor(timestamp / bucket.ms);
      const key = this.sliceTopKey(kind, bucket.ms, slot);
      pipeline.zadd(key, score, member);
      pipeline.zremrangebyrank(key, 0, -(this.topLimit + 1));
      pipeline.expire(key, bucket.ttlSeconds);
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
    this.closed = true;
  }

  // --- reading ----------------------------------------------------------------------

  /** How far back this store's own history reaches. `0` when nothing was recorded yet. */
  private async historyMs(): Promise<number> {
    // The lowest score of the per-series "first seen" set: when collection started.
    const [, score] = await this.redis.zrange(this.seenKey('first'), 0, 0, 'WITHSCORES');
    const first = Number(score);
    if (!Number.isFinite(first) || first <= 0) return 0;
    return Math.max(0, this.now() - first);
  }

  /** Resolve the requested period, and what it actually covers. */
  private async resolve(
    options: WindowOptions = {},
  ): Promise<{ spec: WindowSpec; range: WindowRange | null }> {
    const spec =
      options.window === AUTO
        ? autoWindow(this.windows, await this.historyMs())
        : resolveWindow(options.window, this.windows);
    if (spec.ms === null) return { spec, range: null };

    return {
      spec,
      range: { key: spec.key, label: spec.label, ...coveredRange(spec, this.now()) },
    };
  }

  /** Aggregates for every series, over the requested period. */
  private async aggregates(options: WindowOptions = {}): Promise<{
    spec: WindowSpec;
    range: WindowRange | null;
    entries: Array<[string, StatsAggregator]>;
  }> {
    const { spec, range } = await this.resolve(options);
    if (spec.ms === null) return { spec, range: null, entries: await this.readCumulative() };
    return { spec, range, entries: await this.readWindow(spec) };
  }

  private async readCumulative(): Promise<Array<[string, StatsAggregator]>> {
    const keys = await this.redis.smembers(this.seriesSetKey());
    if (keys.length === 0) return [];

    const [hashes, maxBytes, maxLatency, first, last] = await Promise.all([
      Promise.all(keys.map((key) => this.redis.hgetall(this.hashKey(key)))),
      this.readScores(this.maxKey('bytes')),
      this.readScores(this.maxKey('latency')),
      this.readScores(this.seenKey('first')),
      this.readScores(this.seenKey('last')),
    ]);

    const entries: Array<[string, StatsAggregator]> = [];
    keys.forEach((key, index) => {
      const hash = hashes[index];
      if (!hash || Object.keys(hash).length === 0) return;

      const aggregate = aggregateFromHash(key, hash);
      aggregate.bytesMax = maxBytes.get(key) ?? aggregate.bytesMax;
      aggregate.latencyMax = maxLatency.get(key) ?? aggregate.latencyMax;
      aggregate.firstSeen = first.get(key) ?? 0;
      aggregate.lastSeen = last.get(key) ?? 0;
      entries.push([key, aggregate]);
    });

    return entries;
  }

  private async readWindow(spec: WindowSpec): Promise<Array<[string, StatsAggregator]>> {
    const ms = bucketMs(spec);
    const slots = this.slotsFor(spec);

    // Which series actually have data in each slice, so nothing empty is ever fetched.
    const membership = this.redis.pipeline();
    for (const slot of slots) membership.smembers(this.sliceMembersKey(ms, slot));
    const membershipResult = (await membership.exec()) ?? [];

    const wanted: Array<{ slot: number; key: string }> = [];
    membershipResult.forEach(([error, value], index) => {
      if (error || !Array.isArray(value)) return;
      const slot = slots[index];
      for (const key of value as string[]) wanted.push({ slot, key });
    });
    if (wanted.length === 0) return [];

    const reads = this.redis.pipeline();
    for (const { slot, key } of wanted) reads.hgetall(this.sliceKey(ms, slot, key));
    const results = (await reads.exec()) ?? [];

    const merged = new Map<string, StatsAggregator>();
    results.forEach(([error, value], index) => {
      if (error || !value) return;
      const hash = value as Record<string, string>;
      if (Object.keys(hash).length === 0) return;

      const { key } = wanted[index];
      const slice = aggregateFromHash(key, hash);
      const { name, direction, namespace } = parseSeriesKey(key);

      let target = merged.get(key);
      if (!target) {
        target = new StatsAggregator(name, direction, namespace);
        merged.set(key, target);
      }
      target.merge(slice);
    });

    return [...merged.entries()];
  }

  /** Absolute bucket indexes covering a period, oldest first. */
  private slotsFor(spec: WindowSpec): number[] {
    const last = Math.floor(this.now() / bucketMs(spec));
    const first = last - Math.max(1, spec.slots ?? 1) + 1;
    const slots: number[] = [];
    for (let slot = first; slot <= last; slot++) slots.push(slot);
    return slots;
  }

  private async readScores(key: string): Promise<Map<string, number>> {
    const flat = await this.redis.zrange(key, 0, -1, 'WITHSCORES');
    const scores = new Map<string, number>();
    for (let i = 0; i < flat.length; i += 2) {
      scores.set(flat[i], Number(flat[i + 1]));
    }
    return scores;
  }

  async getOverview(options: WindowOptions = {}): Promise<Overview> {
    // One resolution for the whole answer: `auto` must not pick a different period for
    // the totals and for the timeline.
    const { spec, range, entries } = await this.aggregates(options);
    const overview: Overview = {
      totalMessages: 0,
      totalBytes: 0,
      messageTypes: entries.length,
      in: { count: 0, bytes: 0 },
      out: { count: 0, bytes: 0 },
      firstSeen: null,
      lastSeen: null,
      window: range,
      timeline: await this.readTotalTimeline(spec),
    };

    for (const [, aggregate] of entries) {
      overview.totalMessages += aggregate.count;
      overview.totalBytes += aggregate.bytesTotal;
      const side = overview[aggregate.direction] ?? overview.in;
      side.count += aggregate.count;
      side.bytes += aggregate.bytesTotal;

      if (aggregate.firstSeen > 0 && (overview.firstSeen === null || aggregate.firstSeen < overview.firstSeen)) {
        overview.firstSeen = aggregate.firstSeen;
      }
      if (aggregate.lastSeen > 0 && (overview.lastSeen === null || aggregate.lastSeen > overview.lastSeen)) {
        overview.lastSeen = aggregate.lastSeen;
      }
    }

    return overview;
  }

  async listMessages(options: ListMessagesOptions = {}): Promise<MessageStats[]> {
    const { entries } = await this.aggregates(options);
    return applyListOptions(
      entries.map(([, aggregate]) => aggregate.toStats()),
      options,
    );
  }

  async getMessageStats(name: string, options: MessageStatsOptions = {}): Promise<MessageDetail[]> {
    const { spec, entries } = await this.aggregates(options);

    const wanted = entries.filter(([key]) => {
      const parsed = parseSeriesKey(key);
      if (parsed.name !== name) return false;
      return !options.direction || parsed.direction === options.direction;
    });

    const [timelines, samples] = await Promise.all([
      Promise.all(wanted.map(([key]) => this.readTimeline(key, spec))),
      Promise.all(wanted.map(([key]) => this.readSamples(key))),
    ]);

    const out: MessageDetail[] = wanted.map(([, aggregate], index) => ({
      ...aggregate.toDetail(),
      timeline: timelines[index] ?? [],
      samples: samples[index] ?? [],
    }));

    return out.sort((a, b) => a.direction.localeCompare(b.direction));
  }

  /** The biggest payloads recorded for one series, heaviest first. */
  private async readSamples(key: string): Promise<TopEntry[]> {
    if (this.samplesPerMessage === 0) return [];
    return parseTopMembers(
      await this.redis.zrevrange(this.samplesKey(key), 0, this.samplesPerMessage - 1),
    );
  }

  /**
   * Per-bucket counts for one series, oldest first. Buckets with no traffic come back with
   * `count: 0` so a chart shows the gaps rather than closing them up.
   */
  private async readTimeline(key: string, spec: WindowSpec): Promise<TimelineBucket[]> {
    const target = spec.ms === null ? coarsestWindow(this.windows) : spec;
    if (!target) return [];

    const ms = bucketMs(target);
    const slots = this.slotsFor(target);

    const pipeline = this.redis.pipeline();
    for (const slot of slots) pipeline.hgetall(this.sliceKey(ms, slot, key));
    const results = (await pipeline.exec()) ?? [];

    return slots.map((slot, index) => {
      const entry = results[index];
      const hash = (entry && !entry[0] ? entry[1] : null) as Record<string, string> | null;
      return {
        from: slot * ms,
        to: (slot + 1) * ms,
        count: Number(hash?.count ?? 0),
        bytes: Number(hash?.bytes ?? 0),
      };
    });
  }

  /**
   * Per-bucket totals across every series, oldest first: two round trips whatever the
   * number of message types, since each bucket already knows which series touched it.
   */
  private async readTotalTimeline(spec: WindowSpec): Promise<TimelineBucket[]> {
    const target = spec.ms === null ? coarsestWindow(this.windows) : spec;
    if (!target) return [];

    const ms = bucketMs(target);
    const slots = this.slotsFor(target);

    const membership = this.redis.pipeline();
    for (const slot of slots) membership.smembers(this.sliceMembersKey(ms, slot));
    const membershipResult = (await membership.exec()) ?? [];

    const buckets = slots.map((slot) => ({
      from: slot * ms,
      to: (slot + 1) * ms,
      count: 0,
      bytes: 0,
    }));

    // Which bucket each hash belongs to, so the flat pipeline result can be added back.
    const wanted: Array<{ bucket: TimelineBucket; key: string }> = [];
    membershipResult.forEach(([error, value], index) => {
      if (error || !Array.isArray(value)) return;
      for (const key of value as string[]) wanted.push({ bucket: buckets[index], key });
    });
    if (wanted.length === 0) return buckets;

    const reads = this.redis.pipeline();
    for (const { bucket, key } of wanted) {
      reads.hgetall(this.sliceKey(ms, Math.floor(bucket.from / ms), key));
    }
    const results = (await reads.exec()) ?? [];

    results.forEach(([error, value], index) => {
      if (error || !value) return;
      const hash = value as Record<string, string>;
      const { bucket } = wanted[index];
      bucket.count += Number(hash.count ?? 0);
      bucket.bytes += Number(hash.bytes ?? 0);
    });

    return buckets;
  }

  async getTop(kind: TopKind, options: TopOptions = {}): Promise<TopEntry[]> {
    const limit = options.limit ?? this.topLimit;
    const { spec } = await this.resolve(options);

    if (spec.ms === null) {
      return parseTopMembers(await this.redis.zrevrange(this.topKey(kind), 0, limit - 1));
    }

    const ms = bucketMs(spec);
    const slots = this.slotsFor(spec);
    const pipeline = this.redis.pipeline();
    for (const slot of slots) {
      pipeline.zrevrange(this.sliceTopKey(kind, ms, slot), 0, limit - 1);
    }
    const results = (await pipeline.exec()) ?? [];

    const score = (entry: TopEntry) =>
      kind === 'slowest' ? (entry.latencyMs ?? Number.NaN) : entry.bytes;
    const merged = new TopN<TopEntry>(limit, score);

    for (const [error, value] of results) {
      if (error || !Array.isArray(value)) continue;
      for (const entry of parseTopMembers(value as string[])) merged.push(entry);
    }

    return merged.items(limit);
  }

  async getWindows(): Promise<WindowRange[]> {
    return windowRanges(this.windows, this.now());
  }

  async reset(): Promise<void> {
    this.buffer = new Map();
    this.bufferedSeries = new Set();
    this.topCandidates = [];

    const keys = await this.redis.smembers(this.seriesSetKey());
    // Time slices carry an absolute bucket index, so they are found by pattern.
    const sliced = await this.redis.keys(`${this.prefix}:w:*`);
    const samples = await this.redis.keys(`${this.prefix}:s:*`);
    const members = await this.redis.keys(`${this.prefix}:ws:*`);
    const slicedTops = await this.redis.keys(`${this.prefix}:tw:*`);

    await this.redis.del(
      ...keys.map((key) => this.hashKey(key)),
      ...sliced,
      ...members,
      ...slicedTops,
      ...samples,
      this.seriesSetKey(),
      this.maxKey('bytes'),
      this.maxKey('latency'),
      this.seenKey('first'),
      this.seenKey('last'),
      this.topKey('heaviest'),
      this.topKey('slowest'),
    );
  }
}

/**
 * The distinct bucket sizes the windows need, finest first. Several periods often share
 * one: a slice is written once per size, and lives as long as the longest period using it.
 */
function bucketsFor(
  windows: readonly WindowSpec[],
): Array<{ ms: number; ttlSeconds: number }> {
  const spans = new Map<number, number>();

  for (const window of windows) {
    if (window.ms === null) continue;
    const ms = bucketMs(window);
    spans.set(ms, Math.max(spans.get(ms) ?? 0, window.ms));
  }

  return [...spans.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ms, span]) => ({ ms, ttlSeconds: Math.ceil(span / 1000) }));
}

function incrementBuckets(
  pipeline: RedisPipeline,
  hash: string,
  prefix: 'b' | 'l',
  counts: histogram.Histogram,
): void {
  for (const [index, count] of counts) {
    if (count > 0) pipeline.hincrby(hash, `${prefix}${index}`, count);
  }
}

/** Rebuild a sparse histogram from the `b<i>` / `l<i>` hash fields. */
function readBuckets(hash: Record<string, string>, prefix: 'b' | 'l'): histogram.Histogram {
  const counts = histogram.createHistogram();
  for (const [field, value] of Object.entries(hash)) {
    if (!field.startsWith(prefix)) continue;
    const index = Number(field.slice(prefix.length));
    if (Number.isInteger(index) && index >= 0 && index < histogram.BUCKET_COUNT) {
      counts.set(index, Number(value));
    }
  }
  return counts;
}

/** Turn a stored hash back into an aggregate that can be merged with others. */
function aggregateFromHash(key: string, hash: Record<string, string>): StatsAggregator {
  const { name, direction, namespace } = parseSeriesKey(key);
  const aggregate = new StatsAggregator(name, direction, namespace);

  aggregate.count = Number(hash.count ?? 0);
  aggregate.bytesTotal = Number(hash.bytes ?? 0);
  aggregate.bytesMax = Number(hash.bmax ?? 0);
  aggregate.latencyCount = Number(hash.lcount ?? 0);
  aggregate.latencyTotal = Number(hash.lsumUs ?? 0) / 1000;
  aggregate.latencyMax = Number(hash.lmax ?? 0);
  aggregate.firstSeen = Number(hash.first ?? 0);
  aggregate.lastSeen = Number(hash.last ?? 0);

  histogram.merge(aggregate.bytesHistogram, readBuckets(hash, 'b'));
  histogram.merge(aggregate.latencyHistogram, readBuckets(hash, 'l'));

  return aggregate;
}

function parseTopMembers(members: string[]): TopEntry[] {
  const entries: TopEntry[] = [];
  for (const member of members) {
    try {
      const { n: _ignored, ...entry } = JSON.parse(member) as TopEntry & { n?: string };
      entries.push(entry);
    } catch {
      // A malformed member must not break the dashboard.
    }
  }
  return entries;
}

/** Convenience factory: `const store = createRedisStore(new Redis())`. */
export function createRedisStore(redis: RedisLike, options?: RedisStoreOptions): RedisStore {
  return new RedisStore(redis, options);
}
