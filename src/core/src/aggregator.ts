import * as hist from './histogram.js';
import type {
  Direction,
  Distribution,
  MessageDetail,
  MessageEvent,
  MessageStats,
} from './types.js';

/** Separator used inside composite keys (unit separator: never appears in a message name). */
const SEP = String.fromCharCode(31);

/** Key identifying one series of stats. Used as a Map key and as part of the Redis key. */
export function seriesKey(namespace: string, direction: Direction, name: string): string {
  return namespace + SEP + direction + SEP + name;
}

export function parseSeriesKey(key: string): { namespace: string; direction: Direction; name: string } {
  const [namespace = '/', direction = 'in', ...rest] = key.split(SEP);
  return { namespace, direction: direction as Direction, name: rest.join(SEP) };
}

export function emptyDistribution(): Distribution {
  return { count: 0, total: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
}

/** Build a {@link Distribution} from running counters plus a histogram. */
export function distributionOf(
  count: number,
  total: number,
  max: number,
  counts: hist.Counts,
): Distribution {
  if (count === 0) return emptyDistribution();
  return {
    count,
    total,
    avg: total / count,
    p50: hist.quantile(counts, 0.5, count),
    p95: hist.quantile(counts, 0.95, count),
    p99: hist.quantile(counts, 0.99, count),
    max,
  };
}

/**
 * Running statistics for one message name, in one direction, in one namespace.
 *
 * Memory is constant whatever the traffic: two fixed-size histograms plus a handful of
 * counters. The same object backs the in-memory store and the write buffer of the Redis store.
 */
export class StatsAggregator {
  count = 0;
  bytesTotal = 0;
  bytesMax = 0;
  latencyCount = 0;
  latencyTotal = 0;
  latencyMax = 0;
  firstSeen = 0;
  lastSeen = 0;

  readonly bytesHistogram: hist.Histogram = hist.createHistogram();
  readonly latencyHistogram: hist.Histogram = hist.createHistogram();

  constructor(
    readonly name: string,
    readonly direction: Direction,
    readonly namespace: string,
  ) {}

  add(event: MessageEvent): void {
    this.count++;
    this.bytesTotal += event.bytes;
    if (event.bytes > this.bytesMax) this.bytesMax = event.bytes;
    hist.record(this.bytesHistogram, event.bytes);

    if (event.latencyMs !== undefined && Number.isFinite(event.latencyMs)) {
      this.latencyCount++;
      this.latencyTotal += event.latencyMs;
      if (event.latencyMs > this.latencyMax) this.latencyMax = event.latencyMs;
      hist.record(this.latencyHistogram, event.latencyMs);
    }

    if (this.firstSeen === 0 || event.timestamp < this.firstSeen) this.firstSeen = event.timestamp;
    if (event.timestamp > this.lastSeen) this.lastSeen = event.timestamp;
  }

  toStats(): MessageStats {
    return {
      name: this.name,
      direction: this.direction,
      namespace: this.namespace,
      count: this.count,
      totalBytes: this.bytesTotal,
      firstSeen: this.firstSeen,
      lastSeen: this.lastSeen,
      bytes: distributionOf(this.count, this.bytesTotal, this.bytesMax, this.bytesHistogram),
      latency:
        this.latencyCount > 0
          ? distributionOf(this.latencyCount, this.latencyTotal, this.latencyMax, this.latencyHistogram)
          : null,
    };
  }

  /** Everything a detail view needs except what only a store keeps: history and examples. */
  toDetail(): Omit<MessageDetail, 'timeline' | 'samples'> {
    return {
      ...this.toStats(),
      bytesHistogram: hist.toBuckets(this.bytesHistogram),
      latencyHistogram: hist.toBuckets(this.latencyHistogram),
    };
  }

  /**
   * Fold another aggregator into this one. Summing counters and adding histogram buckets
   * is what makes a time window out of a handful of one-minute slices.
   */
  merge(other: StatsAggregator): void {
    if (other.count === 0 && other.latencyCount === 0) return;

    this.count += other.count;
    this.bytesTotal += other.bytesTotal;
    if (other.bytesMax > this.bytesMax) this.bytesMax = other.bytesMax;
    hist.merge(this.bytesHistogram, other.bytesHistogram);

    this.latencyCount += other.latencyCount;
    this.latencyTotal += other.latencyTotal;
    if (other.latencyMax > this.latencyMax) this.latencyMax = other.latencyMax;
    hist.merge(this.latencyHistogram, other.latencyHistogram);

    if (other.firstSeen > 0 && (this.firstSeen === 0 || other.firstSeen < this.firstSeen)) {
      this.firstSeen = other.firstSeen;
    }
    if (other.lastSeen > this.lastSeen) this.lastSeen = other.lastSeen;
  }

  get isEmpty(): boolean {
    return this.count === 0;
  }

  reset(): void {
    this.count = 0;
    this.bytesTotal = 0;
    this.bytesMax = 0;
    this.latencyCount = 0;
    this.latencyTotal = 0;
    this.latencyMax = 0;
    this.firstSeen = 0;
    this.lastSeen = 0;
    this.bytesHistogram.clear();
    this.latencyHistogram.clear();
  }
}
