import type {
  Direction,
  ListMessagesOptions,
  MessageStats,
  Overview,
  SortKey,
  StoreReaderInterface,
  TopEntry,
  TopKind,
  WindowRange,
} from '@sockeye/core';

export interface ApiRequest {
  method: string;
  /** Path relative to the API root, e.g. `/messages`. */
  path: string;
  query?: Record<string, string | string[] | undefined>;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Everything the dashboard needs, in a single request. */
export interface Dashboard {
  overview: Overview;
  messages: MessageStats[];
  top: Record<TopKind, TopEntry[]>;
  /** Periods this store can answer for, so the UI only offers what exists. */
  windows: WindowRange[];
  generatedAt: number;
}

const SORT_KEYS: SortKey[] = ['count', 'bandwidth', 'bytes', 'latency', 'name'];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function listOptions(query: ApiRequest['query'] = {}): ListMessagesOptions {
  const options: ListMessagesOptions = {};

  const sort = first(query.sort);
  if (sort && SORT_KEYS.includes(sort as SortKey)) options.sort = sort as SortKey;

  const direction = first(query.direction);
  if (direction === 'in' || direction === 'out') options.direction = direction as Direction;

  const namespace = first(query.namespace);
  if (namespace) options.namespace = namespace;

  const limit = Number(first(query.limit));
  if (Number.isFinite(limit) && limit >= 0) options.limit = limit;

  const window = first(query.window);
  if (window) options.window = window;

  return options;
}

/** Windows a store can serve, normalised. Stores without history only offer "all time". */
async function windowsOf(reader: StoreReaderInterface): Promise<WindowRange[]> {
  if (!reader.getWindows) return [];
  const windows = await reader.getWindows();
  return windows.map((window) =>
    typeof window === 'string'
      ? { key: window, label: window, from: 0, to: 0, resolutionMs: 0 }
      : window,
  );
}

const json = (body: unknown, status = 200): ApiResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body,
});

/**
 * The dashboard API, with no HTTP framework involved: give it a store that can read, get
 * back a function from request to response. Adapters turn it into express middleware,
 * a Fastify route, a test double, whatever you need.
 */
export function createApiHandler(reader: StoreReaderInterface): (request: ApiRequest) => Promise<ApiResponse> {
  return async function handle(request: ApiRequest): Promise<ApiResponse> {
    const path = request.path.replace(/\/+$/, '') || '/';
    const query = request.query ?? {};
    const method = request.method.toUpperCase();

    try {
      if (method === 'POST' && path === '/reset') {
        if (!reader.reset) return json({ error: 'This store does not support reset' }, 405);
        await reader.reset();
        return json({ ok: true });
      }

      if (method !== 'GET' && method !== 'HEAD') {
        return json({ error: `Unsupported method ${method}` }, 405);
      }

      if (path === '/health') return json({ ok: true });

      if (path === '/overview') return json(await reader.getOverview(listOptions(query)));

      if (path === '/windows') return json(await windowsOf(reader));

      if (path === '/messages') return json(await reader.listMessages(listOptions(query)));

      if (path.startsWith('/messages/')) {
        const name = decodeURIComponent(path.slice('/messages/'.length));
        const { direction, window } = listOptions(query);
        const details = await reader.getMessageStats(name, {
          ...(direction ? { direction } : {}),
          ...(window ? { window } : {}),
        });
        return details.length > 0 ? json(details) : json({ error: `Unknown message ${name}` }, 404);
      }

      if (path.startsWith('/top/')) {
        const kind = path.slice('/top/'.length);
        if (kind !== 'slowest' && kind !== 'heaviest') {
          return json({ error: `Unknown top list ${kind}` }, 404);
        }
        const limit = Number(first(query.limit));
        const window = first(query.window);
        return json(
          await reader.getTop(kind, {
            ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
            ...(window ? { window } : {}),
          }),
        );
      }

      if (path === '/dashboard' || path === '/') {
        const options = listOptions(query);
        const windowOption = options.window ? { window: options.window } : {};

        const [overview, messages, slowest, heaviest, windows] = await Promise.all([
          reader.getOverview(windowOption),
          reader.listMessages(options),
          reader.getTop('slowest', windowOption),
          reader.getTop('heaviest', windowOption),
          windowsOf(reader),
        ]);

        const dashboard: Dashboard = {
          overview,
          messages,
          top: { slowest, heaviest },
          windows,
          generatedAt: Date.now(),
        };
        return json(dashboard);
      }

      return json({ error: `Unknown endpoint ${path}` }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  };
}
