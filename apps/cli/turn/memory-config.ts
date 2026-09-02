/**
 * Workspace-owned configuration for the first-party mem MemoryPort adapter.
 *
 * The workspace file declares only adapter metadata and environment-variable
 * names. Endpoint, tenant, scope, revision and token values stay outside the
 * workspace and are resolved from the operator environment at run time.
 */

import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import { open } from "node:fs/promises"
import path from "node:path"

import {
  createMemHttpMemoryAdapter,
} from "../../../packages/core/src/mem-http-memory-adapter.js"
import type { MemoryPort } from "../../../packages/core/src/memory-port.js"
import { MemoryPortError } from "../../../packages/core/src/memory-port.js"

export const WORKSPACE_MEMORY_SCHEMA_VERSION = "workspace-memory.v1" as const
export const WORKSPACE_MEMORY_ADAPTER_ID = "mem-http.v1" as const

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/
const TOKEN_ENV_PATTERN = /^MEM_[A-Z0-9_]{1,100}_TOKEN$/
const SCOPE_ENV_PATTERN = /^MEM_[A-Z0-9_]{1,100}_SCOPE$/
const MAX_WORKSPACE_MANIFEST_BYTES = 64 * 1024
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface WorkspaceMemoryPositionBinding {
  tokenEnv: string
  memoryScopeEnv: string
}

export interface WorkspaceMemoryConfiguration {
  schemaVersion: typeof WORKSPACE_MEMORY_SCHEMA_VERSION
  adapter: typeof WORKSPACE_MEMORY_ADAPTER_ID
  enabled: boolean
  mode: "optional" | "required"
  baseUrlEnv: string
  memWorkspaceIdEnv: string
  pinnedRevisionEnv: string
  bindings: Record<string, WorkspaceMemoryPositionBinding>
  limit?: number
}

export interface WorkspaceMemoryResolution {
  status: "enabled"
  adapterIdentity: typeof WORKSPACE_MEMORY_ADAPTER_ID
  port: MemoryPort
  workspaceInstanceId: string
  sessionId: string
  taskId: string
  memoryScope: string
  mode: WorkspaceMemoryConfiguration["mode"]
  limit?: number
}

export interface DisabledWorkspaceMemory {
  status: "disabled"
  reason: "workspace_manifest_missing" | "binding_absent" | "disabled_by_config"
}

export class WorkspaceMemoryConfigError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "WorkspaceMemoryConfigError"
  }
}

interface WorkspaceManifestRecord {
  workspaceInstanceId?: unknown
  memory?: unknown
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function requiredRecord(value: unknown, code: string): Record<string, unknown> {
  if (!record(value)) throw new WorkspaceMemoryConfigError(code)
  return value
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new WorkspaceMemoryConfigError("workspace_memory_config_invalid")
  }
}

function environmentName(value: unknown, code: string, pattern = ENV_NAME_PATTERN): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new WorkspaceMemoryConfigError(code)
  }
  return value
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  code: string,
): string {
  const value = env[name]
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceMemoryConfigError(code)
  }
  return value
}

function boundedUuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new WorkspaceMemoryConfigError(code)
  }
  return value
}

function parseConfiguration(value: unknown): WorkspaceMemoryConfiguration {
  const config = requiredRecord(value, "workspace_memory_config_invalid")
  exactKeys(
    config,
    [
      "schemaVersion",
      "adapter",
      "enabled",
      "mode",
      "baseUrlEnv",
      "memWorkspaceIdEnv",
      "pinnedRevisionEnv",
      "bindings",
    ],
    ["limit"],
  )
  if (config.schemaVersion !== WORKSPACE_MEMORY_SCHEMA_VERSION) {
    throw new WorkspaceMemoryConfigError("workspace_memory_schema_unsupported")
  }
  if (config.adapter !== WORKSPACE_MEMORY_ADAPTER_ID) {
    throw new WorkspaceMemoryConfigError("workspace_memory_adapter_unsupported")
  }
  if (typeof config.enabled !== "boolean") {
    throw new WorkspaceMemoryConfigError("workspace_memory_enabled_invalid")
  }
  if (config.mode !== "optional" && config.mode !== "required") {
    throw new WorkspaceMemoryConfigError("workspace_memory_mode_invalid")
  }
  const baseUrlEnv = environmentName(
    config.baseUrlEnv,
    "workspace_memory_base_url_env_invalid",
  )
  const memWorkspaceIdEnv = environmentName(
    config.memWorkspaceIdEnv,
    "workspace_memory_workspace_id_env_invalid",
  )
  const pinnedRevisionEnv = environmentName(
    config.pinnedRevisionEnv,
    "workspace_memory_revision_env_invalid",
  )
  const rawBindings = requiredRecord(
    config.bindings,
    "workspace_memory_bindings_invalid",
  )
  const bindings: Record<string, WorkspaceMemoryPositionBinding> = {}
  for (const [positionId, rawBinding] of Object.entries(rawBindings)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(positionId)) {
      throw new WorkspaceMemoryConfigError("workspace_memory_position_invalid")
    }
    const binding = requiredRecord(
      rawBinding,
      "workspace_memory_position_binding_invalid",
    )
    exactKeys(binding, ["tokenEnv", "memoryScopeEnv"])
    bindings[positionId] = {
      tokenEnv: environmentName(
        binding.tokenEnv,
        "workspace_memory_token_env_invalid",
        TOKEN_ENV_PATTERN,
      ),
      memoryScopeEnv: environmentName(
        binding.memoryScopeEnv,
        "workspace_memory_scope_env_invalid",
        SCOPE_ENV_PATTERN,
      ),
    }
  }
  let limit: number | undefined
  const rawLimit = config.limit
  if (rawLimit !== undefined) {
    if (
      typeof rawLimit !== "number" ||
      !Number.isSafeInteger(rawLimit) ||
      rawLimit < 1 ||
      rawLimit > 20
    ) {
      throw new WorkspaceMemoryConfigError("workspace_memory_limit_invalid")
    }
    limit = rawLimit
  }
  return {
    schemaVersion: WORKSPACE_MEMORY_SCHEMA_VERSION,
    adapter: WORKSPACE_MEMORY_ADAPTER_ID,
    enabled: config.enabled,
    mode: config.mode,
    baseUrlEnv,
    memWorkspaceIdEnv,
    pinnedRevisionEnv,
    bindings,
    ...(limit === undefined ? {} : { limit }),
  }
}

async function readWorkspaceManifest(
  workspace: string,
): Promise<WorkspaceManifestRecord | DisabledWorkspaceMemory> {
  const manifestPath = path.join(workspace, "workspace.json")
  let handle
  let raw: string
  try {
    handle = await open(
      manifestPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    )
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_WORKSPACE_MANIFEST_BYTES) {
      throw new WorkspaceMemoryConfigError("workspace_memory_manifest_unreadable")
    }
    raw = await handle.readFile({ encoding: "utf8" })
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { status: "disabled", reason: "workspace_manifest_missing" }
    }
    if (error instanceof WorkspaceMemoryConfigError) throw error
    throw new WorkspaceMemoryConfigError("workspace_memory_manifest_unreadable")
  } finally {
    await handle?.close()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new WorkspaceMemoryConfigError("workspace_memory_manifest_invalid")
  }
  return requiredRecord(parsed, "workspace_memory_manifest_invalid")
}

function hashUuid(namespace: string, value: string): string {
  const bytes = createHash("sha256")
    .update(`${namespace}\0${value}`, "utf8")
    .digest()
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString("hex").slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Stable UUID session identity for one workspace/position/conversation. */
export function deriveMemorySessionId(
  workspaceInstanceId: string,
  positionId: string,
  conversationRef?: string,
): string {
  return hashUuid(
    "digital-employee-memory-session.v1",
    `${workspaceInstanceId}\0${positionId}\0${conversationRef ?? "default"}`,
  )
}

/** Turn IDs are normalized before they become task-state identifiers. */
export function deriveMemoryTaskId(turnId: string): string {
  return `turn-${hashUuid("digital-employee-memory-task.v1", turnId).replaceAll("-", "")}`
}

export async function resolveWorkspaceMemory(
  input: {
    workspace: string
    positionId: string
    conversationRef?: string
    turnId: string
    env?: NodeJS.ProcessEnv
  },
): Promise<WorkspaceMemoryResolution | DisabledWorkspaceMemory> {
  const manifest = await readWorkspaceManifest(input.workspace)
  if ("status" in manifest) return manifest
  if (manifest.memory === undefined) {
    return { status: "disabled", reason: "binding_absent" }
  }

  const config = parseConfiguration(manifest.memory)
  if (!config.enabled) {
    return { status: "disabled", reason: "disabled_by_config" }
  }
  const workspaceInstanceId = boundedUuid(
    manifest.workspaceInstanceId,
    "workspace_memory_instance_id_invalid",
  )
  const binding = config.bindings[input.positionId]
  if (!binding) {
    throw new WorkspaceMemoryConfigError("workspace_memory_position_binding_missing")
  }
  const env = input.env ?? process.env
  const baseUrl = environmentValue(
    env,
    config.baseUrlEnv,
    "workspace_memory_base_url_not_configured",
  )
  const memWorkspaceId = environmentValue(
    env,
    config.memWorkspaceIdEnv,
    "workspace_memory_workspace_id_not_configured",
  )
  const pinnedRevision = environmentValue(
    env,
    config.pinnedRevisionEnv,
    "workspace_memory_revision_not_configured",
  )
  const memoryScope = environmentValue(
    env,
    binding.memoryScopeEnv,
    "workspace_memory_scope_not_configured",
  )
  let port: MemoryPort
  try {
    port = createMemHttpMemoryAdapter({
      baseUrl,
      memWorkspaceId,
      workspaceInstanceId,
      positionId: input.positionId,
      memoryScope,
      tokenEnv: binding.tokenEnv,
      pinnedRevision,
      environment: env,
    })
  } catch (error) {
    if (error instanceof MemoryPortError) {
      throw new WorkspaceMemoryConfigError(
        `workspace_memory_adapter_configuration_invalid:${error.code}`,
      )
    }
    throw new WorkspaceMemoryConfigError("workspace_memory_adapter_invalid")
  }
  return {
    status: "enabled",
    adapterIdentity: WORKSPACE_MEMORY_ADAPTER_ID,
    port,
    workspaceInstanceId,
    sessionId: deriveMemorySessionId(
      workspaceInstanceId,
      input.positionId,
      input.conversationRef,
    ),
    taskId: deriveMemoryTaskId(input.turnId),
    memoryScope,
    mode: config.mode,
    ...(config.limit === undefined ? {} : { limit: config.limit }),
  }
}
