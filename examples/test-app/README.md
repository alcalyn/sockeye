# sockeye test app

A small socket.io app used to exercise [sockeye](../..) end to end. It is part of the
workspace and is never published, so it always runs against the packages in this repository.

```bash
pnpm install
pnpm build                                   # from the repository root
pnpm --filter sockeye-test-app start  # or `pnpm start` from this directory
```

Then open <http://localhost:3000/sockeye/>.

The server installs the collector with `io.use(sockeye(store))` and mounts the
dashboard with `app.use('/sockeye', dashboard(store))`. A traffic generator starts
alongside it and produces four very different message profiles on purpose:

| Message            | Profile                                          |
| ------------------ | ------------------------------------------------ |
| `cursor:move`      | tiny, ~8/s per client, no acknowledgement         |
| `chat:send`        | small, acknowledged in a few ms                   |
| `file:upload`      | 50 kB - 400 kB payloads                           |
| `report:generate`  | 300 ms - 1.5 s to answer                          |
| `presence:update`  | broadcast by the server every 3 s                 |

So `report:generate` should top *Slowest responses*, and `file:upload` should top
*Heaviest payloads* and the bandwidth column.

## Options

| Env          | Default    | Effect                                       |
| ------------ | ---------- | -------------------------------------------- |
| `PORT`       | `3000`     | HTTP port                                    |
| `STORE`      | `memory`   | `redis` to store the metrics in Redis        |
| `REDIS_URL`  | local db14 | Redis connection string                      |
| `TRAFFIC`    | `1`        | `0` to start the server without any traffic  |
| `CLIENTS`    | `3`        | Number of simulated clients                  |
