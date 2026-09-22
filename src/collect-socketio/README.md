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

Every message also records **how many clients it was written to**, so one broadcast to a
room of 500 is one emit and 500 sends. The recipients are counted the way socket.io picks
them, which accounts for several rooms at once, for excluded sockets (`socket.broadcast`,
`.except()`), and for a room nobody is in — a broadcast into the void is one emit that
costs no bandwidth at all.

With a clustered adapter (Redis & co), the count is the number of sockets held by *this*
node, which is exactly the bandwidth this node pays for.

A recipient count is not a delivery receipt: it is what was handed to the transport. Only
an acknowledgement proves a client got the message, and that shows up as a latency.

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
| `countRecipients` | `true` | Count the clients each broadcast reaches. `false` counts one per emit, and skips the extra walk of the room |
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
