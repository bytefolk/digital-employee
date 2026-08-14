## Canonical requirement

- Canonical Issue URL: <!-- Full URL, for example https://github.com/fullstack-ai-infra/digital-employee/issues/95 -->
- Consumed revision: <!-- R1, R2, ... -->
- No automatic close keywords: <!-- After checking the PR body and commit messages, replace this comment with acknowledged. -->

## Requirement trace

| REQ/AC IDs | Changed files / domain | Tests or review evidence |
|---|---|---|
| REQ-NNN / AC-NNN |  |  |

## File domains

<!-- List each changed file group, its owner, and why it belongs in this requirement. -->

## Scope and non-goals

<!-- Describe the user-visible change, implementation boundary, and explicit non-goals. -->

## Validation

- Exact commands: <!-- Copyable commands run against this HEAD. -->
- Observed counts/results: <!-- Exact pass/fail counts and key observable output. -->
- Check URLs: <!-- Full CI/check URL, or NOT VERIFIED: <blocking reason>. -->

| ID | REQ/AC | Observable acceptance criterion | Command or manual steps | Environment | Expected | Observed | Status |
|---|---|---|---|---|---|---|---|
| V1 | AC-NNN |  |  |  |  |  | PASS / FAIL / NOT VERIFIED / N/A |

## Security and compatibility

- [ ] No credentials, personal identifiers, private messages, internal URLs, or generated indexes are included.
- [ ] Source/tool access and public evidence are explicitly bounded.
- [ ] Logs redact content, identities, and credential-bearing URLs.
- [ ] Compatibility, migration, and cross-repository effects are stated below.
- [ ] New dependencies and licenses were reviewed, or no dependency changed.
- [ ] `npm run check` and `npm audit --omit=dev --audit-level=high` pass, or an exact NOT VERIFIED boundary is recorded.

<!-- Security findings, compatibility range, migration requirements, and evidence visibility. -->

## Known limitations

<!-- List unverified platforms, unavailable environments, accepted fixture boundaries, and remaining HOLD conditions. Use "None" only after review. -->

## Risk and rollback

<!-- Describe permissions, data flow, rollback steps, and any irreversible effect. -->

## Product review handoff

- Merge ledger owner: <!-- @maintainer -->
- Product reviewer: <!-- @product-owner -->
- Milestone or release packet: <!-- Full canonical URL, or N/A: <reason>. -->
- Merge, CI, release, and model judgment do not accept or close the Issue: <!-- After checking the handoff boundary, replace this comment with acknowledged. -->
