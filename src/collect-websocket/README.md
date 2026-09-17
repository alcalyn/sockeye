# @sockeye/collect-websocket

The free-form collector of [sockeye](../../README.md): you report the messages, so it
works with the browser-style `WebSocket` API, a raw socket, or any protocol sockeye
knows nothing about.

```bash
npm install @sockeye/collect-websocket @sockeye/store-memory
```

```ts
import { createMonitor } from '@sockeye/collect-websocket';
import { createMemoryStore } from '@sockeye/store-memory';

const store = createMemoryStore();
const monitor = createMonitor(store);

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  monitor.received(message.type, message);
});
```

## Measuring response times

`start()` records the incoming message immediately and returns a handle; `end()` records the
reply along with the time it took:

```ts
const pending = monitor.start('report:generate', request);
const report = await generateReport(request);
pending.end(report);
```

If the reply never comes, the incoming message stays recorded: it simply has no response
time. `cancel()` drops the timer without recording a reply.

## API

| Call | What it records |
| --- | --- |
| `monitor.received(name, payload?, options?)` | An incoming message |
| `monitor.sent(name, payload?, options?)` | An outgoing message |
| `monitor.record(name, payload?, options?)` | Either one, via `options.direction` |
| `monitor.start(name, payload?, options?)` | An incoming message + a timer for the reply |
| `monitor.size(payload)` | Measures a payload without recording anything |

`options` accepts `bytes` (when you already know the frame size), `namespace` and `latencyMs`.

```ts
// Skip the JSON measurement when the real frame size is at hand:
monitor.received('sync', undefined, { bytes: frame.byteLength });
```
