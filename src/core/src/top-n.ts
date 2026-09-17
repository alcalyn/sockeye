/**
 * Bounded list of the highest-scoring items seen so far.
 *
 * Unlike the histograms, this keeps the actual events, so the "top 10 slowest" are exact
 * samples and not estimates. `limit` is small (10 by default) so the sorted insert is cheap.
 */
export class TopN<T> {
  private readonly entries: T[] = [];

  constructor(
    private readonly limit: number,
    private readonly score: (item: T) => number,
  ) {}

  push(item: T): void {
    const value = this.score(item);
    if (!Number.isFinite(value)) return;

    if (this.entries.length >= this.limit) {
      const last = this.entries[this.entries.length - 1];
      if (last !== undefined && value <= this.score(last)) return;
      this.entries.pop();
    }

    let i = this.entries.length;
    while (i > 0 && this.score(this.entries[i - 1]) < value) {
      this.entries[i] = this.entries[i - 1];
      i--;
    }
    this.entries[i] = item;
  }

  /** Highest score first. */
  items(limit = this.limit): T[] {
    return this.entries.slice(0, limit);
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }
}
