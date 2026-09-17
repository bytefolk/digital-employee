# Issue batch A implementation design

Date: 2026-09-17

This design covers the first executable batch selected from the open issue
backlog: #310, #308, #305, #303, and #261. Parent issues remain the source of
product intent; these child records define the bounded implementation seams.

## Goals and non-goals

- Preserve byte-for-byte behaviour when each optional declaration or cache is
  absent/disabled.
- Fail closed before model or host execution for malformed declarations and
  unsatisfiable capability requests.
- Keep evidence digest-only and prevent cross-position scope widening.
- Add deterministic regression fixtures before changing production code.
- Do not publish packages, move tags, alter release metadata, or bypass human
  review gates.

## #310 position connector declarations

Each position may contain an optional `connectors.json` using the strict
`position-connectors.v1` shape. The declaration has `channels` and `sources`
arrays. Each item names a connector registry id and may carry only bounded
environment-variable references; raw credentials, traversal paths, unknown
keys, duplicate ids, and ids absent from the runtime registry are rejected by
`org apply`. The validator receives the registry vocabulary rather than a
hard-coded list. When the file is absent, declarations and derived artifacts
remain unchanged.

## #308 network capability contract

The employee package policy accepts `deny`, `host_policy`, or `allowlist`.
`allowlist` carries an optional bounded host list and rejects malformed hosts.
`deny` keeps existing semantics. Any non-`deny` mode derives the
`network_policy` host requirement; the run path reports the existing
adapter-independent compatibility failure before spawn when the capability is
unsupported or unverified.

## #305 skill declaration contract

The manifest gains an optional strict `skills` array. Each unit is referenced by
portable name, SemVer version, content digest, and optional locality. The
contract validator checks identifiers, versions, digest shape, locality, and
duplicate references. No engine loading or tool projection is introduced in
this batch; packages without `skills` remain observationally identical.

## #303 in-process memory reuse

The engine owns a default-disabled in-process cache decorator around
`MemoryPort.recall`. Entries are keyed by adapter identity, workspace instance,
session, position, principal, memory scope, mode, and limit. A 30-second TTL is
used for the first slice. Cache entries are served only while the complete
`memoryId/stateVersion/digest` witness is unchanged; expiry or witness mismatch
forces a live recall. Cached bytes flow through the existing assembler and are
counted normally. Evidence adds optional `cacheHit` and `cacheAgeMs` fields;
no raw memory text or credentials are recorded.

## #261 coverage accounting

The tsx 4.23.13 dependency remains pinned. Development coverage explicitly
uses c8 12.0.0 while preserving all source/build include domains and the
existing 85/65/80 thresholds. Regression fixtures prove source-map accounting
is independent of capture order, retains mapped original-source coverage, and
still fails for a genuinely unexecuted control.

## Verification and delivery

Each child issue gets a focused test command and the complete repository check
before its commit. Commits name the issue and observed hypothesis. The branch
is pushed only when GitHub credentials are available; remote SHA is compared
with `git rev-parse HEAD` and `git ls-remote` before reporting success. Release
issues (#237/#247/#290) are prepared or audited only; publication requires the
explicit owner authorization recorded in those issues.
