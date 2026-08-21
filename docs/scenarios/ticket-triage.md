# Scenario: Ticket Triage Employee

Last reviewed: 2026-08-22

Third scenario spec from Issue #144.

## Who

On-call and support rotation engineers receiving inbound tickets.

## Task

Classify each incoming ticket by severity and owner and emit a structured
routing suggestion. The employee triages only; it never resolves, edits, or
closes a ticket. Automated resolution is explicitly out of scope because the
current capability boundary grants no write authority.

## Capability mix

- Recipe: `structured-action.v1` plus a routing-rule knowledge pack bound
  into the employee package.
- Output: JSON Schema-validated routing suggestion (severity, suggested
  owner, confidence, reasoning).
- Access: read-only over ticket text and the routing knowledge pack.
- Channel: DingTalk MVP; the full shape depends on Lark (#77) and WeCom
  (#78) credentials landing.

## Escalation behavior

- Confidence below the agreed threshold → hand off to a human with the
  reasoning attached, never a silent guess.
- Severity P0 → immediate DingTalk alert escalation to the on-call owner;
  the employee does not queue or batch P0.
- Schema-validation or host failure → fail closed with a stable error code;
  tickets remain in the human queue rather than being misrouted.

## Value acceptance

Named acceptance for this scenario:

| Metric | Target |
| --- | --- |
| Triage accuracy on a labeled backfill set | At or above the agreed rollout target |
| Mean time to acknowledge (MTTA) | Reduced versus the pre-employee baseline |
| Low-confidence hand-off correctness | Every sub-threshold ticket reaches a human with reasoning |

Evidence classes: accuracy on the labeled backfill is task-success evidence;
escalation correctness (no silent guesses, no queued P0) is escalation
evidence per the #140 standard. Fixture tests do not satisfy either.

## Dependency note

This scenario's full value is gated on #77/#78 channel credentials. The
DingTalk MVP exists so the scenario can start producing evidence before
those land.
