# Requirement governance

This repository uses the canonical GitHub Issue as the product requirement
document. An implementation consumes one explicit Issue revision; chat,
roadmap summaries, pull requests, test runs, releases, and model conclusions
do not replace that record.

This workflow applies to roadmap, feature, and maintenance requirements. Use
the **Revisioned requirement** Issue form. Existing Issues do not need a mass
rewrite, but the next semantic change must migrate the Issue to this format
before implementation continues.

## Canonical Issue record

The current Issue body contains exactly one current record after the marker
`<!-- requirement-record:v1 -->` and these stable prose sections:

1. user problem and observable outcome;
2. route and ownership boundary;
3. stable `REQ-NNN` requirements;
4. full canonical dependency URLs with exact revisions;
5. stable `AC-NNN` acceptance criteria;
6. non-goals and forbidden shortcuts;
7. lifecycle status, priority, blockers, and open decisions;
8. evidence plan and latest accepted evidence; and
9. append-only revision history.

The form provides this machine-readable starting point:

<!-- requirement-record:v1 -->
```yaml
schemaVersion: requirement-record.v1
revision: R1
status: needs-design
priority: P2
productOwner: "@product-owner"
technicalOwner: "unassigned"
implementationOwner: "unassigned"
automatedPreReviewOwner: "unassigned"
humanReviewOwner: "none"
userOutcome: "A named user can observe one bounded outcome."
requirements:
  - REQ-001
acceptanceCriteria:
  - AC-001
parent: null
dependencies: []
supersedes: []
lastDecisionAt: null
```

`revision` is a contiguous `R` plus a positive integer. `requirements` and
`acceptanceCriteria` contain stable identifiers defined in the prose. Never
reuse or renumber an identifier to mean something else. A cross-repository
dependency uses its full canonical URL and names the exact revision in prose;
`owner/repo#12` alone is not sufficient.

The three delivery fields form an auditable separation of duties:

- `implementationOwner` owns the bounded P8 implementation, tests, CI fixes,
  and evidence packet;
- `automatedPreReviewOwner` independently replays the acceptance evidence and
  may report `PREFLIGHT PASS`, but cannot claim or impersonate GitHub approval;
- `humanReviewOwner` is `none` unless the Issue or CODEOWNERS explicitly names
  a human final reviewer for a stable high-risk, cross-repository, or public
  contract candidate.

No person implements and performs the final human review of the same
candidate. Totoro (`@Bindy-lbb`) is not a routine implementation, test, or
evidence owner. When she is explicitly routed by the Issue or CODEOWNERS,
request one focused review only after the candidate head is stable, automated
pre-review has no P0/P1 finding, and required CI is green. `org-workbench` and
`context` do not route work to her unless their own Issue explicitly does so.

Every newly created requirement has one authoritative initial lifecycle value:
`needs-design`, both in the record and in the form field. The form does not let
an author self-select `ready`, `in-progress`, `product-review`, `accepted`,
`blocked`, or `HOLD`. Those later states are reached only through a named,
append-only `requirement-decision:v1` comment and the resulting body revision.

## When a revision changes

A semantic change is any change to user outcome, scope, ownership boundary,
dependency, requirement, acceptance criterion, compatibility, priority, or
lifecycle. For every semantic change:

1. prepare the complete new decision;
2. append one `requirement-decision:v1` Issue comment;
3. verify that the comment URL and timestamp are visible;
4. replace the current Issue body with the resulting revision and set
   `lastDecisionAt` to the comment timestamp; and
5. append a history row linking the decision comment.

The repository policy is to never edit or delete an old decision comment.
GitHub comments are technically editable, so this is not tamper prevention.
Correct a mistake with another named decision comment and another revision.
Cosmetic spelling, formatting, or link-display fixes that change no meaning
may keep the revision; record them in the edit summary and do not silently
change an identifier or value.

Every decision comment has this envelope:

<!-- requirement-decision:v1 -->
```yaml
schemaVersion: requirement-decision.v1
canonicalIssue: "https://github.com/fullstack-ai-infra/digital-employee/issues/95"
previousRevision: R1
resultingRevision: R2
decisionType: additive
oldDecision: "REQ-001 only"
newDecision: "REQ-001 plus REQ-002"
reason: "The accepted user outcome requires an independently readable artifact."
impact: "Adds one fixture and one AC; the delivery date remains uncommitted."
approver: "@product-owner"
decidedAt: "2026-08-14T08:00:00Z"
```

`oldDecision`, `newDecision`, `reason`, and `impact` must be concrete enough
for a reviewer to reconstruct the change without chat. `approver` is the
person authorized for the affected product decision, not the implementation
agent. Use an RFC 3339 UTC timestamp. The decision comment exists before the
body changes from `previousRevision` to `resultingRevision`.

## Exact semantic decision examples

The following examples are complete comment bodies. Each advances exactly one
revision and remains available after the Issue body changes.

### Additive

Add a requirement or AC without weakening an existing one.

<!-- requirement-decision:v1 -->
```yaml
schemaVersion: requirement-decision.v1
canonicalIssue: "https://github.com/fullstack-ai-infra/digital-employee/issues/95"
previousRevision: R1
resultingRevision: R2
decisionType: additive
oldDecision: "requirements=[REQ-001]; acceptanceCriteria=[AC-001]"
newDecision: "requirements=[REQ-001, REQ-002]; acceptanceCriteria=[AC-001, AC-002]"
reason: "Consumers also need a deterministic negative example."
impact: "Adds one checked fixture; existing behavior and compatibility are unchanged."
approver: "@product-owner"
decidedAt: "2026-08-14T08:10:00Z"
```

After the comment is posted, update the body to R2, add `REQ-002` and `AC-002`,
and link the comment in history. R1 and the comment remain unchanged.

### Narrowing

Reduce scope while preserving the intended outcome.

<!-- requirement-decision:v1 -->
```yaml
schemaVersion: requirement-decision.v1
canonicalIssue: "https://github.com/fullstack-ai-infra/digital-employee/issues/95"
previousRevision: R2
resultingRevision: R3
decisionType: narrowing
oldDecision: "AC-002 requires Linux, macOS, and Windows evidence."
newDecision: "AC-002 requires Linux and macOS evidence; Windows is NOT VERIFIED and remains a named limit."
reason: "No bounded Windows executor is available in this milestone."
impact: "Windows cannot be claimed or used for milestone acceptance."
approver: "@product-owner"
decidedAt: "2026-08-14T08:20:00Z"
```

Update the R3 AC and known-limits section verbatim; do not erase the broader
R2 decision.

### Breaking or compatibility

Change a public contract or compatibility promise.

<!-- requirement-decision:v1 -->
```yaml
schemaVersion: requirement-decision.v1
canonicalIssue: "https://github.com/fullstack-ai-infra/digital-employee/issues/95"
previousRevision: R3
resultingRevision: R4
decisionType: breaking
oldDecision: "Accept requirement-record.v1 records without an explicit priority."
newDecision: "New records require priority; existing R1 records remain readable until semantically touched."
reason: "Scheduling decisions must be reconstructible without labels."
impact: "New templates and checker fixtures change; no historical Issue is rewritten."
approver: "@product-owner"
decidedAt: "2026-08-14T08:30:00Z"
```

Update R4 compatibility and migration text. The old behavior remains visible
in the comment and must not be described as if it never existed.

### Dependency

Add, remove, or change a blocking or downstream dependency.

<!-- requirement-decision:v1 -->
```yaml
schemaVersion: requirement-decision.v1
canonicalIssue: "https://github.com/fullstack-ai-infra/digital-employee/issues/95"
previousRevision: R4
resultingRevision: R5
decisionType: dependency
oldDecision: "dependencies=[]"
newDecision: "dependencies=[https://github.com/fullstack-ai-infra/digital-employee/issues/89 at R1]"
reason: "The governance check must run in the protected CI merge gate."
impact: "Implementation may proceed, but product acceptance waits for dependency R1 evidence."
approver: "@product-owner"
decidedAt: "2026-08-14T08:40:00Z"
```

Update the R5 record and dependency section with the full URL and exact R1;
never replace the old comment with a shorthand reference.

### Priority

Changing only order or urgency is still semantic.

<!-- requirement-decision:v1 -->
```yaml
schemaVersion: requirement-decision.v1
canonicalIssue: "https://github.com/fullstack-ai-infra/digital-employee/issues/95"
previousRevision: R5
resultingRevision: R6
decisionType: priority
oldDecision: "priority=P2; schedule=after P0 Adoption"
newDecision: "priority=P1; schedule=next governance integration window"
reason: "Two active PRs cannot currently reconstruct their consumed requirements."
impact: "Changes sequencing only; scope, ACs, and release claims do not change."
approver: "@product-owner"
decidedAt: "2026-08-14T08:50:00Z"
```

Update priority and schedule in the R6 record/body; the priority label is a
view, not the decision source.

### HOLD

HOLD is an explicit lifecycle gate, not a synonym for blocked or cancelled.

<!-- requirement-decision:v1 -->
```yaml
schemaVersion: requirement-decision.v1
canonicalIssue: "https://github.com/fullstack-ai-infra/digital-employee/issues/95"
previousRevision: R6
resultingRevision: R7
decisionType: hold
oldDecision: "status=in-progress"
newDecision: "status=HOLD; release and acceptance are prohibited pending independent security review"
reason: "The public fixture boundary needs a named security reviewer."
impact: "Development artifacts may be inspected; merge, release, and acceptance stay gated."
approver: "@product-owner"
decidedAt: "2026-08-14T09:00:00Z"
```

Update the body to R7/HOLD and name the release condition. Do not infer HOLD
from inactivity, a label, or a failed job.

### Release from HOLD

Only an explicit decision releases a HOLD.

<!-- requirement-decision:v1 -->
```yaml
schemaVersion: requirement-decision.v1
canonicalIssue: "https://github.com/fullstack-ai-infra/digital-employee/issues/95"
previousRevision: R7
resultingRevision: R8
decisionType: release
oldDecision: "status=HOLD; security review pending"
newDecision: "status=in-progress; security review https://github.com/fullstack-ai-infra/digital-employee/pull/123#issuecomment-456 accepted"
reason: "The named reviewer accepted the bounded public fixture and no-sensitive-data evidence."
impact: "Implementation may resume; merge and product acceptance remain separate gates."
approver: "@product-owner"
decidedAt: "2026-08-14T09:10:00Z"
```

Update the body to R8/in-progress and preserve both HOLD comments. A release
from HOLD is not a software release and does not accept the Issue.

### Duplicate

A duplicate decision records the canonical replacement and disposition; it
does not pretend that the duplicate itself shipped.

<!-- requirement-decision:v1 -->
```yaml
schemaVersion: requirement-decision.v1
canonicalIssue: "https://github.com/fullstack-ai-infra/digital-employee/issues/95"
previousRevision: R8
resultingRevision: R9
decisionType: duplicate
oldDecision: "status=in-progress; this Issue independently owns REQ-001 and AC-001."
newDecision: "status=product-review; dependency https://github.com/fullstack-ai-infra/digital-employee/issues/120 at R3 owns the complete requirement; disposition=duplicate."
reason: "The target contains the same user outcome, REQ/AC set, dependencies, and unresolved limits."
impact: "No implementation or acceptance is claimed here; product review may close this Issue as duplicate after the R9 body links the target."
approver: "@product-owner"
decidedAt: "2026-08-14T09:20:00Z"
```

Update the R9 status and dependency/disposition text to the full target URL and
R3, then let the product reviewer apply the duplicate disposition. Do not use
a PR close keyword and do not delete this Issue's history.

## Pull request implementation trace

Every PR names the full canonical Issue URL and the exact revision it consumes.
It maps each changed file domain and test or review artifact to `REQ-NNN` and
`AC-NNN`; records exact commands, counts, check URLs, security and compatibility
effects, non-goals, and known limits; and identifies product-review handoff
owners. It repeats `implementationOwner`, `automatedPreReviewOwner`, and
`humanReviewOwner` from the consumed Issue revision. Automated review records
`PREFLIGHT PASS` or findings; only the actual human reviewer may submit or be
reported as a GitHub approval.

Do not use automatic Issue close keywords. A merge is implementation evidence,
not product acceptance. `npm run governance:check` validates the repository PR
template and a bounded allowlist of project-authored examples. For `opened`,
`synchronize`, `reopened`, and `edited` pull-request events, one Node 22 CI lane
reads the actual body from the GitHub event file and scans every source commit
message in the exact event `base.sha..head.sha` range with the same close-keyword
oracle. The body is never interpolated into shell source; the checker invokes
local `git` with argument arrays and no shell, and does not call GitHub REST APIs.
The full-history checkout makes both event commits available and ranges over 256
commits fail closed. The complete example is
[`fixtures/requirement-governance/v1/pr/complete.md`](../fixtures/requirement-governance/v1/pr/complete.md).

The deterministic local E3 exercise covers a clean range, a forbidden commit,
a force-pushed replacement head, and malformed or unreachable event identities.
A real fork event and GitHub checkout is E4 **NOT VERIFIED** locally: the event
contract permits a different `head.repo.full_name`, requires the base repository
to match `event.repository.full_name`, and relies on authoritative GitHub Node 22
CI to prove that the fork's exact base and head objects are present.

This gate does not technically prevent a user from closing or linking an Issue
through the GitHub sidebar or another manual action. It also cannot inspect a
future merge or squash commit message that does not yet exist in the PR's source
range. Repository merge settings, protected required checks, and the named
post-merge ledger/product review remain the policy controls for those cases; a
manual action or generated squash message is not product acceptance.

## Lifecycle and authority

| Status | Meaning | Who advances it |
|---|---|---|
| `needs-design` | User outcome, boundary, dependency, or AC still needs an approved decision. | Product owner through a revision decision |
| `ready` | Current revision is approved and has executable acceptance criteria. | Product owner |
| `in-progress` | An implementation consumes the named revision. | Technical owner after assignment |
| `product-review` | Merge ledger exists; product review of the consumed revision is pending. | Merge-ledger owner through a revision decision |
| `accepted` | Product review explicitly accepted the child Issue revision or disposition. | Named product reviewer |
| `blocked` | A named external artifact or dependency prevents progress. | Product or technical owner; unblock through another decision |
| `HOLD` | An explicit safety, compatibility, or release stop is in force. | Product owner; only an explicit release decision removes it |

Labels mirror this state for discovery but cannot change it. Merge, release,
passing tests, or model judgment never advances a lifecycle by itself.

## Append-only merge verification ledger

After merge, append this ledger to the canonical Issue. Use exact 40-character
SHAs, check URLs, commands, observed counts, artifact digests, and named limits.
The append-only rule is repository policy, not technical tamper prevention:
GitHub permits comment edits. Correct a ledger with a new superseding ledger
comment that names the prior comment URL.

<!-- verification-ledger:v1 -->
```yaml
schemaVersion: verification-ledger.v1
canonicalIssue: "https://github.com/fullstack-ai-infra/digital-employee/issues/95"
consumedRevision: R1
pullRequest: "https://github.com/fullstack-ai-infra/digital-employee/pull/123"
headSha: "1111111111111111111111111111111111111111"
mergeSha: "2222222222222222222222222222222222222222"
mergedAt: "2026-08-14T10:00:00Z"
requirements:
  - id: REQ-001
    acceptanceCriteria:
      - AC-001
    files:
      - .github/ISSUE_TEMPLATE/roadmap_item.yml
    evidence:
      - "npm run governance:check => PASS (7 fixtures)"
commands:
  - "npm run check => PASS (exact count copied from the run)"
checks:
  - "https://github.com/fullstack-ai-infra/digital-employee/actions/runs/123456789"
artifacts:
  - name: "requirement-governance-fixtures.v1"
    sha256: "3333333333333333333333333333333333333333333333333333333333333333"
securityGate: PASS
compatibilityGate: PASS
knownLimits:
  - "Manual independent review is still pending."
productReview: requested
recordedBy: "@maintainer"
recordedAt: "2026-08-14T10:05:00Z"
```

Then append a `requirement-decision:v1` comment moving the Issue from
`in-progress` to `product-review`, advance the body revision, and link both
comments in history. The PR must not close the Issue.

## Product review

The named product reviewer checks the current user outcome and every AC against
the merge ledger. The review is another append-only comment:

<!-- product-review:v1 -->
```yaml
schemaVersion: product-review.v1
canonicalIssue: "https://github.com/fullstack-ai-infra/digital-employee/issues/95"
reviewedRevision: R2
consumedImplementationRevision: R1
verificationLedger: "https://github.com/fullstack-ai-infra/digital-employee/issues/95#issuecomment-789"
decision: ACCEPT
reason: "AC-001 through AC-004 match the approved user outcome and evidence boundary."
remainingLimits:
  - "No historical Issue body was rewritten."
reviewer: "@product-owner"
reviewedAt: "2026-08-14T11:00:00Z"
```

`ACCEPT` permits a decision advancing the child to `accepted` and closing it.
`REJECT` must name the failed ACs and results in a new revision returning to
`in-progress`, `needs-design`, `blocked`, or `HOLD`. A release does not replace
this review.

## Milestone artifact packet and owner decision

A milestone remains open after its child Issues are accepted. Freeze one SHA
and the exact artifact packet, then append this packet to the milestone Issue:

<!-- milestone-packet:v1 -->
```yaml
schemaVersion: milestone-packet.v1
milestoneIssue: "https://github.com/fullstack-ai-infra/digital-employee/issues/25"
milestoneRevision: R4
frozenSha: "4444444444444444444444444444444444444444"
preparedAt: "2026-08-14T12:00:00Z"
childLedgers:
  - "https://github.com/fullstack-ai-infra/digital-employee/issues/95#issuecomment-789"
artifacts:
  - url: "https://github.com/fullstack-ai-infra/digital-employee/releases/tag/v0.4.0"
    sha256: "5555555555555555555555555555555555555555555555555555555555555555"
checks:
  - "https://github.com/fullstack-ai-infra/digital-employee/actions/runs/123456789"
knownLimits:
  - "Windows remains NOT VERIFIED under child Issue R3."
ownerDecision: PENDING
preparedBy: "@maintainer"
```

The named milestone owner responds with an explicit decision that repeats the
frozen identity. This is a required named decision and review gate, not
technical identity or tamper enforcement. The packet author, a label, a
release job, or a model does not satisfy the requirement.

<!-- milestone-owner-decision:v1 -->
```yaml
schemaVersion: milestone-owner-decision.v1
milestoneIssue: "https://github.com/fullstack-ai-infra/digital-employee/issues/25"
milestoneRevision: R4
packet: "https://github.com/fullstack-ai-infra/digital-employee/issues/25#issuecomment-999"
frozenSha: "4444444444444444444444444444444444444444"
decision: ACCEPT
reason: "The frozen SHA, child ledgers, artifacts, checks, and known limits satisfy the milestone outcome."
owner: "@milestone-owner"
decidedAt: "2026-08-14T13:00:00Z"
```

Only `ACCEPT` permits milestone closure. `REJECT` leaves it open and must state
which packet field or outcome is insufficient; a revised packet receives a new
comment URL and another explicit owner decision.

## Security, visibility, and corrections

Public records contain only public-safe commands, identifiers, links, and
sanitized output. A private security review is recorded as gate status and a
public-safe reviewer decision, never as credentials, exploit details, internal
URLs, logs, screenshots, or private identities. If a public record is wrong,
append a correcting decision or ledger that names the superseded comment; do
not destructively rewrite history.
