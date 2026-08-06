# Real-local e2e (Issue #42 Phase A)

The real-local path proves that one neutral employee package can resume
scoped durable memory and read a version-pinned document through **actual
locally-running** `mem` and `doc` services, driven end-to-end through the
public Adapter/MCP boundary. It produces the `real-local-e2e` evidence class;
fixture-backed proof stays `synthetic-conformance` and optional live-provider
evidence stays `live-provider`. Only `real-local-e2e` satisfies #42.

## Pieces

| Piece | Path |
| --- | --- |
| Component matrix (sole version authority) | `recipes/real-local-context/component-matrix.json`, validated by `packages/core/src/component-matrix.ts` |
| Deterministic Agent Host fixture | `apps/cli/real-local-stdio-host.ts` (`agent-host-stdio.v1`, `real_local_*` fail-closed codes) |
| Employee package + operator grant template | `recipes/real-local-context/` |
| Deterministic fault scenarios | `recipes/real-local-context/scenarios.json` |
| Harness (bootstrap, run, evidence, cleanup) | `scripts/real-local-harness.mjs` |
| Offline host verification | `tests/apps/real-local-host.test.ts`, `tests/core/component-matrix.test.ts` |

## Single documented command

```
npm ci && npm run build
MEM_REPO_DIR=../mem DOC_REPO_DIR=../doc node ./scripts/real-local-harness.mjs
```

Requirements: Docker, Go (for the pinned `memd`), Node >= 24, and sibling
checkouts of `mem` and `doc` at exactly the commits pinned in the component
matrix — anything else fails explicitly (`real_local_matrix_unsupported`).
Zero credentials: every user, token and grant is generated locally against
loopback services and torn down afterwards (`--keep` to inspect).

## Behavior contract

- The host resolves the employee's declared `real-mem` server through the
  pinned `durable-context.v1` HTTP contract and `real-doc` through the doc
  bearer API with client-side ETag revision pinning.
- Every read is gated twice: by the operator-owned `capability-grant.v1`
  file materialized **outside** the package, and by the service's own
  operator grants (mem) / ownership (doc).
- Service URLs must be loopback `http://`; anything else is refused.
- Denial and degradation map to the frozen `real_local_*` namespace (see
  `recipes/real-local-context/README.md`); synthetic `mcp_*` codes are never
  emitted on this path.
- The harness's evidence JSON carries `"class": "real-local-e2e"`, the
  matrix digest and per-scenario results, and is scanned to contain no live
  token and no private path before it is written.

## CI boundary

Default CI stays offline: it runs the deterministic host/matrix tests
against loopback in-process fakes (`synthetic-conformance`-grade logic
verification). The `real-local-e2e` run is a manual, operator-driven
command; its evidence is recorded in the issue ledger, never fabricated in
CI.
