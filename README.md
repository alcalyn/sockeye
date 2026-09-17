# sockeye

Know which WebSocket messages your app actually spends its time and bandwidth on.

sockeye sits on your server, measures every message going in and out, and gives you
a dashboard answering the questions you cannot answer today:

- which messages are sent the most?
- which ones carry the heaviest payloads?
- which ones eat the most bandwidth?
- which ones take the longest to answer (median, p95, p99)?
- what are the 10 slowest and the 10 heaviest messages, and what was inside them?
- and all of that over the last 5 minutes, the last hour, or since the start?

It works with **socket.io**, **ws**, and any other transport, and stores its metrics
**in memory** or **in Redis**. Everything is split into small packages: install only what you use.

---

## Install

For a socket.io app keeping metrics in memory:

```bash
npm install @sockeye-js/collect-socketio @sockeye-js/store-memory @sockeye-js/ui
```

Every package is ESM only and needs Node 18 or later.

## Quick start

```ts
import express from 'express';
import { Server } from 'socket.io';
import { sockeye } from '@sockeye-js/collect-socketio';
import { createMemoryStore } from '@sockeye-js/store-memory';
import { dashboard } from '@sockeye-js/ui';

const store = createMemoryStore();

io.use(sockeye(store));                  // collect
app.use('/sockeye', dashboard(store));  // and look at it
```

Open <http://localhost:3000/sockeye/>. That is the whole setup: overview cards, a
sortable table of every message type with its count, total data, payload size and response
time, and the top 10 slowest and heaviest messages. Pick a period in the toolbar to narrow
every figure down to it.

---

## How it works

A **collector** hooks into your WebSocket server and turns every message into an event.
A **store** aggregates those events. The **dashboard** reads the store.

```
socket.io / ws / your code  ──▶  collector  ──▶  store  ──▶  dashboard
                                              (memory, redis, your own)
```

Nothing is kept per message: each message type holds a few counters and two histograms, so
memory usage stays constant whatever the traffic.

### Periods

Every figure can be read over a period: last minute, 5 minutes, 15 minutes, hour, 6 hours,
24 hours, 7 days, or everything since the start. Pick it from the dropdown in the dashboard,
or with `?window=5m` on the API.

Each period is cut into `slots` buckets: the last hour into 60 one-minute buckets, the last
week into 7 one-day buckets. A message is counted in the current bucket of every period, and
a period is answered by adding up its buckets, so asking for a different period costs
nothing at record time.

Buckets are whole, and the newest one is still filling up, so a period is always rounded
outwards. The dashboard shows the range actually covered, and the API returns it in
`overview.window`.

#### Changing the periods

Pass a `windows` list, with a key, a label, a length, and how many buckets it holds:

```ts
import { ALL_TIME } from '@sockeye-js/core';

createMemoryStore({
  windows: [
    { key: '30s', label: 'Last 30 seconds', ms: 30_000, slots: 30 }, // one per second
    { key: '1d', label: 'Last day', ms: 86_400_000, slots: 72 }, // 20-minute steps
    ALL_TIME,
  ],
});
```

`slots` is both the resolution of the charts and what the period costs in memory: more slots
means finer buckets and more of them. The dashboard offers exactly this list, `ALL_TIME`
included or not, so it only ever shows what the store can actually answer.

### Payload previews

Seeing a 400 kB message at the top of the heaviest list only helps if you can tell what was
inside it, so sockeye keeps a **truncated copy of the payload**, 1024 characters by
default, on the messages worth looking at:

- the entries of the global top 10 lists;
- the five biggest messages of **every** message type, so the detail view always has a real
  example of what that message carries, even for a type that never reaches the global top
  (`samplesPerMessage` on both stores, `0` to disable).

Nothing else holds message content: the aggregated stats are counters and histograms only.

If your messages carry data that should not land on a dashboard, turn it off or redact it:

```ts
io.use(sockeye(store, { capturePayload: false }));
io.use(sockeye(store, { redactSample: (sample) => sample.replace(/"token":"[^"]*"/g, '"token":"***"') }));
```

### Where response times come from

A message only has a response time if something actually replies to it. sockeye uses
**acknowledgements**: when a client emits an event with an ack callback, the reply is
recorded with `latencyMs` set to the round-trip time.

So response times live on the **outgoing** side of a message: `chat:send / in` is what you
received, `chat:send / out` is the reply and how long it took. The incoming message is
recorded immediately, so it is never lost when the reply never comes.

For transports with no such concept, you close the timing window yourself: see
[Any other transport](#any-other-transport).

---

## Packages

| Package | What it does |
| --- | --- |
| [`@sockeye-js/collect-socketio`](src/collect-socketio) | One middleware, measures every socket.io event |
| [`@sockeye-js/collect-ws`](src/collect-ws) | Measures every frame of a `ws` server |
| [`@sockeye-js/collect-websocket`](src/collect-websocket) | Report messages yourself, from any transport |
| [`@sockeye-js/store-memory`](src/store-memory) | Keeps metrics in the process, zero dependency |
| [`@sockeye-js/store-redis`](src/store-redis) | Shares metrics across every instance of your app |
| [`@sockeye-js/ui`](src/ui) | REST API + the Vue dashboard |
| [`@sockeye-js/core`](src/core) | Types, store interfaces and the statistics primitives |

Collectors and stores are independent: any collector works with any store.

---

## Going further

### ws

`ws` knows nothing about your protocol, so tell sockeye how to name a message:

```ts
import { attachWsMonitor } from '@sockeye-js/collect-ws';

attachWsMonitor(wss, store, {
  nameOf: (data) => JSON.parse(String(data)).type,
});
```

`nameOf` is optional: by default, JSON frames are named after their `type`, `event`, `name`
or `action` field, and binary frames are grouped under `<binary>`.

### Any other transport

The lowest-level collector works with the browser `WebSocket` API, a raw socket, or anything
else. You call it:

```ts
import { createMonitor } from '@sockeye-js/collect-websocket';

const monitor = createMonitor(store);

monitor.received('chat:send', payload);
monitor.sent('chat:new', payload);

// Measure a response time around your own handler:
const pending = monitor.start('report:generate', payload);
const report = await generateReport(payload);
pending.end(report); // records the reply, its size, and the time it took
```

### Redis

Use it when your app runs several instances, or when you want the metrics to outlive a restart:

```ts
import Redis from 'ioredis';
import { createRedisStore } from '@sockeye-js/store-redis';

const store = createRedisStore(new Redis(process.env.REDIS_URL));
```

Messages are aggregated in memory and pushed in a single pipeline every second, so recording
a message never costs a network round-trip. Several instances can write to the same keys
concurrently and still produce correct percentiles.

### Namespaces

socket.io namespaces are kept apart automatically. `monitorSocketIo` also covers the
namespaces created later:

```ts
import { monitorSocketIo } from '@sockeye-js/collect-socketio';

monitorSocketIo(io, store);
```

### Serving the dashboard

`dashboard(store)` is a plain `(req, res, next)` function: express, connect, or a bare
`http.createServer` all work. It serves the API under `/api` and the SPA for everything else.

If you only want the API, or want to plug the data into your own UI:

```ts
app.use('/sockeye', dashboard(store, { serveClient: false }));
```

| Endpoint | Returns |
| --- | --- |
| `GET /api/dashboard` | Everything below in one payload |
| `GET /api/overview` | Totals: messages, bandwidth, in/out split |
| `GET /api/messages?sort=count\|bandwidth\|bytes\|latency&direction=in\|out&limit=` | Stats for every message type |
| `GET /api/messages/:name` | Detail for one message: histograms, history, payload examples |
| `GET /api/top/slowest\|heaviest?limit=` | The top lists |
| `GET /api/windows` | The periods this store can answer for |
| `POST /api/reset` | Drops every metric |

Every read endpoint takes `?window=` (`1m`, `5m`, `1h`, `24h`, `7d`, `all`…).

The API is framework-free underneath, if you would rather wire it up yourself:

```ts
import { createApiHandler } from '@sockeye-js/ui';

const handle = createApiHandler(store);
const response = await handle({ method: 'GET', path: '/overview' });
```

---

## Collector options

Every collector accepts the same options:

| Option | Default | What it does |
| --- | --- | --- |
| `namespace` | `'/'` | Groups messages, e.g. per namespace or per path |
| `ignore` | none | Message names to skip, or a `(name, direction) => boolean` |
| `sizeOf` | JSON size | Replace the payload measurement, e.g. to avoid stringifying huge objects |
| `capturePayload` | `true` | Keep a truncated payload on the messages that reach the top 10 lists. A number sets the length (1024 characters by default), `false` captures nothing |
| `redactSample` | none | `(sample, name) => string`, to strip anything sensitive before it is stored |
| `onError` | `console.warn` | Called when the collector itself fails |

`sockeye` adds `broadcasts` (default `true`), which also measures `io.emit`,
`socket.broadcast.emit` and `socket.to(room).emit`. A broadcast counts as one message
carrying its payload size, whatever the number of recipients.

A collector never throws into your app: if the store is down or a payload cannot be measured,
the error goes to `onError` and your messages keep flowing.

---

## Accuracy and memory

Percentiles come from a log-linear histogram rather than from a list of samples, which is
what keeps memory constant. Values under 32 (bytes or milliseconds) are exact; above that,
the reported median, p95 and p99 stay within ~2% of the real value. Counters, totals,
maxima and the top 10 lists are exact.

Only the buckets a message actually hit are stored, which is what makes keeping 91 time
buckets per message type affordable: a busy one costs a few hundred kB, a quiet one a few kB.
Past 1000 distinct names, everything else is merged into `<other>`, so an id embedded in a
message name cannot blow up the process (`maxMessageTypes` on both stores).

---

## Writing your own store

A store is two interfaces, on purpose:

```ts
interface StoreWriterInterface {
  record(event: MessageEvent): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

interface StoreReaderInterface {
  getOverview(options?: WindowOptions): Promise<Overview>;
  listMessages(options?: ListMessagesOptions): Promise<MessageStats[]>;
  getMessageStats(name: string, options?: MessageStatsOptions): Promise<MessageDetail[]>;
  getTop(kind: 'slowest' | 'heaviest', options?: TopOptions): Promise<TopEntry[]>;
  /** Periods you can serve. Leave it out if you only know the whole history. */
  getWindows?(): Promise<WindowRange[]>;
  reset?(): Promise<void>;
}
```

Collectors only ever need the writer, so a store that forwards events to a remote service
implements `StoreWriterInterface` alone. Stores the dashboard reads from implement both.

`@sockeye-js/core` gives you the pieces to build one: `StatsAggregator` (counters plus
histograms, mergeable), `WindowedSeries` and `WindowedTops` (the whole time-window machinery),
`TopN` (bounded top lists), `histogram` and `applyListOptions`.

---

## Development

```bash
pnpm install
pnpm build
pnpm test          # Redis tests are skipped when no Redis is reachable
```

A demo socket.io app lives in [`examples/test-app`](examples/test-app): it generates small,
heavy and deliberately slow messages so you can see the dashboard fill up.

```bash
pnpm --filter sockeye-test-app start
```

## Releasing

Versions are managed with [changesets](https://github.com/changesets/changesets), and every
package is released together under the same version (`fixed` in `.changeset/config.json`).

**1. Describe your change.** In the branch or PR that changes something publishable:

```bash
pnpm changeset
```

Pick the packages you touched, pick `patch`, `minor` or `major`, and write the line that will
end up in the changelog. This writes a markdown file in `.changeset/`: commit it with your
change.

**2. Merge to `main`.** The [release workflow](.github/workflows/release.yml) picks the
changesets up and opens (or updates) a PR named *chore: version packages*, which bumps every
version, updates the internal dependency ranges and writes the `CHANGELOG.md` files.

**3. Merge the version PR.** On that merge, the same workflow runs `pnpm run release`
(`pnpm build && changeset publish`), publishes every package that is not on npm yet, and tags
the release.

So the only manual steps are `pnpm changeset` and merging two PRs. Publishing needs an
`NPM_TOKEN` secret on the repository, with publish rights on the `@sockeye-js` scope.

### Releasing by hand

If you ever need to publish outside CI:

```bash
pnpm changeset              # unless the changesets are already there
pnpm version-packages       # changeset version + lockfile update
git commit -am 'chore: version packages'
npm login                   # must have access to the @sockeye-js scope
pnpm release                # build + changeset publish
git push --follow-tags
```

## License

This repository is under the [GNU AGPL v3.0 or later](LICENSE).
