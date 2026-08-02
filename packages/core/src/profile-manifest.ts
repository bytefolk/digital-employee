import { ValidationError, assertPlainObject } from "./contracts.js"
import type { UnknownRecord } from "./contracts.js"

export const EMPLOYEE_PROFILE_SCHEMA_VERSION = "employee-profile.v1"
export const RUNTIME_API_VERSION = "1.0.0"

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const RUNTIME_RANGE_PATTERN = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/

export interface EmployeeProfileManifest {
  $schema?: string
  schemaVersion: typeof EMPLOYEE_PROFILE_SCHEMA_VERSION
  name: string
  version: string
  description: string
  license: string
  authors: string[]
  provenance: { repository: string; revision?: string }
  compatibility: { runtimeApi: string }
  policy: {
    readOnly: boolean
    instructions: string[]
    escalation: {
      strategy: "human"
      onInsufficientEvidence: boolean
      onWriteRequest: boolean
    }
  }
  capabilities: {
    channels: string[]
    models: string[]
    sources: string[]
    memory: string[]
    tools: Array<{ name: string; mode: "read" | "write" }>
  }
  permissions: {
    read: { sourceTypes: string[]; tools: string[] }
    write: { requested: boolean; tools: string[] }
  }
  dependencies: { required: string[]; optional: string[] }
  configuration: { schema: UnknownRecord; secretReferences: string[] }
  entrypoints: { profile: string }
  assets: string[]
  integrity?: { algorithm: "sha256"; files: Record<string, string> }
}

interface StringOptions {
  pattern?: RegExp
  maxLength?: number
}

function manifestError(code: string, details?: unknown): ValidationError {
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
      throw manifestError(`profile_manifest_unknown_field:${label}.${key}`, {
        field: `${label}.${key}`,
      })
    }
  }
  return value
}

function requireString(
  value: unknown,
  label: string,
  { pattern, maxLength = 2_000 }: StringOptions = {},
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    (pattern && !pattern.test(value))
  ) {
    throw manifestError(`profile_manifest_invalid_field:${label}`, {
      field: label,
    })
  }
  return value.trim()
}

function stringList(
  value: unknown,
  label: string,
  { pattern = IDENTIFIER_PATTERN, maxLength = 2_000 }: StringOptions = {},
): string[] {
  if (!Array.isArray(value)) {
    throw manifestError(`profile_manifest_invalid_field:${label}`, {
      field: label,
    })
  }
  const normalized = value.map((item, index) =>
    requireString(item, `${label}[${index}]`, { pattern, maxLength }),
  )
  if (new Set(normalized).size !== normalized.length) {
    throw manifestError(`profile_manifest_duplicate_value:${label}`, {
      field: label,
    })
  }
  return normalized
}

function parseSemver(value: unknown, label: string): [number, number, number] {
  const normalized = requireString(value, label, {
    pattern: SEMVER_PATTERN,
    maxLength: 128,
  })
  const [major, minor, patch] = normalized
    .split(/[+-]/, 1)[0]
    .split(".")
    .map(Number)
  return [major, minor, patch]
}

function compareSemver(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

export function runtimeVersionSatisfies(
  range: unknown,
  version: unknown = RUNTIME_API_VERSION,
): boolean {
  const match = requireString(range, "compatibility.runtimeApi", {
    pattern: RUNTIME_RANGE_PATTERN,
    maxLength: 128,
  }).match(RUNTIME_RANGE_PATTERN)
  if (!match) throw manifestError("profile_manifest_invalid_field:compatibility.runtimeApi")
  const current = parseSemver(version, "runtimeApiVersion")
  const minimum = parseSemver(match[1], "compatibility.runtimeApi.minimum")
  const maximum = parseSemver(match[2], "compatibility.runtimeApi.maximum")
  return (
    compareSemver(current, minimum) >= 0 &&
    compareSemver(current, maximum) < 0
  )
}

function validateTools(
  value: unknown,
): Array<{ name: string; mode: "read" | "write" }> {
  if (!Array.isArray(value)) {
    throw manifestError("profile_manifest_invalid_field:capabilities.tools")
  }
  const names = new Set<string>()
  return value.map((tool, index) => {
    const label = `capabilities.tools[${index}]`
    const entry = assertKnownKeys(tool, ["name", "mode"], label)
    const name = requireString(entry.name, `${label}.name`, {
      pattern: IDENTIFIER_PATTERN,
      maxLength: 128,
    })
    if (names.has(name)) {
      throw manifestError("profile_manifest_duplicate_value:capabilities.tools", {
        field: `${label}.name`,
      })
    }
    names.add(name)
    if (entry.mode !== "read" && entry.mode !== "write") {
      throw manifestError(`profile_manifest_invalid_field:${label}.mode`)
    }
    return { name, mode: entry.mode }
  })
}

function validateConfiguration(
  value: unknown,
): EmployeeProfileManifest["configuration"] {
  const configuration = assertKnownKeys(
    value,
    ["schema", "secretReferences"],
    "configuration",
  )
  assertPlainObject(configuration.schema, "configuration.schema")
  if (configuration.schema.type !== "object") {
    throw manifestError("profile_manifest_invalid_field:configuration.schema.type")
  }
  return {
    schema: structuredClone(configuration.schema),
    secretReferences: stringList(
      configuration.secretReferences,
      "configuration.secretReferences",
      { pattern: IDENTIFIER_PATTERN },
    ),
  }
}

function validateIntegrity(
  value: unknown,
): EmployeeProfileManifest["integrity"] {
  if (value === undefined) return undefined
  const integrity = assertKnownKeys(value, ["algorithm", "files"], "integrity")
  if (integrity.algorithm !== "sha256") {
    throw manifestError("profile_manifest_invalid_field:integrity.algorithm")
  }
  assertPlainObject(integrity.files, "integrity.files")
  const files: Record<string, string> = {}
  for (const [file, digest] of Object.entries(integrity.files)) {
    if (!/^\.\/(?!.*(?:^|\/)\.\.(?:\/|$)).+/.test(file)) {
      throw manifestError("profile_manifest_invalid_field:integrity.files", {
        file,
      })
    }
    files[file] = requireString(digest, `integrity.files.${file}`, {
      pattern: /^[a-f0-9]{64}$/,
      maxLength: 64,
    })
  }
  return { algorithm: "sha256", files }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const item of Object.values(value as UnknownRecord)) deepFreeze(item)
  return Object.freeze(value)
}

export function validateProfileManifest(
  input: unknown,
  { runtimeApiVersion = RUNTIME_API_VERSION }: { runtimeApiVersion?: string } = {},
): EmployeeProfileManifest {
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
      "provenance",
      "compatibility",
      "policy",
      "capabilities",
      "permissions",
      "dependencies",
      "configuration",
      "entrypoints",
      "assets",
      "integrity",
    ],
    "manifest",
  )

  if (manifest.schemaVersion !== EMPLOYEE_PROFILE_SCHEMA_VERSION) {
    throw manifestError(
      `unsupported_profile_manifest_schema:${String(manifest.schemaVersion || "missing")}`,
    )
  }

  const name = requireString(manifest.name, "name", {
    pattern: IDENTIFIER_PATTERN,
    maxLength: 128,
  })
  const version = requireString(manifest.version, "version", {
    pattern: SEMVER_PATTERN,
    maxLength: 128,
  })
  parseSemver(version, "version")
  const description = requireString(manifest.description, "description")
  const license = requireString(manifest.license, "license", {
    pattern: /^[A-Za-z0-9.+-]{1,128}$/,
    maxLength: 128,
  })
  const authors = stringList(manifest.authors, "authors", {
    pattern: /^[^\u0000-\u001f\u007f]{1,256}$/,
  })
  if (authors.length === 0) {
    throw manifestError("profile_manifest_invalid_field:authors")
  }

  const provenance = assertKnownKeys(
    manifest.provenance,
    ["repository", "revision"],
    "provenance",
  )
  let repository
  try {
    repository = new URL(
      requireString(provenance.repository, "provenance.repository"),
    )
  } catch {
    throw manifestError("profile_manifest_invalid_field:provenance.repository")
  }
  if (repository.protocol !== "https:") {
    throw manifestError("profile_manifest_invalid_field:provenance.repository")
  }

  const compatibility = assertKnownKeys(
    manifest.compatibility,
    ["runtimeApi"],
    "compatibility",
  )
  const runtimeApi = requireString(
    compatibility.runtimeApi,
    "compatibility.runtimeApi",
    { pattern: RUNTIME_RANGE_PATTERN, maxLength: 128 },
  )
  if (!runtimeVersionSatisfies(runtimeApi, runtimeApiVersion)) {
    throw manifestError(
      `incompatible_profile_runtime_api:${runtimeApiVersion}`,
      { required: runtimeApi, actual: runtimeApiVersion },
    )
  }

  const policy = assertKnownKeys(
    manifest.policy,
    ["readOnly", "instructions", "escalation"],
    "policy",
  )
  if (typeof policy.readOnly !== "boolean") {
    throw manifestError("profile_manifest_invalid_field:policy.readOnly")
  }
  const instructions = stringList(policy.instructions, "policy.instructions", {
    pattern: /^[^\u0000\u007f]{1,20000}$/,
    maxLength: 20_000,
  })
  if (instructions.length === 0) {
    throw manifestError("profile_manifest_invalid_field:policy.instructions")
  }
  const escalation = assertKnownKeys(
    policy.escalation,
    ["strategy", "onInsufficientEvidence", "onWriteRequest"],
    "policy.escalation",
  )
  if (escalation.strategy !== "human") {
    throw manifestError("profile_manifest_invalid_field:policy.escalation.strategy")
  }
  for (const field of ["onInsufficientEvidence", "onWriteRequest"] as const) {
    if (typeof escalation[field] !== "boolean") {
      throw manifestError(`profile_manifest_invalid_field:policy.escalation.${field}`)
    }
  }

  const manifestCapabilities = assertKnownKeys(
    manifest.capabilities,
    ["channels", "models", "sources", "memory", "tools"],
    "capabilities",
  )
  const capabilities = {
    channels: stringList(manifestCapabilities.channels, "capabilities.channels"),
    models: stringList(manifestCapabilities.models, "capabilities.models"),
    sources: stringList(manifestCapabilities.sources, "capabilities.sources"),
    memory: stringList(manifestCapabilities.memory, "capabilities.memory"),
    tools: validateTools(manifestCapabilities.tools),
  }

  const manifestPermissions = assertKnownKeys(
    manifest.permissions,
    ["read", "write"],
    "permissions",
  )
  const readPermissions = assertKnownKeys(
    manifestPermissions.read,
    ["sourceTypes", "tools"],
    "permissions.read",
  )
  const writePermissions = assertKnownKeys(
    manifestPermissions.write,
    ["requested", "tools"],
    "permissions.write",
  )
  if (typeof writePermissions.requested !== "boolean") {
    throw manifestError("profile_manifest_invalid_field:permissions.write.requested")
  }
  const permissions = {
    read: {
      sourceTypes: stringList(
        readPermissions.sourceTypes,
        "permissions.read.sourceTypes",
      ),
      tools: stringList(readPermissions.tools, "permissions.read.tools"),
    },
    write: {
      requested: writePermissions.requested,
      tools: stringList(writePermissions.tools, "permissions.write.tools"),
    },
  }
  const toolModes = new Map(capabilities.tools.map((tool) => [tool.name, tool.mode]))
  for (const sourceType of permissions.read.sourceTypes) {
    if (!capabilities.sources.includes(sourceType)) {
      throw manifestError(`profile_permission_not_declared:source:${sourceType}`)
    }
  }
  for (const tool of permissions.read.tools) {
    if (toolModes.get(tool) !== "read") {
      throw manifestError(`profile_permission_not_declared:read-tool:${tool}`)
    }
  }
  for (const tool of permissions.write.tools) {
    if (toolModes.get(tool) !== "write") {
      throw manifestError(`profile_permission_not_declared:write-tool:${tool}`)
    }
  }
  if (!permissions.write.requested && permissions.write.tools.length > 0) {
    throw manifestError("profile_manifest_write_tools_require_request")
  }

  const manifestDependencies = assertKnownKeys(
    manifest.dependencies,
    ["required", "optional"],
    "dependencies",
  )
  const dependencies = {
    required: stringList(manifestDependencies.required, "dependencies.required"),
    optional: stringList(manifestDependencies.optional, "dependencies.optional"),
  }
  const manifestEntrypoints = assertKnownKeys(
    manifest.entrypoints,
    ["profile"],
    "entrypoints",
  )
  const profileEntrypoint = requireString(
    manifestEntrypoints.profile,
    "entrypoints.profile",
    { pattern: /^\.\/(?!.*(?:^|\/)\.\.(?:\/|$)).+\.m?js$/, maxLength: 512 },
  )
  const assets = stringList(manifest.assets, "assets", {
    pattern: /^\.\/(?!.*(?:^|\/)\.\.(?:\/|$)).+/,
  })
  const configuration = validateConfiguration(manifest.configuration)
  const integrity = validateIntegrity(manifest.integrity)

  return deepFreeze({
    ...(typeof manifest.$schema === "string" ? { $schema: manifest.$schema } : {}),
    schemaVersion: EMPLOYEE_PROFILE_SCHEMA_VERSION,
    name,
    version,
    description,
    license,
    authors,
    provenance: {
      repository: repository.toString(),
      ...(provenance.revision
        ? {
            revision: requireString(
              provenance.revision,
              "provenance.revision",
              { maxLength: 256 },
            ),
          }
        : {}),
    },
    compatibility: { runtimeApi },
    policy: {
      readOnly: policy.readOnly,
      instructions,
      escalation: {
        strategy: "human",
        onInsufficientEvidence: escalation.onInsufficientEvidence,
        onWriteRequest: escalation.onWriteRequest,
      },
    },
    capabilities,
    permissions,
    dependencies,
    configuration,
    entrypoints: { profile: profileEntrypoint },
    assets,
    ...(integrity ? { integrity } : {}),
  } as EmployeeProfileManifest)
}
