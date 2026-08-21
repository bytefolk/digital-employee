# Scenario: Structured Report Employee

Last reviewed: 2026-08-22

Second scenario spec from Issue #144.

## Product decision recorded (merge of the copywriting candidate)

Four scenario candidates were evaluated for the first three slots. The
copywriting candidate was **merged into this scenario as its second
instance** rather than taking a standalone slot: both are Schema-bound
structured output over approved sources, so the capability mix is identical
and only the output Schema and knowledge pack differ. This keeps the first
three scenarios covering three distinct capability mixes instead of two.
Recorded here as the Issue #144 requirement that at least one product
rejection or reordering is documented with reason.

## Who

Team leads and weekly-report authors; for the second instance, marketing or
copy authors producing short public-facing text.

## Task

- Instance A: generate a structured weekly report from approved data
  sources, delivered through DingTalk.
- Instance B (copywriting): generate marketing copy against a copy-guideline
  knowledge pack, same recipe, different output Schema.

## Capability mix

- Recipe: `structured-action.v1` (offline fixture conformance checked in
  `examples/recipes/`).
- Output: JSON Schema-validated structured output; validation is local and
  fail-closed, with bounded retries before escalation.
- Sources: only approved, read-only data sources; no write authority.
- Channel: DingTalk first; Lark/WeCom after #77/#78 land credentials.

## Escalation behavior

- Missing or incomplete source data → escalate to a human; never emit a
  half-baked report.
- Repeated Schema-validation failure after bounded retries → escalate with a
  stable error code; the employee does not relax its Schema.
- Unverified host or package state → fail closed; no degraded mode.

## Value acceptance

Named acceptance for this scenario:

| Metric | Target |
| --- | --- |
| Schema pass rate on produced artifacts | At or above the agreed rollout target |
| Human review rounds per artifact | Reduced versus the pre-employee baseline |
| Report production time (Instance A) | Reduced versus the pre-employee baseline |

Evidence classes: schema pass rate and review-round counts are task-success
and output-quality evidence per the #140 standard; fixture tests alone do
not satisfy them.
