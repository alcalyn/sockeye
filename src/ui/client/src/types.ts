export type Direction = 'in' | 'out';

export interface Distribution {
  count: number;
  total: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface MessageStats {
  name: string;
  direction: Direction;
  namespace: string;
  count: number;
  totalBytes: number;
  /** The same two numbers counted once per recipient rather than once per emit. */
  sentCount: number;
  sentBytes: number;
  firstSeen: number;
  lastSeen: number;
  bytes: Distribution;
  latency: Distribution | null;
}

export interface HistogramBucket {
  from: number;
  to: number;
  count: number;
}

/** One time bucket of a message's history. Quiet buckets come back with `count: 0`. */
export interface TimelineBucket {
  from: number;
  to: number;
  count: number;
  bytes: number;
  sentCount: number;
  sentBytes: number;
  /** Response times measured in this bucket. Absent when no reply was measured in it. */
  latency?: Distribution;
}

export interface MessageDetail extends MessageStats {
  bytesHistogram: HistogramBucket[];
  latencyHistogram: HistogramBucket[];
  timeline: TimelineBucket[];
  /** The biggest payloads seen for this message, heaviest first, over the whole history. */
  samples: TopEntry[];
}

export interface TopEntry {
  name: string;
  direction: Direction;
  namespace: string;
  bytes: number;
  latencyMs?: number;
  timestamp: number;
  /** How many clients this one was sent to. Absent means one. */
  recipients?: number;
  /** Truncated payload, when the collector captured one. */
  sample?: string;
}

export interface WindowRange {
  key: string;
  label: string;
  from: number;
  to: number;
  /** Size of one bucket; the newest one is still filling up. */
  resolutionMs: number;
}

/** Totals for one direction, counted both per emit and per recipient. */
export interface DirectionTotals {
  count: number;
  bytes: number;
  sentCount: number;
  sentBytes: number;
}

export interface Overview {
  totalMessages: number;
  totalBytes: number;
  totalSent: number;
  totalSentBytes: number;
  messageTypes: number;
  in: DirectionTotals;
  out: DirectionTotals;
  firstSeen: number | null;
  lastSeen: number | null;
  /** The period these numbers cover. `null` means the whole history. */
  window: WindowRange | null;
  /** Every message type summed per time bucket, oldest first. */
  timeline: TimelineBucket[];
}

export interface Dashboard {
  overview: Overview;
  messages: MessageStats[];
  top: { slowest: TopEntry[]; heaviest: TopEntry[] };
  windows: WindowRange[];
  generatedAt: number;
}

export type SortKey = 'count' | 'bandwidth' | 'bytes' | 'latency' | 'name';
