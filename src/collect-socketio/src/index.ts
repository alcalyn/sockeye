import {
  Collector,
  UNNAMED,
  monotonicNow,
  type CollectorOptions,
  type StoreWriterInterface,
} from '@sockeye/core';

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
}

export interface ServerLike {
  use(fn: (socket: any, next: (err?: Error) => void) => void): unknown;
  of?(name: any): { use(fn: (socket: any, next: (err?: Error) => void) => void): unknown };
  _nsps?: Map<string, any>;
}

export interface SocketIoMonitorOptions extends CollectorOptions {
  /**
   * Also measure broadcasts (`io.emit`, `socket.broadcast.emit`, `socket.to(room).emit`).
   * A broadcast counts as one message carrying its payload size, whatever the number of
   * recipients. Defaults to `true`.
   */
  broadcasts?: boolean;
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
 * - every outgoing event, as `out`, with its payload size;
 * - when an event is acknowledged, the reply is recorded with `latencyMs` set to the
 *   round-trip time. Response times therefore live on the `out` side of a message.
 */
export function sockeye(
  store: StoreWriterInterface,
  options: SocketIoMonitorOptions = {},
): (socket: any, next: (err?: Error) => void) => void {
  const collector = new Collector(store, options);
  const withBroadcasts = options.broadcasts ?? true;
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
      if (withBroadcasts) instrumentAdapter(socket.nsp?.adapter, collector, namespace, seenAdapters);
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
 * Broadcasts never go through `socket.emit`: they are handed straight to the namespace
 * adapter. Wrapping it once per namespace is what catches `io.emit`, `socket.broadcast.emit`
 * and `socket.to(room).emit` with a single integration point.
 */
function instrumentAdapter(
  adapter: AdapterLike | undefined,
  collector: Collector,
  namespace: string,
  seen: WeakSet<object>,
): void {
  if (!adapter || typeof adapter.broadcast !== 'function') return;
  if (seen.has(adapter)) return;
  seen.add(adapter);

  const recordPacket = (packet: any): void => {
    collector.guard(() => {
      if (!packet || (packet.type !== EVENT && packet.type !== BINARY_EVENT)) return;
      const data = packet.data;
      if (!Array.isArray(data) || data.length === 0) return;

      const name = typeof data[0] === 'string' ? data[0] : UNNAMED;
      collector.record({
        name,
        direction: 'out',
        ...collector.describe(data.slice(1), name),
        namespace: packet.nsp ?? namespace,
      });
    });
  };

  const originalBroadcast = adapter.broadcast.bind(adapter);
  adapter.broadcast = function monitoredBroadcast(packet: any, opts: any): void {
    recordPacket(packet);
    return originalBroadcast(packet, opts);
  };

  if (typeof adapter.broadcastWithAck === 'function') {
    const originalBroadcastWithAck = adapter.broadcastWithAck.bind(adapter);
    adapter.broadcastWithAck = function monitoredBroadcastWithAck(packet: any, opts: any, ...rest: any[]): void {
      recordPacket(packet);
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
