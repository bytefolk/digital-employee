# Knowledge source quality bar

Last verified: 2026-08-22

This is the minimum bar a packaged employee must meet before it may declare a
knowledge source — whether that source ships inside the package as
`knowledge/` material or is reached at runtime through an approved connector
or MCP capability. Where shared knowledge lives and how assets are named is
defined in [asset-convention.md](asset-convention.md); this document defines
scope, provenance, freshness, and the staleness-tracking cadence.

## Scope

- Every source is explicit. In-package material is listed file-by-file in
  `employee.json` `assets`; policy globs grant a maximum scope and never
  discover package files. External sources are declared as an MCP capability
  or connector configuration with environment-variable secret names only.
- Declared scope is read-only and maximal, never a floor: a run may narrow the
  declared scope (operator grant, deployment policy) but never widen it.
- Sources outside the package are bound by the operator-owned deployment, not
  by the package. The package carries locators and capability names, never
  endpoints with embedded credentials, tenant identifiers, or raw URLs.

## Provenance

- Each declared source names its origin: the owning system or author, its
  approval status, and the trust boundary the read crosses. Approved fixture
  material states this in the asset itself (see the recipe `knowledge/README.md`
  files); external sources state it in the operator grant and connector
  configuration.
- Generated or private indexes, chat exports, and personal data are not
  package content and cannot become a declared source by being copied into
  `knowledge/`.
- Answers grounded in an approved source cite that source; the package's Skill
  or contract must say so, as the built-in `minimal-answer.v1` recipe does.

## Freshness

- Where the backing system supports revisions, the read pins one: the #42
  real-local path reads documents with client-side ETag revision pinning and
  rejects a wrong revision (`real_local_revision_mismatch`), and the component
  matrix is the sole version authority for the services themselves.
- Where no revision exists, the source or its index entry carries a
  last-verified date, and the deployment treats reads past the review cadence
  below as stale until re-verified.
- A declared source never silently serves a degraded snapshot as current: the
  Git source contract, for example, revalidates any last-known-good generation
  and reports `degraded` instead of presenting it as fresh.

## Alignment with the mem/doc read-path contract (#42)

The real-local read path is the reference implementation for external
knowledge reads, and any declared mem/doc source inherits its contract:

- every read is gated twice — by the operator-owned `capability-grant.v1`
  file materialized **outside** the package (a grant found inside the package
  is rejected as a self-grant) and by the service's own grants or ownership;
- service URLs are loopback-only in the harness, and denial, revocation, and
  absence map to the frozen `real_local_*` code namespace rather than prose;
- revoked, unlisted, and absent documents are indistinguishable — no
  enumeration — and evidence is emitted with an empty secret scan;
- fixture-backed declarations stay `synthetic-conformance`; only the pinned
  real-service path earns `real-local-e2e`, and a packaged employee's claims
  are capped by the evidence class its source path actually earned.

## Alignment with the retention RFC (#104)

Retention and deletion policy is set by the operator or platform that hosts
the data, per [SECURITY.md](../../SECURITY.md) — not by the employee package.
Accordingly:

- a package declares no retention behavior and never implies that declaring a
  source grants retention, export, or deletion rights over it;
- connector contributions document the retention behavior of their boundary
  (see [../connectors/README.md](../connectors/README.md));
- the retention RFC tracked in
  [#104](https://github.com/bytefolk/digital-employee/issues/104)
  owns the runtime retention semantics. When that RFC lands, declared sources
  must not contradict it, and any retention metadata it introduces is adopted
  here rather than redefined. This bar deliberately does not pre-implement the
  RFC's runtime behavior.

## Staleness tracking and review cadence

Matching the verification-ledger habit (`Last reviewed:` in
[../verification.md](../verification.md)):

1. Every context asset — verification ledger rows, host/version matrices,
   research audits, recipe knowledge files, and this directory's conventions —
   carries a last-verified date.
2. Cadence: an asset is re-verified at every release gate that touches its
   domain, and at least every 90 days even when nothing touched it.
3. A behavior-changing pull request that lands without updating the assets it
   makes stale is flagged under the doc-consistency rule in
   [CONTRIBUTING.md](../../CONTRIBUTING.md); the same change must reset the
   date or record why the date stands.
4. An asset past its cadence is stale: it may remain in place for history, but
   a packaged employee or public doc may not cite it as current until it is
   re-verified or corrected. Corrections append a dated note or a new dated
   revision rather than rewriting the old record.
