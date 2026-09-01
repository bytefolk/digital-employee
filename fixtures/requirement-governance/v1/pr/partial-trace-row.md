## Canonical requirement

- Canonical Issue URL: https://github.com/bytefolk/digital-employee/issues/95
- Consumed revision: R1
- No automatic close keywords: acknowledged

## Requirement trace

| REQ/AC IDs | Changed files / domain | Tests or review evidence |
|---|---|---|
| REQ-001 / AC-001 | `.github/ISSUE_TEMPLATE/roadmap_item.yml` | `npm run governance:check` (PASS: Issue contract) |
| REQ-002 / AC-002 | `docs/requirement-governance.md` | |

## File domains

Repository governance examples only; product runtime files are unchanged.

## Scope and non-goals

This negative example proves that one complete row cannot hide a later partial
trace row. It makes no product or runtime change.

## Validation

- Exact commands: `npm run governance:check`
- Observed counts/results: PASS, 1/1 expected partial-row rejection observed
- Check URLs: NOT VERIFIED: this local negative fixture has no CI check URL

| ID | REQ/AC | Observable acceptance criterion | Command or manual steps | Environment | Expected | Observed | Status |
|---|---|---|---|---|---|---|---|
| V1 | REQ-002 / AC-002 | Every nonseparator trace row is complete | `npm run governance:check` | Node.js 20+ repository root | The second row is rejected | One exact row error is returned | PASS |

## Security and compatibility

The fixture is bounded public text and changes no compatibility contract.

## Known limitations

This fixture tests a missing evidence cell; other fixtures cover hollow sections.

## Risk and rollback

This is an intentionally invalid negative fixture with no external side effect.

## Product review handoff

- Merge ledger owner: @maintainer
- Product reviewer: @product-owner
- Milestone or release packet: N/A: this fixture is not a milestone delivery
- Merge, CI, release, and model judgment do not accept or close the Issue: acknowledged
