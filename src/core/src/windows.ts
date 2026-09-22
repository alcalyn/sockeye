import { StatsAggregator } from './aggregator.js';
import { TopN } from './top-n.js';
import type {
  Direction,
  MessageEvent,
  TimelineBucket,
  TopEntry,
  WindowRange,
} from './types.js';

/**
 * A period the dashboard can ask for, and how finely it is cut up.
 *
 * A message is counted in the current bucket of every window, so the cost of recording
 * does not depend on which period the dashboard asks for.
 */
export interface WindowSpec {
  key: string;
  label: string;
  /** Length of the period in milliseconds, or `null` for everything since the start. */
  ms: number | null;
  /**
   * How many buckets the period is cut into: its resolution, and the number of points a
   * chart gets. Ignored when `ms` is `null`, which is kept as a running total.
   */
  slots?: number;
}

/** The window always offered: everything since the store started. */
export const ALL_TIME: WindowSpec = { key: 'all', label: 'All time', ms: null };

/** Periods offered by default, from the last minute to the last week. */
export const DEFAULT_WINDOWS: readonly WindowSpec[] = [
  { key: '1m', label: 'Last minute', ms: 60_000, slots: 60 },
  { key: '5m', label: 'Last 5 minutes', ms: 5 * 60_000, slots: 60 },
  { key: '15m', label: 'Last 15 minutes', ms: 15 * 60_000, slots: 60 },
  { key: '1h', label: 'Last hour', ms: 60 * 60_000, slots: 60 },
  { key: '6h', label: 'Last 6 hours', ms: 6 * 60 * 60_000, slots: 60 },
  { key: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000, slots: 48 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000, slots: 42 },
  ALL_TIME,
];

/** Length of one bucket of a window. `0` for the whole history, which has no bucket. */
export function bucketMs(window: WindowSpec): number {
  if (window.ms === null) return 0;
  return Math.max(1, Math.floor(window.ms / Math.max(1, window.slots ?? 1)));
}

/**
 * Window key asking the store to choose the period itself, rather than naming one.
 *
 * A dashboard opened on a process that started a minute ago should show that minute, not
 * a week of empty buckets; an hour later it should have grown into the hour. This is that
 * key, resolved against the history by {@link autoWindow}.
 */
export const AUTO = 'auto';

/** Bucketed windows, finest first. The whole history has no bucket, so it is left out. */
function bucketed(windows: readonly WindowSpec[]): Array<WindowSpec & { ms: number }> {
  return windows
    .filter((window): window is WindowSpec & { ms: number } => window.ms !== null)
    .sort((a, b) => a.ms - b.ms);
}

/**
 * The period {@link AUTO} resolves to: the finest one the history does not fill yet.
 *
 * With the default windows, a store that has been collecting for ten seconds answers for
 * the last minute; past a minute of history it moves up to the last five minutes, and so
 * on until the coarsest period, which it then keeps.
 */
export function autoWindow(windows: readonly WindowSpec[], historyMs: number): WindowSpec {
  const candidates = bucketed(windows);
  if (candidates.length === 0) return ALL_TIME;
  return candidates.find((window) => window.ms > historyMs) ?? candidates[candidates.length - 1];
}

/** Resolve a window key coming from the API. Unknown keys fall back to the whole history. */
export function resolveWindow(
  key: string | undefined | null,
  windows: readonly WindowSpec[] = DEFAULT_WINDOWS,
): WindowSpec {
  if (!key) return ALL_TIME;
  return windows.find((window) => window.key === key) ?? ALL_TIME;
}

/** The period a window actually covers, which is rounded out to whole buckets. */
export interface CoveredRange {
  from: number;
  to: number;
  /** Size of one bucket. The newest one is still filling up. */
  resolutionMs: number;
}

/** Bucket indexes covering a window, oldest first. */
function slotRange(window: WindowSpec, now: number): { first: number; last: number } {
  const ms = bucketMs(window);
  const last = Math.floor(now / ms);
  return { first: last - Math.max(1, window.slots ?? 1) + 1, last };
}

export function coveredRange(window: WindowSpec, now: number): CoveredRange {
  const ms = bucketMs(window);
  const { first, last } = slotRange(window, now);
  return { from: first * ms, to: (last + 1) * ms, resolutionMs: ms };
}

/** What every offered period covers right now, in order. */
export function windowRanges(windows: readonly WindowSpec[], now: number): WindowRange[] {
  return windows.map((window) =>
    window.ms === null
      ? { key: window.key, label: window.label, from: 0, to: now, resolutionMs: 0 }
      : { key: window.key, label: window.label, ...coveredRange(window, now) },
  );
}

interface Slot<T> {
  /** Absolute bucket index, so a recycled slot is detected instead of double-counted. */
  index: number;
  value: T;
}

/** A ring of buckets for one window. */
class Ring<T> {
  private readonly slots: Array<Slot<T> | undefined>;
  private readonly count: number;
  private readonly ms: number;

  constructor(
    window: WindowSpec,
    private readonly create: () => T,
  ) {
    this.count = Math.max(1, window.slots ?? 1);
    this.ms = bucketMs(window);
    this.slots = new Array(this.count);
  }

  private position(index: number): number {
    return ((index % this.count) + this.count) % this.count;
  }

  /** The bucket holding `timestamp`, recycling the slot when it belonged to an older one. */
  at(timestamp: number): T {
    const index = Math.floor(timestamp / this.ms);
    const position = this.position(index);
    const slot = this.slots[position];

    if (!slot || slot.index !== index) {
      const value = this.create();
      this.slots[position] = { index, value };
      return value;
    }
    return slot.value;
  }

  /** The bucket with this absolute index, if it has not been recycled yet. */
  get(index: number): T | undefined {
    const slot = this.slots[this.position(index)];
    return slot && slot.index === index ? slot.value : undefined;
  }

  clear(): void {
    this.slots.fill(undefined);
  }
}

/** Build one ring per bucketed window, keyed by window key. */
function ringsFor<T>(
  windows: readonly WindowSpec[],
  create: () => T,
): Map<string, Ring<T>> {
  const rings = new Map<string, Ring<T>>();
  for (const window of windows) {
    if (window.ms !== null) rings.set(window.key, new Ring(window, create));
  }
  return rings;
}

/** The coarsest bucketed window, used to show as much history as there is. */
export function coarsestWindow(windows: readonly WindowSpec[]): WindowSpec | undefined {
  let coarsest: WindowSpec | undefined;
  for (const window of windows) {
    if (window.ms === null) continue;
    if (!coarsest || bucketMs(window) > bucketMs(coarsest)) coarsest = window;
  }
  return coarsest;
}

/**
 * Sum timelines cut on the same window into one, oldest first.
 *
 * Every series is bucketed on the same absolute grid, so buckets line up by their start;
 * a series that was quiet for a bucket simply contributes nothing to it.
 */
export function mergeTimelines(timelines: readonly TimelineBucket[][]): TimelineBucket[] {
  const merged = new Map<number, TimelineBucket>();

  for (const timeline of timelines) {
    for (const bucket of timeline) {
      const total = merged.get(bucket.from);
      if (total) {
        total.count += bucket.count;
        total.bytes += bucket.bytes;
        total.sentCount += bucket.sentCount;
        total.sentBytes += bucket.sentBytes;
      } else {
        merged.set(bucket.from, { ...bucket });
      }
    }
  }

  return [...merged.values()].sort((a, b) => a.from - b.from);
}

/**
 * Statistics for one message, kept at every offered period at once.
 *
 * `total` is the running sum since the store started; the rings hold the recent history,
 * so the dashboard can ask "and over the last 5 minutes?" without keeping any raw sample.
 */
export class WindowedSeries {
  readonly total: StatsAggregator;
  private readonly rings: Map<string, Ring<StatsAggregator>>;

  constructor(
    readonly name: string,
    readonly direction: Direction,
    readonly namespace: string,
    private readonly windows: readonly WindowSpec[] = DEFAULT_WINDOWS,
  ) {
    this.total = new StatsAggregator(name, direction, namespace);
    this.rings = ringsFor(windows, () => new StatsAggregator(name, direction, namespace));
  }

  add(event: MessageEvent): void {
    this.total.add(event);
    for (const ring of this.rings.values()) ring.at(event.timestamp).add(event);
  }

  /** Aggregate over a period, or the running total for the whole history. */
  window(spec: WindowSpec, now: number): StatsAggregator {
    if (spec.ms === null) return this.total;

    const merged = new StatsAggregator(this.name, this.direction, this.namespace);
    const ring = this.rings.get(spec.key);
    if (!ring) return merged;

    const { first, last } = slotRange(spec, now);
    for (let index = first; index <= last; index++) {
      const slice = ring.get(index);
      if (slice) merged.merge(slice);
    }
    return merged;
  }

  /**
   * How many of this message per time bucket, oldest first.
   *
   * Buckets with no traffic are reported with `count: 0`, so a chart shows the gaps instead
   * of silently closing them up. The whole history falls back to the coarsest period, which
   * reaches as far back as any history goes.
   */
  timeline(spec: WindowSpec, now: number): TimelineBucket[] {
    const target = spec.ms === null ? coarsestWindow(this.windows) : spec;
    if (!target) return [];

    const ring = this.rings.get(target.key);
    if (!ring) return [];

    const ms = bucketMs(target);
    const { first, last } = slotRange(target, now);
    const buckets: TimelineBucket[] = [];

    for (let index = first; index <= last; index++) {
      const slice = ring.get(index);
      buckets.push({
        from: index * ms,
        to: (index + 1) * ms,
        count: slice?.count ?? 0,
        bytes: slice?.bytesTotal ?? 0,
        sentCount: slice?.sentCount ?? 0,
        sentBytes: slice?.sentBytes ?? 0,
      });
    }
    return buckets;
  }
}

/**
 * Top lists kept per period.
 *
 * Only a handful of entries are kept per bucket, not per message type, so the whole
 * history of "worst offenders" costs a few hundred entries for the entire store.
 */
export class WindowedTops {
  private readonly all: TopN<TopEntry>;
  private readonly rings: Map<string, Ring<TopN<TopEntry>>>;

  constructor(
    private readonly limit: number,
    private readonly score: (entry: TopEntry) => number,
    windows: readonly WindowSpec[] = DEFAULT_WINDOWS,
  ) {
    this.all = new TopN<TopEntry>(limit, score);
    this.rings = ringsFor(windows, () => new TopN<TopEntry>(limit, score));
  }

  push(entry: TopEntry): void {
    this.all.push(entry);
    for (const ring of this.rings.values()) ring.at(entry.timestamp).push(entry);
  }

  window(spec: WindowSpec, now: number, limit = this.limit): TopEntry[] {
    if (spec.ms === null) return this.all.items(limit);

    const ring = this.rings.get(spec.key);
    if (!ring) return [];

    const merged = new TopN<TopEntry>(limit, this.score);
    const { first, last } = slotRange(spec, now);
    for (let index = first; index <= last; index++) {
      const bucket = ring.get(index);
      if (bucket) for (const entry of bucket.items()) merged.push(entry);
    }
    return merged.items(limit);
  }

  clear(): void {
    this.all.clear();
    for (const ring of this.rings.values()) ring.clear();
  }
}
