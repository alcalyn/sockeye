import {
  Collector,
  monotonicNow,
  type CollectorOptions,
  type Direction,
  type StoreWriterInterface,
} from '@sockeye-js/core';

export type { CollectorOptions } from '@sockeye-js/core';

export interface RecordOptions {
  /** Defaults to `in`. */
  direction?: Direction;
  /** Override the measured payload size, when you already know the frame size. */
  bytes?: number;
  /** Override the collector namespace for this message. */
  namespace?: string;
  /** Attach a response time you measured yourself. */
  latencyMs?: number;
}

/** Handle returned by {@link SocketMonitor.start}, used to close the timing window. */
export interface PendingMessage {
  /**
   * Record the reply and the time elapsed since `start()`.
   * Passing the response payload also records its size as an outgoing message.
   */
  end(responsePayload?: unknown, options?: Omit<RecordOptions, 'direction' | 'latencyMs'>): void;
  /** Give up on timing this message. The incoming message stays recorded. */
  cancel(): void;
  /** Milliseconds elapsed so far. */
  elapsed(): number;
}

/**
 * The lowest-level collector: you call it, so it works with the browser-style `WebSocket`
 * API, a raw TCP protocol, or anything else sockeye does not know about.
 *
 * ```ts
 * const monitor = createMonitor(store);
 * monitor.received('chat:send', payload);
 *
 * const pending = monitor.start('chat:send', payload);
 * const answer = await handle(payload);
 * pending.end(answer); // records the response size and the response time
 * ```
 */
export class SocketMonitor {
  private readonly collector: Collector;

  constructor(store: StoreWriterInterface, options: CollectorOptions = {}) {
    this.collector = new Collector(store, options);
  }

  /** Record one message. */
  record(name: string, payload?: unknown, options: RecordOptions = {}): void {
    const described = this.collector.describeOne(payload, name);
    this.collector.record({
      name,
      direction: options.direction ?? 'in',
      bytes: options.bytes ?? described.bytes,
      ...(described.sample !== undefined ? { sample: described.sample } : {}),
      ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
      ...(options.latencyMs !== undefined ? { latencyMs: options.latencyMs } : {}),
    });
  }

  /** Record a message received from a client. */
  received(name: string, payload?: unknown, options: Omit<RecordOptions, 'direction'> = {}): void {
    this.record(name, payload, { ...options, direction: 'in' });
  }

  /** Record a message sent to a client. */
  sent(name: string, payload?: unknown, options: Omit<RecordOptions, 'direction'> = {}): void {
    this.record(name, payload, { ...options, direction: 'out' });
  }

  /**
   * Record an incoming message and start timing the reply.
   *
   * The incoming message is recorded immediately, so it is never lost if the reply never
   * comes. The response time is attached to the outgoing reply, exactly like a socket.io ack.
   */
  start(name: string, payload?: unknown, options: Omit<RecordOptions, 'direction' | 'latencyMs'> = {}): PendingMessage {
    this.received(name, payload, options);

    const startedAt = monotonicNow();
    let done = false;

    return {
      elapsed: () => monotonicNow() - startedAt,
      cancel: () => {
        done = true;
      },
      end: (responsePayload?: unknown, endOptions: Omit<RecordOptions, 'direction' | 'latencyMs'> = {}) => {
        if (done) return;
        done = true;
        this.sent(name, responsePayload, {
          ...options,
          ...endOptions,
          latencyMs: monotonicNow() - startedAt,
        });
      },
    };
  }

  /** Measure a payload the way the collector would, without recording anything. */
  size(payload: unknown): number {
    return this.collector.measure(payload);
  }
}

/** Convenience factory: `const monitor = createMonitor(store)`. */
export function createMonitor(store: StoreWriterInterface, options?: CollectorOptions): SocketMonitor {
  return new SocketMonitor(store, options);
}
