import { describe, expect, it } from 'vitest';
import * as hist from '../src/histogram.js';

/** Exact quantile, to compare the histogram estimate against. */
function exactQuantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1];
}

function relativeError(estimate: number, exact: number): number {
  if (exact === 0) return estimate === 0 ? 0 : 1;
  return Math.abs(estimate - exact) / exact;
}

describe('histogram', () => {
  it('keeps buckets ordered and contiguous', () => {
    let previous = hist.bucketBounds(0);
    expect(previous.from).toBe(0);

    for (let i = 1; i < hist.BUCKET_COUNT; i++) {
      const bounds = hist.bucketBounds(i);
      expect(bounds.from).toBe(previous.to);
      expect(bounds.to).toBeGreaterThan(bounds.from);
      previous = bounds;
    }
  });

  it('maps every value into the bucket that contains it', () => {
    const values = [0, 1, 7, 31, 32, 33, 63, 64, 100, 1023, 1024, 1e5, 1e6, 12345678];
    for (const value of values) {
      const index = hist.bucketIndex(value);
      const { from, to } = hist.bucketBounds(index);
      expect(value, `value ${value}`).toBeGreaterThanOrEqual(from);
      expect(value, `value ${value}`).toBeLessThan(to);
    }
  });

  it('is exact below the linear limit', () => {
    const counts = hist.createHistogram();
    for (let value = 0; value < hist.LINEAR_LIMIT; value++) {
      for (let n = 0; n < 10; n++) hist.record(counts, value);
    }
    expect(hist.quantile(counts, 0.5)).toBe(exactQuantile(
      Array.from({ length: hist.LINEAR_LIMIT * 10 }, (_, i) => Math.floor(i / 10)),
      0.5,
    ));
  });

  it('estimates median and percentiles within 2% on 10k samples', () => {
    // A realistic-ish latency distribution: a fast bulk plus a slow tail.
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    const values: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      values.push(random() < 0.9 ? 20 + random() * 200 : 500 + random() * 4500);
    }

    const counts = hist.createHistogram();
    for (const value of values) hist.record(counts, value);

    for (const q of [0.5, 0.95, 0.99]) {
      const exact = exactQuantile(values, q);
      const estimate = hist.quantile(counts, q, values.length);
      expect(relativeError(estimate, exact), `q=${q} exact=${exact} got=${estimate}`).toBeLessThan(0.02);
    }
  });

  it('stays accurate on payload sizes spanning several orders of magnitude', () => {
    const values: number[] = [];
    for (let i = 0; i < 5000; i++) values.push(Math.round(10 ** (1 + (i % 60) / 10)));

    const counts = hist.createHistogram();
    for (const value of values) hist.record(counts, value);

    for (const q of [0.25, 0.5, 0.9, 0.99]) {
      const exact = exactQuantile(values, q);
      const estimate = hist.quantile(counts, q, values.length);
      expect(relativeError(estimate, exact), `q=${q} exact=${exact} got=${estimate}`).toBeLessThan(0.02);
    }
  });

  it('returns 0 when nothing was recorded', () => {
    expect(hist.quantile(hist.createHistogram(), 0.5)).toBe(0);
  });

  it('clamps huge values into the last bucket instead of overflowing', () => {
    const counts = hist.createHistogram();
    hist.record(counts, Number.MAX_SAFE_INTEGER);
    expect(hist.toBuckets(counts)).toHaveLength(1);
  });

  it('only reports non-empty buckets', () => {
    const counts = hist.createHistogram();
    hist.record(counts, 5);
    hist.record(counts, 5);
    hist.record(counts, 900);

    const buckets = hist.toBuckets(counts);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ from: 5, to: 6, count: 2 });
    expect(buckets[1].count).toBe(1);
  });
});
