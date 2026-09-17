import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoreReaderInterface } from '@sockeye/core';
import { createApiHandler, type ApiRequest } from './api.js';

/** Minimal shapes of the node request/response, so express is never a dependency. */
export interface NodeRequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string | number): void;
  end(chunk?: string | Uint8Array): void;
  writableEnded?: boolean;
}

export interface DashboardOptions {
  /** Serve the bundled SPA alongside the API. Defaults to `true`. */
  serveClient?: boolean;
  /** Override the directory holding the built SPA. */
  clientDir?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const here = dirname(fileURLToPath(import.meta.url));

/** The SPA is published inside this package, next to the compiled server code. */
function defaultClientDir(): string {
  for (const candidate of [join(here, 'client'), join(here, '..', 'dist', 'client')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return join(here, 'client');
}

function sendJson(res: NodeResponseLike, status: number, headers: Record<string, string>, body: unknown): void {
  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

/**
 * Mount the dashboard on any express-compatible server:
 *
 * ```ts
 * app.use('/sockeye', dashboard(store));
 * ```
 *
 * It answers `/api/*` from the store and serves the bundled SPA for everything else.
 * Works with a plain `http.createServer` too, as long as the mount path is the root.
 */
export function dashboard(
  reader: StoreReaderInterface,
  options: DashboardOptions = {},
): (req: NodeRequestLike, res: NodeResponseLike, next?: (error?: unknown) => void) => void {
  const handleApi = createApiHandler(reader);
  const serveClient = options.serveClient ?? true;
  const clientDir = resolve(options.clientDir ?? defaultClientDir());

  return function dashboardMiddleware(req, res, next): void {
    const rawUrl = req.url ?? '/';
    const url = new URL(rawUrl, 'http://localhost');
    const pathname = decodeURI(url.pathname);

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const request: ApiRequest = {
        method: req.method ?? 'GET',
        path: pathname.slice('/api'.length) || '/',
        query: Object.fromEntries(url.searchParams),
      };

      void handleApi(request).then(
        (response) => sendJson(res, response.status, response.headers, response.body),
        (error) => sendJson(res, 500, {}, { error: String(error) }),
      );
      return;
    }

    if (!serveClient) {
      if (next) return next();
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    // Assets are referenced relatively, so the dashboard URL must end with a slash.
    const originalUrl = req.originalUrl ?? rawUrl;
    if (pathname === '/' && !originalUrl.split('?')[0].endsWith('/')) {
      res.statusCode = 302;
      res.setHeader('location', `${originalUrl.split('?')[0]}/${url.search}`);
      res.end();
      return;
    }

    const relative = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^(\.\.[/\\])+/, '').slice(1);
    let file = join(clientDir, relative);

    if (!file.startsWith(clientDir) || !existsSync(file) || !statSync(file).isFile()) {
      // Single page app: anything unknown falls back to the entry point.
      file = join(clientDir, 'index.html');
    }

    if (!existsSync(file)) {
      res.statusCode = 500;
      res.end(
        'sockeye dashboard assets are missing. Build them with `pnpm --filter @sockeye/ui build`.',
      );
      return;
    }

    res.statusCode = 200;
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    res.setHeader('cache-control', file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable');
    createReadStream(file).pipe(res as unknown as NodeJS.WritableStream);
  };
}

/** Alias kept explicit for express users. */
export const createExpressRouter = dashboard;
