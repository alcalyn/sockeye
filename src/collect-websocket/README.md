# @sockeye-js/collect-websocket

The free-form collector of [sockeye](../../README.md): you report the messages, so it
works with the browser-style `WebSocket` API, a raw socket, or any protocol sockeye
knows nothing about.

```bash
npm install @sockeye-js/collect-websocket @sockeye-js/store-memory
```

```ts
import { createMonitor } from '@sockeye-js/collect-websocket';
import { createMemoryStore } from '@sockeye-js/store-memory';

const store = createMemoryStore();
const monitor = createMonitor(store);

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  monitor.received(message.type, message);
});
```

Sizes are the payloads you report, before any framing or compression, so the real traffic
on the wire is often smaller.

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

`options` accepts `bytes` (when you already know the frame size), `recipients`, `namespace`
and `latencyMs`.

```ts
// Skip the JSON measurement when the real frame size is at hand:
monitor.received('sync', undefined, { bytes: frame.byteLength });
```

## Counting a fan-out

`recipients` says how many clients got the same frame, so the dashboard can show what a
broadcast really costs. It defaults to `1`, and `0` means the message went to nobody.

```ts
for (const client of room) client.send(frame);
monitor.sent('chat:message', message, { recipients: room.size });
```

Leave it alone if you already call `sent()` once per client: each call is one recipient.

## License

This package is part of [sockeye](../../README.md), under the
[GNU AGPL v3.0 or later](LICENSE).
