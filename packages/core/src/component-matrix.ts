import { CoreError } from "./contracts.js"

export const COMPONENT_MATRIX_SCHEMA_ID = "component-matrix.v1" as const

/**
 * Fail-closed error namespace for the real-local Phase A path (#42). These
 * codes are distinct from the synthetic `mcp_*` conformance codes on purpose:
 * synthetic and real-local evidence must never share a code namespace.
 */
export const REAL_LOCAL_CODES = {
  matrixUnsupported: "real_local_matrix_unsupported",
  grantMissing: "real_local_grant_missing",
  grantInvalid: "real_local_grant_invalid",
  selfGrantRejected: "real_local_self_grant_rejected",
  grantRevoked: "real_local_grant_revoked",
  scopeDenied: "real_local_scope_denied",
  modeExcessive: "real_local_mode_excessive",
  itemUnavailable: "real_local_item_unavailable",
  revisionMismatch: "real_local_revision_mismatch",
  contractUnsupported: "real_local_contract_unsupported",
  serviceUnavailable: "real_local_service_unavailable",
} as const

export interface ComponentMatrixEntry {
  name: string
  repository: string
  commit: string
  contract: string
  startCommand: string
  healthEndpoint: string
  ports: Record<string, number>
}

export interface ComponentMatrix {
  schema: typeof COMPONENT_MATRIX_SCHEMA_ID
  components: ComponentMatrixEntry[]
}

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const CONTRACT_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/

function matrixError(message: string, details?: unknown): CoreError {
  return new CoreError(REAL_LOCAL_CODES.matrixUnsupported, message, {
    status: 400,
    retryable: false,
    details,
  })
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * Rejects both unknown AND missing keys. Every declared key must be present
 * and no undeclared key is tolerated. This makes schema violations explicit
 * at the structural check layer instead of relying on downstream per-field
 * validation to catch omissions.
 */
function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === allowed.length &&
    keys.every((key) => allowed.includes(key))
  )
}

/**
 * Validates one component-matrix.v1 document. The matrix is the sole version
 * authority for the real-local harness: anything unknown, missing, or
 * malformed fails explicitly instead of running against an unpinned service.
 */
export function validateComponentMatrix(value: unknown): ComponentMatrix {
  if (!plainRecord(value) || !exactKeys(value, ["schema", "components"])) {
    throw matrixError("component matrix carries unknown fields")
  }
  if (value.schema !== COMPONENT_MATRIX_SCHEMA_ID) {
    throw matrixError(`schema must be ${COMPONENT_MATRIX_SCHEMA_ID}`)
  }
  if (!Array.isArray(value.components) || value.components.length === 0) {
    throw matrixError("components must be a non-empty array")
  }
  const seen = new Set<string>()
  const components: ComponentMatrixEntry[] = []
  for (const entry of value.components) {
    if (
      !plainRecord(entry) ||
      !exactKeys(entry, [
        "name",
        "repository",
        "commit",
        "contract",
        "startCommand",
        "healthEndpoint",
        "ports",
      ])
    ) {
      throw matrixError("component entry carries unknown fields")
    }
    if (typeof entry.name !== "string" || !NAME_PATTERN.test(entry.name)) {
      throw matrixError("component name must be a lowercase identifier")
    }
    if (seen.has(entry.name)) {
      throw matrixError(`duplicate component: ${entry.name}`)
    }
    seen.add(entry.name)
    if (
      typeof entry.repository !== "string" ||
      !entry.repository.startsWith("https://")
    ) {
      throw matrixError("component repository must be an https URL")
    }
    if (typeof entry.commit !== "string" || !COMMIT_PATTERN.test(entry.commit)) {
      throw matrixError("component commit must be a 40-char lowercase sha")
    }
    if (
      typeof entry.contract !== "string" ||
      !CONTRACT_PATTERN.test(entry.contract)
    ) {
      throw matrixError("component contract must be a versioned identifier")
    }
    if (
      typeof entry.startCommand !== "string" ||
      entry.startCommand.trim() === ""
    ) {
      throw matrixError("component startCommand is required")
    }
    if (
      typeof entry.healthEndpoint !== "string" ||
      entry.healthEndpoint.trim() === ""
    ) {
      throw matrixError("component healthEndpoint is required")
    }
    if (
      !plainRecord(entry.ports) ||
      Object.keys(entry.ports).length === 0 ||
      Object.entries(entry.ports).some(
        ([key, port]) =>
          !NAME_PATTERN.test(key) ||
          typeof port !== "number" ||
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65535,
      )
    ) {
      throw matrixError("component ports must map identifiers to tcp ports")
    }
    components.push({
      name: entry.name,
      repository: entry.repository,
      commit: entry.commit,
      contract: entry.contract,
      startCommand: entry.startCommand,
      healthEndpoint: entry.healthEndpoint,
      ports: { ...(entry.ports as Record<string, number>) },
    })
  }
  return { schema: COMPONENT_MATRIX_SCHEMA_ID, components }
}

/**
 * Asserts that the matrix pins one component under the exact contract the
 * caller requires. An absent component or a different contract revision is an
 * unsupported matrix, never a silent fallback.
 */
export function requireMatrixComponent(
  matrix: ComponentMatrix,
  name: string,
  contract: string,
): ComponentMatrixEntry {
  const entry = matrix.components.find((candidate) => candidate.name === name)
  if (!entry) {
    throw matrixError(`matrix does not pin component ${name}`)
  }
  if (entry.contract !== contract) {
    throw matrixError(
      `matrix pins ${name} to ${entry.contract}, need ${contract}`,
      { pinned: entry.contract, required: contract },
    )
  }
  return entry
}
