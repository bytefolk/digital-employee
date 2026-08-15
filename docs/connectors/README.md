# Connector matrix

| Connector | Direction | Permission model | Default |
| --- | --- | --- | --- |
| Console | channel | Local process | Enabled in demo |
| HTTP | channel | Loopback; optional bearer token | Available |
| DingTalk Stream | channel | App credentials and Stream subscription | Optional |
| Filesystem | source | Explicit directory | Enabled in demo |
| Git | source | Credential-free HTTPS repository; isolated cache; no shell; refresh fails closed, optional validated last-known-good | Optional |
| DWS | source | Explicit profile and read-only approved queries | Optional |
| Extractive | model | Local process | Enabled in demo |
| OpenAI-compatible | model | Environment-supplied API key | Optional |

Connector contributions must document provider permissions, data sent across
the boundary, retention behavior, time/size limits, and rejected input tests.
See `CONTRIBUTING.md`.
