## Canonical requirement

- Canonical Issue URL: https://github.com/fullstack-ai-infra/digital-employee/issues/95
- Consumed revision: R1
- No automatic close keywords: acknowledged

Fixes: #95

## Requirement trace

| REQ/AC IDs | Changed files / domain | Tests or review evidence |
|---|---|---|
| REQ-003 / AC-003 | `.github/pull_request_template.md` | `npm run governance:check` (expected rejection) |

## File domains

Repository governance fixtures only; product runtime files are unchanged.

## Scope and non-goals

This negative fixture proves colon-delimited automatic closure fails closed.

## Validation

- Exact commands: `npm run governance:check`
- Observed counts/results: PASS, 1/1 expected forbidden-keyword result observed
- Check URLs: NOT VERIFIED: this local negative fixture has no CI check URL

| ID | REQ/AC | Observable acceptance criterion | Command or manual steps | Environment | Expected | Observed | Status |
|---|---|---|---|---|---|---|---|
| V1 | REQ-003 / AC-003 | Automatic closure fails closed | `npm run governance:check` | Node.js 20+ repository root | One exact forbidden-keyword error | One exact forbidden-keyword error | PASS |

## Security and compatibility

The offline fixture contains public synthetic text and changes no compatibility
contract.

## Known limitations

This fixture covers one GitHub keyword/reference spelling; sibling fixtures
cover full URLs and cross-repository references.

## Risk and rollback

This is an intentionally invalid negative fixture with no external side effect.

## Product review handoff

- Merge ledger owner: @maintainer
- Product reviewer: @product-owner
- Milestone or release packet: N/A: this fixture is not a milestone delivery
- Merge, CI, release, and model judgment do not accept or close the Issue: acknowledged
