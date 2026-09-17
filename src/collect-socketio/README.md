# @sockeye-js/collect-socketio

socket.io collector for [sockeye](../../README.md). One middleware, and every event
is measured.

```bash
npm install @sockeye-js/collect-socketio @sockeye-js/store-memory
```

```ts
import { sockeye } from '@sockeye-js/collect-socketio';
import { createMemoryStore } from '@sockeye-js/store-memory';

const store = createMemoryStore();
io.use(sockeye(store));
```

## What gets recorded

- every **incoming** event, with its payload size;
- every **outgoing** event: direct emits and, unless you turn it off, broadcasts
  (`io.emit`, `socket.broadcast.emit`, `socket.to(room).emit`);
- every **acknowledgement**, recorded as the outgoing reply with `latencyMs` set to the
  round-trip time. Acks the server asks of a client are timed the same way.

The incoming message is recorded as soon as it arrives, so it is never lost when the reply
never comes. Response times therefore live on the `out` side of a message.

A broadcast counts as one message carrying its payload size, whatever the number of recipients.

## Namespaces

`io.use()` covers the default namespace. To cover the others, including those created later:

```ts
import { monitorSocketIo } from '@sockeye-js/collect-socketio';

monitorSocketIo(io, store);
```

Each namespace is kept as a separate series in the store.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `broadcasts` | `true` | Also measure broadcasts |
| `namespace` | socket's namespace | Override the grouping key |
| `ignore` | none | Event names to skip, or a `(name, direction) => boolean` |
| `sizeOf` | JSON size | Replace the payload measurement |
| `capturePayload` | `true` | Keep a truncated payload (1024 chars) on the top 10 entries. `false` captures nothing |
| `redactSample` | none | `(sample, name) => string`, to strip anything sensitive before storing |
| `onError` | `console.warn` | Called when the collector itself fails |

The middleware never throws into your app: if the store is down, the error goes to `onError`
and your events keep flowing.

## License

This package is part of [sockeye](../../README.md), under the
[GNU AGPL v3.0 or later](LICENSE).
