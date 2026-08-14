# External stdio Agent Host Adapters (`agent-host-stdio.v1`)

Issue #33 R1 ships one versioned contract for external Agent Hosts. There is
no plugin marketplace, no auto-discovery, and no remote installer: an operator
explicitly registers one digest-pinned executable at a time.

## Wire protocol

- Transport: child process stdio, one JSON message per line (JSONL).
- Envelope: `{protocol: "agent-host-stdio.v1", id, kind, ...}`. `id` is the
  outer runtime's exchange identifier and is echoed on every reply.
- Requests (`kind`): `probe`, `preflight`, `run`, `cancel`. `run` and
  `preflight` carry an `agent-host.v1` run request; `cancel` carries exactly
  `{runId}`.
- Replies: `kind: "response"` with `ok: true` + `result`, or `ok: false` +
  `{code, message, retryable}`; `kind: "event"` carries one validated
  `agent-host.v1` native event.
- Stdout carries protocol messages only. Diagnostics go to stderr, bounded,
  and are never surfaced unbounded to callers.
- Every unknown protocol version, unknown field, malformed line, oversized
  line, or unsolicited message fails closed.

A run exchange ends with exactly one terminal event (`run.completed` or
`run.failed`), followed by a closing success response. Anything after the
terminal, or a second terminal, is a contract violation.

## Local configuration (`agent-host-stdio-config.v1`)

```json
{
  "schema": "agent-host-stdio-config.v1",
  "hostId": "example-host",
  "displayName": "Example Host",
  "executable": "/opt/hosts/example-host",
  "args": ["serve"],
  "digest": { "algorithm": "sha256", "hex": "<64 hex chars>" },
  "envAllowlist": ["PATH"],
  "workingDirectoryPolicy": "request",
  "timeoutMs": 30000,
  "maxStderrBytes": 16384
}
```

Rules enforced by `validateStdioAdapterConfig`:

- one explicit literal executable path; no globs, shell expansion or
  interpolation; pinned by a sha256 digest verified before every spawn;
- fixed literal arguments; no directory scanning;
- environment propagation is strictly allowlisted (unique `UPPER_SNAKE`
  names); nothing else reaches the child;
- explicit working-directory policy (`request` or `config_directory`);
- bounded timeout (1s–600s) and bounded stderr diagnostics.

An employee package can never select or ship Adapter executables.

## CLI

```
digital-employee stdio-host <config.json>            # probe
digital-employee stdio-host <config.json> --question "..." [--json]
```

## Reference Adapter

`apps/cli/reference-stdio-host.ts` is the deterministic reference
implementation. Violation fixtures are selected with `REFERENCE_STDIO_*`
environment flags (hang, duplicate terminal, event after terminal, unknown
probe field, missing capability, disallowed tool, leaked process tree) so the
fail-closed paths are reproducible in CI.

## Qualification

An Adapter cannot be reported as supported on fixture evidence alone: run the
Issue #52 qualification kit against it to produce an
`adapter-qualification-record.v1` record
(`tests/apps/stdio-agent-host.test.ts` shows the integration). The complete
case matrix, timeout bounds, direct deny evidence, and real two-generation
cleanup fixture contract are documented in
[`adapter-qualification.md`](adapter-qualification.md).

Stdio isolation is a process boundary, not a multi-tenant sandbox.
