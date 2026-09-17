function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

export const POSITION_CONNECTORS_SCHEMA_VERSION = "position-connectors.v1" as const
export const POSITION_CONNECTORS_FILE = "connectors.json"

const CONNECTOR_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/
const ENV_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const CREDENTIAL_VALUE_PATTERN =
  /(?:ghp_|github_pat_|sk-|xox[baprs]-|Bearer\s|-----BEGIN)/i
const MAX_BINDINGS = 16
const MAX_ENV_ENTRIES = 16

export type PositionConnectorKind = "channel" | "source"

export interface ConnectorVocabulary {
  has(kind: PositionConnectorKind, id: string): boolean
}

export interface PositionConnectorBinding {
  id: string
  env?: Record<string, string>
}

export interface PositionConnectorsDeclaration {
  schemaVersion: typeof POSITION_CONNECTORS_SCHEMA_VERSION
  channels: PositionConnectorBinding[]
  sources: PositionConnectorBinding[]
}

export class PositionConnectorsError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "PositionConnectorsError"
  }
}

function fail(code: string): never {
  throw new PositionConnectorsError(code)
}

function knownKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(`position_connectors_invalid_field:${label}`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`position_connectors_unknown_field:${label}.${key}`)
    }
  }
  return value
}

function requireString(
  value: unknown,
  label: string,
  pattern: RegExp,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value || value.length > maxLength || !pattern.test(value)) {
    fail(`position_connectors_invalid_field:${label}`)
  }
  return value
}

function validateEnv(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    fail(`position_connectors_invalid_field:${label}`)
  }
  const keys = Object.keys(value)
  if (keys.length > MAX_ENV_ENTRIES) {
    fail(`position_connectors_invalid_field:${label}`)
  }
  const env: Record<string, string> = {}
  for (const key of keys) {
    if (!ENV_KEY_PATTERN.test(key) || key.length > 64) {
      fail(`position_connectors_invalid_field:${label}.${key}`)
    }
    const entry = value[key]
    if (typeof entry !== "string" || CREDENTIAL_VALUE_PATTERN.test(entry)) {
      fail(`position_connectors_inline_credential:${label}.${key}`)
    }
    if (!ENV_NAME_PATTERN.test(entry)) {
      fail(`position_connectors_inline_credential:${label}.${key}`)
    }
    env[key] = entry
  }
  return env
}

function validateBindings(
  value: unknown,
  kind: PositionConnectorKind,
  vocabulary: ConnectorVocabulary,
): PositionConnectorBinding[] {
  const label = `${kind}s`
  if (!Array.isArray(value) || value.length > MAX_BINDINGS) {
    fail(`position_connectors_invalid_field:${label}`)
  }
  const ids = new Set<string>()
  return value.map((item, index) => {
    const itemLabel = `${label}[${index}]`
    const entry = knownKeys(item, ["id", "env"], itemLabel)
    const id = requireString(entry.id, `${itemLabel}.id`, CONNECTOR_ID_PATTERN, 128)
    if (ids.has(id)) {
      fail(`position_connectors_duplicate_id:${kind}:${id}`)
    }
    ids.add(id)
    if (!vocabulary.has(kind, id)) {
      fail(`position_connectors_unregistered:${kind}:${id}`)
    }
    const env = validateEnv(entry.env, `${itemLabel}.env`)
    return { id, ...(env ? { env } : {}) }
  })
}

/**
 * Validate an optional position-connectors.v1 declaration against a live
 * connector registry vocabulary. The validator does not load connectors.
 */
export function validatePositionConnectors(
  input: unknown,
  vocabulary: ConnectorVocabulary,
): PositionConnectorsDeclaration {
  const document = knownKeys(input, ["schemaVersion", "channels", "sources"], "manifest")
  if (document.schemaVersion !== POSITION_CONNECTORS_SCHEMA_VERSION) {
    fail(
      `unsupported_position_connectors_schema:${String(document.schemaVersion || "missing")}`,
    )
  }
  return {
    schemaVersion: POSITION_CONNECTORS_SCHEMA_VERSION,
    channels: validateBindings(document.channels, "channel", vocabulary),
    sources: validateBindings(document.sources, "source", vocabulary),
  }
}
