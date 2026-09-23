---
"@sockeye-js/collect-socketio": minor
"@sockeye-js/collect-websocket": minor
"@sockeye-js/collect-ws": minor
"@sockeye-js/core": minor
"@sockeye-js/store-memory": minor
"@sockeye-js/store-redis": minor
"@sockeye-js/ui": minor
---

Count how many clients each message is sent to, so a broadcast to a room of 500 shows the
bandwidth it really costs and a broadcast to an empty room shows none. The dashboard counts
per client, and says how many clients one emit reached on average when that is more than one.
