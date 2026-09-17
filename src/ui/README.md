# @sockeye-js/ui

The local dashboard of [sockeye](../../README.md): a REST API over your store, plus a
small Vue SPA, in one mountable handler.

```bash
npm install @sockeye-js/ui
```

```ts
import { dashboard } from '@sockeye-js/ui';

app.use('/sockeye', dashboard(store));
```

Open <http://localhost:3000/sockeye/>.

`dashboard(store)` is a plain `(req, res, next)` function: express, connect and a bare
`http.createServer` all work. `store` only has to implement `StoreReaderInterface`.

## What the dashboard shows

- a period selector (last minute, 5 minutes, hour, 24 hours, 7 days, all time) driving
  every figure on the page;
- totals: messages, total data, in/out split, and the period actually covered;
- the **10 slowest responses** and the **10 heaviest payloads**, each with a preview of what
  the message actually contained;
- a sortable table of every message type (count, total data, median/average payload size,
  median/p95 response time), each column drawn as a bar so the outliers jump out;
- a detail panel per message: how many of it over time, the payload size and response time
  histograms, and a few real payloads to unfold.

It polls the API, so the numbers keep moving while you watch. Dark and light themes are
both there: it follows the system preference, and the picker in the toolbar overrides it
(remembered in the browser).

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/dashboard` | Everything below, in one payload |
| `GET /api/overview` | Totals |
| `GET /api/messages?sort=count\|bandwidth\|bytes\|latency&direction=in\|out&namespace=&limit=` | Stats per message type |
| `GET /api/messages/:name?direction=` | Detail for one message, with histograms |
| `GET /api/top/slowest\|heaviest?limit=` | Top lists |
| `GET /api/windows` | Periods the store can answer for |
| `POST /api/reset` | Drops every metric (when the store supports it) |
| `GET /api/health` | `{ ok: true }` |

Every read endpoint takes `?window=` (`1m`, `5m`, `1h`, `24h`, `7d`, `all`…). Which periods
exist depends on the store's `windows`; `GET /api/windows` is the source of truth, and the
dashboard only offers those.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `serveClient` | `true` | Serve the bundled SPA. `false` leaves non-API requests to your app |
| `clientDir` | bundled | Serve your own build of the SPA |

## Without a server

The API is framework-free underneath, useful for tests, or to feed your own UI:

```ts
import { createApiHandler } from '@sockeye-js/ui';

const handle = createApiHandler(store);
const { status, body } = await handle({ method: 'GET', path: '/messages', query: { sort: 'latency' } });
```

## Developing the SPA

```bash
pnpm --filter @sockeye-js/ui dev:client
```

Vite proxies `/api` to an app serving the dashboard on `http://localhost:3000/sockeye`.

## License

This package is part of [sockeye](../../README.md), under the
[GNU AGPL v3.0 or later](LICENSE).
