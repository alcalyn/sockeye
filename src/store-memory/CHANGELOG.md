# @sockeye-js/store-memory

## 0.5.0

### Minor Changes

- 13f6a69: Show response times over time in the message detail: each history bucket of a message now
  carries the latency of the replies measured in it (median, p95, max…), so a moment where a
  message took longer to be acknowledged stands out. Percentiles never exceed the exact maximum.

### Patch Changes

- Updated dependencies [13f6a69]
  - @sockeye-js/core@0.5.0

## 0.4.0

### Minor Changes

- a74c33a: Count how many clients each message is sent to, so a broadcast to a room of 500 shows the
  bandwidth it really costs and a broadcast to an empty room shows none. The dashboard counts
  per client, and says how many clients one emit reached on average when that is more than one.

### Patch Changes

- Updated dependencies [a74c33a]
  - @sockeye-js/core@0.4.0

## 0.3.0

### Minor Changes

- Settings menu. Allow to add time marks on graphs.

### Patch Changes

- Updated dependencies
  - @sockeye-js/core@0.3.0

## 0.2.0

### Minor Changes

- 12d8568: Add bandwidth over time to measure impact of a change on bandwidth, per message

### Patch Changes

- Updated dependencies [12d8568]
  - @sockeye-js/core@0.2.0

## 0.1.0

### Minor Changes

- dd29785: First release: collectors for socket.io, `ws` and any other transport, in-memory and Redis
  stores, and a local dashboard showing message counts, bandwidth, payload sizes and response
  times per message type.

### Patch Changes

- Updated dependencies [dd29785]
  - @sockeye-js/core@0.1.0
