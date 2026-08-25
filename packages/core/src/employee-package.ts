import {
  AGENT_HOST_CAPABILITIES,
  AGENT_HOST_PROTOCOL_VERSION,
} from "./agent-host.js"
import type { AgentHostCapability, AgentHostPolicy } from "./agent-host.js"
import { ValidationError, assertPlainObject } from "./contracts.js"
import type { UnknownRecord } from "./contracts.js"

export const EMPLOYEE_PACKAGE_SCHEMA_VERSION = "employee-package.v1alpha1"
export const EMPLOYEE_PACKAGE_MANIFEST_NAME = "employee.json"

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const LICENSE_PATTERN = /^[A-Za-z0-9.+-]{1,128}$/
const PORTABLE_PATH_PATTERN = /^\.\/(?!.*\\)[^\u0000-\u001f\u007f]+$/
const IDENTITY_ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const IDENTITY_KNOWN_FIELDS = ["displayName", "avatar", "persona", "roleId"]

/**
 * Optional identity segment (#194). Human-facing expressiveness only: the
 * package-level `name` remains the machine identifier. Vocabulary resolution
 * (roleId) and org placement (reportTo) belong to the consumer org-workbench,
 * never to this validator.
 */
export interface EmployeePackageIdentity {
  displayName: string
  /** Content-addressed avatar: `asset` must be an entry in `assets`. */
  avatar?: { asset: string }
  persona?: string
  roleId?: string
  /**
   * Additive extension point: unknown fields inside identity are accepted
   * with a collected warning instead of failing closed (#194 R4 freeze).
   */
  readonly [field: string]: unknown
}

export interface EmployeePackageManifest {
  $schema?: string
  schemaVersion: typeof EMPLOYEE_PACKAGE_SCHEMA_VERSION
  name: string
  version: string
  description: string
  license: string
  authors: string[]
  identity?: EmployeePackageIdentity
  host: {
    protocol: typeof AGENT_HOST_PROTOCOL_VERSION
    requiredCapabilities: AgentHostCapability[]
  }
  entrypoints: {
    skill: string
    inputSchema: string
    outputSchema: string
    mcp?: string
  }
  policy: {
    mode: "read_only" | "approval_required"
    /** Employee tool/MCP data-plane egress, excluding the host control plane. */
    network: "deny" | "host_policy"
    filesystem: {
      read: string[]
      write: string[]
    }
    mcpTools: Array<{
      name: string
      requestedMode: "read" | "write"
    }>
  }
  assets: string[]
}

/** Security requirements are derived from policy, not trusted to the author. */
export function deriveEmployeeHostRequirements(
  manifest: EmployeePackageManifest,
): { requiredCapabilities: AgentHostCapability[] } {
  const required = new Set(manifest.host.requiredCapabilities)
  // Every effective policy uses default-deny plus an exact tool grant set.
  // Approval gates a permitted call; it cannot substitute for removing tools
  // that the employee was never granted in the first place.
  required.add("tool_allowlist")
  if (
    manifest.policy.filesystem.read.length > 0 ||
    manifest.policy.filesystem.write.length > 0
  ) {
    required.add("filesystem_scope")
  }
  if (manifest.policy.network === "deny") required.add("network_policy")
  if (manifest.entrypoints.mcp || manifest.policy.mcpTools.length > 0) {
    required.add("mcp")
  }
  if (manifest.policy.mode === "approval_required") {
    required.add("approval_callback")
  }
  return { requiredCapabilities: [...required] }
}

export function deriveEffectiveAgentHostPolicy(
  manifest: EmployeePackageManifest,
): AgentHostPolicy {
  const allowedTools: Array<{ name: string; mode: "read" | "write" }> = []
  if (manifest.policy.filesystem.read.length > 0) {
    allowedTools.push(
      { name: "filesystem.read", mode: "read" },
      { name: "filesystem.search", mode: "read" },
    )
  }
  if (manifest.policy.filesystem.write.length > 0) {
    allowedTools.push({ name: "filesystem.write", mode: "write" })
  }
  allowedTools.push(
    ...manifest.policy.mcpTools.map((tool) => ({
      name: tool.name,
      mode: tool.requestedMode,
    })),
  )
  return {
    tools: { default: "deny", allow: allowedTools },
    filesystem: {
      read: [...manifest.policy.filesystem.read],
      write: [...manifest.policy.filesystem.write],
    },
    network: { mode: manifest.policy.network },
    approval: {
      mode: manifest.policy.mode === "approval_required" ? "required" : "never",
    },
  }
}

function packageError(code: string, details?: unknown): ValidationError {
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
      throw packageError(`employee_package_unknown_field:${label}.${key}`, {
        field: `${label}.${key}`,
      })
    }
  }
  return value
}

function requireString(
  value: unknown,
  label: string,
  {
    pattern,
    maxLength = 2_000,
  }: { pattern?: RegExp; maxLength?: number } = {},
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    (pattern && !pattern.test(value))
  ) {
    throw packageError(`employee_package_invalid_field:${label}`, {
      field: label,
    })
  }
  return value.trim()
}

function uniqueStringList(
  value: unknown,
  label: string,
  options: { pattern?: RegExp; maxLength?: number } = {},
): string[] {
  if (!Array.isArray(value)) {
    throw packageError(`employee_package_invalid_field:${label}`, {
      field: label,
    })
  }
  const normalized = value.map((entry, index) =>
    requireString(entry, `${label}[${index}]`, options),
  )
  if (new Set(normalized).size !== normalized.length) {
    throw packageError(`employee_package_duplicate_value:${label}`, {
      field: label,
    })
  }
  return normalized
}

function portablePath(value: unknown, label: string): string {
  const normalized = requireString(value, label, {
    pattern: PORTABLE_PATH_PATTERN,
    maxLength: 1_024,
  })
  const segments = normalized.slice(2).split("/")
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => !segment || segment === "." || segment === "..",
    )
  ) {
    throw packageError(`employee_package_invalid_field:${label}`, {
      field: label,
    })
  }
  return normalized
}

function portableFilePath(value: unknown, label: string): string {
  const normalized = portablePath(value, label)
  if (/[*?[\]{}!]/.test(normalized)) {
    throw packageError(`employee_package_invalid_field:${label}`, {
      field: label,
    })
  }
  return normalized
}

function portablePathList(
  value: unknown,
  label: string,
  itemValidator: (item: unknown, itemLabel: string) => string,
): string[] {
  if (!Array.isArray(value)) {
    throw packageError(`employee_package_invalid_field:${label}`, {
      field: label,
    })
  }
  const normalized = value.map((item, index) =>
    itemValidator(item, `${label}[${index}]`),
  )
  if (new Set(normalized).size !== normalized.length) {
    throw packageError(`employee_package_duplicate_value:${label}`, {
      field: label,
    })
  }
  return normalized
}

function validateRequiredCapabilities(value: unknown): AgentHostCapability[] {
  const capabilities = uniqueStringList(
    value,
    "host.requiredCapabilities",
    { pattern: IDENTIFIER_PATTERN, maxLength: 128 },
  )
  for (const capability of capabilities) {
    if (!(AGENT_HOST_CAPABILITIES as readonly string[]).includes(capability)) {
      throw packageError(
        `employee_package_unknown_host_capability:${capability}`,
        { field: "host.requiredCapabilities", capability },
      )
    }
  }
  return capabilities as AgentHostCapability[]
}

function validateMcpTools(
  value: unknown,
): Array<{ name: string; requestedMode: "read" | "write" }> {
  if (!Array.isArray(value)) {
    throw packageError("employee_package_invalid_field:policy.mcpTools")
  }
  const names = new Set<string>()
  return value.map((tool, index) => {
    const label = `policy.mcpTools[${index}]`
    const entry = assertKnownKeys(tool, ["name", "requestedMode"], label)
    const name = requireString(entry.name, `${label}.name`, {
      pattern: IDENTIFIER_PATTERN,
      maxLength: 128,
    })
    if (names.has(name)) {
      throw packageError("employee_package_duplicate_value:policy.mcpTools", {
        field: `${label}.name`,
      })
    }
    names.add(name)
    if (entry.requestedMode !== "read" && entry.requestedMode !== "write") {
      throw packageError(`employee_package_invalid_field:${label}.requestedMode`)
    }
    return { name, requestedMode: entry.requestedMode }
  })
}

/**
 * Validate the optional identity segment (#194). Unknown fields INSIDE
 * identity are additive: they are preserved and produce a collected warning
 * instead of failing closed. `reportTo` is rejected outright because org
 * placement belongs to the consumer (org-workbench), never to the package.
 */
function validateIdentity(
  value: unknown,
  assets: readonly string[],
  warnings: string[],
): EmployeePackageIdentity {
  assertPlainObject(value, "identity")
  if (Object.prototype.hasOwnProperty.call(value, "reportTo")) {
    throw packageError("employee_package_unknown_field:identity.reportTo", {
      field: "identity.reportTo",
    })
  }
  const identity: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!IDENTITY_KNOWN_FIELDS.includes(key)) {
      warnings.push(`employee_package_identity_unknown_field:${key}`)
      identity[key] = entry
    }
  }
  identity.displayName = requireString(value.displayName, "identity.displayName", {
    maxLength: 64,
  })
  if (value.avatar !== undefined) {
    const avatar = assertKnownKeys(value.avatar, ["asset"], "identity.avatar")
    const asset = portableFilePath(avatar.asset, "identity.avatar.asset")
    if (!assets.includes(asset)) {
      throw packageError("employee_package_identity_avatar_asset_unknown", {
        field: "identity.avatar.asset",
        asset,
      })
    }
    identity.avatar = { asset }
  }
  if (value.persona !== undefined) {
    identity.persona = requireString(value.persona, "identity.persona", {
      maxLength: 2_048,
    })
  }
  if (value.roleId !== undefined) {
    identity.roleId = requireString(value.roleId, "identity.roleId", {
      pattern: IDENTITY_ROLE_ID_PATTERN,
      maxLength: 64,
    })
  }
  return identity as unknown as EmployeePackageIdentity
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const item of Object.values(value as UnknownRecord)) deepFreeze(item)
  return Object.freeze(value)
}

export function validateEmployeePackageManifest(
  input: unknown,
  warnings: string[] = [],
): EmployeePackageManifest {
  const manifest = assertKnownKeys(
    input,
    [
      "$schema",
      "schemaVersion",
      "name",
      "version",
      "description",
      "license",
      "authors",
      "identity",
      "host",
      "entrypoints",
      "policy",
      "assets",
    ],
    "manifest",
  )

  if (manifest.schemaVersion !== EMPLOYEE_PACKAGE_SCHEMA_VERSION) {
    throw packageError(
      `unsupported_employee_package_schema:${String(manifest.schemaVersion || "missing")}`,
    )
  }

  const host = assertKnownKeys(
    manifest.host,
    ["protocol", "requiredCapabilities"],
    "host",
  )
  if (host.protocol !== AGENT_HOST_PROTOCOL_VERSION) {
    throw packageError(
      `unsupported_agent_host_protocol:${String(host.protocol || "missing")}`,
    )
  }

  const entrypoints = assertKnownKeys(
    manifest.entrypoints,
    ["skill", "inputSchema", "outputSchema", "mcp"],
    "entrypoints",
  )
  const policy = assertKnownKeys(
    manifest.policy,
    ["mode", "network", "filesystem", "mcpTools"],
    "policy",
  )
  const filesystem = assertKnownKeys(
    policy.filesystem,
    ["read", "write"],
    "policy.filesystem",
  )

  if (policy.mode !== "read_only" && policy.mode !== "approval_required") {
    throw packageError("employee_package_invalid_field:policy.mode")
  }
  if (policy.network !== "deny" && policy.network !== "host_policy") {
    throw packageError("employee_package_invalid_field:policy.network")
  }

  const requiredCapabilities = validateRequiredCapabilities(
    host.requiredCapabilities,
  )
  const readPaths = portablePathList(
    filesystem.read,
    "policy.filesystem.read",
    portablePath,
  )
  const writePaths = portablePathList(
    filesystem.write,
    "policy.filesystem.write",
    portablePath,
  )
  const mcpTools = validateMcpTools(policy.mcpTools)
  if (policy.mode === "read_only" && writePaths.length > 0) {
    throw packageError("read_only_employee_cannot_request_write_paths")
  }
  if (
    policy.mode === "read_only" &&
    mcpTools.some((tool) => tool.requestedMode === "write")
  ) {
    throw packageError("read_only_employee_cannot_request_write_mcp_tools")
  }
  if (mcpTools.length > 0 && !entrypoints.mcp) {
    throw packageError("mcp_tools_require_mcp_entrypoint")
  }

  const assets = portablePathList(manifest.assets, "assets", portableFilePath)

  const result: EmployeePackageManifest = {
    ...(manifest.$schema
      ? { $schema: requireString(manifest.$schema, "$schema", { maxLength: 2_000 }) }
      : {}),
    schemaVersion: EMPLOYEE_PACKAGE_SCHEMA_VERSION,
    name: requireString(manifest.name, "name", {
      pattern: SKILL_NAME_PATTERN,
      maxLength: 64,
    }),
    version: requireString(manifest.version, "version", {
      pattern: SEMVER_PATTERN,
      maxLength: 128,
    }),
    description: requireString(manifest.description, "description"),
    license: requireString(manifest.license, "license", {
      pattern: LICENSE_PATTERN,
      maxLength: 128,
    }),
    authors: uniqueStringList(manifest.authors, "authors", {
      pattern: /^[^\u0000-\u001f\u007f]{1,256}$/,
      maxLength: 256,
    }),
    host: {
      protocol: AGENT_HOST_PROTOCOL_VERSION,
      requiredCapabilities,
    },
    entrypoints: {
      skill: portableFilePath(entrypoints.skill, "entrypoints.skill"),
      inputSchema: portableFilePath(
        entrypoints.inputSchema,
        "entrypoints.inputSchema",
      ),
      outputSchema: portableFilePath(
        entrypoints.outputSchema,
        "entrypoints.outputSchema",
      ),
      ...(entrypoints.mcp
        ? { mcp: portableFilePath(entrypoints.mcp, "entrypoints.mcp") }
        : {}),
    },
    policy: {
      mode: policy.mode,
      network: policy.network,
      filesystem: {
        read: readPaths,
        write: writePaths,
      },
      mcpTools,
    },
    assets,
  }

  if (manifest.identity !== undefined) {
    result.identity = validateIdentity(manifest.identity, assets, warnings)
  }

  if (result.authors.length === 0) {
    throw packageError("employee_package_invalid_field:authors")
  }

  return deepFreeze(result)
}
