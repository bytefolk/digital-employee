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

A position may declare optional `connectors.json` (`position-connectors.v1`)
next to `employee.json`. `org apply` validates `channels` and `sources`
against the CLI connector registry vocabulary. Bindings may carry only
environment-variable names; inline credentials, traversal paths, unknown
fields, and unregistered ids fail closed. An absent file changes nothing.
This slice does not bind connectors at runtime (#310). A later derived-artifact
revision (#311) may copy a validated declaration onto the role as optional
`connectors` plus digest; an absent file still omits the field.

Connector contributions must document provider permissions, data sent across
the boundary, retention behavior, time/size limits, and rejected input tests.
See `CONTRIBUTING.md`.
