import { DEFAULT_SAMPLE_CHARS, describeArgs, measureSize } from './size.js';
import type { Direction, MessageEvent, MessageEventInput, StoreWriterInterface } from './types.js';

/** Name given to a message whose type could not be determined. */
export const UNNAMED = '<unnamed>';

export interface CollectorOptions {
  /** Grouping key for every event of this collector. Defaults to `/`. */
  namespace?: string;
  /** Message names to skip entirely, or a predicate. */
  ignore?: string[] | ((name: string, direction: Direction) => boolean);
  /** Replace the payload size measurement, e.g. to avoid stringifying large objects. */
  sizeOf?: (payload: unknown) => number;
  /**
   * Keep a truncated copy of the payload on the messages that reach the top 10 lists, so
   * you can see what a heavy or slow message actually contained.
   *
   * `true` (the default) keeps the first 1024 characters, a number sets that length, and
   * `false` captures nothing. Turn it off, or use {@link CollectorOptions.redactSample},
   * when messages carry data you would rather not show on a dashboard.
   */
  capturePayload?: boolean | number;
  /** Rewrite a captured payload before it is stored, e.g. to strip a token. */
  redactSample?: (sample: string, name: string) => string;
  /** Called when the collector itself fails. Defaults to a `console.warn`. */
  onError?: (error: unknown) => void;
  /** Clock override, for tests. */
  now?: () => number;
}

function defaultOnError(error: unknown): void {
  // A monitoring library must never take the app down with it.
  console.warn('[sockeye] collector error:', error);
}

/**
 * Shared plumbing for every collector: default values, name filtering, payload measurement
 * and, most importantly, error isolation. Nothing thrown in here ever reaches the host app.
 */
export class Collector {
  private readonly namespace: string;
  private readonly onError: (error: unknown) => void;
  private readonly now: () => number;
  private readonly sizeOf: (payload: unknown) => number;
  private readonly ignored: (name: string, direction: Direction) => boolean;
  private readonly sampleChars: number;
  private readonly redactSample: ((sample: string, name: string) => string) | undefined;

  constructor(
    private readonly store: StoreWriterInterface,
    options: CollectorOptions = {},
  ) {
    if (!store || typeof store.record !== 'function') {
      throw new TypeError('[sockeye] a store implementing StoreWriterInterface is required');
    }
    this.namespace = options.namespace ?? '/';
    this.onError = options.onError ?? defaultOnError;
    this.now = options.now ?? Date.now;
    this.sizeOf = options.sizeOf ?? measureSize;
    this.redactSample = options.redactSample;

    const capture = options.capturePayload ?? true;
    this.sampleChars =
      capture === false ? 0 : capture === true ? DEFAULT_SAMPLE_CHARS : Math.max(0, capture);

    const { ignore } = options;
    if (typeof ignore === 'function') {
      this.ignored = ignore;
    } else if (Array.isArray(ignore) && ignore.length > 0) {
      const set = new Set(ignore);
      this.ignored = (name) => set.has(name);
    } else {
      this.ignored = () => false;
    }
  }

  /** Measure a payload with the configured sizer, never throwing. */
  measure(payload: unknown): number {
    try {
      return this.sizeOf(payload);
    } catch (error) {
      this.onError(error);
      return 0;
    }
  }

  /** Sum the sizes of an argument list, skipping callbacks. */
  measureAll(args: readonly unknown[]): number {
    let total = 0;
    for (const arg of args) {
      if (typeof arg === 'function') continue;
      total += this.measure(arg);
    }
    return total;
  }

  /**
   * Measure an argument list and capture a preview of it in the same pass.
   *
   * Falls back to {@link Collector.measureAll} when payload capture is off, or when a
   * custom `sizeOf` is in play: that one decides what a payload weighs.
   */
  describe(args: readonly unknown[], name = ''): { bytes: number; sample?: string } {
    if (this.sampleChars === 0 || this.sizeOf !== measureSize) {
      return { bytes: this.measureAll(args) };
    }

    try {
      const { bytes, sample } = describeArgs(args, this.sampleChars);
      if (!sample) return { bytes };
      return { bytes, sample: this.redactSample ? this.redactSample(sample, name) : sample };
    } catch (error) {
      this.onError(error);
      return { bytes: this.measureAll(args) };
    }
  }

  /** Measure a single payload and capture a preview of it. */
  describeOne(payload: unknown, name = ''): { bytes: number; sample?: string } {
    return this.describe([payload], name);
  }

  /**
   * Turn already-decoded text into a stored preview, applying the capture limit and the
   * redaction hook. For collectors that know the frame size on their own.
   */
  sampleOf(text: string | undefined, name = ''): string | undefined {
    if (this.sampleChars === 0 || !text) return undefined;
    try {
      const truncated = text.length > this.sampleChars ? `${text.slice(0, this.sampleChars)}…` : text;
      return this.redactSample ? this.redactSample(truncated, name) : truncated;
    } catch (error) {
      this.onError(error);
      return undefined;
    }
  }

  /** Hand one event over to the store. Fire-and-forget, and never throws. */
  record(input: MessageEventInput): void {
    try {
      const name = input.name || UNNAMED;
      if (this.ignored(name, input.direction)) return;

      const event: MessageEvent = {
        name,
        direction: input.direction,
        bytes: input.bytes,
        timestamp: input.timestamp ?? this.now(),
        namespace: input.namespace ?? this.namespace,
      };
      if (input.latencyMs !== undefined) event.latencyMs = input.latencyMs;
      if (input.sample !== undefined) event.sample = input.sample;

      this.store.record(event);
    } catch (error) {
      this.onError(error);
    }
  }

  /** Current time from the configured clock. */
  clock(): number {
    return this.now();
  }

  /** Run `fn`, swallowing and reporting any error. */
  guard<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (error) {
      this.onError(error);
      return undefined;
    }
  }

  /** Report an error through the configured handler. */
  fail(error: unknown): void {
    this.onError(error);
  }
}

/**
 * Monotonic clock used to measure durations. Unlike `Date.now`, it has sub-millisecond
 * resolution and is immune to system clock adjustments.
 */
export function monotonicNow(): number {
  return performance.now();
}
