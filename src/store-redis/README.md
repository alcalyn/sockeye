# @sockeye/store-redis

Redis store for [sockeye](../../README.md): every instance of your app feeds a single
dashboard, and the metrics survive a restart.

```bash
npm install @sockeye/store-redis ioredis
```

```ts
import Redis from 'ioredis';
import { createRedisStore } from '@sockeye/store-redis';

const store = createRedisStore(new Redis(process.env.REDIS_URL));
```

It implements both `StoreWriterInterface` and `StoreReaderInterface`, so collectors and the
dashboard can both use it.

## Cost per message: none

Messages are aggregated in memory and pushed in **one pipeline per interval** (1 s by
default), so recording a message never costs a network round-trip. Call `flush()` to push
immediately, and `close()` on shutdown: it flushes first.

Concurrent writers are safe: counters are `HINCRBY`-ed, and maxima and first/last timestamps
go through a small Lua script, so nothing is lost when two instances write at once. Because
the histogram layout is a pure function of the value, percentiles stay correct however many
instances contribute.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `prefix` | `sockeye` | Key prefix, so several apps can share one Redis |
| `flushIntervalMs` | `1000` | How often buffered metrics are pushed. `0` disables the timer |
| `topLimit` | `10` | Entries kept in each top list |
| `samplesPerMessage` | `5` | Payload examples kept per message type, biggest first. `0` disables it |
| `ttlSeconds` | none | Expire the all-time keys after some inactivity |
| `maxMessageTypes` | `1000` | Cardinality guard, like the memory store |
| `windows` | minute → week | Periods the dashboard may ask for, and their resolution |
| `now` | `Date.now` | Clock override, for tests |
| `onError` | `console.warn` | Called when a flush fails |

## Periods

The store keeps the recent history per period: the last hour minute by minute, the last day
in hours, the last week in days, so any of them can be read back:

```ts
await store.listMessages({ window: '15m' });
```

Each time slice is a key named after an absolute bucket index, with a TTL as long as the
period using it, so old history expires on its own and changing `windows` needs no migration.
A read only fetches the slices that actually hold data, thanks to a per-slice index.

## Requirements

`ioredis` (or any compatible client) and Redis 3.0 or later. The flush timer is `unref`-ed,
so it never keeps your process alive.

## License

This package is part of [sockeye](../../README.md), under the
[GNU AGPL v3.0 or later](LICENSE).
