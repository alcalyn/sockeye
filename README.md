# sockeye

Monitor websocket messages of your app.

Add sockeye on your nodejs app to collect websocket messages, and get metrics about:

- which messages are sent the most?
- which ones carry the heaviest payloads?
- which ones eat the most bandwidth?
- which ones take the longest to answer (median, p95, p99)? (when using `ack` from socket.io)
- what are the 10 slowest and the 10 heaviest messages, and what was inside them
- and all of that over the last 5 minutes, the last hour, or since the start

Supports:
- [socket.io](https://socket.io/)
- [websockets/ws](https://github.com/websockets/ws)
- and native or any other websocket server with a function to track your events

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

const store = createMemoryStore();      // in memory, but can use a persistent storage like redis

io.use(sockeye(store));                 // collect
app.use('/sockeye', dashboard(store));  // plug the dashboard, but you can put it behind a basic auth
```

Open <http://localhost:3000/sockeye/>.

That's it.

## How it works

A **collector** hooks into your WebSocket server and turns every message into an event.
A **store** aggregates those events. The **dashboard** reads the store.

Nothing is kept per message: each message type holds a few counters and two histograms, so
memory usage stays constant whatever the traffic.

### Periods

You can customize periods and/or add more granularity, example:

```ts
import { ALL_TIME } from '@sockeye-js/core';

createMemoryStore({
  windows: [
    { key: '30s', label: 'Last 30 seconds', ms: 30_000, slots: 60 }, // short period with 500ms resolution
    { key: '1d', label: 'Last day', ms: 86_400_000, slots: 288 }, // day period with 5 minutes resolution
    { key: '1month', label: 'Last 30 days', ms: 2_592_000_000, slots: 30 * 12 }, // month period with 12h resolution
    ALL_TIME,
  ],
});
```

`slots` is both the resolution of the charts and what the period costs in memory: more slots
means finer buckets and more of them. The dashboard offers exactly this list, `ALL_TIME`
included or not, so it only ever shows what the store can actually answer.

### What a message costs

Every message is counted twice, because both numbers are useful:

- **per emit**: one call to `emit` is one message, whatever the number of recipients;
- **per client reached**: a broadcast to a room of 500 is 500 messages and 500 payloads.

Only the second says what the server actually pushed out, so it is what the dashboard shows
by default; the switch in the messages table flips the whole page to the first. The gap
between the two is the fan-out, and it cuts both ways: a broadcast to an empty room is one
emit that costs no bandwidth at all, since socket.io writes to nobody.

The socket.io collector counts the recipients the way socket.io picks them, so rooms,
exclusions (`socket.broadcast`, `.except()`) and `io.emit` are all accounted for. With
`ws`, fanning out is a loop of `send` in your own code, so each recipient is already its
own message. With the free-form collector you say it yourself, through `recipients`.

A recipient count is what was handed to the transport, not a delivery receipt. Only an
acknowledgement proves a client received a message, and that is a response time.

### Payload size is not bytes on the wire

sockeye measures the **payload** your app sends, not the bytes the socket writes. A frame
carries protocol overhead on top of it, and, more importantly, `permessage-deflate`
compresses it: on JSON, the real traffic is often several times smaller than what the
dashboard reports. Read the numbers as the relative weight of your message types, which is
what they are good at, rather than as a bandwidth bill.

### Payload previews

You can debug biggest payload of each type of message.

Store will keep top biggest payloads (first 1kb) so you can see how it looks like.

If your messages carry data that should not land on a dashboard, turn it off or redact it:

```ts
io.use(sockeye(store, { capturePayload: false })); // disable it
io.use(sockeye(store, { redactSample: (sample) => sample.replace(/"token":"[^"]*"/g, '"token":"***"') })); // do not keep sensitive data
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

If you use another socket server not natively supported,
you can still branch monitoring where you receive and send websocket messages:

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

Every read endpoint takes `?window=` (`1m`, `5m`, `1h`, `24h`, `7d`, `all`...).

To serve dashboard with any nodejs framework, use this lower level function:

```ts
import { createApiHandler } from '@sockeye-js/ui';

const handle = createApiHandler(store);
const response = await handle({ method: 'GET', path: '/overview' });
```

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
`socket.broadcast.emit` and `socket.to(room).emit`, and `countRecipients` (default `true`),
which counts the clients each broadcast reaches — see [What a message
costs](#what-a-message-costs).

A collector never throws into your app: if the store is down or a payload cannot be measured,
the error goes to `onError` and your messages keep flowing.

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

## Development

```bash
pnpm install
pnpm build
pnpm test          # Redis tests are skipped when no Redis is reachable
```

### App example

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

**2. Publish.** Releases are cut by hand from `main`:

```bash
pnpm version-packages       # changeset version + lockfile update
git commit -am 'chore: version packages'
npm login                   # must have access to the @sockeye-js scope
pnpm release                # build + changeset publish
git push --follow-tags
```

`pnpm version-packages` bumps every version, updates the internal dependency ranges and
writes the `CHANGELOG.md` files; `pnpm release` runs `pnpm build && changeset publish`,
publishes every package that is not on npm yet, and tags the release.

## License

This repository is under the [GNU AGPL v3.0 or later](LICENSE).
