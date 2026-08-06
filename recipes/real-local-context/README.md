# Real-local context recipe (Issue #42 Phase A)

Read-only reference recipe that resumes durable memory and reads a
version-pinned document through **actual locally-running** `mem` and `doc`
services, driven end-to-end through the public Adapter/MCP boundary
(`runEmployeePackage` + `agent-host-stdio.v1`).

This recipe produces `real-local-e2e` evidence. It is the counterpart of
`recipes/synthetic-mcp-context` (which produces `synthetic-conformance`
evidence); the two evidence classes never share error-code namespaces:
synthetic uses `mcp_*`, this path uses `real_local_*`.

## Layout

- `component-matrix.json` — the **sole version authority**: exact pinned
  `mem` and `doc` commits, start commands, health endpoints and default
  ports. Anything not pinned here fails explicitly with
  `real_local_matrix_unsupported`.
- `employee/` — the portable employee package (declares `real-mem` and
  `real-doc` MCP servers, read-only policy, `mcp` host capability).
- `grant.template.json` — the operator-owned `capability-grant.v1`
  template. The harness materializes it **outside** the package directory
  with the actual workspace id; a grant found inside the package is
  rejected (`real_local_self_grant_rejected`).
- `scenarios.json` — the deterministic fault-scenario table: fixed seeded
  inputs mapped to expected stable `real_local_*` results. No wall-clock,
  network variance, or model output decides an expectation.

## Frozen decision codes

`real_local_matrix_unsupported`, `real_local_grant_missing`,
`real_local_grant_invalid`, `real_local_self_grant_rejected`,
`real_local_grant_revoked`, `real_local_scope_denied`,
`real_local_mode_excessive`, `real_local_item_unavailable`,
`real_local_revision_mismatch`, `real_local_contract_unsupported`,
`real_local_service_unavailable`.

## Running it

Single documented command (from the repository root, credential-free):

```
MEM_REPO_DIR=../mem DOC_REPO_DIR=../doc node ./scripts/real-local-harness.mjs
```

The harness verifies both service checkouts against the pinned matrix
commits, starts the services, seeds synthetic state (approved / superseded /
forgotten / unapproved memories, one pinned document), registers throwaway
local users and tokens, runs every scenario through
`apps/cli/real-local-stdio-host.ts`, emits a machine-readable evidence file
with `"class": "real-local-e2e"`, verifies no secret leaks into the
evidence, and tears everything down. `--keep` skips teardown.

All service URLs must be loopback (`http://127.0.0.1`); the host refuses
anything else. No model credential, DWS, or external network is involved.

## Boundaries

- Read-only: any write-mode MCP tool request fails with
  `real_local_mode_excessive`; the doc path never mutates.
- Revoked, unlisted and absent documents are indistinguishable by the doc
  API's non-enumeration design; all map to `real_local_item_unavailable`.
- Phase B (reviewed write) and Phase C (portability) are out of scope until
  their dependency gates open (#42 R3).
