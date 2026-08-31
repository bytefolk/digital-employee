# Explicit single-hop delegation

The S3-P0 delegation seam implements the bounded engine slice approved in
[Issue #158 R3](https://github.com/fullstack-ai-infra/digital-employee/issues/158)
and [Issue #165 R4](https://github.com/fullstack-ai-infra/digital-employee/issues/165).
It is a released preview in the public npm `0.6.0` package (first published in
`0.5.0`), but it is not a live-qualified capability. This checkout declares
package version `0.6.1`; source and packed artifacts do not establish npm, tag,
GHCR image, or GitHub Release availability, which requires a release receipt.

## Ownership boundary

Digital Employee owns the portable `delegation-envelope.v1`,
`delegation-event.v1`, and requested `task.v1` initializer, canonical digests,
applied-organization and permission revalidation, direct-report authorization,
intersection-only effective scope, and one child Host execution. The Workbench
owns the explicit user action, durable conversation/task/turn files,
cancellation requests, restart repair, and the authoritative retry history.
For each invocation it exposes a bounded read-only snapshot of that history to
the CLI; the engine validates the snapshot but never writes it. API/SSE and
presentation of the responsibility chain also remain Workbench-owned.

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
digital-employee task delegate [workspace] --stdin \
  --history-file <workspace-local-history.json>
```

The workspace must already contain real, non-symlinked applied state at
`.digital-employee/org.json` and `.digital-employee/permissions.json`. The CLI
recomputes both canonical digests, verifies that permissions are the exact
derivation of the applied organization, resolves the worker package from that
state, requires the package to stay inside the workspace, and verifies its
declared package digest before the Host result can be trusted.

`--history-file` is required at the CLI boundary, must resolve to a real
non-symlinked file inside the workspace, and is capped at 4 MiB / 1024 exact
reference records. An empty JSON array is the authoritative first-attempt
snapshot. Each record has exactly `taskId`, `parentTurnId`, `childTurnId`,
`attempt`, and `retryOfTaskId`. For one parent turn, records must form one
contiguous chain: attempt 1 has no predecessor and each later attempt points
to the immediately preceding task. Duplicate identities, duplicate attempt
numbers, gaps, branches, and stale predecessor references fail before Host
preflight. The CLI never creates or retries a task automatically.

Before Host preflight the engine projects the parent/worker intersection into
the actual `runEmployeePackage` request. Context grants are workspace-relative;
`Read` maps only to filesystem read, while `Grep`/`Glob` are required for
filesystem search. Writes, employee data-plane network, MCP, approvals, and
downstream delegation are denied. An unexpressible authority fails before a
Host process is spawned.

Stdout is ordered `delegation-event.v1` NDJSON. Exit `0` means exactly one
trusted `delegation.completed`, `delegation.failed`, or
`delegation.cancelled`. Exit `1` means preflight, spawn, process, or protocol
uncertainty: no terminal is fabricated and the Workbench must record
`indeterminate` without retrying automatically. `assistant.delta` / model
deltas are never projected as a delegation answer.

`delegation.started` is derived only from a validated child `run.started`.
Package inspection, Adapter resolution, preflight, spawn failure, or
abort-before-start emits no false running transition. Once started, the engine
emits ordered usage followed by exactly one trusted terminal, or leaves the
task indeterminate if the Host process/protocol becomes uncertain.

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

The portable helpers are consumable from the installed root artifact through
`@fullstack-ai-infra/digital-employee/engine`; the distribution smoke imports
that exact subpath after packing and installing the candidate. The standalone
`@fullstack-ai-infra/digital-employee-engine` workspace package is not claimed
or qualified by this slice.

## Evidence boundary

The deterministic E3 suite executes the identical contract path for `qoder`
and `claude-code` without invoking a real model. It covers route/scope
negatives, event ordering, modeled failure, cancellation, process ambiguity,
duplicate admission, and explicit retry identity. This does **not** make either
Host live-qualified. Qoder and Claude Code each require a separate E4 run on
an authorized machine; one Host's evidence cannot qualify the other. In
particular, no Claude Code live run is part of the local E3 suite.
