# Adapter qualification

`runQualificationSuite` produces an `adapter-qualification-record.v1` record
from repository-owned, offline evidence. Kit version `1.3.0` hardens every
case with a wall-clock bound and requires direct evidence for cancellation,
default-deny policy enforcement, secret handling, process-tree cleanup,
Adapter-enforced terminal output Schema validity, and the read/search-only
workspace projection.

Qualification does not discover, install, or trust an Adapter. The caller
registers the Adapter and supplies a working directory plus a deterministic
process fixture:

```ts
const record = await runQualificationSuite(adapter, {
  workingDirectory,
  generatedAt: new Date().toISOString(),
  caseTimeoutMs: 30_000,
  processTreeFixture,
})
```

`caseTimeoutMs` defaults to 30 seconds and must be an integer from 1,000 to
600,000 milliseconds. The bound is applied independently to each case. Every
value, error, overflow, and timeout goes through one awaited finalizer: abort
the case, await cancellation on the exact Adapter that owns each run, then
await iterator return and fixture disposal. A hung body that responds to abort
records `qualification_case_timeout` and the next case may run only after
teardown settles. If teardown itself does not settle within its separate
bounded grace, the entire suite fails with `QUALIFICATION_CLEANUP_TIMEOUT` and
does not emit a record.

## Evidence matrix

The record contains 20 cases across ten domains:

| Domain | Case | Required evidence |
| --- | --- | --- |
| `capability_negotiation` | `probe_contract` | A complete `agent-host.v1` probe for the registered host. `capabilitySource` is exactly `adapter_declaration` or `conformance_test`; `version` is non-empty and at most 256 characters. |
| `native_event_validation` | `events_well_formed` | Every native event validates and the bounded stream closes. |
| `single_terminal_outcome` | `exactly_one_terminal` | Exactly one terminal event is last. |
| `deadline_cancel` | `cancel_stops_active_run` | The kit observes `run.started`, then calls `cancel`, then observes exactly one final `run.failed` and no later event. |
| `process_tree_cleanup` | `descendants_disposed_normal` | A real child and its real grandchild are alive during a normally completing run and absent after fixture disposal. |
| `process_tree_cleanup` | `descendants_disposed_timeout` | The same two-generation evidence is collected for a run that stays active until its deadline and is cancelled. |
| `process_tree_cleanup` | `descendants_disposed_cancel` | The same two-generation evidence is collected for an explicitly cancelled active run. |
| `credential_boundaries` | `no_metadata_echo` | A sentinel placed in request metadata is absent from events, partial streams, malformed values, rejected promises, thrown errors, and the final record. |
| `filesystem_network_enforcement` | `hostile_write_refused` | The typed `filesystem.write` qualification operation is rejected with `qualification_filesystem_policy_denied` during preflight or after `run.started` in one final `run.failed`. |
| `filesystem_network_enforcement` | `network_deny_refused` | The typed `network.connect` qualification operation is rejected with `qualification_network_policy_denied` during preflight or after `run.started` in one final `run.failed`. |
| `tool_mcp_enforcement` | `tool_allowlist_respected` | No event reports a tool outside the frozen allowlist. |
| `tool_mcp_enforcement` | `mcp_deny_refused` | The typed `mcp.invoke` qualification operation is rejected with `qualification_mcp_policy_denied` during preflight or after `run.started` in one final `run.failed`. |
| `output_schema` | `valid_json` | A run against the frozen closed case Schema ends in exactly one terminal whose output is strict JSON conforming to that Schema. |
| `output_schema` | `non_json` | A non-JSON terminal is never forwarded: the run ends in exactly one typed final `run.failed` and no `run.completed`. |
| `output_schema` | `schema_mismatch` | A Schema-violating terminal is never forwarded: the run ends in exactly one typed final `run.failed` and the offending output bytes are never echoed. |
| `output_schema` | `invalid_schema_preflight` | An invalid Schema (the canonical `$async: true` hazard) is rejected before any `run.started` and before any model process, in exactly one typed final `run.failed`. |
| `output_schema` | `cancel_buffered` | Cancellation wins over success: buffered partial output is never flushed as `run.completed`, and the run ends in exactly one typed final `run.failed`. |
| `output_schema` | `secret_rejected` | A terminal carrying the credential sentinel is rejected in exactly one typed final `run.failed`; the sentinel never appears in events, errors, or the record. |
| `readonly_projection` | `read_search_only` | A projection run ends in exactly one final `run.completed`, every tool event stays within the frozen read-only pair (`read_file`, `search_workspace`), and both tools are exercised. |
| `readonly_projection` | `write_tool_refused` | A write through the projection is rejected with `qualification_filesystem_policy_denied` during preflight or after `run.started` in one final `run.failed`, and no tool event ever executes for it. |

The sentinel scanner is bounded and cycle-safe. It inspects string and symbol
data properties without invoking getters or custom serializers. Accessors,
Proxies, descriptor failures, and budget exhaustion produce an `incomplete`
scan and fail closed; a sentinel produces `detected`. Teardown errors are
awaited and scanned before another case or a record is allowed. The same scan
is applied before externally supplied records are read. Evidence records
contain only the frozen machine-readable fields; diagnostics, raw exceptions,
paths, credentials, and process IDs are never copied into the record.

## Process-tree fixture contract

`processTreeFixture.create(scenario)` must return the exact process-backed
Adapter instance being qualified. The Adapter exposes an opaque configuration
digest and real owner PID through `qualificationIdentity()`; the kit rechecks
that identity plus the original probe fingerprint and Host version for every
scenario. `descendants()` returns the PID of a real child and that child's real
grandchild. The kit independently verifies their parent relationship, process
group, start identities, and liveness. Both PIDs must be absent after the
fixture's idempotent, awaited `dispose()` finishes.

The kit invokes the fixture separately for `normal`, `timeout`, and `cancel`.
If the fixture is missing, malformed, substitutes another Adapter, drifts its
probe/configuration/version, supplies unrelated PIDs, or leaves either
descendant alive, all affected cleanup evidence fails closed. Synthetic PID
claims and leader-only cleanup cannot earn `fixtureConformant`.

The reference implementation is exercised in
`tests/apps/stdio-agent-host.test.ts`; the in-memory protocol fixture is
exercised in `tests/core/adapter-qualification.test.ts`.

## Evidence axes

- `implemented` requires the exact probe contract and canonical capability
  source.
- `fixtureConformant` requires `implemented` and every deterministic case to
  pass.
- `liveQualified` is false unless the caller explicitly supplies validated,
  digest-addressed `liveEvidence`.

The kit never calls a live model or provider itself. Fixture conformance is
not vendor certification, entitlement validation, or a commercial deployment
gate.

## Evidence standard and per-release snapshot

Every capability claim must carry four standardized, machine-checkable
fields — this codifies what
[`docs/agent-hosts.md`](agent-hosts.md) already states for the exact-version
evidence table and the frozen vector corpora:

1. **Exact Host version** (`hostId` + `hostVersion`). Ranges and unbounded
   families are not evidence; the claim names the precise version the corpus
   ran against.
2. **Deterministic fixture version** (`kitVersion`). The versioned
   qualification corpus the evidence was earned against; unknown versions
   fail closed.
3. **The evidence boundary** (`axes.implemented` / `axes.fixtureConformant` /
   `axes.liveQualified`). `fixtureConformant` is repository-owned offline
   evidence; `liveQualified` may only be set by digest-addressed
   `liveEvidence` and is never produced by default CI.
4. **Fixture-corpus digest** (`fixtureCorpusDigest`): sha256 over the
   canonical JSON encoding of the kit's frozen `[domain, case]` contract in
   declared order (`qualificationFixtureCorpusDigest`). A verifier recomputes
   the digest from the claimed kit version instead of trusting the claimant.

`createQualificationSnapshot(record, { release })` derives a machine-readable
`adapter-qualification-snapshot.v1` claim from a qualification record, and
`validateAdapterQualificationSnapshot` enforces the standard: a claim missing
any required field, carrying an unknown field, naming an unknown kit version,
carrying a digest that does not match the named corpus, omitting or
duplicating a domain row, under-reporting the corpus counts, or asserting
axes that disagree with its own rows is rejected. Snapshots never carry
policy bytes, credentials, paths, or process IDs.

The committed per-release snapshot lives at
`fixtures/qualification/snapshots/v<release>.json`; the baseline is
[`v0.4.0`](../fixtures/qualification/snapshots/v0.4.0.json) (kit `1.1.0`, the
13-case corpus the v0.4.0 release gate proved against the reference stdio
Host). The release regression harness re-runs the full vector set against the
reference Host, derives the current snapshot, and compares it against the
baseline with `compareQualificationSnapshots`, which fails closed when the
Host identity or exact version drifts, the kit version regresses, an evidence
axis flips from true to false, a previously earned domain row disappears, or
an earned case count shrinks. New or strengthened evidence always passes. The
harness runs in `tests/apps/stdio-agent-host.test.ts`, which is part of
`npm run check` — executed by CI on every change and by the release workflow
before any publish. Cutting a release means adding that release's snapshot
file next to the baseline so the next harness run compares against it.

## Record compatibility

New runs always emit kit `1.3.0` with the 20-case contract above. The v1
record validator also accepts the three earlier published contracts under
their own case sets and domain sets: kit `1.2.0` (the 18-case contract without
`readonly_projection`), kit `1.1.0` (the 13-case contract ending in
`terminal_output_matches_schema`), and kit `1.0.0` (the original nine-case
contract with `cancel_stops_run` and `stream_terminates`). For every accepted
version it rejects missing, extra, duplicated, or cross-domain cases and
recomputes every domain count and evidence axis from the cases and optional
live evidence. A pre-`1.3.0` record that carries `readonly_projection` fails
closed, exactly like a `1.3.0` record that drops it. Unknown kit versions
fail closed.
