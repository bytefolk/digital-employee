# Knowledge asset convention

Last verified: 2026-08-22

This convention defines where shared knowledge lives, how assets are named and
kept fresh, and where the public-safe boundary sits. It applies to every
knowledge asset a packaged employee, a recipe, or this repository's docs rely
on. The quality bar a packaged employee must meet when it declares such an
asset as a knowledge source is defined in
[knowledge-source-quality-bar.md](knowledge-source-quality-bar.md).

## Where shared knowledge lives

| Location | What belongs there | What never belongs there |
| --- | --- | --- |
| In-package `knowledge/` | Small, approved, public-safe reference material shipped with one employee package and explicitly listed in `employee.json` `assets` | Large corpora, private data, credentials, account identifiers, generated indexes |
| This repository (`docs/`, `examples/`, `recipes/`, `fixtures/`) | Public product contracts, the verification ledger, approved public fixtures and recipe samples | Anything internal-only; see the boundary below |
| DWS drive (网盘) and DWS doc | Team-shared documents read at runtime through the explicitly approved, read-only DWS connector | Inline copies pasted into packages or issues; the package holds an approved locator, not the content |
| `mem` / `doc` services | Scoped durable memory and version-pinned documents read through the operator-granted path described in [real-local-e2e.md](../real-local-e2e.md) | Operator grants inside the package; service URLs outside the loopback harness |
| Internal knowledge bases | Internal-only material referenced from internal deployments | Any reference in public docs, packages, commit messages, or PR bodies |

A packaged employee never mounts an internal system directly. It declares an
abstract source or MCP capability; the operator-owned deployment binds the
concrete locator and credential names.

## Naming

- Public files and directories use lowercase letters, digits and single
  hyphens — the same portable subset as the employee name in
  [employee-package.md](../employee-package.md) — at most 64 characters.
- Dated snapshots and audits carry an ISO date suffix, for example
  `codex-cli-0.148.0-default-deny-audit.md`; superseded revisions stay in
  place and are named as their own dated revision rather than rewritten.
- Locators that leave the repository (drive/doc nodes, service workspaces) are
  recorded as capability or grant names, never as raw URLs or identifiers in
  public artifacts.

## Freshness

- Every curated knowledge asset carries a last-verified date, either in the
  asset itself (a `Last verified:` or `Last reviewed:` line, as in
  [../verification.md](../verification.md)) or in the index that lists it.
- The review cadence and the stale-asset rule are defined once in
  [knowledge-source-quality-bar.md](knowledge-source-quality-bar.md) and apply
  here unchanged.
- A behavior-changing pull request that touches an asset resets that asset's
  date in the same change; see the doc-consistency rule in
  [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Public-safe vs internal boundary

Public artifacts (this repository, packages, issues, PRs, ledgers) may contain
only public-safe commands, sanitized output, public URLs and capability names.
The following stay internal and are never committed, pasted, or screenshotted
into public records:

- credentials, tokens, cookies, and credential-bearing URLs;
- tenant, organization, user, profile, document, or chat identifiers, and any
  internal hostname or URL;
- chat exports, personal data, and generated private knowledge indexes;
- screenshots and recordings — share them through the private channel only and
  reference them from public records by a text description.

Redact by keeping the shape and dropping the value: `sk-...`, not a partial
real key. The evidence discipline in
[requirement-governance.md](../requirement-governance.md#security-visibility-and-corrections)
and the repository security scan (`npm run security:check`) enforce the same
boundary mechanically; this convention is the human-readable statement of it.
