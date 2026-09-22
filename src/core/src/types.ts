/**
 * Direction of a message, from the point of view of the server running the collector.
 * - `in`  : received from a client
 * - `out` : sent to a client (including acknowledgement replies)
 */
export type Direction = 'in' | 'out';

/** A single observed message. This is the only thing collectors hand over to a store. */
export interface MessageEvent {
  /** Message type, e.g. `chat:send`. Falls back to `<unnamed>` when it cannot be determined. */
  name: string;
  direction: Direction;
  /** Size of the serialized payload, in bytes. */
  bytes: number;
  /**
   * How many client sockets this message was written to. Defaults to `1`, and `0` means it
   * was emitted into the void: a broadcast to a room nobody is in costs no bandwidth at all.
   *
   * This is what was handed to the transport, not a proof of reception: only an
   * acknowledgement proves that, and it shows up as a `latencyMs` of its own.
   */
  recipients?: number;
  /** Round-trip time in milliseconds. Only set when it could be measured (socket.io ack, manual timer). */
  latencyMs?: number;
  /** Unix epoch in milliseconds. */
  timestamp: number;
  /** socket.io namespace, WebSocket path, or any grouping key. Defaults to `/`. */
  namespace: string;
  /**
   * Truncated copy of the payload, kept only by the top lists so you can see what was
   * actually inside a heavy or slow message. Absent when payload capture is off.
   */
  sample?: string;
}

/** Everything a collector may provide; `timestamp` and `namespace` get defaults. */
export type MessageEventInput = Omit<MessageEvent, 'timestamp' | 'namespace'> &
  Partial<Pick<MessageEvent, 'timestamp' | 'namespace'>>;

/** Summary of a set of values (payload sizes or latencies). Percentiles come from a histogram. */
export interface Distribution {
  /** Number of values recorded. */
  count: number;
  /** Sum of all values. For payload sizes this is the total bandwidth. */
  total: number;
  avg: number;
  /** Median. */
  p50: number;
  p95: number;
  p99: number;
  /** Exact maximum (not an histogram estimate). */
  max: number;
}

/** Aggregated stats for one message name, in one direction, in one namespace. */
export interface MessageStats {
  name: string;
  direction: Direction;
  namespace: string;
  /** Number of messages seen. One broadcast counts once, whoever received it. */
  count: number;
  /** Total bytes of the payloads, counted once per message. */
  totalBytes: number;
  /** Number of copies sent: every message summed over its recipients. */
  sentCount: number;
  /** Bytes actually pushed to clients: every payload multiplied by its recipients. */
  sentBytes: number;
  firstSeen: number;
  lastSeen: number;
  bytes: Distribution;
  /** `null` when no latency could ever be measured for this message. */
  latency: Distribution | null;
}

/** One histogram bar, as consumed by the UI. Empty buckets are omitted. */
export interface HistogramBucket {
  /** Inclusive lower bound. */
  from: number;
  /** Exclusive upper bound. */
  to: number;
  count: number;
}

/** One time bucket of a message's history. Empty buckets are reported with `count: 0`. */
export interface TimelineBucket {
  /** Start of the bucket, and the instant it ends. */
  from: number;
  to: number;
  count: number;
  bytes: number;
  /** Same two numbers, counted per recipient rather than per message. */
  sentCount: number;
  sentBytes: number;
}

/** `MessageStats` plus the raw distributions and the history, for the detail view. */
export interface MessageDetail extends MessageStats {
  bytesHistogram: HistogramBucket[];
  latencyHistogram: HistogramBucket[];
  /** How many of this message per time bucket, oldest first. The last one is still filling up. */
  timeline: TimelineBucket[];
  /**
   * The biggest payloads ever seen for this message, heaviest first: a few real examples
   * of what it carries. Kept for every message, whatever the global top lists hold, and
   * always over the whole history rather than the selected period.
   */
  samples: TopEntry[];
}

/** A single message kept in a "top 10" list. */
export interface TopEntry {
  name: string;
  direction: Direction;
  namespace: string;
  bytes: number;
  latencyMs?: number;
  timestamp: number;
  /** How many clients this one was sent to. Absent when it is not known, meaning one. */
  recipients?: number;
  /** Truncated payload, when the collector was allowed to capture one. */
  sample?: string;
}

export type TopKind = 'slowest' | 'heaviest';

export type SortKey = 'count' | 'bandwidth' | 'bytes' | 'latency' | 'name';

/** Restricts a query to a period, by window key (`5m`, `1h`, `24h`, `all`…). */
export interface WindowOptions {
  /** A key from `WINDOWS`. Defaults to `all`, the whole history. */
  window?: string;
}

export interface ListMessagesOptions extends WindowOptions {
  /**
   * - `count`     : most frequent first
   * - `bandwidth` : biggest total bytes first
   * - `bytes`     : biggest median payload first
   * - `latency`   : biggest median latency first
   */
  sort?: SortKey;
  direction?: Direction;
  namespace?: string;
  limit?: number;
}

export interface MessageStatsOptions extends WindowOptions {
  direction?: Direction;
}

export interface TopOptions extends WindowOptions {
  limit?: number;
}

/** The period a set of numbers actually covers. */
export interface WindowRange {
  key: string;
  label: string;
  /** Start and end of the covered period. Buckets are whole, so this is rounded out. */
  from: number;
  to: number;
  /** Size of one bucket; the newest one is still filling up. */
  resolutionMs: number;
}

/** Totals for one direction, counted both per message and per recipient. */
export interface DirectionTotals {
  count: number;
  bytes: number;
  sentCount: number;
  sentBytes: number;
}

export interface Overview {
  totalMessages: number;
  totalBytes: number;
  /** The same two totals counted per recipient: what was really pushed to the clients. */
  totalSent: number;
  totalSentBytes: number;
  /** Number of distinct (namespace, direction, name) series being tracked. */
  messageTypes: number;
  in: DirectionTotals;
  out: DirectionTotals;
  /** Timestamp of the first and last message in the window, or `null` when empty. */
  firstSeen: number | null;
  lastSeen: number | null;
  /** The period these numbers cover. `null` when they cover the whole history. */
  window: WindowRange | null;
  /**
   * Every message type summed per time bucket, oldest first: the shape of the traffic
   * over the period. Empty buckets are kept, so a chart shows the quiet moments. The
   * whole history falls back to the coarsest period a store keeps.
   */
  timeline: TimelineBucket[];
}

/**
 * Write side of a store. This is all a collector needs.
 *
 * `record` is fire-and-forget: collectors never await it, so an implementation must
 * never throw synchronously and should buffer rather than block the host app.
 */
export interface StoreWriterInterface {
  record(event: MessageEvent): void;
  /** Push anything buffered. Optional: in-memory stores have nothing to flush. */
  flush?(): Promise<void>;
  /** Release resources (timers, connections). Should flush first. */
  close?(): Promise<void>;
}

/** Read side of a store, used by the dashboard API. Cloud-forwarding stores do not implement it. */
export interface StoreReaderInterface {
  getOverview(options?: WindowOptions): Promise<Overview>;
  listMessages(options?: ListMessagesOptions): Promise<MessageStats[]>;
  /** One entry per direction (and namespace) the message was seen in. Empty when unknown. */
  getMessageStats(name: string, options?: MessageStatsOptions): Promise<MessageDetail[]>;
  getTop(kind: TopKind, options?: TopOptions): Promise<TopEntry[]>;
  /** Periods this store can answer for. Defaults to the whole history only. */
  getWindows?(): Promise<WindowRange[] | string[]>;
  /** Drop everything. Optional. */
  reset?(): Promise<void>;
}

/** A store that can both collect and serve data (memory, redis). */
export interface StoreInterface extends StoreWriterInterface, StoreReaderInterface {}
