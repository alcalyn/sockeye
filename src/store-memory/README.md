# @sockeye/store-memory

In-process store for [sockeye](../../README.md). No service to run, no configuration.

```bash
npm install @sockeye/store-memory
```

```ts
import { createMemoryStore } from '@sockeye/store-memory';

const store = createMemoryStore();
```

Pass it to any collector, and to the dashboard: it implements both
`StoreWriterInterface` and `StoreReaderInterface`.

## Memory usage

Nothing is kept per message. Each message type holds a running total plus one small
aggregate per time bucket, and only the histogram buckets actually hit are stored, so a
busy message type costs a few hundred kB and a quiet one a few kB, whatever the traffic.
The two top 10 lists keep real events, so they are exact.

| Option | Default | Effect |
| --- | --- | --- |
| `topLimit` | `10` | Entries kept in each top list |
| `samplesPerMessage` | `5` | Payload examples kept per message type, biggest first. `0` disables it |
| `maxMessageTypes` | `1000` | Past this many distinct names, the rest is merged into `<other>` |
| `windows` | minute → week | Periods the dashboard may ask for, and their resolution |
| `now` | `Date.now` | Clock override, for tests |

`maxMessageTypes` is the guard against message names carrying an id (`job:42`), which would
otherwise grow the store forever.

## Periods

By default the store keeps an hour minute by minute, a day hour by hour and a week day by
day, so the dashboard can ask for any of them:

```ts
await store.listMessages({ window: '5m', sort: 'latency' });
await store.getTop('slowest', { window: '1h' });
```

Choose the periods yourself by passing a `windows` list:

```ts
import { ALL_TIME } from '@sockeye/core';

createMemoryStore({
  windows: [
    { key: '1d', label: 'Last day', ms: 86_400_000, slots: 72 }, // 20-minute steps
    ALL_TIME,
  ],
});
```

`slots` is how many buckets the period is cut into: its resolution, and what it costs in
memory. `store.getWindows()` returns the list the dashboard offers.

## Caveats

Metrics live in the process: they are lost on restart, and each instance of your app only
knows about its own traffic. Use [`@sockeye/store-redis`](../store-redis) when you run
more than one instance.

## License

This package is part of [sockeye](../../README.md), under the
[GNU AGPL v3.0 or later](LICENSE).
