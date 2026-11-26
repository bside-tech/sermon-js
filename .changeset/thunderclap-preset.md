---
"sermon-js": minor
---

New `thunderclap` preset for Thunderclap realtime. It checks the realtime server's `/health`; given the app's public `key`, that a client WebSocket connection is accepted; and, given an organisation API key, reads the Usage API's monthly summary: peak connections and messages as usage bars against the plan, degraded at 90%. Thunderclap organisation API keys (`tc_org_…`) are now redacted by shape, like other well-known keys, even when not declared in `secrets`.
