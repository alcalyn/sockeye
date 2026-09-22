import {
  Collector,
  UNNAMED,
  measureSize,
  type CollectorOptions,
  type StoreWriterInterface,
} from '@sockeye-js/core';

/**
 * Structural shape of a `ws` socket. Typed here rather than imported, so this package
 * never pulls `ws` into your bundle and works with any compatible implementation.
 */
export interface WebSocketLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: any, ...rest: any[]): void;
}

export interface WebSocketServerLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface WsMonitorOptions extends CollectorOptions {
  /**
   * Extract the message type from a frame. `ws` knows nothing about your protocol, so
   * this is how sockeye learns it.
   *
   * Defaults to reading `type`, `event` or `name` out of a JSON frame, and falls back to
   * `<unnamed>` (binary frames become `<binary>`).
   */
  nameOf?: (data: unknown, isBinary: boolean) => string | undefined;
  /** Same thing for outgoing frames. Defaults to `nameOf`. */
  nameOfOutgoing?: (data: unknown) => string | undefined;
  /** Derive the namespace from the upgrade request, e.g. its path. */
  namespaceOf?: (request: any) => string | undefined;
}

/** Name used for frames that are not JSON objects. */
export const BINARY = '<binary>';

/**
 * Sockets already instrumented, per store.
 *
 * Attaching the monitor twice (on the server and on a sub-protocol handler, say) is a
 * realistic mistake, and without this guard every message would silently be counted twice.
 * Keying on the store is what still lets a second, separate monitor take its own
 * measurements of the same socket.
 */
const instrumented = new WeakMap<StoreWriterInterface, WeakSet<object>>();

function alreadyInstrumented(store: StoreWriterInterface, socket: object): boolean {
  let sockets = instrumented.get(store);
  if (!sockets) {
    sockets = new WeakSet<object>();
    instrumented.set(store, sockets);
  }
  if (sockets.has(socket)) return true;
  sockets.add(socket);
  return false;
}

/** Exact size of a frame as received by `ws`, without re-serializing anything. */
function frameSize(data: unknown): number {
  if (Array.isArray(data)) return data.reduce<number>((total, part) => total + frameSize(part), 0);
  return measureSize(data);
}

/** Text of a frame, for the payload preview kept by the top lists. */
function frameText(data: unknown, isBinary: boolean): string | undefined {
  if (isBinary) return `<binary ${frameSize(data)} bytes>`;
  const text = decode(data);
  return text ?? `<binary ${frameSize(data)} bytes>`;
}

/** Decode a frame to text, or `undefined` when it is not text. */
function decode(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (Array.isArray(data)) return Buffer.concat(data.map((part) => Buffer.from(part))).toString('utf8');
  return undefined;
}

function defaultNameOf(data: unknown, isBinary: boolean): string | undefined {
  if (isBinary) return BINARY;

  const text = decode(data);

  if (text === undefined) {
    // Already a decoded object (some setups hand over parsed payloads).
    return pickName(data);
  }

  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return undefined;

  try {
    return pickName(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function pickName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['type', 'event', 'name', 'action']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Instrument a single `ws` socket. Returns the socket, so it can be chained.
 *
 * Use this when you create sockets yourself; otherwise prefer {@link attachWsMonitor}.
 */
export function monitorWsSocket(
  socket: WebSocketLike,
  store: StoreWriterInterface,
  options: WsMonitorOptions = {},
): WebSocketLike {
  if (alreadyInstrumented(store, socket)) return socket;

  const collector = new Collector(store, options);
  const nameOf = options.nameOf ?? defaultNameOf;
  const nameOfOutgoing = options.nameOfOutgoing ?? ((data: unknown) => nameOf(data, false));
  const namespace = options.namespace;

  collector.guard(() => {
    socket.on('message', (data: unknown, isBinary: boolean) => {
      const name = collector.guard(() => nameOf(data, isBinary)) ?? (isBinary ? BINARY : UNNAMED);
      collector.record({
        name,
        direction: 'in',
        bytes: frameSize(data),
        sample: collector.sampleOf(collector.guard(() => frameText(data, isBinary)), name),
        ...(namespace !== undefined ? { namespace } : {}),
      });
    });

    const originalSend = socket.send.bind(socket);
    socket.send = function send(data: any, ...rest: any[]): void {
      const name = collector.guard(() => nameOfOutgoing(data)) ?? UNNAMED;
      // `ws` has no broadcast of its own: fanning out to a room is a loop of `send` in
      // your own code, so every recipient already gets its own measurement here.
      collector.record({
        name,
        direction: 'out',
        bytes: frameSize(data),
        recipients: 1,
        sample: collector.sampleOf(collector.guard(() => frameText(data, false)), name),
        ...(namespace !== undefined ? { namespace } : {}),
      });
      return originalSend(data, ...rest);
    };
  });

  return socket;
}

/**
 * Watch every connection of a `ws` server.
 *
 * ```ts
 * attachWsMonitor(wss, store, { nameOf: (raw) => JSON.parse(String(raw)).type });
 * ```
 *
 * Returns a function that stops monitoring new connections.
 */
export function attachWsMonitor(
  server: WebSocketServerLike,
  store: StoreWriterInterface,
  options: WsMonitorOptions = {},
): () => void {
  const onConnection = (socket: WebSocketLike, request?: unknown): void => {
    const namespace =
      options.namespaceOf && request !== undefined
        ? (() => {
            try {
              return options.namespaceOf?.(request);
            } catch {
              return undefined;
            }
          })()
        : options.namespace;

    monitorWsSocket(socket, store, {
      ...options,
      ...(namespace !== undefined ? { namespace } : {}),
    });
  };

  server.on('connection', onConnection);

  return () => {
    server.off?.('connection', onConnection);
  };
}
