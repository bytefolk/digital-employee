# Explicit single-hop delegation

The S3-P0 delegation seam implements the bounded engine slice approved in
[Issue #158 R3](https://github.com/fullstack-ai-infra/digital-employee/issues/158)
and [Issue #165 R4](https://github.com/fullstack-ai-infra/digital-employee/issues/165).
It is a source-level preview after public npm `0.4.0`, not a released or
live-qualified capability.

## Ownership boundary

Digital Employee owns the portable `delegation-envelope.v1`,
`delegation-event.v1`, and requested `task.v1` initializer, canonical digests,
applied-organization and permission revalidation, direct-report authorization,
intersection-only effective scope, and one child Host execution. The Workbench
owns the explicit user action, durable conversation/task/turn files,
cancellation requests, restart repair, retry admission history, API/SSE, and
presentation of the responsibility chain.

The first slice is deliberately small:

- one trusted completed parent turn to one declared direct report;
- `trigger=user_explicit`, `delegationDepth=1`;
- Qoder or Claude Code only, with no silent fallback;
- no autonomous routing, worker-originated delegation, fan-out, recursion,
  parallel graph, or automatic retry;
- Context and tool scope can only intersect or narrow; writes and downstream
  delegation remain denied.

## CLI wire boundary

The Workbench seals one exact envelope and passes it on stdin:

```text
digital-employee task delegate [workspace] --stdin
```

The workspace must already contain real, non-symlinked applied state at
`.digital-employee/org.json` and `.digital-employee/permissions.json`. The CLI
recomputes both canonical digests, verifies that permissions are the exact
derivation of the applied organization, resolves the worker package from that
state, requires the package to stay inside the workspace, and verifies its
declared package digest before the Host result can be trusted.

Stdout is ordered `delegation-event.v1` NDJSON. Exit `0` means exactly one
trusted `delegation.completed`, `delegation.failed`, or
`delegation.cancelled`. Exit `1` means preflight, spawn, process, or protocol
uncertainty: no terminal is fabricated and the Workbench must record
`indeterminate` without retrying automatically. `assistant.delta` / model
deltas are never projected as a delegation answer.

The CLI forwards its first `SIGINT` or `SIGTERM` as an `AbortSignal` to the
selected Host. A bounded, trusted cancellation result produces
`delegation.cancelled`; if the Host/process cannot settle the cancellation
contract, the CLI produces no terminal and the Workbench records
`indeterminate`.

The envelope carries exact required fields:

```json
{
  "schemaVersion": "delegation-envelope.v1",
  "taskId": "task-opaque",
  "parentTurnId": "turn-parent",
  "childTurnId": "turn-child",
  "delegatedBy": "repo-owner",
  "routedTo": "issue-researcher",
  "trigger": "user_explicit",
  "delegationDepth": 1,
  "attempt": 1,
  "retryOfTaskId": null,
  "engine": "qoder",
  "instruction": "bounded explicit instruction",
  "organizationDigest": "sha256:<64hex>",
  "permissionsDigest": "sha256:<64hex>",
  "deadline": "RFC3339",
  "envelopeDigest": "sha256:<64hex>"
}
```

All unknown fields, stale digests, unsupported engines, invalid reporting
lines, self-routes, worker-originated routes, widened scopes, and ambiguous
retry identities fail before child execution.

## Evidence boundary

The deterministic E3 suite executes the identical contract path for `qoder`
and `claude-code` without invoking a real model. It covers route/scope
negatives, event ordering, modeled failure, cancellation, process ambiguity,
duplicate admission, and explicit retry identity. This does **not** make either
Host live-qualified. Qoder and Claude Code each require a separate E4 run on
an authorized machine; one Host's evidence cannot qualify the other. In
particular, no Claude Code live run is part of the local E3 suite.
