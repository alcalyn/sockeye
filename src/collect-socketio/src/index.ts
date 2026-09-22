import {
  Collector,
  UNNAMED,
  monotonicNow,
  type CollectorOptions,
  type StoreWriterInterface,
} from '@sockeye-js/core';

/**
 * Structural shapes of the socket.io objects we touch. Typed here rather than imported,
 * so installing this package never forces a socket.io version on you.
 */
export interface SocketLike {
  nsp?: { name?: string; adapter?: AdapterLike };
  use(fn: (event: any[], next: (err?: Error) => void) => void): unknown;
  emit(event: string, ...args: any[]): any;
}

export interface AdapterLike {
  broadcast(packet: any, opts: any): void;
  broadcastWithAck?(packet: any, opts: any, ...rest: any[]): void;
  /** How socket.io itself picks the recipients of a broadcast. */
  apply?(opts: any, callback: (socket: any) => void): void;
  /** Sockets per room, used for the O(1) shortcut. */
  rooms?: Map<string, Set<string>>;
}

export interface ServerLike {
  use(fn: (socket: any, next: (err?: Error) => void) => void): unknown;
  of?(name: any): { use(fn: (socket: any, next: (err?: Error) => void) => void): unknown };
  _nsps?: Map<string, any>;
}

export interface SocketIoMonitorOptions extends CollectorOptions {
  /**
   * Also measure broadcasts (`io.emit`, `socket.broadcast.emit`, `socket.to(room).emit`).
   * A broadcast counts as one message, and as one recipient per client it reaches.
   * Defaults to `true`.
   */
  broadcasts?: boolean;
  /**
   * Count how many clients each broadcast is actually sent to, so the dashboard can show
   * the bandwidth it really costs rather than one payload per call. Defaults to `true`.
   *
   * Counting walks the target room once more than socket.io already does (no I/O). Turn it
   * off if you broadcast to huge rooms and would rather not pay for that walk: every
   * message then counts as one recipient.
   */
  countRecipients?: boolean;
}

/** socket.io-parser packet types that carry an application event. */
const EVENT = 2;
const BINARY_EVENT = 5;

/**
 * socket.io middleware measuring every event of every connected socket.
 *
 * ```ts
 * io.use(sockeye(store));
 * ```
 *
 * What gets recorded:
 * - every incoming event, as `in`, with its payload size;
 * - every outgoing event, as `out`, with its payload size and how many clients it went to;
 * - when an event is acknowledged, the reply is recorded with `latencyMs` set to the
 *   round-trip time. Response times therefore live on the `out` side of a message.
 */
export function sockeye(
  store: StoreWriterInterface,
  options: SocketIoMonitorOptions = {},
): (socket: any, next: (err?: Error) => void) => void {
  const collector = new Collector(store, options);
  const withBroadcasts = options.broadcasts ?? true;
  const countRecipients = options.countRecipients ?? true;
  // Scoped to this middleware: installing it twice counts once, while a second, separate
  // monitor (a different store) still gets its own measurements.
  const seenSockets = new WeakSet<object>();
  const seenAdapters = new WeakSet<object>();

  return function sockeyeMiddleware(socket: SocketLike, next: (err?: Error) => void): void {
    collector.guard(() => {
      // Installing the middleware twice (e.g. on the server and on a namespace) must not
      // double-count anything.
      if (seenSockets.has(socket)) return;
      seenSockets.add(socket);

      const namespace = socket.nsp?.name ?? options.namespace ?? '/';
      instrumentIncoming(socket, collector, namespace);
      instrumentOutgoing(socket, collector, namespace);
      if (withBroadcasts) {
        instrumentAdapter(socket.nsp?.adapter, collector, namespace, seenAdapters, countRecipients);
      }
    });
    next();
  };
}

function instrumentIncoming(socket: SocketLike, collector: Collector, namespace: string): void {
  socket.use((packet: any[], next: (err?: Error) => void) => {
    collector.guard(() => {
      const name = typeof packet[0] === 'string' ? packet[0] : UNNAMED;
      const args = packet.slice(1);

      collector.record({ name, direction: 'in', ...collector.describe(args, name), namespace });

      // socket.io appends the acknowledgement callback to the packet before middlewares run,
      // so replacing it here is what lets us time the reply the client actually waits for.
      const lastIndex = packet.length - 1;
      const ack = packet[lastIndex];
      if (lastIndex > 0 && typeof ack === 'function') {
        const startedAt = monotonicNow();
        let acked = false;

        packet[lastIndex] = function monitoredAck(this: unknown, ...response: any[]) {
          if (!acked) {
            acked = true;
            collector.record({
              name,
              direction: 'out',
              ...collector.describe(response, name),
              latencyMs: monotonicNow() - startedAt,
              namespace,
            });
          }
          return ack.apply(this, response);
        };
      }
    });

    next();
  });
}

function instrumentOutgoing(socket: SocketLike, collector: Collector, namespace: string): void {
  const originalEmit = socket.emit.bind(socket);

  socket.emit = function monitoredEmit(event: string, ...args: any[]): any {
    collector.guard(() => {
      const eventName = typeof event === 'string' ? event : UNNAMED;
      collector.record({
        name: eventName,
        direction: 'out',
        ...collector.describe(args, eventName),
        recipients: 1,
        namespace,
      });

      // The server asked the client to acknowledge: time that round-trip too.
      const lastIndex = args.length - 1;
      const ack = args[lastIndex];
      if (lastIndex >= 0 && typeof ack === 'function') {
        const startedAt = monotonicNow();
        let acked = false;

        args[lastIndex] = function monitoredAck(this: unknown, ...response: any[]) {
          if (!acked) {
            acked = true;
            collector.record({
              name: typeof event === 'string' ? event : UNNAMED,
              direction: 'in',
              ...collector.describe(response, eventName),
              latencyMs: monotonicNow() - startedAt,
              namespace,
            });
          }
          return ack.apply(this, response);
        };
      }
    });

    return originalEmit(event, ...args);
  };
}

/**
 * How many clients a broadcast is about to be written to, or `undefined` when the adapter
 * cannot tell.
 *
 * `apply` is the very function socket.io uses to pick the recipients of a broadcast, so
 * asking it is what makes the count right for a union of rooms, for `except`, for `io.emit`
 * with no room at all, and for sids whose socket is already gone. It is called here for its
 * count only, which costs one extra walk of the room and no I/O.
 *
 * With a clustered adapter (Redis & co) this counts the sockets held by *this* node, which
 * is exactly the bandwidth this node pays for.
 */
function recipientsOf(adapter: AdapterLike, opts: any): number | undefined {
  const rooms: Set<string> | undefined = opts?.rooms;
  const except: Set<string> | undefined = opts?.except;

  // One room, nobody excluded: the adapter already knows the answer, no walk needed.
  // A socket that is disconnecting may still be listed for a moment, which is close enough.
  if (rooms?.size === 1 && !except?.size && adapter.rooms) {
    const [room] = rooms;
    return adapter.rooms.get(room)?.size ?? 0;
  }

  if (typeof adapter.apply !== 'function') return undefined;

  let recipients = 0;
  adapter.apply(opts, () => {
    recipients++;
  });
  return recipients;
}

/**
 * Broadcasts never go through `socket.emit`: they are handed straight to the namespace
 * adapter. Wrapping it once per namespace is what catches `io.emit`, `socket.broadcast.emit`
 * and `socket.to(room).emit` with a single integration point.
 */
function instrumentAdapter(
  adapter: AdapterLike | undefined,
  collector: Collector,
  namespace: string,
  seen: WeakSet<object>,
  countRecipients: boolean,
): void {
  if (!adapter || typeof adapter.broadcast !== 'function') return;
  if (seen.has(adapter)) return;
  seen.add(adapter);

  const recordPacket = (packet: any, opts: any): void => {
    collector.guard(() => {
      if (!packet || (packet.type !== EVENT && packet.type !== BINARY_EVENT)) return;
      const data = packet.data;
      if (!Array.isArray(data) || data.length === 0) return;

      const recipients = countRecipients
        ? collector.guard(() => recipientsOf(adapter, opts))
        : undefined;

      const name = typeof data[0] === 'string' ? data[0] : UNNAMED;
      collector.record({
        name,
        direction: 'out',
        ...collector.describe(data.slice(1), name),
        ...(recipients !== undefined ? { recipients } : {}),
        namespace: packet.nsp ?? namespace,
      });
    });
  };

  const originalBroadcast = adapter.broadcast.bind(adapter);
  adapter.broadcast = function monitoredBroadcast(packet: any, opts: any): void {
    recordPacket(packet, opts);
    return originalBroadcast(packet, opts);
  };

  if (typeof adapter.broadcastWithAck === 'function') {
    const originalBroadcastWithAck = adapter.broadcastWithAck.bind(adapter);
    adapter.broadcastWithAck = function monitoredBroadcastWithAck(packet: any, opts: any, ...rest: any[]): void {
      recordPacket(packet, opts);
      return originalBroadcastWithAck(packet, opts, ...rest);
    };
  }
}

/**
 * Install the monitor on a whole socket.io server: the main namespace, the namespaces that
 * already exist, and the ones created later through `io.of()`.
 *
 * `io.use(sockeye(store))` is enough when you only use the default namespace.
 */
export function monitorSocketIo(
  io: ServerLike,
  store: StoreWriterInterface,
  options: SocketIoMonitorOptions = {},
): void {
  const middleware = sockeye(store, options);
  const instrumented = new WeakSet<object>();

  io.use(middleware);

  const existing = io._nsps;
  if (existing instanceof Map) {
    for (const [name, nsp] of existing) {
      if (!nsp) continue;
      // The main namespace is already covered by `io.use` above.
      instrumented.add(nsp);
      if (name !== '/' && typeof nsp.use === 'function') nsp.use(middleware);
    }
  }

  const originalOf = io.of;
  if (typeof originalOf === 'function') {
    io.of = function monitoredOf(this: ServerLike, ...args: any[]) {
      const nsp = (originalOf as any).apply(this, args);
      try {
        if (nsp && typeof nsp.use === 'function' && !instrumented.has(nsp)) {
          instrumented.add(nsp);
          nsp.use(middleware);
        }
      } catch {
        // Never break namespace creation because of monitoring.
      }
      return nsp;
    } as ServerLike['of'];
  }
}
