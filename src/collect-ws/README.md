# @sockeye/collect-ws

Collector for the [`ws`](https://github.com/websockets/ws) library, part of
[sockeye](../../README.md).

```bash
npm install @sockeye/collect-ws @sockeye/store-memory
```

```ts
import { attachWsMonitor } from '@sockeye/collect-ws';
import { createMemoryStore } from '@sockeye/store-memory';

const store = createMemoryStore();
attachWsMonitor(wss, store);
```

Every frame received and every frame sent is recorded with its **exact wire size**, binary
frames included.

## Naming messages

`ws` knows nothing about your protocol. By default, JSON frames are named after their
`type`, `event`, `name` or `action` field, binary frames are grouped under `<binary>`, and
anything else under `<unnamed>`. Override it when your protocol differs:

```ts
attachWsMonitor(wss, store, {
  nameOf: (data, isBinary) => (isBinary ? 'blob' : String(data).split('|')[0]),
});
```

## Namespaces

Group messages by path, or by anything you can read off the upgrade request:

```ts
attachWsMonitor(wss, store, {
  namespaceOf: (request) => new URL(request.url, 'http://x').pathname,
});
```

## Response times

`ws` has no acknowledgement mechanism, so there is nothing to time automatically. If your
protocol has a notion of a reply, measure it with
[`@sockeye/collect-websocket`](../collect-websocket):

```ts
const pending = monitor.start('report:generate', payload);
pending.end(await generateReport(payload));
```

## Other exports

- `monitorWsSocket(socket, store, options)` instruments a single socket you manage yourself.
- `attachWsMonitor` returns a function that stops monitoring new connections.
