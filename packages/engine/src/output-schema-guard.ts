import { Ajv2020 } from "ajv/dist/2020.js"

import type { SafeValue } from "../../core/src/contracts.js"

export const ENGINE_MAX_OUTPUT_SCHEMA_BYTES = 16 * 1024

/**
 * One bounded, immutable terminal-schema snapshot per turn. The compiled
 * validator is the single synchronous terminal check: the validate/repair
 * loop must consume this snapshot and never recompile.
 *
 * Asynchronous schemas are the canonical hazard: an accepted `$async`
 * validator would let a Promise masquerade as a synchronous terminal
 * guarantee, so every compile failure fails closed.
 */
export interface PreparedTerminalSchema {
  json: string
  value: SafeValue
  validate: (candidate: unknown) => boolean
}

export class OutputSchemaGuardError extends Error {
  constructor(
    readonly code:
      | "engine.output_schema_too_large"
      | "engine.output_schema_invalid",
    message: string,
  ) {
    super(message)
    this.name = "OutputSchemaGuardError"
  }
}

export function prepareTerminalSchema(
  schema: SafeValue | undefined,
  maxBytes = ENGINE_MAX_OUTPUT_SCHEMA_BYTES,
): PreparedTerminalSchema | undefined {
  if (schema === undefined) return undefined
  try {
    const json = JSON.stringify(schema)
    if (typeof json !== "string" || json.length === 0) {
      throw new OutputSchemaGuardError(
        "engine.output_schema_invalid",
        "output schema must serialize to a non-empty JSON document",
      )
    }
    if (Buffer.byteLength(json, "utf8") > maxBytes) {
      throw new OutputSchemaGuardError(
        "engine.output_schema_too_large",
        `output schema exceeds ${maxBytes} bytes`,
      )
    }
    const ajv = new Ajv2020({
      allErrors: true,
      allowUnionTypes: true,
      strict: false,
      validateSchema: true,
    })
    const value = JSON.parse(json) as SafeValue
    const compiled = ajv.compile(value as object)
    if ("$async" in compiled && compiled.$async === true) {
      throw new OutputSchemaGuardError(
        "engine.output_schema_invalid",
        "asynchronous output schemas are rejected",
      )
    }
    return {
      json,
      value,
      validate: (candidate: unknown) => compiled(candidate) === true,
    }
  } catch (error) {
    if (error instanceof OutputSchemaGuardError) throw error
    throw new OutputSchemaGuardError(
      "engine.output_schema_invalid",
      "output schema failed to compile",
    )
  }
}
