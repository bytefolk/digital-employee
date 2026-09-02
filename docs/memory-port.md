# MemoryPort and pinned mem adapter

`MemoryPort` is the strict durable-memory seam for a local digital-organization
workspace. The first adapter speaks the public HTTP API of
[`mem`](https://github.com/bytefolk/mem). The adapter accepts an exact
`pinnedRevision` per instance; the operator supplies that value through the
workspace environment rather than relying on a revision compiled into this
package. Recall remains disabled unless the workspace binding sets `enabled` to
`true`. This checkout declares package version `0.6.1`; its source and packed
artifacts do not establish npm, tag, GHCR image, or GitHub Release availability,
which requires a release receipt. The CLI binding writes only a bounded
terminal task-state projection; it does not copy conversation history, resume
an Agent Host, extract model-authored memories, or grant access. The public
`0.6.0` engine preview can consume the underlying `MemoryPort` through explicit
`EngineMemoryOptions`; this workspace binding is source-tree preview behavior.

## Boundary

One adapter instance is permanently bound to all of these values:

- one digital-employee `workspaceInstanceId`;
- one mem workspace;
- one position and its derived principal `position.<positionId>`;
- one canonical, non-root virtual `memoryScope`;
- one environment-variable name containing a position-scoped mem Agent token.

The adapter reads the token from that environment variable only when an
operation starts. The token is sent only in the HTTP `Authorization` header.
It is not accepted as an option value and is never returned in a result,
written into task state, placed in a URL, or included in request JSON.

The adapter has no grant, revoke, archive, forget, registration, or admin
method. An operator must provision an exact workspace-bound Agent token with
only `read` and `write` permissions and a path no broader than
`memoryScope`. Grants and lifecycle operations stay on mem's operator-owned
admin surface. The pinned public capability response exposes effective
permissions and workspace identity, but not token paths, so token-path
provisioning remains an operator responsibility while mem enforces the path on
every request.

Before every write or recall, the adapter verifies `/v1/version` against the
pinned revision and checks the exact `/v1/capabilities` shape. It rejects a
credential that lacks `read` or `write`, exposes search/delete/admin/provider
mutation/export/import authority, or resolves to another workspace.

## Typed records

`task-state.v1` is a bounded, reviewed terminal projection:

```ts
interface TaskState {
  schemaVersion: "task-state.v1"
  taskId: string
  status: "completed" | "failed" | "cancelled"
  summary: string
  terminalOutputDigest: `sha256:${string}`
  recordedAt: string
}
```

It is not a transcript, tool grant, Host resume handle, credential carrier, or
chain-of-thought record. A write uses a deterministic idempotency key bound to
the workspace instance, session, turn, position, and terminal-output digest.
Success is returned only after an exact public-API readback matches the
canonical task state, scope, digest, lifecycle status, citation, state version,
and provenance.

`memory-recall.v1` bounds item count and UTF-8 bytes and returns citations,
locators, state versions, digests, provenance, timestamps, and `retrievedAt`.
Every recalled item is marked `trust: "untrusted"` and `authority: "none"`.
A caller must treat the text as data; it cannot grant tools, permissions,
identity, policy changes, or instructions.

Unknown fields, malformed identifiers, non-canonical paths, unexpected wire
responses, scope mismatches, and readback mismatches fail closed.

## Constructing the adapter

```ts
import { createMemHttpMemoryAdapter } from "@fullstack-ai-infra/digital-employee-core"

const memory = createMemHttpMemoryAdapter({
  baseUrl: "https://mem.example.com",
  memWorkspaceId: "00000000-0000-4000-8000-000000000001",
  workspaceInstanceId: "00000000-0000-4000-8000-000000000002",
  positionId: "sales-owner",
  memoryScope: "/workspaces/00000000-0000-4000-8000-000000000002/positions/sales-owner",
  tokenEnv: "MEM_SALES_OWNER_TOKEN",
  pinnedRevision: "4c714aa352f79f0080a24904668210d6c445ba10",
})
```

Set the named variable in the process environment through the operator's
secret manager. Do not render it into a workspace file or pass it on argv.
The returned value implements `MemoryPort`. An embedder may pass it through
`TurnExecutorOptions.memory` with the exact workspace, session, scope, mode,
and adapter identity binding. Omitting that option or setting `enabled: false`
performs no recall.

Recall mode is explicit:

- `optional` converts only a typed `MEMORY_UNAVAILABLE` outage into an empty
  recall with one retryable warning;
- `required` returns the stable error to its caller, which must stop before a
  model call;
- denial, bad configuration, unsupported contracts, malformed records, and
  scope mismatches always fail closed in both modes.

## First-party CLI binding

`workspace init` writes a disabled `memory` block into `workspace.json` and a
stable `workspaceInstanceId`. Enable it only after provisioning a position-
scoped mem token and grant. The workspace file contains variable names, never
endpoint, tenant, scope, revision, or token values:

```json
{
  "workspaceInstanceId": "<generated UUID>",
  "memory": {
    "schemaVersion": "workspace-memory.v1",
    "adapter": "mem-http.v1",
    "enabled": true,
    "mode": "optional",
    "baseUrlEnv": "MEM_HTTP_BASE_URL",
    "memWorkspaceIdEnv": "MEM_HTTP_WORKSPACE_ID",
    "pinnedRevisionEnv": "MEM_HTTP_PINNED_REVISION",
    "bindings": {
      "repo-owner": {
        "tokenEnv": "MEM_REPO_OWNER_TOKEN",
        "memoryScopeEnv": "MEM_REPO_OWNER_SCOPE"
      }
    },
    "limit": 10
  }
}
```

Set the referenced values in the operator environment, then pass a stable
`conversationRef` in the sealed turn envelope when separate conversations
need separate memory sessions. `turn run` performs recall before model
consumption and persists a digest-bound `task-state.v1` projection after a
completed turn. With `mode: "optional"`, a temporary mem outage leaves the
turn result usable but reports that the task state was not persisted; contract,
scope, credential, and revision failures remain fail-closed.

## Verification

The deterministic contract tests use a mocked public HTTP boundary:

```sh
npm exec -- tsx --test \
  tests/core/memory-port.test.ts \
  tests/core/mem-http-memory-adapter.test.ts
```

The E3 test requires a disposable loopback mem service built from the pinned
revision and backed by PostgreSQL. It provisions fresh fixtures, exercises
write/readback/replay/conflict, authorization denial and the complete
grant/token/archive/forget lifecycle, and then destroys its credentials and
data:

```sh
MEMORY_E3_RUN=1 \
MEMORY_E3_BASE_URL=http://127.0.0.1:<port> \
npm exec -- tsx --test tests/integration/mem-http-memory-adapter.e3.test.ts
```

Without `MEMORY_E3_RUN=1`, that external-service test skips. Published
evidence must contain only versions, digests, commands with placeholders, and
pass/fail counts—never tokens, admin credentials, response bodies,
transcripts, or absolute local paths. This verification does not run a live
Qoder or Claude Code Host.
