# Hire request contract (hire-request.v1alpha1)

The hire request is a thin reference envelope (#194, R4 freeze). It
REFERENCES a sealed employee package and a sealed turn envelope, and names
where the employee would hang in the org tree. It does not spawn anything,
call the engine, invoke a model or provider, or mutate any tree.

```
digital-employee hire validate <file> [--json]
```

Validation is static and fail-closed. Exit 0 means the document is a valid
`hire-request.v1alpha1`. Any violation exits 1 before any effect, with a
stable machine-readable diagnostic code — one stderr line
(`digital-employee: <code>`), or `{ "status": "failed", "code": ... }` on
stdout under `--json`.

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | Const `"hire-request.v1alpha1"` |
| `workspaceRef` | yes | Non-empty string, bounded to 256 characters — the same constraints as turn-envelope.v1 `workspaceRef` |
| `packageRef` | yes | Exactly `{ "name", "version", "digest" }`; no other fields. `name` is a non-empty bounded string, `version` matches `^v1alpha1(\.[0-9]+)?$`, `digest` is a string of at least 16 characters. There is no `localReference` channel |
| `targetParentId` | yes | Non-empty opaque string (bounded to 256 characters). Validated as text only: no tree lookup, no import of org-workbench |
| `budget` | yes | `{ "perTask": budgetScope, "perDay": budgetScope }` — a hire without a budget fails closed |
| `requestedBy` | yes | Non-empty bounded string naming the requester |
| `deadline` | no | String, handled exactly like turn-envelope.v1 `deadline` (must be parseable as an ISO 8601 timestamp) |
| `envelopeDigest` | yes | String of at least 16 characters referencing the sealed turn envelope |

Unknown fields are rejected at every level (`hire_request_unknown_field:<path>`).

### budgetScope vocabulary

Each `budgetScope` is an object with optional `tokens` and `iterations`
(positive integers, each between 1 and 1,000,000,000), at least one of the
two declared, and no other fields. The vocabulary is byte-aligned with the
engine `BudgetScope` and the published turn-envelope.v1 `$defs/budgetScope`
(#194 AC-005); the cap mirrors `MAX_BUDGET_CAP` in
`packages/engine/src/budget.ts`.

## Fail-closed diagnostics

| Code | Meaning |
| --- | --- |
| `hire_request_unknown_field:<path>` | Field not part of the frozen contract |
| `hire_request_invalid_field:<path>` | Missing required field or value violates its constraint |
| `hire_request_missing_budget` | `budget` absent — hiring without a budget is rejected |
| `hire_request_file_unreadable` | The file cannot be read |
| `hire_request_too_large` | Input exceeds the bounded envelope size |
| `hire_request_invalid_json` | Input is not valid JSON |

## Budget-attached rule

A hire request without `budget` is not a warning; it is a rejection. Budget
is attached at hire time so every spawned task inherits declared per-task and
per-day caps instead of negotiating them after the fact.

## Consumer boundary

This contract deliberately stops at validation:

- `targetParentId` is opaque here (#194 AC-003). Resolving it against the
  org tree is the consumer's job (org-workbench #33); this repo performs no
  tree validation and no org-workbench import.
- `identity.roleId` on the employee package is likewise unresolved here; the
  consumer resolves it against its role vocabulary.
- There are no approval semantics on the hire channel: no `pendingApproval`,
  no new approval vocabulary, and no engine changes.

The published schema is `configs/hire-request.schema.json`; it is
byte-identical to the code-side builder `buildHireRequestSchema()`
(`packages/core/src/hire-request.ts`), enforced by the schema-consistency
test.
