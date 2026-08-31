# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.6.1] - 2026-08-31

### Changed

- Document the release-availability boundary for the immutable `0.6.0` npm
  artifacts. The source package version `0.6.1` and packed artifacts do not
  establish an npm package, tag, GHCR image, or GitHub Release; the release
  receipt is required. Current-facing documentation retains the recorded public
  `0.6.0` evidence and the explicit opt-in `MemoryPort` wiring boundary.

## [0.6.0] - 2026-08-29

### Changed

- Public documentation no longer embeds non-synthetic conversation captures;
  `security:check` now fails closed on unreviewed `docs/assets` binaries,
  Alibaba Cloud access-key shapes, signed object-storage URLs, and
  enterprise-internal URLs (#207).
- The Claude Code host adapter now accepts an optional `ANTHROPIC_BASE_URL`
  and forwards it into the spawned `claude` process after HTTPS (or loopback
  HTTP) validation without embedded credentials, matching the Qwen Code
  adapter's `OPENAI_BASE_URL` parity (#215). An invalid configured value
  fails `probe`/`preflight` closed with `claude_base_url_invalid`, and the
  HTTP deploy channel forwards the variable for the `claude-code` engine.

### Added

- `turn-envelope` bumps to `v1alpha2` with a strictly additive, optional
  `conversationRef` back-link field (#205, DE-CONVREF-001): an opaque
  workbench-generated conversation identifier that the spawn surface echoes
  verbatim on every `engine.v1` event of the turn so consumers can group
  turns by conversation. Legacy `turn-envelope.v1` envelopes remain accepted
  with byte-exact behavior, a v1 envelope carrying the field fails closed,
  and type violations (non-string, empty, oversized) reject through the
  existing `engine.input_invalid` channel. The published
  `configs/turn-envelope.schema.json` gains dual-version acceptance and an
  `if/then` v1 guard under the builder byte-identity discipline.
- Engine wires organization permission enforcement (#159 REQ-004..REQ-009):
  a harness pre-check before any model consumption evaluates Context Scope and
  Authority Scope against the `org apply`-recomputed `permissions.json`
  artifact (org-permissions.v1). Out-of-scope context reads settle
  `workspace_org_context_denied`, out-of-authority tool calls settle
  `workspace_org_authority_denied`, and unknown positions settle
  `workspace_org_position_unknown` before any lifecycle event; every denial
  carries `redirectTo=owner` and is recorded in turn evidence with zero
  content from the denied resource. A missing or malformed artifact fails the
  turn closed with `engine.permissions_invalid`. `role.mode`
  (read_only/approval_required) is now consumed and carried into the derived
  permissions; an absent mode defaults to read_only and a malformed mode fails
  `org apply` closed. A new `permission_denied` terminal reason lands with the
  semantic-mapping doc.
- Engine wires the `memory_recall` context slot to the strict `MemoryPort`
  seam (#180 wiring, consumed through #209): an opt-in `EngineMemoryOptions`
  (disabled by default) calls a pinned, scope-bound adapter before any model
  consumption; `optional` mode converts only a typed `MEMORY_UNAVAILABLE`
  outage into an empty recall plus one warning, `required` mode settles the
  turn retryable with `engine.memory_unavailable` before the model call, and
  denial, scope mismatch, revoked/expired grants, archived/forgotten items,
  tampered records, bad configuration (including a missing or malformed
  adapter identity), or an unexpected wire schema version fail closed as
  `engine.memory_denied` in both modes. `turn-evidence.v1` gains a
  digest-only `memory` field (adapter identity, item digests, locators, state
  versions, provenance digests, byte counts) that never carries recall text
  or raw provenance.
- Engine adds the strict read-only `ContextPort` and pins the workbench
  `context adapter recall` CLI/stdio adapter (#179, context repo pinned at
  f63f57f): an opt-in `EngineContextOptions` (disabled by default) recalls
  the position's granted `context-bundle.v1` before any model consumption and
  re-validates the envelope byte-for-byte (exact keys, artifact and bundle
  digest recomputation, item/byte bounds, timestamp and freshness checks,
  exact pinned scope). Recalled context is projected into a new
  `context_bundle` assembly slot as quoted untrusted data and cannot change
  tools, authority, policy, or system instructions; `optional` mode converts
  only a typed `CONTEXT_UNAVAILABLE` outage into an empty context plus one
  warning, `required` mode settles the turn retryable with
  `engine.context_unavailable` before the model call, and auth denial, scope
  mismatch, corrupt records, malformed envelopes, or bad configuration fail
  closed as `engine.context_denied` in both modes (unknown failures are
  treated as denials, never as outages). `turn-evidence.v1` gains a
  digest-only `context` field (adapter identity, bundle digest, watermark
  revision, artifact digests, locators, byte counts) that never carries
  context text or credentials.

## [0.5.0] - 2026-08-26

### Added

- `docs/releasing.md` codifies the version-bump semantics (#200): within 0.x,
  additive capability releases bump MINOR, defect-only releases bump PATCH,
  breaking changes to a shipped surface bump MINOR with a `Breaking` changelog
  heading, and MAJOR is reserved for the 1.0 stability commitment. The
  convention takes effect starting with the 0.5.0 release.
- Local PR governance precheck (#197 REQ-001): `npm run governance:precheck
  -- --body-file <path>` validates a draft pull request body against the
  exact CI implementation-trace gate before pushing. The precheck builds a
  synthetic `opened` event around the draft body and delegates to the same
  `validateGithubEventFile()` entry point the CI gate runs, so the local and
  CI verdicts share one rule source and cannot drift. On failure it prints
  every gate error followed by fixed repair guidance (nine required
  headings, `Consumed revision: R<positive integer>`, no-auto-close
  acknowledgement, `PASS N/N` counts, full check URLs, product-review
  handoff handles). `docs/requirement-governance.md` gains the mandatory
  pre-push step plus an append-only known-fragile-test-patterns correction
  list (first entry: hardcoded wall-clock deadlines sealed into test
  envelopes, adjudicated on Issue #178), and `docs/flaky-tests.md` archives
  the timing-sensitive deploy-cli cases adjudicated under the
  clean-main-baseline method during #193/#195.
- `hire-request.v1alpha1` contract surface (#194 R4 freeze): a thin
  reference envelope that references a sealed employee package
  (`packageRef` with `name`/`version`/`digest`, no `localReference`
  channel), a sealed turn envelope (`envelopeDigest`), and an opaque
  org-tree placement reference (`targetParentId`, validated as bounded text
  only — tree resolution belongs to the consumer org-workbench). New
  published schema `configs/hire-request.schema.json` (byte-identical to
  the code-side builder `buildHireRequestSchema()`), core validator
  `validateHireRequest`, and CLI `digital-employee hire validate <file>
  [--json]`. Validation is static and fail-closed: no spawn, no engine, no
  paid calls, no provider; any violation exits 1 before any effect with a
  stable diagnostic code (`hire_request_unknown_field:<path>`,
  `hire_request_invalid_field:<path>`, `hire_request_missing_budget`).
  Budget is attached at hire time: `budget` with `perTask`/`perDay` scopes
  is required, and a hire without a budget is rejected. The budget scope
  vocabulary is byte-aligned with the engine `BudgetScope` and the
  turn-envelope.v1 `$defs/budgetScope` (`tokens`/`iterations`, positive
  integers capped at 1,000,000,000, at least one declared). No approval
  semantics, no `pendingApproval`, no engine changes.
- `employee-package.v1alpha1` gains an optional `identity` segment (#194):
  human-facing expressiveness only — `name` stays the machine identifier.
  `displayName` (required, 1–64 chars), `avatar` (exactly
  `{ "asset": <portablePath> }`, content-addressed against the package
  `assets` list, no URL channel), `persona` (≤2048 chars) and `roleId`
  (`^[a-z][a-z0-9-]{0,63}$`, resolved in the consumer org-workbench, never
  here). `reportTo` does not belong in `identity` and fails closed. Inside
  `identity`, unknown fields are additive: accepted with a collected warning
  surfaced by `digital-employee validate` (`warnings` array under `--json`,
  one stderr line otherwise) while the exit code stays 0; outside
  `identity` unknown fields are still rejected. Packages without the
  segment validate exactly as in 0.4.0.
- `turn-envelope.v1` gains an optional `pendingApproval` field (#193
  REQ-001..REQ-003) so an operator verdict for a previously requested
  approval can reach the #187 engine gate through the spawn surface. The
  field shape is the engine `TurnPendingApprovalInput` verbatim
  (`approvalId` / `decision: granted|denied` / `decidedBy: operator` /
  `scope: once|run` / `reason?` / `expiresAt?`) — no parallel vocabulary —
  and `turn run` maps it into `EngineTurnRequest.pendingApproval` with zero
  engine changes: the verdict settles exactly as #187 already merged it
  (granted proceeds with `approval.granted` before any model consumption,
  denied settles `engine.approval_denied` `retryable=false` with zero
  consumption, expired fails closed with `engine.approval_expired`). The
  envelope boundary is the first gate and fails closed per the #173 spawn
  contract (exit 1 + stderr diagnostics before spawn); the engine
  validation stays the byte-exact backstop. The schema is purely additive:
  envelopes without the field behave identically.
- engine.v1 gains the approval three-event contract (#187 REQ-001..REQ-005,
  Option 1 terminal-and-resume): additive events `approval.requested`,
  `approval.granted`, `approval.denied` alongside the existing five event
  shapes (single source `packages/engine/src/contracts.ts`). A turn
  declaring a write action at the capability gate must carry a validated
  `write-approval.v1` preview (`state=preview_validated`); without it the
  turn fails closed (`engine.approval_preview_invalid`), aligned with the
  `undeclared_tool` / `approval_not_configured` guard semantics. The
  requesting turn settles as `run.failed` with `engine.approval_required`
  (`retryable=true`); the operator verdict returns through the sealed
  envelope of the next turn (`pendingApproval` on the engine request) and is
  consumed before any model consumption — granted proceeds, denied settles
  `engine.approval_denied` (`retryable=false`, no downgrade to an unapproved
  write), and an expired or malformed verdict fails closed with
  `engine.approval_expired`. Approval settlements reuse the existing
  terminal-reason enumeration and are distinguished by error code; turn
  evidence carries the approval chain reference (`approvalRef`) so a denied
  terminal keeps its approval reference and terminal reason. The
  `pendingApproval` plumbing on the `turn-envelope.v1` spawn surface is a
  separate follow-up; no in-run inbound channel is introduced and the
  fail-closed posture of #178 is unchanged.
- `turn run` gains a `qoder` model port (#185 REQ-001..REQ-005), so an
  operator holding a lawfully obtained `QODER_PERSONAL_ACCESS_TOKEN` can
  complete a turn through the conformance-verified isolated Qoder adapter
  running in zero-tool mode (`tools.default=deny` with an empty allowlist, no
  filesystem or network grants, `approval: never`, no MCP, `maxTurns=1`).
  The token enters only through the inherited environment allowlist and never
  appears in argv, envelope fields, events or diagnostics; the adapter's
  auth-payload file discipline (0600, run-local, removed on cleanup) is
  unchanged. The port returns text without token counts: the adapter's usage
  events are not a stable contract (`usage_events: unknown`), so per-task and
  per-day token accounting records zero for this port while iteration budgets
  still apply. A missing binary, a version outside the `1.1.x` conformance
  family, a missing or empty token, or an unverified platform (Windows) fails
  closed during port resolution (exit 1, an environment fault) instead of
  being modeled as a failed turn (exit 0), each with a distinct diagnostic
  code. The `agent run` surface, the agent-host registry and the adapter's
  existing qualification conclusions are unchanged, and no frozen contract
  (`turn-envelope.v1`, `engine.v1`) is modified. The port is a model seam on
  the spawn surface, not a host qualification: Qoder live E4 qualification
  stays with #177 and requires real token authorization; CI covers the
  conformance fixture (E3) only. See
  [`docs/agent-hosts.md`](docs/agent-hosts.md).
- Zero-Claude runbook (#185): `docs/employee-package.md` documents how an
  operator with no `ANTHROPIC_API_KEY` and no Claude login operates an
  employee package end to end — offline `validate`/`eval`, the zero-credential
  `deterministic` spawn-surface smoke test, and the online `qoder`
  service-token port — with the fail-closed diagnostic codes and the honest
  limit that the Qoder port reports no token usage. No Claude path is
  required anywhere in the runbook.
- `turn run` gains a `claude-local` model port (#182 REQ-001..REQ-005), so a
  local operator can complete a turn with the Claude Code install already
  authenticated on their machine and no `ANTHROPIC_API_KEY`. The port spawns
  the official binary and lets Claude Code resolve its own login: it never
  reads, parses or forwards any credential store, and `HOME` /
  `CLAUDE_CONFIG_DIR` are deliberately left untouched. The run stream must
  announce `apiKeySource: claude_cli_oauth`; an `ANTHROPIC_API_KEY`-sourced
  init is rejected so a service credential cannot be used while reporting an
  unverified authentication source, and a `none`-sourced init maps to an
  actionable `claude_local_not_logged_in` (verified against 2.1.223: `none`
  means not logged in). Token usage is read from the stream, so
  per-task and per-day budget accounting keeps working. A missing or
  out-of-window binary fails closed during port resolution (exit 1, an
  environment fault) instead of being modeled as a failed turn (exit 0).
  Scope is local interactive use only — unattended, multi-tenant, third-party
  or resale deployments still require the isolated `ANTHROPIC_API_KEY`
  adapter, and no subscription credential may be bundled into a distributed
  employee package. The port has not been through adapter qualification, and
  end-to-end verification against a genuinely authenticated Claude Code is a
  manual local check that CI does not cover. See
  [`docs/agent-hosts.md`](docs/agent-hosts.md).

- A strict, engine-detached `MemoryPort` and public-HTTP mem adapter now bind
  one workspace instance, position-derived principal and canonical memory
  scope to an env-only minimum read/write token (#180). The adapter pins mem
  revision `4c714aa352f79f0080a24904668210d6c445ba10`, verifies version and
  capabilities before every operation, writes only bounded reviewed
  `task-state.v1` records with deterministic idempotency and exact readback,
  and projects bounded recalled content as untrusted data with no authority.
  It contains no grant or admin path and is not wired into the engine. Mocked
  contract tests and a disposable actual mem/PostgreSQL E3 cover replay,
  changed-payload conflict, cross-scope and self-grant denial, root-token
  rejection, explicit grant, revoke/expiry, archive/forget and unrelated-item
  isolation without live Qoder or Claude Code calls.
- The ready S3-P0 slice from #158 R3 / #165 R4 adds a fail-closed
  `digital-employee task delegate [workspace] --stdin --history-file <path>`
  boundary. Exact sealed
  `delegation-envelope.v1` input is revalidated against current applied
  organization and permission digests; only one explicit owner-to-direct-report
  route on Qoder or Claude Code is accepted. The engine derives an
  intersection-only scope into the real Host policy (search requires
  `Grep`/`Glob`; writes, network, MCP, approval and downstream delegation are
  denied), emits `delegation.started` only after trusted child `run.started`
  and ordered `delegation-event.v1` NDJSON with exactly one trusted terminal,
  validates a bounded Workbench-owned linear retry-history snapshot, and
  exposes a pure requested `task.v1` initializer for the Workbench-owned store.
  Deterministic E3 fixtures cover both Host identifiers, invalid routes, stale
  state, duplicate/branched/gapped retry admission, modeled failure,
  cancellation, and process ambiguity. The installed root artifact's
  `./engine` subpath is distribution-smoked. Neither Host is claimed
  live-qualified; Workbench persistence,
  API/SSE and UI remain downstream work.
- The capability evidence standard is now codified and enforced (#140
  REQ-001 / REQ-002 / REQ-004, AC-001 / AC-002): every claim must carry the
  exact Host version, the deterministic fixture (kit) version, the
  `fixtureConformant` vs `liveQualified` boundary, and the sha256
  fixture-corpus digest recomputed from the kit's frozen case contract.
  `adapter-qualification-snapshot.v1` is the machine-readable per-release
  form: `createQualificationSnapshot` derives it from a validated record and
  `validateAdapterQualificationSnapshot` rejects incomplete or incoherent
  claims (missing fields, unknown kit versions, digest/corpus mismatches,
  dropped or duplicated domain rows, under-reported counts, or axes that
  disagree with the rows). The release regression harness re-runs the full
  deterministic vector set against the reference stdio Host on every
  `npm run check` (CI and the release workflow) and fails closed via
  `compareQualificationSnapshots` if any evidence earned in the committed
  v0.4.0 baseline snapshot
  (`fixtures/qualification/snapshots/v0.4.0.json`) disappears or weakens;
  strengthened evidence always passes.
- The Adapter qualification kit earns a tenth domain, `readonly_projection`
  (#140 REQ-003 / AC-003), through two deterministic, model-free vectors:
  `read_search_only` (one final `run.completed`, every tool event inside the
  frozen read-only pair `read_file`/`search_workspace`, both exercised) and
  `write_tool_refused` (a typed `qualification_filesystem_policy_denied` at
  preflight or in one final `run.failed`, with zero executed tool events). Kit
  version moves to `1.3.0` (20 cases); the v1 record validator now accepts
  four versioned contracts (`1.0.0`, `1.1.0`, `1.2.0`, `1.3.0`) with
  per-version domain sets, so a pre-`1.3.0` record carrying
  `readonly_projection` fails closed exactly like a `1.3.0` record that drops
  it. The reference stdio Host serves both operations deterministically.
- The reusable Adapter qualification kit now earns `output_schema` evidence
  through six deterministic vectors (#113): `valid_json`, `non_json`,
  `schema_mismatch`, `invalid_schema_preflight`, `cancel_buffered`, and
  `secret_rejected`. Kit version moves to `1.2.0` (18 cases); the v1 record
  validator still accepts the superseded `1.1.0` 13-case and legacy `1.0.0`
  nine-case contracts, and unknown kit versions fail closed. Rejection is
  Adapter-enforced and synchronous: invalid, `$async`, or oversized Schemas
  never reach a model process, nonconforming terminals are replaced by one
  typed final `run.failed` without echoing hostile output bytes, cancellation
  wins over buffered success, and the credential sentinel never surfaces.
  Default CI stays offline: records are `fixtureConformant` with
  `liveQualified: false` and no live model or paid call.

### Changed

- Claude, Qwen, CodeBuddy and Qoder now share one synchronous output-Schema
  preflight guard (`apps/cli/output-schema-guard.ts`, #113): invalid,
  oversized (>16 KiB), `$async:true` and otherwise unsupported Schemas are
  rejected before any version probe, projection or model process, and each
  run prepares exactly one Schema snapshot that projection and terminal
  validation both consume — the stream layer never recompiles or re-accepts
  a Schema. Claude, Qwen and CodeBuddy preflight previously probed first,
  and Qwen/CodeBuddy recompiled Ajv at the terminal; both behaviors are
  gone. New deterministic regressions prove the shared guard unit contract
  and that each of the three adapters fails closed with its typed code,
  zero version-probe calls and no model spawn for invalid/`$async`/oversized
  Schemas; Schema-absent requests keep the existing unstructured behavior.
  Relative to 0.4.0 the failure point for unsupported Schemas moves
  forward: the run now fails closed at the shared preflight guard before
  any side effect, instead of later inside adapter-specific probe or
  terminal validation layers.
- Issue #113 AC-004 evidence is hardened without changing any authority:
  Claude, Qwen and CodeBuddy projection tests now assert (as Qoder already
  did) that output-Schema bytes never reach process environment values or
  the public event stream, joining the existing argv assertions; stdin
  stays the one bounded channel. `docs/agent-hosts.md` gains the canonical
  exact-version qualification table (Qoder `1.1.x` family / fixture
  `1.1.12`, Claude Code `>=2.1.214 <2.2.0`, Qwen Code `0.17.1`, CodeBuddy
  Code `2.106.4`) separating fixture conformance from live entitlement, and
  `docs/verification.md` is refreshed (Codex 0.146.0 wording replaced by
  the 0.148.0 audit, new #113 evidence row). The later versioned release
  proving generic downstream selection remains a separate release gate.
- Codex default-deny research is re-audited against stable Codex CLI 0.148.0
  (release `rust-v0.148.0`, tag commit `3ba0f71`): the offline Responses
  fixture still observes model-visible `apply_patch` after every expressible
  tool reduction, four candidate removal surfaces are rejected by
  `--strict-config` as unknown fields, and upstream closed the `apply_patch`
  disable request as NOT_PLANNED (openai/codex#8161). The verdict stays
  NO-GO / probe-only; the audit script and tests now pin 0.148.0 with a new
  sanitized fixture, and `docs/agent-hosts.md` drops the stale 0.146.0
  wording in favor of the 0.148.0/0.147.0 research records.

### Fixed

- Public `RunnerReplayClaim` values now require the verified positive
  safe-integer `fencingToken`; direct claim callers and typed custom guard
  fixtures must add the field, while executor-integrated guards receive it
  automatically. The durable adapter persists the value unchanged and rejects
  lower tokens after a new guard instance is attached to the same store;
  legacy durable records whose token is `0` fail closed because their original
  ordering cannot be recovered. The preview guard now bounds nonce TTL entries
  separately from process-lifetime task high-watermarks, but remains explicitly
  restart-unsafe.
- The external stdio Adapter no longer fails closed on its own teardown
  traffic (#113). After a synthesized Schema-mismatch terminal, the mandated
  closing response is drained before the run stream is deleted, and `cancel`
  registers a bounded waiter for its exchange id, so late closing responses
  and cancel acknowledgements can no longer be dispatched as unsolicited
  messages that kill every active stream and signal the host child. Pipe
  errors on a dead Adapter are absorbed instead of escaping as uncaught
  stream errors.
- Deploy i18n malformed-catalog handling is now observable and pinned by
  built-CLI tests (#79). A catalog that fails JSON parsing or has a
  non-object root falls back to canonical English with a single `[i18n]`
  stderr warning instead of silently or unsafely loading. New
  `tests/apps/deploy-i18n-discovery.test.ts` proves on the built CLI that a
  JSON-only synthetic locale is discovered and rendered without any
  TypeScript registration, that malformed catalogs fall back to English, and
  that an explicitly unsupported `--locale` exits nonzero;
  `locales/README.md` documents the exact built-CLI verification commands.

## [0.4.0] - 2026-08-16

### Added

- Git source refresh is fail closed by default and can serve a validated
  last-known-good generation when the remote is unreachable (#103). With
  `policy: "prefer_last_known_good"` and an integer `maxStaleMs` in
  [1000, 604800000], every degraded read revalidates the pinned commit,
  manifest provenance, selected-content digest, path safety, and age;
  `legacy sync` reports `degraded` and exits 2, and runtime/HTTP health
  report per-source status. A failed refresh never touches the active
  generation, and the cache remains disposable.
- Qoder CLI 1.1.x now advertises `structured_output` from Adapter-specific
  deterministic conformance fixtures under the common Adapter-enforced
  terminal-validity contract. A checked-in employee package
  that keeps `requiredCapabilities: ["structured_output"]` can pass the normal
  package-aware Qoder preflight; unverified Qoder versions remain fail closed.
  Deterministic fixtures cover matching JSON, malformed/fenced/prose/truncated
  output, Schema mismatch and additional properties, unstructured output,
  buffered cancellation, and the independent deadline path.
- Added revisioned roadmap/feature/maintenance Issue requirements, an
  append-only decision policy, PR-to-REQ/AC traces, append-only merge
  verification ledgers, explicit product review, and frozen milestone packets
  requiring a named owner's ACCEPT/REJECT decision. These are review policies,
  not technical tamper prevention. A bounded checker validates templates,
  fixtures, the actual PR body, and every source commit message in the exact
  event base-to-head range from a safe event file and local Git history in CI.
- Added the immutable `agent-host-vectors/v2` corpus revision with one
  aggregate digest and 50 independently consumable vectors. The revision
  preserves the frozen v1 fixtures while pinning capability-key allowlisting,
  not-ready/non-conformance/probe-only/unavailable migration rejection,
  completed-plus-failed terminal ambiguity, and exact probe result/issue keys
  in one integrated Issue #46 ledger.
- Added package-bound `deploy [package-path]` with exact identity/version/digest
  binding, explicit runtime semantics, localized deterministic automation,
  truthful `ready|pending_external_action|unsupported|failed` outcomes, a
  verified loopback HTTP runtime, Console pending guidance, and a fail-closed
  DingTalk reconciliation path. Current DWS JSON list output omits the required
  pagination metadata, so real DingTalk integration remains on external HOLD.
- Hardened deploy so DingTalk resources cannot be orphaned by implicit
  rebinding, provider create errors retain their durable reconciliation fence,
  provider identities and fences are tenant/auth-scope bound without persisting
  raw identity or credential data,
  HTTP runtimes receive only the selected engine credentials, and requests run
  from a private digest-bound package snapshot.
- Added bounded interactive input and clean installed-tarball deploy gates,
  including recipe assets, setup version identity, health/ask readback, and
  runtime PID cleanup.
- Real-local Phase A path (#42): a `component-matrix.v1` contract that pins
  the exact `mem` and `doc` service commits as the sole version authority, a
  deterministic `real-local-stdio-host` Agent Host fixture that resumes
  scoped durable memory (`durable-context.v1`) and reads ETag-pinned
  documents from actual loopback services behind the operator
  `capability-grant.v1` gate, the `recipes/real-local-context` employee
  package with a deterministic fault-scenario table, and a credential-free
  harness (`scripts/real-local-harness.mjs`) that bootstraps, seeds, runs,
  emits `real-local-e2e` evidence with an empty secret scan, and cleans up.
  Real-local failures use the frozen `real_local_*` code namespace, never
  the synthetic `mcp_*` codes.

### Security

- Adapter qualification kit 1.1.0 now gives every case one awaited, bounded
  finalizer; teardown that cannot settle aborts the suite without emitting a
  record. Typed filesystem/network/MCP denial codes replace generic failure evidence,
  sentinel scans fail closed on accessors, Proxies, descriptor errors, and
  budget exhaustion, and process cleanup is bound to the exact Adapter,
  config/probe/version fingerprint, and verified child-to-grandchild lineage.
  The v1 record validator retains the original 1.0.0 nine-case contract while
  deriving all domain counts and axes exactly for both supported kit versions.
- Employee-package inspection and the generic run/eval boundaries now reject
  asynchronous JSON Schemas. Claude, Qwen, and CodeBuddy also prepare one
  immutable Schema snapshot per run, reject `$async` before Host execution,
  and require synchronous validators to return exactly `true`; this closes the
  Ajv Promise-truthiness path across every built-in structured-output Adapter.
  All built-ins validate the unchanged terminal JSON before safety scrubbing;
  repair, coercion, defaults, field removal, or redaction cannot manufacture a
  passing value, and a required post-validation mutation fails closed.

- Qoder JSON Schemas are serialized, capped at 16 KiB, and compiled before
  any run-workspace projection or Qoder subprocess, including the bounded
  version probe; invalid, oversized, or asynchronous Schemas therefore cannot
  reach a paid model invocation. Invalid, oversized, or asynchronous Schema and
  unsafe terminal output produce typed failures.
- Deployment state now uses a strict secret-free schema, owner-only atomic
  persistence, generation checks, and a retained local `lockf`/`flock`
  descriptor. HTTP activation is parent-coupled through an exact fd4 lease and
  publishes Ready only after fresh state/package/endpoint readback; unsafe PIDs
  are preserved without blind signals. DingTalk writes persist an operation
  fence before create and every uncertain retry is reconcile-only.
- Qoder assistant text is now buffered until successful process and cleanup
  completion, then scrubbed as one value with the exact service credential.
  This prevents secrets split across native stream chunks from escaping in
  standard events. Tool input values are scrubbed before truncation,
  credential-bearing tool identifiers and keys are rejected, and schema-bound
  structured output that would require credential or pattern redaction fails
  closed.

## [0.3.0] - 2026-08-04

This public release added the publisher-owned Runner execution boundary and is
available through the root and core npm packages, GHCR, and GitHub Releases.
It predates the package-bound `deploy` work in `[Unreleased]`.

### Added

- Added the cross-repository `digital-employee.runner-protocol.v1` contract:
  Ed25519 task/receipt envelopes, strict canonical payloads, lease fencing,
  bounded hash-chained events, Runner-attested usage and shared golden vectors.
- Added deterministic employee-package digests and per-run sealed local
  snapshots so the bytes verified are the bytes passed to the Agent Host.
- Added a required replay-guard port, process-local preview implementation,
  signed-renewal lease state and a one-shot Runner executor for a publisher or
  operator-owned machine.
- Added package identity checks before and after Host preflight/execution,
  lease-aware cancellation, bounded normalized event transport and signed
  completion receipts.

### Security

- Runner tasks can resolve packages by immutable identity only; a platform
  payload cannot provide a local path, command, module or Agent credential.
- Runner receipts prove provenance and integrity only. They deliberately carry
  no Credit or price authority and cannot make self-reported usage billable.
- All validity windows are half-open, bounded clock skew is explicit, signed
  renewals preserve the full task identity, and late executions cannot produce
  an acceptable receipt.

## [0.2.0] - 2026-08-04

This release is the Agent-native CLI and Host Adapter release. The published
`0.1.0` artifacts remain the frozen `standalone-v1` compatibility release;
the `0.2.0` artifacts are not public until the release workflow completes.

### Breaking changes

- **Source-checkout startup:** Running `npm start` without arguments no longer
  starts the `standalone-v1` configured channel. It prints Agent-native CLI
  help and exits. Use `npm run legacy:start -- [options]` to retain that
  behavior.
- **Source-built container startup:** Running the image without arguments no
  longer starts the compatibility HTTP server on port 3000, and the image no
  longer declares `EXPOSE 3000`. Existing deployments must explicitly pass
  `legacy serve --config ./dist/configs/demo.json --host 0.0.0.0 --port 3000`.
  The published `0.1.0` image is unchanged.

### Added

- Added the host-neutral `employee-package.v1alpha1` manifest, source package
  scaffold, static validation, and public JSON Schema.
- Added `employee-mcp.v1alpha1` for host-neutral stdio/HTTPS MCP declarations
  with environment-variable secret references.
- Added the `agent-host.v1` adapter/event/capability contract and fail-closed
  host compatibility assessment.
- Added an explicit, host-neutral `AgentHostRegistry` and trusted embedder API.
  Host IDs and aliases cannot shadow each other; employee packages cannot
  discover or install adapters, and deployments can inject only adapters they
  register deliberately.
- Added local-only `doctor`, `init`, and `validate` CLI commands; diagnosis
  probes executable versions without starting a model run.
- Added built-in catalog entries for Claude Code, Qoder CLI, Codex CLI, Qwen
  Code and CodeBuddy Code. Documentation claims never satisfy runnable package
  compatibility, and Codex remains probe-only because Codex CLI 0.146.0 cannot
  reliably remove every model-visible built-in tool, notably `apply_patch`.
- Added the `run --engine qoder` path for Qoder CLI 1.1.x, verified by
  Adapter-specific deterministic process fixtures. It uses a stateless
  read-only projection,
  isolated configuration, filtered environment, stdin JSONL initialization and
  task transport, native stream normalization, package-aware preflight,
  pre-launch cancellation, file-identity checks, runtime policy attestation,
  SDK process-mode authentication, protocol-major validation, atomic native
  event validation, pre-terminal credential cleanup, and outer JSON Schema
  validation.
- Added runnable, stateless context-only adapters for Claude Code
  `>=2.1.214 <2.2.0`, Qwen Code `0.17.1` and CodeBuddy Code `2.106.4`. They use
  explicit service API keys instead of personal login state, sealed bounded
  UTF-8 asset values over stdin, empty isolated workspace, home, configuration
  and temp directories, version-specific zero-tool/MCP runtime attestation,
  filtered environments, strict unknown-event and secret-output handling,
  bounded cleanup, POSIX process-group termination, cancellation and
  post-cleanup terminal events. Qwen also
  disables its built-in slash commands; CodeBuddy exhaustively denies every
  tool exposed by 2.106.4 because its empty `--tools` flag alone is ineffective.
  MCP, attachments, session resume, write tools, approval callbacks and Windows
  execution remain unsupported; live model entitlement was not tested.
- Added `--stdin` and `--input-file` task sources so callers can keep task data
  out of the outer CLI argument vector.
- Added the strict `employee-profile.v1` manifest and runtime API compatibility contract.
- Added explicit profile, source, model, channel, and tool registries plus a fail-closed local module loader.

### Changed

- Reframed the existing model/retriever execution path as the
  `standalone-v1` compatibility runtime; new Agent behavior targets external
  Agent hosts through adapters instead of extending a second general loop.
- Added the explicit `legacy ask|sync|start|serve` namespace. Existing
  top-level commands remain deprecated aliases through `0.x`; Agent-native
  commands do not eagerly import or fall back to the compatibility runtime.
- Changed zero-argument `npm start` and the source-built container to show the
  Agent-native CLI help. Compatibility services now require an explicit
  `legacy ...` entry point.
- npm releases now use GitHub Actions OIDC trusted publishing instead of a long-lived repository token.
- Shipped runtime, connector, profile, application, and test sources now use
  strict TypeScript; npm and CLI entry points execute generated ESM from
  `dist/` with declarations and source maps.
- `answer-agent` and all shipped connectors now assemble through registry entries instead of CLI conditionals; legacy 0.1 profile strings remain supported.
- The first-release runtime now rejects any deployment or profile that requests write capability.

## [0.1.0] - 2026-08-01

### Added

- Generic digital employee runtime with a read-only `answer-agent` profile.
- Approved filesystem, Git, and optional DWS knowledge sources.
- Console and optional DingTalk channels.
- OpenAI-compatible and zero-credential extractive model providers.
