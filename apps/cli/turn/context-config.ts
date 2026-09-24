/**
 * Workspace-owned configuration for the ContextPort CLI adapter (#304).
 *
 * The workspace file declares adapter metadata and environment-variable names
 * only. The existing `context` field remains the portable context directory
 * path; this opt-in block is the sibling object `contextPort`.
 */

import { constants as fsConstants } from "node:fs"
import { open } from "node:fs/promises"
import path from "node:path"

import {
  createContextCliAdapter,
} from "../../../packages/core/src/context-cli-adapter.js"
import type { ContextPort } from "../../../packages/core/src/context-port.js"
import { ContextPortError } from "../../../packages/core/src/context-port.js"

export const WORKSPACE_CONTEXT_SCHEMA_VERSION = "workspace-context.v1" as const
export const WORKSPACE_CONTEXT_ADAPTER_ID = "context-cli.v1" as const

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/
const TOKEN_ENV_PATTERN = /^CONTEXT_[A-Z0-9_]{1,100}_TOKEN$/
const SCOPE_ENV_PATTERN = /^CONTEXT_[A-Z0-9_]{1,100}_SCOPE$/
const MAX_WORKSPACE_MANIFEST_BYTES = 64 * 1024

export interface WorkspaceContextPositionBinding {
  tokenEnv: string
  contextScopeEnv: string
}

export interface WorkspaceContextConfiguration {
  schemaVersion: typeof WORKSPACE_CONTEXT_SCHEMA_VERSION
  adapter: typeof WORKSPACE_CONTEXT_ADAPTER_ID
  enabled: boolean
  mode: "optional" | "required"
  commandEnv?: string
  contextWorkspaceIdEnv: string
  pinnedRevisionEnv: string
  bindings: Record<string, WorkspaceContextPositionBinding>
}

export interface WorkspaceContextResolution {
  status: "enabled"
  adapterIdentity: typeof WORKSPACE_CONTEXT_ADAPTER_ID
  port: ContextPort
  workspaceId: string
  mode: WorkspaceContextConfiguration["mode"]
}

export interface DisabledWorkspaceContext {
  status: "disabled"
  reason:
    | "workspace_manifest_missing"
    | "binding_absent"
    | "disabled_by_config"
    | "optional_unusable"
}

export class WorkspaceContextConfigError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "WorkspaceContextConfigError"
  }
}

interface WorkspaceManifestRecord {
  contextPort?: unknown
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
  if (!record(value)) throw new WorkspaceContextConfigError(code)
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
    throw new WorkspaceContextConfigError("workspace_context_config_invalid")
  }
}

function environmentName(value: unknown, code: string, pattern = ENV_NAME_PATTERN): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new WorkspaceContextConfigError(code)
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
    throw new WorkspaceContextConfigError(code)
  }
  return value
}

function parseConfiguration(value: unknown): WorkspaceContextConfiguration {
  const config = requiredRecord(value, "workspace_context_config_invalid")
  exactKeys(
    config,
    [
      "schemaVersion",
      "adapter",
      "enabled",
      "mode",
      "contextWorkspaceIdEnv",
      "pinnedRevisionEnv",
      "bindings",
    ],
    ["commandEnv"],
  )
  if (config.schemaVersion !== WORKSPACE_CONTEXT_SCHEMA_VERSION) {
    throw new WorkspaceContextConfigError("workspace_context_schema_unsupported")
  }
  if (config.adapter !== WORKSPACE_CONTEXT_ADAPTER_ID) {
    throw new WorkspaceContextConfigError("workspace_context_adapter_unsupported")
  }
  if (typeof config.enabled !== "boolean") {
    throw new WorkspaceContextConfigError("workspace_context_enabled_invalid")
  }
  if (config.mode !== "optional" && config.mode !== "required") {
    throw new WorkspaceContextConfigError("workspace_context_mode_invalid")
  }
  const rawBindings = requiredRecord(
    config.bindings,
    "workspace_context_bindings_invalid",
  )
  const bindings: Record<string, WorkspaceContextPositionBinding> = {}
  for (const [positionId, rawBinding] of Object.entries(rawBindings)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(positionId)) {
      throw new WorkspaceContextConfigError("workspace_context_position_invalid")
    }
    const binding = requiredRecord(
      rawBinding,
      "workspace_context_position_binding_invalid",
    )
    exactKeys(binding, ["tokenEnv", "contextScopeEnv"])
    bindings[positionId] = {
      tokenEnv: environmentName(
        binding.tokenEnv,
        "workspace_context_token_env_invalid",
        TOKEN_ENV_PATTERN,
      ),
      contextScopeEnv: environmentName(
        binding.contextScopeEnv,
        "workspace_context_scope_env_invalid",
        SCOPE_ENV_PATTERN,
      ),
    }
  }
  return {
    schemaVersion: WORKSPACE_CONTEXT_SCHEMA_VERSION,
    adapter: WORKSPACE_CONTEXT_ADAPTER_ID,
    enabled: config.enabled,
    mode: config.mode,
    ...(config.commandEnv === undefined
      ? {}
      : {
          commandEnv: environmentName(
            config.commandEnv,
            "workspace_context_command_env_invalid",
          ),
        }),
    contextWorkspaceIdEnv: environmentName(
      config.contextWorkspaceIdEnv,
      "workspace_context_workspace_id_env_invalid",
    ),
    pinnedRevisionEnv: environmentName(
      config.pinnedRevisionEnv,
      "workspace_context_revision_env_invalid",
    ),
    bindings,
  }
}

async function readWorkspaceManifest(
  workspace: string,
): Promise<WorkspaceManifestRecord | DisabledWorkspaceContext> {
  const manifestPath = path.join(workspace, "workspace.json")
  let handle
  let raw: string
  try {
    handle = await open(
      manifestPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    )
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_WORKSPACE_MANIFEST_BYTES) {
      throw new WorkspaceContextConfigError("workspace_context_manifest_unreadable")
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
    if (error instanceof WorkspaceContextConfigError) throw error
    throw new WorkspaceContextConfigError("workspace_context_manifest_unreadable")
  } finally {
    await handle?.close()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new WorkspaceContextConfigError("workspace_context_manifest_invalid")
  }
  return requiredRecord(parsed, "workspace_context_manifest_invalid")
}

function unusable(
  mode: WorkspaceContextConfiguration["mode"],
  code: string,
): DisabledWorkspaceContext {
  if (mode === "required") throw new WorkspaceContextConfigError(code)
  return { status: "disabled", reason: "optional_unusable" }
}

/**
 * Resolve the opt-in ContextPort binding. Absence or `enabled: false`
 * preserves today's turn-run behaviour. `command` is a test seam; production
 * uses `commandEnv` or the default `context` executable.
 */
export async function resolveWorkspaceContext(input: {
  workspace: string
  positionId: string
  env?: NodeJS.ProcessEnv
  command?: readonly string[]
}): Promise<WorkspaceContextResolution | DisabledWorkspaceContext> {
  const manifest = await readWorkspaceManifest(input.workspace)
  if ("status" in manifest) return manifest
  if (manifest.contextPort === undefined) {
    return { status: "disabled", reason: "binding_absent" }
  }
  const config = parseConfiguration(manifest.contextPort)
  if (!config.enabled) {
    return { status: "disabled", reason: "disabled_by_config" }
  }
  const binding = config.bindings[input.positionId]
  if (!binding) {
    return unusable(config.mode, "workspace_context_position_binding_missing")
  }
  const env = input.env ?? process.env
  let workspaceId: string
  try {
    workspaceId = environmentValue(
      env,
      config.contextWorkspaceIdEnv,
      "workspace_context_workspace_id_not_configured",
    )
    environmentValue(
      env,
      config.pinnedRevisionEnv,
      "workspace_context_revision_not_configured",
    )
    environmentValue(
      env,
      binding.tokenEnv,
      "workspace_context_token_not_configured",
    )
    environmentValue(
      env,
      binding.contextScopeEnv,
      "workspace_context_scope_not_configured",
    )
  } catch (error) {
    if (error instanceof WorkspaceContextConfigError) {
      return unusable(config.mode, error.code)
    }
    throw error
  }
  const command = input.command
    ?? (config.commandEnv && env[config.commandEnv]
      ? [env[config.commandEnv]!]
      : ["context"])
  let port: ContextPort
  try {
    port = createContextCliAdapter({
      command,
      workspaceId,
      positionId: input.positionId,
      env: {
        ...env,
        CONTEXT_RUNTIME_TOKEN: env[binding.tokenEnv],
      },
    })
  } catch (error) {
    const code =
      error instanceof ContextPortError
        ? `workspace_context_adapter_configuration_invalid:${error.code}`
        : "workspace_context_adapter_invalid"
    return unusable(config.mode, code)
  }
  return {
    status: "enabled",
    adapterIdentity: WORKSPACE_CONTEXT_ADAPTER_ID,
    port,
    workspaceId,
    mode: config.mode,
  }
}
