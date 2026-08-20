import { Ajv2020 } from "ajv/dist/2020.js"

import type { SafeValue } from "../../packages/core/src/contracts.js"

export const SHARED_MAX_OUTPUT_SCHEMA_BYTES = 16 * 1024

/**
 * One bounded, immutable Schema snapshot shared by every built-in Adapter.
 * The compiled validator is the single synchronous terminal check: projection
 * and terminal validation must both consume this snapshot, never recompile.
 */
export interface PreparedOutputSchemaSnapshot {
  json: string
  value: SafeValue
  validate: (candidate: unknown) => boolean
}

export interface OutputSchemaGuardErrors {
  tooLarge: () => Error
  invalid: () => Error
  isGuardError: (error: unknown) => boolean
}

/**
 * Prepares the run output Schema before probe, projection, or any model
 * process. Asynchronous Schemas are the canonical hazard: an accepted
 * `$async` validator would let a Promise masquerade as a synchronous
 * terminal guarantee, so every compile failure fails closed.
 */
export function prepareOutputSchemaSnapshot(
  schema: SafeValue | undefined,
  errors: OutputSchemaGuardErrors,
  maxBytes = SHARED_MAX_OUTPUT_SCHEMA_BYTES,
): PreparedOutputSchemaSnapshot | undefined {
  if (schema === undefined) return undefined
  try {
    const json = JSON.stringify(schema)
    if (typeof json !== "string" || json.length === 0) {
      throw errors.invalid()
    }
    if (Buffer.byteLength(json, "utf8") > maxBytes) {
      throw errors.tooLarge()
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
      throw errors.invalid()
    }
    return {
      json,
      value,
      validate: (candidate: unknown) => compiled(candidate) === true,
    }
  } catch (error) {
    if (errors.isGuardError(error)) throw error
    throw errors.invalid()
  }
}
