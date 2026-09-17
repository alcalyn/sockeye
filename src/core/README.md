# @sockeye/core

Shared foundation of [sockeye](../../README.md): the types every package agrees on,
the two store interfaces, and the statistics primitives.

You only need it directly to **write your own store or collector**. Collectors and stores
already depend on it.

```bash
npm install @sockeye/core
```

## What is in it

| Export | Purpose |
| --- | --- |
| `StoreWriterInterface`, `StoreReaderInterface` | The store contract. Writers collect, readers feed the dashboard |
| `MessageEvent`, `MessageStats`, `MessageDetail`, `TopEntry`, `Overview` | The data model |
| `StatsAggregator` | Counters + histograms for one message type, at constant memory cost |
| `TopN` | Bounded "top 10" list, kept exact |
| `histogram` | The log-linear histogram: `bucketIndex`, `quantile`, `merge`, `toBuckets` |
| `WindowedSeries`, `WindowedTops` | Time windows: the same data kept per period |
| `DEFAULT_WINDOWS`, `ALL_TIME`, `resolveWindow`, `windowRanges` | Period configuration |
| `applyListOptions` | Sorting/filtering shared by every reader store |
| `Collector` | Collector plumbing: defaults, name filtering, error isolation |
| `measureSize` | Payload size measurement |

## Writing a store

```ts
import { StatsAggregator, seriesKey, type MessageEvent, type StoreWriterInterface } from '@sockeye/core';

class MyStore implements StoreWriterInterface {
  private series = new Map<string, StatsAggregator>();

  record(event: MessageEvent): void {
    const key = seriesKey(event.namespace, event.direction, event.name);
    let aggregator = this.series.get(key);
    if (!aggregator) {
      aggregator = new StatsAggregator(event.name, event.direction, event.namespace);
      this.series.set(key, aggregator);
    }
    aggregator.add(event);
  }
}
```

Implement `StoreReaderInterface` as well if the dashboard should read from it;
`aggregator.toStats()` and `aggregator.toDetail()` produce exactly what it expects.

## Histograms

Percentiles come from a fixed-layout histogram rather than stored samples, so memory stays
constant. Values under 32 are exact, and above that the estimate stays within ~2% of the
real value. Only the buckets actually hit are stored.

Because the layout is a pure function of the value, two histograms merge by simply adding
their buckets, which is what lets several processes increment the same Redis counters, and
what turns a handful of one-minute slices into a "last 15 minutes" figure.
