import {
  StatsAggregator,
  WindowedSeries,
  WindowedTops,
  TopN,
  DEFAULT_WINDOWS,
  applyListOptions,
  AUTO,
  autoWindow,
  coveredRange,
  mergeTimelines,
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
  type TopEntry,
  type TopKind,
  type TopOptions,
  type WindowOptions,
  type WindowRange,
  type WindowSpec,
} from '@sockeye-js/core';

/** Bucket every message falls into once `maxMessageTypes` is reached. */
export const OTHER = '<other>';

export interface MemoryStoreOptions {
  /** How many entries each top list keeps. Defaults to 10. */
  topLimit?: number;
  /**
   * How many payload examples are kept per message type (the biggest ones seen), so the
   * detail view can show what a message actually carries. Defaults to 5, `0` disables it.
   */
  samplesPerMessage?: number;
  /**
   * Safety net against unbounded cardinality: if message names embed an id, the number of
   * series would grow forever. Past this many series, everything else is merged into
   * {@link OTHER}. Defaults to 1000.
   */
  maxMessageTypes?: number;
  /**
   * Periods the dashboard may ask for, each cut into `slots` buckets. Defaults to a set
   * going from the last minute to the last week.
   *
   * ```ts
   * createMemoryStore({
   *   windows: [
   *     { key: '1d', label: 'Last day', ms: 86_400_000, slots: 72 }, // 20-minute steps
   *     ALL_TIME,
   *   ],
   * });
   * ```
   */
  windows?: readonly WindowSpec[];
  /** Clock override, for tests. */
  now?: () => number;
}

/**
 * Keeps every metric in the process memory. Implements both sides of the store contract,
 * so the dashboard can read straight from it.
 *
 * Memory usage is bounded: each message type holds a running total plus one sparse
 * aggregate per time bucket, and the number of buckets is fixed by the windows.
 */
export class MemoryStore implements StoreInterface {
  private readonly series = new Map<string, WindowedSeries>();
  /** The heaviest messages seen per series, kept apart from the global top lists. */
  private readonly samples = new Map<string, TopN<TopEntry>>();
  private readonly tops: Record<TopKind, WindowedTops>;
  private readonly topLimit: number;
  private readonly samplesPerMessage: number;
  private readonly maxMessageTypes: number;
  private readonly windows: readonly WindowSpec[];
  private readonly now: () => number;

  constructor(options: MemoryStoreOptions = {}) {
    this.topLimit = options.topLimit ?? 10;
    this.samplesPerMessage = options.samplesPerMessage ?? 5;
    this.maxMessageTypes = options.maxMessageTypes ?? 1000;
    this.windows = options.windows ?? DEFAULT_WINDOWS;
    this.now = options.now ?? Date.now;
    this.tops = {
      slowest: new WindowedTops(this.topLimit, (e) => e.latencyMs ?? Number.NaN, this.windows),
      heaviest: new WindowedTops(this.topLimit, (e) => e.bytes, this.windows),
    };
  }

  record(event: MessageEvent): void {
    let name = event.name;
    let key = seriesKey(event.namespace, event.direction, name);

    if (!this.series.has(key) && this.series.size >= this.maxMessageTypes) {
      name = OTHER;
      key = seriesKey(event.namespace, event.direction, name);
    }

    let series = this.series.get(key);
    if (!series) {
      series = new WindowedSeries(name, event.direction, event.namespace, this.windows);
      this.series.set(key, series);
    }
    series.add(event);

    const entry: TopEntry = {
      name: event.name,
      direction: event.direction,
      namespace: event.namespace,
      bytes: event.bytes,
      timestamp: event.timestamp,
    };
    if (event.recipients !== undefined) entry.recipients = event.recipients;
    if (event.sample !== undefined) entry.sample = event.sample;
    if (event.latencyMs !== undefined) {
      entry.latencyMs = event.latencyMs;
      this.tops.slowest.push(entry);
    }
    this.tops.heaviest.push(entry);

    if (this.samplesPerMessage > 0) {
      let examples = this.samples.get(key);
      if (!examples) {
        examples = new TopN<TopEntry>(this.samplesPerMessage, (e) => e.bytes);
        this.samples.set(key, examples);
      }
      examples.push(entry);
    }
  }

  /** How far back this store's own history reaches. `0` when nothing was recorded yet. */
  private historyMs(): number {
    let first = 0;
    for (const series of this.series.values()) {
      const seen = series.total.firstSeen;
      if (seen > 0 && (first === 0 || seen < first)) first = seen;
    }
    return first === 0 ? 0 : Math.max(0, this.now() - first);
  }

  /** Resolve the requested period, and what it actually covers. */
  private resolve(options: WindowOptions = {}): { spec: WindowSpec; range: WindowRange | null } {
    const spec =
      options.window === AUTO
        ? autoWindow(this.windows, this.historyMs())
        : resolveWindow(options.window, this.windows);
    if (spec.ms === null) return { spec, range: null };

    return {
      spec,
      range: { key: spec.key, label: spec.label, ...coveredRange(spec, this.now()) },
    };
  }

  private aggregates(options: WindowOptions = {}): {
    spec: WindowSpec;
    range: WindowRange | null;
    entries: Array<[string, StatsAggregator]>;
  } {
    const { spec, range } = this.resolve(options);
    const now = this.now();
    const entries: Array<[string, StatsAggregator]> = [];

    for (const [key, series] of this.series) {
      const aggregate = series.window(spec, now);
      if (aggregate.isEmpty) continue;
      entries.push([key, aggregate]);
    }

    return { spec, range, entries };
  }

  async getOverview(options: WindowOptions = {}): Promise<Overview> {
    // One resolution for the whole answer: `auto` must not pick a different period for
    // the totals and for the timeline.
    const { spec, range, entries } = this.aggregates(options);
    const now = this.now();
    const overview: Overview = {
      totalMessages: 0,
      totalBytes: 0,
      totalSent: 0,
      totalSentBytes: 0,
      messageTypes: entries.length,
      in: { count: 0, bytes: 0, sentCount: 0, sentBytes: 0 },
      out: { count: 0, bytes: 0, sentCount: 0, sentBytes: 0 },
      firstSeen: null,
      lastSeen: null,
      window: range,
      timeline: mergeTimelines(
        [...this.series.values()].map((series) => series.timeline(spec, now)),
      ),
    };

    for (const [, aggregate] of entries) {
      overview.totalMessages += aggregate.count;
      overview.totalBytes += aggregate.bytesTotal;
      overview.totalSent += aggregate.sentCount;
      overview.totalSentBytes += aggregate.sentBytes;
      const side = overview[aggregate.direction];
      side.count += aggregate.count;
      side.bytes += aggregate.bytesTotal;
      side.sentCount += aggregate.sentCount;
      side.sentBytes += aggregate.sentBytes;

      if (aggregate.firstSeen > 0 && (overview.firstSeen === null || aggregate.firstSeen < overview.firstSeen)) {
        overview.firstSeen = aggregate.firstSeen;
      }
      if (overview.lastSeen === null || aggregate.lastSeen > overview.lastSeen) {
        overview.lastSeen = aggregate.lastSeen;
      }
    }

    return overview;
  }

  async listMessages(options: ListMessagesOptions = {}): Promise<MessageStats[]> {
    const { entries } = this.aggregates(options);
    return applyListOptions(
      entries.map(([, aggregate]) => aggregate.toStats()),
      options,
    );
  }

  async getMessageStats(name: string, options: MessageStatsOptions = {}): Promise<MessageDetail[]> {
    const { spec } = this.resolve(options);
    const now = this.now();
    const out: MessageDetail[] = [];

    // Read the series directly rather than the merged aggregates: the history comes from it.
    for (const [key, series] of this.series) {
      const parsed = parseSeriesKey(key);
      if (parsed.name !== name) continue;
      if (options.direction && parsed.direction !== options.direction) continue;

      const aggregate = series.window(spec, now);
      if (aggregate.isEmpty) continue;

      out.push({
        ...aggregate.toDetail(),
        timeline: series.timeline(spec, now),
        samples: this.samples.get(key)?.items() ?? [],
      });
    }

    return out.sort((a, b) => a.direction.localeCompare(b.direction));
  }

  async getTop(kind: TopKind, options: TopOptions = {}): Promise<TopEntry[]> {
    const top = this.tops[kind];
    if (!top) return [];
    const { spec } = this.resolve(options);
    return top.window(spec, this.now(), options.limit ?? this.topLimit);
  }

  async getWindows(): Promise<WindowRange[]> {
    return windowRanges(this.windows, this.now());
  }

  async reset(): Promise<void> {
    this.series.clear();
    this.samples.clear();
    this.tops.slowest.clear();
    this.tops.heaviest.clear();
  }
}

/** Convenience factory: `const store = createMemoryStore()`. */
export function createMemoryStore(options?: MemoryStoreOptions): MemoryStore {
  return new MemoryStore(options);
}
