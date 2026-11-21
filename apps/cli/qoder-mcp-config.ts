import type { AgentHostMcpServer } from "../../packages/core/src/agent-host.js"

/**
 * Builds the qoder CLI `--mcp-config` payload from the portable
 * `AgentHostMcpServer` list an employee package declares.
 *
 * Fail-closed: unknown transports, malformed names, duplicate servers, and
 * oversized lists are rejected before any qoder process launches. Credentials
 * are never embedded in the emitted JSON — stdio `environment` entries are
 * emitted as `${NAME}` references and resolved from the (filtered) process
 * environment at spawn time. http transport stays unsupported until the
 * network-policy question is decided separately.
 */

const SERVER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/
const DENIED_MCP_ENV_NAMES = new Set([
  // Adapter / cloud credentials the parent must not hand to an MCP server wholesale.
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "QODER_PERSONAL_ACCESS_TOKEN",
  "QODER_SERVICE_TOKEN",
  "QODER_API_KEY",
])


export const MAX_QODER_MCP_SERVERS = 16
const MAX_COMMAND_LENGTH = 1_024
const MAX_ARGS = 64
const MAX_ENV_ENTRIES = 32

export class QoderMcpConfigError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "QoderMcpConfigError"
  }
}

function fail(code: string): never {
  throw new QoderMcpConfigError(code)
}

function requireName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 128 ||
    !SERVER_NAME_PATTERN.test(value)
  ) {
    fail(`qoder_mcp_invalid_server_name:${label}`)
  }
  return value
}

function requireCommand(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > MAX_COMMAND_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`qoder_mcp_invalid_field:${label}`)
  }
  return value.trim()
}

function requireArgs(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARGS ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        !entry ||
        entry.length > 2_000 ||
        /[\u0000-\u001f\u007f]/.test(entry),
    )
  ) {
    fail(`qoder_mcp_invalid_field:${label}`)
  }
  return [...(value as string[])]
}

function requireEnvNames(
  value: unknown,
  label: string,
): string[] {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.length > MAX_ENV_ENTRIES ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        !ENV_NAME_PATTERN.test(entry) ||
        DENIED_MCP_ENV_NAMES.has(entry),
    )
  ) {
    fail(`qoder_mcp_invalid_field:${label}`)
  }
  return [...(value as string[])]
}

function envReferences(names: string[]): Record<string, string> {
  const output: Record<string, string> = {}
  for (const name of names) {
    output[name] = `\${${name}}`
  }
  return output
}

export interface QoderMcpConfig {
  /** JSON payload for qoder's `--mcp-config`, newline-terminated. */
  json: string
  /** Server names for `--allowed-mcp-server-names`. */
  serverNames: string[]
}

export function buildQoderMcpConfig(
  servers: AgentHostMcpServer[] | undefined,
): QoderMcpConfig {
  if (!servers || servers.length === 0) {
    return { json: '{"mcpServers":{}}\n', serverNames: [] }
  }
  if (servers.length > MAX_QODER_MCP_SERVERS) {
    fail("qoder_mcp_too_many_servers")
  }
  const seen = new Set<string>()
  const mcpServers: Record<string, unknown> = {}
  for (const [index, server] of servers.entries()) {
    const label = `servers[${index}]`
    const name = requireName(server.name, `${label}.name`)
    if (seen.has(name)) {
      fail(`qoder_mcp_duplicate_server_name:${name}`)
    }
    seen.add(name)
    if (server.transport === "stdio") {
      mcpServers[name] = {
        command: requireCommand(server.command, `${label}.command`),
        ...(server.args?.length
          ? { args: requireArgs(server.args, `${label}.args`) }
          : {}),
        ...(server.environment?.length
          ? {
              env: envReferences(
                requireEnvNames(server.environment, `${label}.environment`),
              ),
            }
          : {}),
      }
    } else {
      fail(`qoder_mcp_http_transport_unsupported:${name}`)
    }
  }
  return {
    json: `${JSON.stringify({ mcpServers })}\n`,
    serverNames: [...seen],
  }
}
