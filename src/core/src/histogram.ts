/**
 * Fixed-layout log-linear histogram, stored sparsely.
 *
 * Values below {@link LINEAR_LIMIT} land in buckets of width 1 (so small latencies and
 * payload sizes are recorded exactly). Above that, each power of two is split into
 * {@link SUB_BUCKETS} buckets of equal width, which keeps the relative error below
 * ~1.6% when a quantile is read back as the middle of its bucket.
 *
 * The layout is a pure function of the value, identical in every process, which is what
 * lets several servers write into the same Redis counters, and lets two histograms be
 * merged by simply adding their buckets, which is how time windows are computed.
 *
 * Only the buckets that were actually hit are stored: a message type usually touches a
 * few dozen of them, so a one-minute slice costs a few hundred bytes rather than 4 kB.
 */

/** Number of sub-buckets per power of two. */
export const SUB_BUCKETS = 32;
/** Below this value, buckets are exactly 1 unit wide. */
export const LINEAR_LIMIT = SUB_BUCKETS;
const LINEAR_EXP = Math.log2(LINEAR_LIMIT); // 5
/** Values above 2^MAX_EXP are clamped into the last bucket (~4 GB, or ~50 days in ms). */
const MAX_EXP = 32;

export const BUCKET_COUNT = LINEAR_LIMIT + (MAX_EXP - LINEAR_EXP + 1) * SUB_BUCKETS;

/** Bucket index to number of values recorded in it. */
export type Histogram = Map<number, number>;

/** Anything a quantile can be read from: a sparse histogram or a dense bucket array. */
export type Counts = Histogram | number[] | Uint32Array;

export function createHistogram(): Histogram {
  return new Map();
}

/** Index of the bucket holding `value`. Negative values and NaN land in bucket 0. */
export function bucketIndex(value: number): number {
  if (!(value > 0)) return 0;
  if (value < LINEAR_LIMIT) return Math.floor(value);

  const exp = Math.floor(Math.log2(value));
  if (exp > MAX_EXP) return BUCKET_COUNT - 1;

  // `value / 2^exp` is in [1, 2), so `sub` is in [0, SUB_BUCKETS).
  const sub = Math.floor((value / 2 ** exp) * SUB_BUCKETS) - SUB_BUCKETS;
  return LINEAR_LIMIT + (exp - LINEAR_EXP) * SUB_BUCKETS + sub;
}

/** Inclusive lower bound and exclusive upper bound of a bucket. */
export function bucketBounds(index: number): { from: number; to: number } {
  if (index < LINEAR_LIMIT) return { from: index, to: index + 1 };

  const offset = index - LINEAR_LIMIT;
  const exp = LINEAR_EXP + Math.floor(offset / SUB_BUCKETS);
  const sub = offset % SUB_BUCKETS;
  const width = 2 ** exp / SUB_BUCKETS;
  const from = 2 ** exp + sub * width;
  return { from, to: from + width };
}

/** Value reported for a quantile falling in this bucket: exact below the linear limit, midpoint above. */
function bucketValue(index: number): number {
  if (index < LINEAR_LIMIT) return index;
  const { from, to } = bucketBounds(index);
  return Math.round((from + to) / 2);
}

export function record(counts: Histogram, value: number): void {
  const index = bucketIndex(value);
  counts.set(index, (counts.get(index) ?? 0) + 1);
}

/** Add `source` into `target`, in place. This is how time slices are combined. */
export function merge(target: Histogram, source: Counts): void {
  for (const [index, count] of entriesOf(source)) {
    target.set(index, (target.get(index) ?? 0) + count);
  }
}

/** Non-empty buckets, lowest first. */
function entriesOf(counts: Counts): Array<[number, number]> {
  if (counts instanceof Map) {
    return [...counts.entries()].filter(([, count]) => count > 0).sort((a, b) => a[0] - b[0]);
  }

  const out: Array<[number, number]> = [];
  for (let index = 0; index < counts.length; index++) {
    const count = counts[index];
    if (count > 0) out.push([index, count]);
  }
  return out;
}

/** Number of values recorded. */
export function totalOf(counts: Counts): number {
  let total = 0;
  for (const [, count] of entriesOf(counts)) total += count;
  return total;
}

/**
 * Estimate the `q`-th quantile (`q` in [0, 1]) of the recorded values.
 * Returns 0 when nothing was recorded.
 */
export function quantile(counts: Counts, q: number, total?: number): number {
  const entries = entriesOf(counts);
  let n = total;
  if (n === undefined) {
    n = 0;
    for (const [, count] of entries) n += count;
  }
  if (n === 0) return 0;

  // Rank of the wanted value, 1-based, using the nearest-rank definition.
  const rank = Math.max(1, Math.ceil(q * n));
  let seen = 0;
  for (const [index, count] of entries) {
    seen += count;
    if (seen >= rank) return bucketValue(index);
  }

  const last = entries[entries.length - 1];
  return last ? bucketValue(last[0]) : 0;
}

/** Non-empty buckets, ready to be drawn as bars. */
export function toBuckets(counts: Counts): Array<{ from: number; to: number; count: number }> {
  return entriesOf(counts).map(([index, count]) => ({ ...bucketBounds(index), count }));
}
