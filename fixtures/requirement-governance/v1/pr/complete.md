## Canonical requirement

- Canonical Issue URL: https://github.com/fullstack-ai-infra/digital-employee/issues/95
- Consumed revision: R1
- No automatic close keywords: acknowledged

## Requirement trace

| REQ/AC IDs | Changed files / domain | Tests or review evidence |
|---|---|---|
| REQ-001 / AC-001 | `.github/ISSUE_TEMPLATE/roadmap_item.yml` | `npm run governance:check` (PASS: Issue contract) |
| REQ-003 / AC-003 | `.github/pull_request_template.md`, `scripts/requirement-governance-check.js` | `npm run governance:check` (PASS: 7/7 fixtures) |
| REQ-004 / AC-004 | `docs/requirement-governance.md` | Independent manual review requested |

## File domains

- Repository governance: Issue/PR templates, maintainer guide, offline fixtures, and CI checker only.
- Product runtime: unchanged.

## Scope and non-goals

Add an auditable requirement-to-acceptance path for revision R1. Do not change
runtime behavior, rewrite existing Issue history, or infer acceptance from CI.

## Validation

- Exact commands: `npm run governance:check`
- Observed counts/results: PASS, 7/7 allowlisted PR fixtures matched expected outcomes
- Check URLs: NOT VERIFIED: this local fixture has no authoritative CI check URL

| ID | REQ/AC | Observable acceptance criterion | Command or manual steps | Environment | Expected | Observed | Status |
|---|---|---|---|---|---|---|---|
| V1 | REQ-003 / AC-003 | Missing PR headings fail closed | `npm run governance:check` | Node.js 20+; repository root | Negative fixture is rejected with its exact expected error | 7/7 allowlisted fixtures matched their expected result | PASS |

## Security and compatibility

The checker is offline, reads only fixed repository files and allowlisted
bounded fixtures, adds no dependency, and changes no public runtime contract.

## Known limitations

Historical Issues migrate only when semantically touched; no mass rewrite is
performed. Product and owner review remain manual authority gates.

## Risk and rollback

Risk is limited to contributor workflow friction. Revert the governance asset
change as one unit; no product data or runtime migration exists.

## Product review handoff

- Merge ledger owner: @maintainer
- Product reviewer: @product-owner
- Milestone or release packet: N/A: this fixture is not a milestone delivery
- Merge, CI, release, and model judgment do not accept or close the Issue: acknowledged
