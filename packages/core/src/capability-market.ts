import { ValidationError, assertPlainObject } from "./contracts.js"
import type { UnknownRecord } from "./contracts.js"

/**
 * The capability market is the single, portable declaration surface for the
 * digital-employee "employee capability center". It lists reusable employee
 * capabilities — MCP servers, CLI tools, and position connectors — together
 * with the security metadata (credential environment names, network egress
 * intent, and a risk rating) that both the RoleWeave UI and the Agent Host
 * adapters need to render, filter, and authorize them safely.
 *
 * This module only validates the market manifest. It never executes a command,
 * opens a network connection, or resolves credentials: secret values stay in
 * the host process environment, and manifests reference them by name only.
 */

export const CAPABILITY_MARKET_SCHEMA_VERSION = "capability-market.v1alpha1"

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/
const ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
// Rejects loopback-ish/single-label placeholders and malformed DNS labels
// such as `localhost` or `a..b`. Real hosts must be at least two labels
// (subdomain + TLD) with no consecutive or trailing dots.
const HOST_PATTERN = /^(?!localhost$)(?!.*\.\.)[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,}$/


const CAPABILITY_KINDS = ["mcp", "cli", "connector"] as const
const RISK_LEVELS = ["low", "medium", "high"] as const

export type CapabilityMarketKind = (typeof CAPABILITY_KINDS)[number]
export type CapabilityRisk = (typeof RISK_LEVELS)[number]

export type CapabilityMcpTransport =
  | {
      type: "stdio"
      command: string
      args: string[]
      environment: string[]
    }
  | {
      type: "http"
      url: string
      headers: Array<{ name: string; valueFromEnv: string }>
    }

export interface CapabilityCliCommand {
  command: string
  args: string[]
  /** Human-readable, side-effect-free install hint (e.g. "npm i -g x"). */
  install?: string
}

export interface CapabilityConnectorRef {
  kind: "channel" | "source"
  id: string
}

export interface CapabilityAuth {
  required: string[]
  optional: string[]
}

export interface CapabilityNetwork {
  required: boolean
  hosts: string[]
}

export interface CapabilityEntry {
  id: string
  kind: CapabilityMarketKind
  title: string
  description: string
  homepage?: string
  license?: string
  tags: string[]
  transport?: CapabilityMcpTransport
  command?: CapabilityCliCommand
  connector?: CapabilityConnectorRef
  auth: CapabilityAuth
  network: CapabilityNetwork
  risk: CapabilityRisk
}

export interface CapabilityMarketManifest {
  $schema?: string
  schemaVersion: typeof CAPABILITY_MARKET_SCHEMA_VERSION
  capabilities: CapabilityEntry[]
}

function marketError(code: string, details?: unknown): ValidationError {
  return new ValidationError(code, details)
}

function assertKnownKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): UnknownRecord {
  assertPlainObject(value, label)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw marketError(`capability_market_unknown_field:${label}.${key}`)
    }
  }
  return value
}

function requireString(
  value: unknown,
  label: string,
  pattern?: RegExp,
  maxLength = 2_000,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    throw marketError(`capability_market_invalid_field:${label}`)
  }
  return value.trim()
}

function optionalString(
  value: unknown,
  label: string,
  pattern?: RegExp,
  maxLength = 2_000,
): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, label, pattern, maxLength)
}

function stringList(
  value: unknown,
  label: string,
  pattern?: RegExp,
  maxItems = 128,
  unique = true,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw marketError(`capability_market_invalid_field:${label}`)
  }
  const result = value.map((item, index) =>
    requireString(item, `${label}[${index}]`, pattern, 4_096),
  )
  if (unique && new Set(result).size !== result.length) {
    throw marketError(`capability_market_duplicate_value:${label}`)
  }
  return result
}

function validateHttpsUrl(value: unknown, label: string): string {
  const normalized = requireString(value, label, undefined, 2_000)
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw marketError(`capability_market_invalid_field:${label}`)
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw marketError(`capability_market_invalid_field:${label}`)
  }
  return parsed.toString()
}

function validateTransport(
  value: unknown,
  label: string,
): CapabilityMcpTransport {
  assertPlainObject(value, label)
  if (value.type === "stdio") {
    const transport = assertKnownKeys(
      value,
      ["type", "command", "args", "environment"],
      label,
    )
    return {
      type: "stdio",
      command: requireString(transport.command, `${label}.command`, undefined, 1_024),
      args: stringList(transport.args ?? [], `${label}.args`, undefined, 128, false),
      environment: stringList(
        transport.environment ?? [],
        `${label}.environment`,
        ENVIRONMENT_NAME_PATTERN,
        128,
      ),
    }
  }
  if (value.type === "http") {
    const transport = assertKnownKeys(
      value,
      ["type", "url", "headers"],
      label,
    )
    const rawHeaders = transport.headers ?? []
    if (!Array.isArray(rawHeaders)) {
      throw marketError(`capability_market_invalid_field:${label}.headers`)
    }
    const headers = rawHeaders.map((header, index) => {
      const headerLabel = `${label}.headers[${index}]`
      const item = assertKnownKeys(
        header,
        ["name", "valueFromEnv"],
        headerLabel,
      )
      return {
        name: requireString(
          item.name,
          `${headerLabel}.name`,
          HEADER_NAME_PATTERN,
          128,
        ),
        valueFromEnv: requireString(
          item.valueFromEnv,
          `${headerLabel}.valueFromEnv`,
          ENVIRONMENT_NAME_PATTERN,
          128,
        ),
      }
    })
    if (headers.length > 64) {
      throw marketError(`capability_market_invalid_field:${label}.headers`)
    }
    return {
      type: "http",
      url: validateHttpsUrl(transport.url, `${label}.url`),
      headers,
    }
  }
  throw marketError(`capability_market_invalid_field:${label}.type`)
}

function validateCommand(value: unknown, label: string): CapabilityCliCommand {
  const command = assertKnownKeys(value, ["command", "args", "install"], label)
  const result: CapabilityCliCommand = {
    command: requireString(command.command, `${label}.command`, undefined, 1_024),
    args: stringList(command.args ?? [], `${label}.args`, undefined, 128, false),
  }
  const install = optionalString(command.install, `${label}.install`, undefined, 1_024)
  if (install !== undefined) result.install = install
  return result
}

function validateConnectorRef(
  value: unknown,
  label: string,
): CapabilityConnectorRef {
  const connector = assertKnownKeys(value, ["kind", "id"], label)
  const kind = requireString(connector.kind, `${label}.kind`, undefined, 64)
  if (kind !== "channel" && kind !== "source") {
    throw marketError(`capability_market_invalid_field:${label}.kind`)
  }
  return {
    kind,
    id: requireString(connector.id, `${label}.id`, IDENTIFIER_PATTERN, 128),
  }
}

function validateAuth(value: unknown, label: string): CapabilityAuth {
  const auth = assertKnownKeys(value, ["required", "optional"], label)
  return {
    required: stringList(
      auth.required ?? [],
      `${label}.required`,
      ENVIRONMENT_NAME_PATTERN,
      32,
    ),
    optional: stringList(
      auth.optional ?? [],
      `${label}.optional`,
      ENVIRONMENT_NAME_PATTERN,
      32,
    ),
  }
}

function validateNetwork(value: unknown, label: string): CapabilityNetwork {
  const network = assertKnownKeys(value, ["required", "hosts"], label)
  if (typeof network.required !== "boolean") {
    throw marketError(`capability_market_invalid_field:${label}.required`)
  }
  return {
    required: network.required,
    hosts: stringList(
      network.hosts ?? [],
      `${label}.hosts`,
      HOST_PATTERN,
      64,
    ),
  }
}

function validateEntry(value: unknown, label: string): CapabilityEntry {
  const entry = assertKnownKeys(
    value,
    [
      "id",
      "kind",
      "title",
      "description",
      "homepage",
      "license",
      "tags",
      "transport",
      "command",
      "connector",
      "auth",
      "network",
      "risk",
    ],
    label,
  )
  const id = requireString(entry.id, `${label}.id`, IDENTIFIER_PATTERN, 128)
  const kind = requireString(entry.kind, `${label}.kind`, undefined, 64)
  if (!CAPABILITY_KINDS.includes(kind as CapabilityMarketKind)) {
    throw marketError(`capability_market_invalid_field:${label}.kind`)
  }
  const risk = requireString(entry.risk, `${label}.risk`, undefined, 64)
  if (!RISK_LEVELS.includes(risk as CapabilityRisk)) {
    throw marketError(`capability_market_invalid_field:${label}.risk`)
  }

  const hasTransport = entry.transport !== undefined
  const hasCommand = entry.command !== undefined
  const hasConnector = entry.connector !== undefined
  const shapeCount = [hasTransport, hasCommand, hasConnector].filter(Boolean).length

  if (kind === "mcp" && !hasTransport) {
    throw marketError(`capability_market_missing_field:${label}.transport`)
  }
  if (kind === "cli" && !hasCommand) {
    throw marketError(`capability_market_missing_field:${label}.command`)
  }
  if (kind === "connector" && !hasConnector) {
    throw marketError(`capability_market_missing_field:${label}.connector`)
  }
  if (shapeCount > 1) {
    throw marketError(`capability_market_conflicting_shape:${label}`)
  }

  const result: CapabilityEntry = {
    id,
    kind: kind as CapabilityMarketKind,
    title: requireString(entry.title, `${label}.title`, undefined, 256),
    description: requireString(entry.description, `${label}.description`, undefined, 4_096),
    tags: stringList(entry.tags ?? [], `${label}.tags`, undefined, 32),
    auth: validateAuth(entry.auth ?? {}, `${label}.auth`),
    network: validateNetwork(entry.network ?? {}, `${label}.network`),
    risk: risk as CapabilityRisk,
  }
  const homepage = optionalString(entry.homepage, `${label}.homepage`, undefined, 2_000)
  const license = optionalString(entry.license, `${label}.license`, undefined, 128)
  if (homepage !== undefined) {
    result.homepage = validateHttpsUrl(homepage, `${label}.homepage`)
  }
  if (license !== undefined) result.license = license
  if (hasTransport) result.transport = validateTransport(entry.transport, `${label}.transport`)
  if (hasCommand) result.command = validateCommand(entry.command, `${label}.command`)
  if (hasConnector) result.connector = validateConnectorRef(entry.connector, `${label}.connector`)
  return result
}

export function validateCapabilityMarketManifest(
  input: unknown,
): CapabilityMarketManifest {
  const manifest = assertKnownKeys(
    input,
    ["$schema", "schemaVersion", "capabilities"],
    "capability-market",
  )
  if (manifest.schemaVersion !== CAPABILITY_MARKET_SCHEMA_VERSION) {
    throw marketError(
      `unsupported_capability_market_schema:${String(manifest.schemaVersion || "missing")}`,
    )
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length > 256) {
    throw marketError("capability_market_invalid_field:capabilities")
  }
  const ids = new Set<string>()
  const capabilities = manifest.capabilities.map((entry, index) => {
    const validated = validateEntry(entry, `capabilities[${index}]`)
    if (ids.has(validated.id)) {
      throw marketError("capability_market_duplicate_id")
    }
    ids.add(validated.id)
    return validated
  })
  return Object.freeze({
    ...(manifest.$schema
      ? { $schema: requireString(manifest.$schema, "$schema") }
      : {}),
    schemaVersion: CAPABILITY_MARKET_SCHEMA_VERSION,
    capabilities,
  })
}