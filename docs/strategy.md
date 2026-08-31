# Digital Employee product strategy

[简体中文](strategy.zh-CN.md)

This document is the authoritative product contract for the open
`digital-employee` repository. The [roadmap](roadmap.md) translates this stable
direction into milestones and work items. Implementation status belongs in the
[verification ledger](verification.md), not in product claims.

## North Star

> Digital Employee is a local-first, conversation-first digital-organization
> workspace: it turns one business directory into a directly addressable AI
> team with long-term Context and permission boundaries.

The workspace model is the product, not a command collection:

| Mapping | Meaning |
| --- | --- |
| One directory = one business | `workspace init` turns a local directory into a business workspace with an organization tree, positions, and a business Context area. |
| One position = one addressable digital employee | `chat @position` addresses a named position directly; the position id is the stable identity that survives sessions and Host changes. Every hired position carries a budget before the change takes effect. |
| One conversation = work with position Context and permission boundary | A conversation loads only that position's Context slice and runs inside its Authority Scope; out-of-scope requests are refused, not silently widened. |
| Organization hierarchy = business owner → digital employees | The owner sees the business whole, delegates work, and is accountable for the result; workers see only the slice their position is allowed to see. Budget-exceeded reports escalate along the reporting line — the reporting chain and budget governance share one escalation mechanism. |
| Long-term Context foundation = mem + context | Decisions and task state persist to the memory plane (`mem`), and session text is distilled into a context graph; a new session recalls and continues without Host-native session resume. |
| Built-in engine = default Host | Positions run on a built-in, TypeScript-native execution engine; external Agent Host adapters remain an option, not a dependency. |
| Open source builds the brand; transactions stay inside the company | The open repository owns the workspace framework and the public narrative; marketplace, billing, settlement and company-internal transactions are private work and never enter this repository. |

Digital Employee does not implement another general-purpose model. Positions
run on a built-in, TypeScript-native execution engine that is the workspace's
default Host
([Epic #165](https://github.com/fullstack-ai-infra/digital-employee/issues/165));
external Agent Host adapters remain an option, not a dependency. This
repository owns the workspace, the position address book, the permission
boundary, the long-term Context path and the built-in engine. Local create,
validate and run workflows do not require a marketplace.

`answer-agent` and the `standalone-v1` compatibility runtime are historical
first employee use cases, not the product definition. The released
`init` / `doctor` / `validate` / `eval` / one-shot `run` / `setup` /
package-bound `deploy` commands validate employee packages and execute bounded
local runs; they are the foundation the workspace mainline builds on, not the
workspace itself.

### Built-in execution engine (default Host)

The workspace runs positions on a built-in, TypeScript-native execution engine
— an independently designed clean-room implementation of a five-layer
capability model (prompt / context / harness / loop / graph), tracked by
[Epic #165](https://github.com/fullstack-ai-infra/digital-employee/issues/165).

- **S1 — read-only engine core:** turn-contract execution, per-turn context
  assembly, fail-safe loop control, structural fail-closed behavior, and
  per-turn evidence records are a released preview in the public `0.6.0`
  root package (first published in `0.5.0`). The source package version
  `0.6.1` does not add a runtime claim or establish a publication channel;
  verify the release receipt for availability.
- **S2 — harness layer (M2–M3):** approval events, organization-permission
  enforcement, and opt-in Context/Memory ports have released preview slices;
  broader tool dispatch, MCP, and sandboxing remain planned. Every extension
  must preserve the S1 fail-closed baseline.
- **S3 — graph layer (M4+):** one explicit owner-to-direct-report delegation
  is a released, deterministic-E3 preview. General cross-position routing,
  parallelism, recursion, and autonomous orchestration remain planned.

Engine narrative discipline: the engine is independently original. Public
documents in this repository do not name third-party agent frameworks;
capability decisions cite this repository's own requirement records.

## North Star metric: Digital-Organization Work Loop

A **Digital-Organization Work Loop** is a verified end-to-end loop for which:

1. `workspace init` creates a business workspace and every generated employee
   package passes `validate`;
2. `org tree` renders the organization hierarchy with parent/child positions;
3. `chat @position` completes one bounded conversation with that position's
   Context slice and Authority Scope, producing a machine-readable result with
   citations and, where delegated, a traceable task chain;
4. decisions and task state persist to the memory plane (`mem`) with source
   and task provenance, and session text is collected for context distillation;
5. a new session (possibly on another Host) recalls the same position memory
   and can continue the work;
6. `org apply` after an organizational change preserves Context and recomputes
   permission scopes without silent expansion.

This metric measures the workspace closed loop. A passing `eval` on offline
fixtures verifies contract conformance, not live model entitlement or response
quality; the evidence vocabulary below governs every claim about the loop.

## Direct users and jobs to be done

| Direct user | Job to be done |
| --- | --- |
| Business owner | Turn a business directory into a workspace, see the whole organization, delegate work to named positions and remain accountable for the result. |
| Position worker | Answer when addressed by role, operate only inside its Context slice and Authority Scope, and hand escalation back to the owner instead of widening scope. |
| Integrator / operator | Bind positions to installed Agent Hosts, keep decisions and task state in the memory plane, and recompute permissions when the organization changes. |
| Open-source contributor | Understand which capability is released, which is planned, and where the boundary with the old Runner/deploy track sits. |

The buyer or end user benefits from the result but is not a direct user of this
open framework. Marketplace accounts, discovery, rental, payment and settlement
remain private company-internal concerns.

## Product scope

### In scope for this open repository

- the workspace command surface: `workspace init`, `org tree` / `org apply`,
  and `chat @position` (the first milestone is tracked in
  [Epic #155](https://github.com/fullstack-ai-infra/digital-employee/issues/155));
- the organization model `organization.v1alpha1`, workspace metadata, and the
  position package references; the directory tree is the org chart — the
  workspace directory is the enterprise, each position is a subdirectory
  holding its employee package, and the parent-child directory relation is the
  reporting relationship (#157);
- position budget governance: every hire carries a budget before the change
  takes effect; budget caps are enforced by the engine loop layer;
  budget-exceeded reports escalate along the reporting line (#157);
- position permission boundaries: Context Scope (which business slice a
  position can recall) and Authority Scope (which tools a position can call),
  with owner/worker defaults and no silent inheritance;
- long-term Context integration: `mem` R1-level memory plane writes and recalls
  plus rule-based `context` fact distillation, decoupling continuity from
  Host-native session resume;
- the built-in TypeScript-native execution engine as the default-Host
  direction (the S1/turn core is a released preview; the complete Workbench
  path remains in delivery), with external Agent Host adapters retained as an
  option (#165);
- the already released employee-package, Skill, Schema, eval and Host Adapter
  contracts, plus `init` / `doctor` / `validate` / `eval` / one-shot `run` /
  `setup` / package-bound `deploy`, which the workspace builds on;
- package digests, sealed per-run snapshots, normalized events, signed receipts
  and the audit/redaction/observability boundary at the local framework edge;
- the verification ledger and evidence vocabulary that keep every public claim
  honest.

### Out of scope for this open repository

- a replacement for an Agent Host's model access and commercial service; the
  built-in engine executes positions locally, and adapters to external Hosts
  remain an option;
- cloud hosting of employee packages, Agent Hosts, model accounts, credentials
  or application/service robots;
- marketplace accounts, listings, discovery, ranking, reviews, rentals, dynamic
  pricing, Quote, Credit, billing, settlement, or any company-internal
  transaction — this is private work (see the boundary below);
- channel expansion (Lark #77 / WeCom #78) in the first milestone; the first
  milestone is CLI-only;
- a full RBAC system; the first milestone ships owner/worker defaults plus an
  explicit authority allowlist derivation;
- Host-native session resume as a requirement; long-term continuity is rebuilt
  from `mem` + `context` each turn (#102);
- hard-coded document, drive, DWS or business-system integrations in the core;
  those capabilities enter through explicit MCP, connector or adapter
  boundaries; long-term Context enters through the explicit memory-plane
  boundary;
- React, a design system or a marketplace UI in runtime packages.

## Boundary with the previous mainline (Runner / security / deploy governance)

The previous public mainline was **Builder → Seller Runner → Trusted
execution** ([Epic #25](https://github.com/fullstack-ai-infra/digital-employee/issues/25)).
The strategy decision of 2026-08-14 pivots the product mainline to the
**local digital-organization workspace** ([Epic #155](https://github.com/fullstack-ai-infra/digital-employee/issues/155)),
and the 2026-08-23 decision record
[#164](https://github.com/fullstack-ai-infra/digital-employee/issues/164)
fixes the old-track disposition ledger.

- The old track is **finished, not extended**: the released foundation
  (`init`/`validate`/`eval`/`run`, package contracts, Host Adapters, the
  preview Runner kernel) remains supported and is the substrate for the new
  mainline. No new capability is added to the old track.
- Every open old-track issue carries an explicit **KEEP / REPURPOSE / PARK**
  disposition in the [roadmap](roadmap.md), per the approved #164 ledger:
  **KEEP 11 / REPURPOSE 9 / PARK 5**. Execution has happened: PARK issues are
  closed as not planned; REPURPOSE issues carry a disposition comment and stay
  open; KEEP issues are untouched. Dispositions are recorded, not destructive:
  issues are not mass-rewritten, and no issue is silently dropped.
- The private marketplace story is unchanged and remains inside the company:
  the open repository never implements listings, pricing, billing, settlement,
  or company-internal transactions.

## Practice path

### What the current source supports

1. Build the `0.6.1` source checkout, or install the recorded public `0.6.0`
   release; source and packed artifacts are not proof of availability, which
   requires a release receipt.
2. Create and validate an employee package with `init` and `validate`, then
   use `doctor --engine` for bounded local Host diagnosis. These steps do not
   prove model entitlement.
3. Run a real one-shot local Agent/model run with `run --engine` after an
   explicit deployment credential; it may consume provider credits.
4. Bind a validated package to a truthful local deployment outcome with the
   package-bound `deploy` command within its documented fail-closed boundary.
5. Create a workspace skeleton with `workspace init --template oss-maintainer`
   (released preview in `0.6.0`, first published in `0.5.0`; the target must
   be a missing or empty directory — any other target fails closed).
6. Inspect and apply the organization with the released-preview `org tree`
   and `org apply` commands, then use the turn engine, bounded explicit
   delegation, permission enforcement, or opt-in Memory/Context ports only
   within their documented preview boundaries.

`chat @position`, durable Workbench persistence/UI, productive long-term
memory and context distillation, and the complete default-Host journey remain
planned under [Epic #155](https://github.com/fullstack-ai-infra/digital-employee/issues/155)
and [Epic #165](https://github.com/fullstack-ai-infra/digital-employee/issues/165).
The shipped Memory/Context seams are opt-in and do not claim that full product
loop. Consult the [verification ledger](verification.md) for exact evidence.

### Target end-to-end path (new mainline)

1. The user runs `workspace init ./<business> --template oss-maintainer` and
   gets a workspace with an organization tree and per-position employee
   packages. (Released preview in `0.6.0`.)
2. The user inspects the organization with `org tree` and sees who is
   addressable and what each position can see and do. (Released preview in
   `0.6.0`; full Workbench presentation remains planned.)
3. The user asks `chat @repo-owner` (owner delegates, worker executes) or
   `chat @issue-researcher` (narrow Context, narrow permission) and receives a
   result with citations and a traceable delegation chain. (`chat` remains
   planned; the lower-level explicit single-hop delegation seam is a released
   preview.)
4. Decisions and task state persist to the `mem` memory plane; session text is
   collected for `context` distillation. (The opt-in recall seams are released
   previews; durable persistence and distillation remain planned.)
5. A new session or Host recalls the same position memory and continues the
   work. (The bounded engine recall seam is released; the end-to-end Workbench
   continuity journey remains planned.)
6. An organizational change runs through `org apply`: Context survives, and
   permission scopes are recomputed without silent expansion; a hire without
   an allocated budget fails closed. (`org apply`, permission derivation, and
   static hire validation are released previews; the complete change workflow
   remains planned.)

## Milestone contract

The roadmap owns dates and issue membership. These milestone outcomes and gates
define the stable sequence.

### W1 — Workspace closed loop (first milestone, due 2026-09-30)

Engine S1 (#165) and the workspace sub-issues I-01..I-07 align on this
milestone.

**User outcome:** a user turns one business directory into a directly
addressable AI team and reproduces the first showcase case (oss-maintainer)
end to end: `workspace init` → `org tree` → `chat @position` (owner and worker
paths) → `mem` persistence → new-session recall.

**Gate:**

- `workspace init ./oss-maintainer --template oss-maintainer` succeeds on a
  clean machine and every generated employee package passes `validate`;
- `org tree` renders the hierarchy and its JSON output passes the
  `org-tree.v1` schema check;
- `chat @repo-owner` produces a task chain `user → owner → worker`, and
  `chat @issue-researcher` proves its Context slice is narrow (no business-wide
  facts leak into `contextUsed`);
- out-of-scope requests are refused with a stable error that points the user
  back to the owner; unbound positions fail closed;
- after a conversation, `mem` contains a position decision record with
  source/task provenance, and a new session recalls and can restate it;
- `org apply` preserves Context and recomputes permission scopes; a hire
  without an allocated budget is rejected fail-closed with a stable error;
- the four oss-maintainer packages run end to end on the built-in engine with
  zero external host and zero credentials, a forced budget or doom-loop
  termination is demonstrated, and every showcase turn carries an evidence
  record under the #140 standard (#165 AC-001..AC-004);
- all claims use the evidence vocabulary below, and no fixture-only path is
  presented as live-qualified.

**Non-goals:** channels (CLI-only), marketplace/transaction work, full RBAC,
Host-native session resume, and any weakening of the S1 structural
guarantees.

### M2–M3 — Context depth, org lifecycle and engine harness

**User outcome:** the workspace keeps learning: session text is distilled into
a rule-based entity graph, `org apply` becomes the trusted way to change the
organization, and the engine grows a harness layer above the read-only core.

**Gate:** rule-based `context` distillation (#162) is idempotent and drives
narrow-slice recall; `org apply` audits organizational changes; mem-backed
recall is in productive use (#161); the engine S2 harness layer (tool
dispatch, MCP client, approval gates, sandboxing, runtime enforcement of
position permission boundaries) extends the S1 zero-tool baseline without
weakening it (#165). Channel output rendering (#160) is owned outside this
pivot and is not a gate here.

**Non-goals:** channel expansion, marketplace/transaction work, and full RBAC.

### M4+ — Engine graph layer

The engine S3 graph layer provides cross-position routing, parallelism and
delegation orchestration over the organization model, with permission checks
at every hop (#165). Planned; scope binds only after M2–M3 closes.

### Old-track wrap-up

The old Runner/deploy/security track is not a milestone on the new mainline.
Its open issues carry an explicit disposition in the
[roadmap](roadmap.md) — KEEP (joins the new mainline), REPURPOSE (re-scoped
onto the workspace/engine lines), or PARK (closed as not planned with a
revival condition). The approved #164 ledger is already executed; no new
old-track capability is scheduled.

## Evidence maturity vocabulary

Use exactly one or more of these terms in documentation, issues and release
notes. Never infer a stronger term from a weaker one.

| Term | Meaning |
| --- | --- |
| **shipped** | Implemented and present in a specified source revision or published artifact. Always say which; shipped does not imply live provider testing or production readiness. |
| **preview** | Implemented for evaluation with explicit missing production properties, compatibility limits or change risk. |
| **fixture-conformant** | The locked Adapter/protocol path passes repository-owned deterministic fixtures. It is not vendor certification, live authentication, model entitlement or commercial qualification. |
| **live-qualified** | A named, locked integration path has passed a recorded test with real provider/service credentials in an approved environment, including declared policy and cleanup gates. This does not grant resale rights or prove all versions. |
| **design** | A reviewed target, contract or decision with no claim that an executable implementation exists. |
| **private** | Implemented or planned outside this public repository. Public interfaces may reference it, but this repository must not claim or incorporate its implementation. |

Use `unsupported` or `probe-only` where applicable; neither is a synonym for
preview. Legal permission for unattended operation or resale is a separate
commercial gate even after live qualification.

## Routing a new requirement

Before adding a requirement or issue, answer these questions in order:

1. Does it help a user turn a directory into a business workspace, address a
   position, bound a conversation by Context and permissions, or keep long-term
   Context across sessions? If yes, it may belong in the new mainline.
2. Does it define, validate, package, run or observe an employee on the local
   machine as released foundation work? If yes, it belongs in the open
   framework.
3. Does it own marketplace identity, listing, discovery, rating, rental,
   Quote, Credit, billing, payment or settlement state, or any
   company-internal transaction? If yes, it is private work.
4. Is it a server-side device-registration, task-dispatch, `UsageVerifier` or
   settlement implementation? If yes, it is private work; only the
   interoperable client/protocol boundary belongs here.
5. Does it create another model or tool loop? The built-in engine is the
   workspace's default execution path; do not add a second loop around it. New
   position capabilities enter through the engine capability-model slices
   (S1 read-only core first); external Agent Host integration enters through
   version-gated adapters, never through the portable package contract.
6. Is it vendor-specific? Put enforcement and projection in a version-gated
   Host Adapter, never in the portable package contract.
7. Is it a channel (Lark/WeCom), document, drive, DWS or business
   capability? Prefer explicit MCP/connector/adapter extension over a core
   dependency, and keep channel expansion out of the first milestone;
   long-term Context enters through the memory-plane boundary.
8. Is it a UI? A local operator UI may consume public APIs without entering
   runtime packages; marketplace UI is private.
9. What evidence term applies today, and what observable gate would promote it?
   If that answer is missing, the requirement is not ready to claim completion.
10. Would the change send package bytes, local paths, Host credentials or
    private chain-of-thought to a private service? If yes, reject it.

When a requirement crosses boundaries, split it at the public protocol. Do not
put both open-framework work and company-internal transaction state into one
issue or implementation.
