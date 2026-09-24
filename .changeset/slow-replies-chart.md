---
"@sockeye-js/core": minor
"@sockeye-js/store-memory": minor
"@sockeye-js/store-redis": minor
"@sockeye-js/ui": minor
---

Show response times over time in the message detail: each history bucket of a message now
carries the latency of the replies measured in it (median, p95, max…), so a moment where a
message took longer to be acknowledged stands out. Percentiles never exceed the exact maximum.
