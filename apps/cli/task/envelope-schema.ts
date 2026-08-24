import { DELEGATION_ENVELOPE_VERSION } from "../../../packages/engine/src/delegation.js"

export const DELEGATION_ENVELOPE_SCHEMA_ID =
  "https://fullstack-ai-infra.dev/schemas/delegation-envelope.schema.json" as const

function identifier(): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    maxLength: 256,
    pattern: "^[^\\u0000-\\u001f\\u007f]+$",
  }
}
export function buildDelegationEnvelopeSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: DELEGATION_ENVELOPE_SCHEMA_ID,
    title: "delegation-envelope.v1 explicit single-hop request",
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "taskId",
      "parentTurnId",
      "childTurnId",
      "delegatedBy",
      "routedTo",
      "trigger",
      "delegationDepth",
      "attempt",
      "retryOfTaskId",
      "engine",
      "instruction",
      "organizationDigest",
      "permissionsDigest",
      "deadline",
      "envelopeDigest",
    ],
    properties: {
      schemaVersion: { const: DELEGATION_ENVELOPE_VERSION },
      taskId: identifier(),
      parentTurnId: identifier(),
      childTurnId: identifier(),
      delegatedBy: identifier(),
      routedTo: identifier(),
      trigger: { const: "user_explicit" },
      delegationDepth: { const: 1 },
      attempt: { type: "integer", minimum: 1 },
      retryOfTaskId: { anyOf: [{ type: "null" }, identifier()] },
      engine: { enum: ["qoder", "claude-code"] },
      instruction: { type: "string", minLength: 1, maxLength: 20_000 },
      organizationDigest: { $ref: "#/$defs/digest" },
      permissionsDigest: { $ref: "#/$defs/digest" },
      deadline: { type: "string", format: "date-time" },
      envelopeDigest: { $ref: "#/$defs/digest" },
    },
    $defs: {
      digest: {
        type: "string",
        pattern: "^sha256:[a-f0-9]{64}$",
      },
    },
  }
}
