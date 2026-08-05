# Digital Employee product strategy

[简体中文](strategy.zh-CN.md)

This document is the authoritative product contract for the open
`digital-employee` repository. The [roadmap](roadmap.md) translates this stable
direction into milestones and work items. Implementation status belongs in the
[verification ledger](verification.md), not in product claims.

## North Star

> Digital Employee is an open Agent-native CLI, local execution framework and
> protocol that lets a portable, verifiable employee package run safely through
> an existing Agent Host on a publisher-owned machine and produce normalized
> events and verifiable execution evidence for an optional private control
> plane—without hosting the employee or implementing the marketplace.

Digital Employee does not implement another general-purpose model or tool loop.
The selected Agent Host owns model access, context and its native Agent loop;
this framework owns the package, adapter, policy and local execution boundary.
Local create, validate and run workflows do not require a marketplace.

`answer-agent` is the historical first employee use case, not the product
definition. Its checked-in implementation belongs to `standalone-v1`; no
Agent-native recipe is shipped yet, and delivering the first one is an M0
outcome. `standalone-v1` is a compatibility path, not the target for new general
Agent capabilities.

## North Star metric: Verified Local Employee Run

A **Verified Local Employee Run** is a run for which:

1. the employee executes on the publisher or operator's own computer or server;
2. the selected package identity, version and digest match the bytes executed;
3. a registered Agent Host satisfies the required policy and capability gates;
4. the run produces one valid terminal result, a bounded normalized event
   chain and a Runner-signed receipt that can be verified with trusted keys;
5. the platform receives no local package path, employee package artifact bytes or
   Agent Host credential.

This metric measures the framework's end-to-end execution contract. A Runner
signature proves origin and integrity, not that token or cost claims are
billable. Runner-attested usage becomes eligible for settlement only after a
separate private-platform `UsageVerifier` approves it against an immutable
Quote. Credits, prices and seller proceeds are never part of this metric.

## Direct users and jobs to be done

| Direct user | Job to be done |
| --- | --- |
| Employee author or publisher | Define a role once with portable Skill instructions, task/result Schemas, declared assets, evals and capability requirements; validate it and run it through compatible Agent Hosts without embedding vendor commands in the package. |
| Runner operator | Keep the employee package, Agent Host, credentials and execution on a machine they control; use an outbound-only Runner to accept authentic tasks, enforce the selected release and policy, recover safely and return verifiable evidence. |
| Private-platform integrator | Register immutable employee release identity and digest, dispatch signed work and verify events, receipts and usage without hosting the employee package or holding the operator's Agent Host credentials. |

The buyer or end user benefits from the result but is not a direct user of this
open framework. Buyer accounts, discovery, rental and payment are private
marketplace concerns.

## Product scope

### In scope for this open repository

- the `digital-employee` CLI for creating, validating, diagnosing, evaluating,
  packaging and running portable employees;
- the host-neutral employee package, Skill, Schema, declared asset, eval and MCP
  declaration contracts;
- Agent Host adapters, capability negotiation, version gates, normalized events
  and a safe external-adapter extension contract;
- one-shot local execution and the long-running, seller-owned `runner start`
  client that runs on the publisher or operator's machine;
- local deployment bindings, package resolution, device-key handling, durable
  replay/outbox state, reconnect, cancellation and process lifecycle for that
  Runner client;
- package digests, sealed per-run snapshots, signed task and lease verification,
  hash-chained events and Runner-signed receipts;
- provider-neutral raw usage claims and integrity-verification primitives;
- mock or reference control-plane fixtures needed to test the public protocol
  without importing a private platform implementation;
- policy, audit metadata, redaction, escalation and observability at the local
  framework boundary.

### Out of scope for this open repository

- a replacement for Claude Code, Qoder CLI, Codex, Qwen Code, CodeBuddy Code or
  another Agent Host's model and native tool loop;
- cloud hosting of employee packages, Agent Hosts, model accounts, credentials
  or application/service robots;
- marketplace accounts, listings, search, ranking, reviews, rentals, dynamic
  pricing or Quote creation;
- Credit ledgers, billable-usage policy, payment, refund, revenue sharing, tax or
  settlement;
- private-platform server implementations for device registration and identity
  issuance, task dispatch, `UsageVerifier`, Quote, Credit or settlement;
- hard-coded document, drive, DWS, memory or business-system integrations in the
  core. Those capabilities enter through explicit MCP, connector or adapter
  boundaries;
- React, a design system or a marketplace UI in runtime packages. A future local
  operator UI may consume public runtime APIs, while marketplace UI remains
  private.

## Open framework and private marketplace boundary

All application/service employees execute on the publisher or operator's own
machine. The platform is a control plane, never an employee hosting plane.

| Open `digital-employee` framework | Private marketplace control plane |
| --- | --- |
| Employee source package and deterministic local digest | Listing and immutable release identity referencing that digest |
| Host Adapter, local credentials and process/sandbox policy | Server-side device registration and trusted key registry |
| Seller-owned `runner start`, local replay/outbox and outbound client | Task creation, dispatch, lease service and authenticated server API |
| Normalized events, usage claims, event chain and signed receipt | Event ingestion, independent `UsageVerifier` and dispute policy |
| Public signature, lease and receipt verification primitives | Quote, reservation, Credit ledger, billing and settlement |

The platform must not send a local path, arbitrary command, module or credential
to the Runner. It must not receive package bytes or copy Host execution code into
the control plane. The Runner initiates every network connection; publisher
machines do not expose an inbound platform port.

## Practice path

### What the current source supports

1. Build the current source checkout.
2. Create an employee package with `init` and edit its `SKILL.md`, task/result
   Schemas, explicitly declared assets and eval cases.
3. Run static `validate`, then use `doctor --engine` for bounded local Host
   diagnosis. These steps do not prove model entitlement.
4. Provide an explicit deployment credential and use `run --engine` for a real,
   one-shot local Agent/model run. It may consume provider credits.
5. Embedders can use the preview Runner kernel to compute a package digest,
   verify a signed task and lease, execute one local task, produce a hash-chained
   event stream and sign a receipt.

The current source does not ship a deployable long-running `runner start`
process, durable local replay/outbox, reconnecting platform client or public
platform network SDK. Adapter-specific deterministic fixtures do not constitute
live model entitlement or commercial deployment qualification. Consult the
[verification ledger](verification.md) for exact evidence.

### Target end-to-end path

1. The author creates, validates and evaluates a host-neutral employee package.
2. The framework produces a deterministic package artifact and digest.
3. The operator binds the employee release to a locally installed Agent Host,
   legal service credential, sandbox and operating policy.
4. The operator starts the open, outbound-only seller Runner.
5. The private platform registers only release identity, digest, compatible
   Engine metadata and marketplace data, then dispatches a signed task and
   lease after a buyer accepts an immutable Quote.
6. The Runner verifies task, lease, device identity, replay claim and exact
   local package bytes, creates a sealed snapshot and invokes the local Host.
7. The framework emits bounded normalized events and usage claims, builds an
   event chain and submits a Runner-signed terminal receipt.
8. The private platform verifies identity, signatures, lease and event chain;
   its independent `UsageVerifier` decides billable facts before Quote/Credit
   settlement.

## Milestone contract

The roadmap owns dates and issue membership. These milestone outcomes and gates
define the stable sequence.

### M0 — Builder Ready

**User outcome:** an employee author can install the Agent-native framework,
create a host-neutral employee that is not forced into the answer-agent shape,
validate and evaluate it, and complete a documented local run.

**Gate:**

- a clean-machine Agent-native install and quickstart are repeatable;
- neutral scaffolding and at least two materially different employee examples
  use the same package and runtime contracts without core switches;
- eval declarations are validated and executable rather than inert files;
- package and Host failures are actionable and fail closed;
- support claims use the evidence vocabulary below, and no fixture-only Adapter
  is presented as live-qualified;
- release documentation distinguishes source availability from published
  artifacts and never claims an unpublished version is installable.

**Non-goals:** a long-running Runner, marketplace operation and write-capable
business actions.

### M1 — Seller Runner Ready

**User outcome:** a seller can keep an employee online on a machine they control
and safely accept platform work without exposing an inbound port or uploading
the package or Host credential.

**Gate:**

- the open framework ships `runner init/doctor/start/status` or equivalent
  lifecycle commands;
- local release/Engine bindings, device keys, durable replay/outbox, heartbeat,
  reconnect, cancellation and upgrade recovery fail safely across restart;
- a committed mock-control-plane test covers signed claim, local Host execution,
  event upload, receipt verification and network interruption recovery;
- replayed or stale attempts cannot launch work or complete a newer attempt;
- observable evidence proves the control plane did not receive local paths,
  package artifact bytes or Host credentials.

**Non-goals:** marketplace pricing, orders, payment, settlement or a production
private-platform `UsageVerifier`.

### M2 — Framework v1 / Trust Ready

**User outcome:** third-party or enterprise Hosts and approved capabilities can
integrate with stable contracts, while portable employee artifacts and
side-effectful actions have explicit trust and compatibility boundaries.

**Gate:**

- stable employee-package, Agent Host, Runner task/event/receipt and compatibility
  contracts have golden vectors and upgrade rules;
- deterministic package, inspect, verify, provenance, upgrade and rollback
  workflows reject tampering without executing package code;
- an explicit external Adapter protocol and conformance kit integrate one sample
  Adapter without changing core dispatch logic;
- provider-neutral usage evidence remains separate from Quote and Credit math;
- write-capable tools remain default-deny and, when enabled, follow validated
  preview, approval, idempotent execution and immutable audit semantics.

**Non-goals:** marketplace UI, account systems, price algorithms, payment and
robot cloud hosting.

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
| **private** | Implemented or planned outside this public repository. Public interfaces may reference it, but this repository must not claim or absorb its implementation. |

Use `unsupported` or `probe-only` where applicable; neither is a synonym for
preview. Legal permission for unattended operation or resale is a separate
commercial gate even after live qualification.

## Routing a new requirement

Before adding a requirement or issue, answer these questions in order:

1. Does it help define, validate, package, run or observe an employee on the
   publisher-owned machine? If yes, it may belong in the open framework.
2. Does it implement the seller-owned Runner client, its local durability or the
   public task/event/receipt contract? If yes, it belongs in the open framework.
3. Does it own marketplace identity, listing, discovery, rating, rental, Quote,
   Credit, billing, payment or settlement state? If yes, it is private-platform
   work.
4. Is it a server-side device-registration, task-dispatch or `UsageVerifier`
   implementation? If yes, it is private-platform work; only the interoperable
   client/protocol boundary belongs here.
5. Does it create another model or tool loop around an Agent Host? If yes, reject
   or redesign it as a package, Host Adapter or outer-runtime concern.
6. Is it vendor-specific? Put enforcement and projection in a version-gated Host
   Adapter, never in the portable package contract.
7. Is it a document, drive, DWS, memory or business capability? Prefer explicit
   MCP/connector/adapter extension over a core dependency.
8. Is it a UI? A local operator UI may consume public APIs without entering
   runtime packages; marketplace UI is private.
9. What evidence term applies today, and what observable gate would promote it?
   If that answer is missing, the requirement is not ready to claim completion.
10. Would the change send package bytes, local paths, Host credentials or private
    chain-of-thought to the platform? If yes, reject it.

When a requirement crosses boundaries, split it at the public protocol. Do not
put both seller execution and marketplace business state into one issue or
implementation.
