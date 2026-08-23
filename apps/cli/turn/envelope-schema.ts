/**
 * Code-side builder for the turn-envelope.v1 JSON Schema (#173 REQ-002,
 * open decision 3: published under configs/ with the builder byte-identity
 * discipline). The published file configs/turn-envelope.schema.json must be
 * byte-identical to `JSON.stringify(buildTurnEnvelopeSchema(), null, 2) +
 * "\n"`; the schema-consistency test enforces this.
 */

import {
  TURN_ENVELOPE_SCHEMA_ID,
  TURN_ENVELOPE_VERSION,
} from "./envelope.js"

function boundedIdSchema(): Record<string, unknown> {
  return { type: "string", minLength: 1, maxLength: 256 }
}

function budgetScopeSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      tokens: { type: "integer", exclusiveMinimum: 0, maximum: 1_000_000_000 },
      iterations: {
        type: "integer",
        exclusiveMinimum: 0,
        maximum: 1_000_000_000,
      },
    },
  }
}

/**
 * Build the turn-envelope.v1 JSON Schema (draft 2020-12). Mirrors
 * `parseTurnEnvelope` field-by-field; validator/builder agreement is
 * asserted by the test suite on the fixture set.
 */
export function buildTurnEnvelopeSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: TURN_ENVELOPE_SCHEMA_ID,
    title: "turn-envelope.v1 sealed turn request",
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "workspaceRef",
      "positionId",
      "turnId",
      "input",
      "envelopeDigest",
    ],
    properties: {
      schemaVersion: { const: TURN_ENVELOPE_VERSION },
      workspaceRef: boundedIdSchema(),
      positionId: boundedIdSchema(),
      turnId: boundedIdSchema(),
      input: {},
      budget: {
        type: "object",
        additionalProperties: false,
        required: ["maxIterations"],
        properties: {
          maxIterations: { type: "integer", minimum: 1 },
          maxTokens: { type: "integer", minimum: 1 },
        },
      },
      positionBudget: {
        type: "object",
        additionalProperties: false,
        required: ["perTask", "perDay"],
        properties: {
          perTask: { $ref: "#/$defs/budgetScope" },
          perDay: { $ref: "#/$defs/budgetScope" },
        },
      },
      taskId: boundedIdSchema(),
      dayKey: boundedIdSchema(),
      deadline: { type: "string" },
      envelopeDigest: { type: "string", minLength: 1 },
    },
    $defs: {
      budgetScope: budgetScopeSchema(),
    },
  }
}
