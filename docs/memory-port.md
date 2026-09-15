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

The opt-in E3 lane requires an **actual published memd artifact**, a disposable
service using that artifact, and isolated PostgreSQL. It never starts a server,
builds mem, or configures Docker. The service operator must first establish
that the endpoint belongs to the disposable stack and record its launch
artifact. Loopback alone is not proof of isolation.

The lane checks the downloaded artifact's SHA-256, the configured version
assertion, and readiness before registering a fresh synthetic user/workspace.
It then exercises write/readback/replay/conflict, authorization denial, and
grant/token/archive/forget lifecycle. It also launches the built
`digital-employee turn run` CLI with a generated workspace configuration and
`mode: "required"`. The model uses the existing deterministic fixture port;
every memory operation goes to the real service. A successful terminal,
idempotent replay of the exact CLI write, and subsequent recall of that record
are required. The receipt reports adapter identity and the synthetic scope.

The test changes grants and tokens **only in its newly registered workspace**.
It deletes its generated local CLI workspace and restores its process token
variable, but does not delete the server-side user/workspace or all records.
Afterwards the operator must tear down the exact disposable stack and its
data. Never point this test at personal or production memory.

### Manual release gate (AC-001 / AC-004)

First select a release that actually contains a `memd-*` server asset.
`mem-mcp-*`, source archives, locally rebuilt binaries, and an HTTP fixture do
not satisfy this lane. Read the release metadata and checksum, download the
exact asset, and record the operator's isolated-service launch identity:

```sh
gh release view '<published-tag>' --repo bytefolk/mem \
  --json tagName,assets,url
mkdir -p .cache/memory-e3-artifact
gh release download '<published-tag>' --repo bytefolk/mem \
  --pattern '<exact-memd-asset-name>' --dir .cache/memory-e3-artifact
shasum -a 256 '.cache/memory-e3-artifact/<exact-memd-asset-name>'
```

Do not continue if the published server or its supported bootstrap contract is
missing. Use the mem release's documented isolated-service setup, then run
from this repository's root. The artifact path refers to the bytes actually
used to launch that service; the checksum must come from the release metadata,
not merely from the local file:

```sh
export MEMORY_E3_DISPOSABLE=1
export MEMORY_E3_BASE_URL='http://127.0.0.1:<isolated-port>'
export MEM_HTTP_PINNED_REVISION='<exact-published-server-version-value>'
export MEMORY_E3_ARTIFACT_URL='https://github.com/bytefolk/mem/releases/download/<published-tag>/<exact-memd-asset-name>'
export MEMORY_E3_ARTIFACT_PATH='.cache/memory-e3-artifact/<exact-memd-asset-name>'
export MEMORY_E3_ARTIFACT_SHA256='<64-lowercase-hex-digest-from-release>'

npm ci --ignore-scripts
npm run build
MEMORY_E3_RUN=1 \
npm exec -- tsx --test tests/integration/mem-http-memory-adapter.e3.test.ts
```

Without `MEMORY_E3_RUN=1`, that external-service test skips. An opted-in run
with missing inputs fails; it never skips or silently uses a default revision.
Examples of named failures are `MEMORY_E3_DISPOSABLE_REQUIRED`,
`MEMORY_E3_ARTIFACT_URL_REQUIRED`, `MEMORY_E3_ARTIFACT_DIGEST_MISMATCH`,
`MEMORY_CONTRACT_UNSUPPORTED`, and `MEMORY_REVISION_MISMATCH`.
The helper's regression tests use synthetic bytes/metadata only:

```sh
npm exec -- tsx --test tests/integration/memory-e3-prerequisites.test.ts
```

The artifact hash and server version checks do not remotely attest a running
process. Attach the operator's public-safe artifact/launch receipt along with
the lane output, timestamp, tested digital-employee commit, exit code and
pass/fail/skip counts. A manual gate is complete only after this actual run;
writing the lane or passing its prerequisite tests is not acceptance.

Published evidence must contain only versions, digests, commands with placeholders, and
pass/fail counts—never tokens, admin credentials, response bodies,
transcripts, or absolute local paths. This verification does not run a live
Qoder or Claude Code Host.

### Last investigation: 2026-09-09 — real acceptance NOT VERIFIED

Both [digital-employee #245 R1](https://github.com/bytefolk/digital-employee/issues/245)
and its dependency [mem #151 R1](https://github.com/bytefolk/mem/issues/151)
remain the acceptance contract. AC-001 and AC-004 are not removed or deferred
to a replacement issue.

| Check | Observed evidence | Consequence |
| --- | --- | --- |
| Published artifact | [mem v0.1.1](https://github.com/bytefolk/mem/releases/tag/v0.1.1), release commit `cc727db0bc72655f299166de1f60756f5c686cc7`: six `mem-mcp` binaries and their checksums; no `memd` server asset | No released server was available for this lane |
| Current release path | [release workflow at mem `2986fe3`](https://github.com/bytefolk/mem/blob/2986fe38175f54d99f15dd38a498708c6ecd88cd/.github/workflows/release.yml) builds only `./cmd/mem-mcp`; [deployment docs](https://github.com/bytefolk/mem/blob/2986fe38175f54d99f15dd38a498708c6ecd88cd/docs/DEPLOYMENT.md) instruct operators to build their own images | A Dockerfile or source build is not a published server receipt |
| Protocol | [server version handler](https://github.com/bytefolk/mem/blob/2986fe38175f54d99f15dd38a498708c6ecd88cd/server/internal/api/api.go) returns only `{"version": Version}`; the default is `dev`, and the Docker build injects one version string | This adapter can assert a configured exact string, but mem #151's separate semantic-version, revision and contract fields are not present; adding fields would require a coordinated adapter contract change |
| Local prerequisites | `docker context ls` selected `default`; `docker version` found client 29.5.0 but no configured daemon socket; `memd` was not on PATH, and no listener was found on standard ports 8080/5432 | No isolated live stack was verified; Docker, permissions and personal stores were not changed |
| Baseline live attempt | `MEMORY_E3_RUN=1` with endpoint unset: 0 passed, 1 failed at the loopback URL assertion, before HTTP | This was a prerequisite failure, not a real mem run |
| Repaired gate attempt | Opted in with disposable/loopback/version inputs but no artifact URL: exit 1, 0 passed, 1 failed with `MEMORY_E3_ARTIFACT_URL_REQUIRED`, before HTTP | Missing release provenance is now a named failure; real acceptance remains unverified |
| Prerequisite regressions | `npm exec -- tsx --test tests/integration/memory-e3-prerequisites.test.ts`: 5 passed, 0 failed | Synthetic metadata/bytes only; no real server evidence |

The real-service last-run receipt is **absent**. Local fixture/unit results,
including the prerequisite regressions, cannot close AC-001/AC-004. Re-run
this documented gate when mem #151 supplies a compatible published server and
supported bootstrap path; attach the actual result before requesting acceptance.
