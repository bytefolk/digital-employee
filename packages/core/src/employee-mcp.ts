import { ValidationError, assertPlainObject } from "./contracts.js"
import type { UnknownRecord } from "./contracts.js"

export const EMPLOYEE_MCP_SCHEMA_VERSION = "employee-mcp.v1alpha1"

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/
const ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/

export interface EmployeeMcpManifest {
  $schema?: string
  schemaVersion: typeof EMPLOYEE_MCP_SCHEMA_VERSION
  servers: Array<{
    name: string
    transport:
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
  }>
}

function mcpError(code: string, details?: unknown): ValidationError {
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
      throw mcpError(`employee_mcp_unknown_field:${label}.${key}`)
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
    throw mcpError(`employee_mcp_invalid_field:${label}`)
  }
  return value.trim()
}

function stringList(
  value: unknown,
  label: string,
  pattern?: RegExp,
  maxItems = 128,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw mcpError(`employee_mcp_invalid_field:${label}`)
  }
  const result = value.map((item, index) =>
    requireString(item, `${label}[${index}]`, pattern, 4_096),
  )
  if (new Set(result).size !== result.length) {
    throw mcpError(`employee_mcp_duplicate_value:${label}`)
  }
  return result
}

function validateHttpsUrl(value: unknown, label: string): string {
  const normalized = requireString(value, label, undefined, 2_000)
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw mcpError(`employee_mcp_invalid_field:${label}`)
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw mcpError(`employee_mcp_invalid_field:${label}`)
  }
  return parsed.toString()
}

function validateTransport(
  value: unknown,
  label: string,
): EmployeeMcpManifest["servers"][number]["transport"] {
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
      args: stringList(transport.args ?? [], `${label}.args`, undefined, 128),
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
      throw mcpError(`employee_mcp_invalid_field:${label}.headers`)
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
      throw mcpError(`employee_mcp_invalid_field:${label}.headers`)
    }
    return {
      type: "http",
      url: validateHttpsUrl(transport.url, `${label}.url`),
      headers,
    }
  }
  throw mcpError(`employee_mcp_invalid_field:${label}.type`)
}

export function validateEmployeeMcpManifest(
  input: unknown,
): EmployeeMcpManifest {
  const manifest = assertKnownKeys(
    input,
    ["$schema", "schemaVersion", "servers"],
    "mcp",
  )
  if (manifest.schemaVersion !== EMPLOYEE_MCP_SCHEMA_VERSION) {
    throw mcpError(
      `unsupported_employee_mcp_schema:${String(manifest.schemaVersion || "missing")}`,
    )
  }
  if (!Array.isArray(manifest.servers) || manifest.servers.length > 64) {
    throw mcpError("employee_mcp_invalid_field:servers")
  }
  const names = new Set<string>()
  const servers = manifest.servers.map((server, index) => {
    const label = `servers[${index}]`
    const entry = assertKnownKeys(server, ["name", "transport"], label)
    const name = requireString(entry.name, `${label}.name`, IDENTIFIER_PATTERN, 128)
    if (names.has(name)) throw mcpError("employee_mcp_duplicate_server_name")
    names.add(name)
    return { name, transport: validateTransport(entry.transport, `${label}.transport`) }
  })
  return Object.freeze({
    ...(manifest.$schema
      ? { $schema: requireString(manifest.$schema, "$schema") }
      : {}),
    schemaVersion: EMPLOYEE_MCP_SCHEMA_VERSION,
    servers,
  })
}
