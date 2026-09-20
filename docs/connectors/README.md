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

## Position declaration (`position-connectors.v1`, #310)

A position may optionally ship `positions/<id>/connectors.json`:

```json
{
  "schemaVersion": "position-connectors.v1",
  "sources": [{ "id": "filesystem", "env": "FILESYSTEM_ROOT" }],
  "channels": [{ "id": "console" }]
}
```

`id` must be a **registered** CLI connector (`apps/cli/registry.ts`). Disk
paths under `connectors/sources/mem` or `doc` are **not** vocabulary until
registered. Credentials belong in environment variable *names* (`env`), never
inline secrets. An absent file leaves `org apply` unchanged. Nothing consumes
these bindings at runtime yet.
