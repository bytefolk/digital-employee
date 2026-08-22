# Scenario: Knowledge Answering Employee

Last reviewed: 2026-08-22

First scenario spec from Issue #144. Direction decision and alternatives are
recorded in the Issue discussion; this document is the committed one-page spec.

## Who

Team members — new hires and on-call engineers — asking questions in a
DingTalk group. The employee serves people who need a fast, citable answer
from internal knowledge without hunting through documents themselves.

## Task

Answer questions strictly from an approved knowledge pack. The employee is
read-only and zero-tool: it may read its packaged assets and nothing else.

## Capability mix

- Recipe: `minimal-answer.v1` (offline fixture conformance checked in
  `examples/recipes/`).
- Assets: reviewed knowledge pack bound into the employee package.
- Output: text answer with the approved citation; no write authority, no
  network calls, no tool surface.
- Channel: DingTalk (the only mature channel today; Lark and WeCom are
  blocked on credentials per #77/#78).

## Escalation behavior

- Question outside the knowledge pack → fixed refusal phrasing and hand-off
  to a human. Guessing is forbidden.
- Knowledge-pack update → repackage and re-verify before redistribution; the
  running employee is never patched in place.
- Host or package verification failure → fail closed with a stable error
  code; the employee does not degrade into an unverified mode.

## Value acceptance

Named acceptance for this scenario:

| Metric | Target |
| --- | --- |
| Golden-question-set accuracy | At or above the target agreed with the team before rollout |
| Out-of-scope refusal rate | 100% — no guessed answers beyond the pack |
| DingTalk end-to-end response latency | Within the agreed interactive budget |

Evidence classes: the golden-question run and refusal audit are task-success
evidence per the #140 standard; they are not substitutable by fixture tests.
