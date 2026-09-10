# Qoder command resolution: frozen v1 compatibility repair

Canonical bug: [#253](https://github.com/bytefolk/digital-employee/issues/253).
The [#254](https://github.com/bytefolk/digital-employee/pull/254) description calls
its consumed revision R1. The live Issue remains an ordinary bug report; this
repair does not introduce a new requirement revision or imply product approval.

Author baseline: `8b197e29f6f91124577ba76b32e149f2647c8904`.
Frozen pre-PR consumer source: `8a8a2a3a16c45e22c622b2d4ee8ff3698cc4ad4c`.
Local environment: macOS arm64, Node.js `26.7.0`, npm `11.19.0`.

## Regression and repair

Before editing implementation, three regression tests failed on the author
baseline: both Qoder and probe-only Codex emitted `resolvedCommand`, which an
independent copy of the old exact-key allowlist rejected; a simulated Windows
turn invoked the candidate version executor three times before rejecting the
unsupported platform. The expected count was zero.

The repaired core probe type, registry validator, wire validator, and shared
probe-only producer are byte-identical to the frozen pre-PR source. The
compatibility test pins its own old key list, checks serialized new producers,
and checks the current wire key list against that frozen list. Core tests also
reject `resolvedCommand` when its value is valid, malformed, or `undefined`.
Existing corpus digests and version/capability checks remain unchanged.

Qoder's local `probeWithCommand()` returns `{ command, probe }`. Only `probe`
is returned by the public `probe()` / `preflight()` contract. Execution consumes
its own local preflight command, never a field parsed from public diagnostics;
missing command state fails closed. No optional probe-field nonnull assertion
or mutable last-probed command is used. Successful discovery reports the
command through the existing `issues[]` shape; text is scrubbed before bounding.
Windows turn rejection precedes even the command resolver.

The regression commands below use synthetic version executors or isolated
fixture executables. They do not authenticate a provider or make paid requests.
The CN CLI test limits PATH to its generated fixture directory and exercises
doctor, setup, employee run, and turn run. The concurrency test stages two runs
on different CN commands, interleaves an aborted probe, and verifies two
separate successful terminal streams and the actual commands launched.

## Reproducible local checks

From the candidate checkout:

```sh
npm ci --ignore-scripts --no-fund
./node_modules/.bin/tsx --test --test-concurrency=1 \
  tests/apps/agent-host-probe-compat.test.ts \
  tests/apps/qoder-agent-host.test.ts \
  tests/apps/qoder-model-port.test.ts \
  tests/apps/turn-run.test.ts \
  tests/core/agent-host-registry.test.ts \
  tests/core/agent-host-wire.test.ts \
  tests/core/agent-host-vectors.test.ts
./node_modules/.bin/tsx --test --test-concurrency=1 \
  tests/apps/agent-host-registry.test.ts \
  tests/apps/agent-hosts.test.ts \
  tests/apps/cli-agent-host.test.ts \
  tests/apps/setup.test.ts
npm run check
./node_modules/.bin/tsx --test --test-concurrency=1 \
  --test-name-pattern='deployment lock deadline and supervised-helper matrix uses the real platform primitive' \
  tests/apps/deploy-cli.test.ts
npm run security:check
npm run governance:check
npm audit --omit=dev --audit-level=high
git diff --check
git diff 8a8a2a3a16c45e22c622b2d4ee8ff3698cc4ad4c --exit-code -- \
  packages/core/src/agent-host.ts \
  packages/core/src/agent-host-registry.ts \
  packages/core/src/agent-host-wire.ts \
  apps/cli/agent-hosts.ts
```

| Check | Observed result |
| --- | --- |
| Before implementation: old-consumer Qoder/Codex and Windows gate regressions | 0 passed, 3 failed; unexpected `resolvedCommand` and executor count `3 !== 0` |
| Focused compatibility, Qoder, turn, registry, wire, frozen vectors | 126 passed, 0 failed, 0 skipped |
| Built-in registry, shared probes, CLI, setup | 31 passed, 0 failed, 1 native-Windows skip |
| Typecheck and build | Passed |
| Security and governance | Passed; 7 allowlisted governance PR fixtures |
| Dependency install and production audit | Passed; 0 vulnerabilities |
| Full `npm run check` | Exit 1: 1888 passed, 2 failed (one child and its parent), 2 skipped; typecheck/build passed |
| Isolated replay of the full deployment-lock matrix, after the full suite finished | 14 passed, 0 failed, 0 skipped |
| Frozen consumer/producer file comparison and diff whitespace check | Passed; no differences in the four frozen files |

Tests clean their newly introduced fixture directories through test teardown.
Build output and local logs remain ignored; they are not source changes.

The full-suite failure was `direct real utility contention, watchdog close,
timeout, and successor` at `tests/apps/deploy-cli.test.ts:5113`: expected
`["SIGTERM"]`, observed `["SIGTERM", "SIGTERM"]`. Its parent matrix accounts
for the second failed count. Neither this test nor deployment configuration
code changed. The matrix is listed in `docs/flaky-tests.md`; its isolated
replay passed, but that does not retroactively make the full run pass or
establish the cause. No assertion, timeout, or security gate was weakened.
Fresh required CI remains necessary before any ready/merge claim.

## Changed file domains

| Files | Change |
| --- | --- |
| `packages/core/src/agent-host.ts`, `agent-host-registry.ts`, `agent-host-wire.ts`; `apps/cli/agent-hosts.ts` | Restore the exact frozen probe contract and shared producer |
| `apps/cli/qoder-agent-host.ts` | Separate local command state from public probes/preflight; bound and scrub diagnostics |
| `apps/cli/turn/turn-run.ts` | Reject Windows before discovery; consume the local command without a wire-field assertion |
| `tests/apps/agent-host-probe-compat.test.ts` | Independent frozen key list versus current producers |
| `tests/apps/qoder-agent-host.test.ts`, `turn-run.test.ts` | Public preflight, diagnostics, command authority, CN execution, concurrency, Windows gate |
| `tests/core/agent-host-registry.test.ts`, `agent-host-wire.test.ts` | Reject the removed field without relaxing other validation |
| `docs/agent-hosts.md`, this verification record, `CHANGELOG.md` | Match the public contract and record evidence/limits |

## Limits and handoff

- Windows evidence is an injected platform gate with a counted version executor,
  not native Windows conformance. The native Windows probe test is skipped on
  macOS. Real CN service and provider authentication are not verified.
- The old frozen validators already reject `not_spawnable` as a status. This
  repair preserves that rejection and tests it; it does not extend the enum or
  claim that every possible legacy producer result was accepted.
- Coverage, package-consumer, container/distribution, and the remote Node
  20/22/24 matrix have not been run for this local candidate. Prior-head CI
  results are not evidence for this candidate. The full run skipped the native
  Windows PATHEXT case and the live loopback mem/PostgreSQL case.
- Independent preflight and the final human review by `@Bindy-lbb` remain
  separate gates. This record is author verification, not an independent pass,
  GitHub approval, release, or acceptance of #253.
- Before publication, #254's description needs to match this candidate: remove
  the claim that consumers must upgrade for a new probe field, describe local
  command state and `issues[]`, update verification evidence, and correct the
  rollback explanation. The resolver works with the original frozen wire.
- Reverting this repair alone restores the incompatible baseline. Any rollback
  should preserve the frozen v1 producer shape and its strict validators.
