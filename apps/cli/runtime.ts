import { readFile } from "node:fs/promises"
import path from "node:path"
import {
  DigitalEmployee,
  EscalationPolicy,
  LexicalRetriever,
  RuntimeComponentRegistry,
  SessionStore,
  VerifiedFaqStore,
} from "../../packages/core/index.js"
import type {
  EmployeeProfileManifest,
  RuntimeProfileComponent,
} from "../../packages/core/index.js"
import {
  createBuiltInRegistry,
  loadAllowedComponentModules,
} from "./registry.js"

const MAX_CONFIG_BYTES = 1024 * 1024

type ConfigObject = Record<string, unknown>

interface ProfileReferenceObject {
  name: string
  version: string
}

interface EmployeeConfig extends ConfigObject {
  id?: string
  profile?: string | ProfileReferenceObject
  displayName?: string
  domain?: string
  instructions?: string
}

interface SourceConfig extends ConfigObject {
  id: string
  type: string
}

interface RuntimeConfig extends ConfigObject {
  employee?: EmployeeConfig
  runtime?: {
    readOnly?: boolean
    topK?: number
    minScore?: number
    sessionTtlMs?: number
    maxSessions?: number
    maxMessages?: number
  }
  model?: ConfigObject & { provider?: string }
  sources?: SourceConfig[]
  channel?: ConfigObject & {
    type?: string
    clientIdEnv?: string
    clientSecretEnv?: string
  }
  server?: { apiTokenEnv?: string }
  escalation?: {
    threshold?: number
    minEvidence?: number
    minCitations?: number
    target?: string
    message?: string
  }
  extensions?: { modules?: unknown[] }
}

interface ResolvedProfileReference {
  name: string
  version: string | null
  legacy: boolean
}

interface CreateRuntimeOptions {
  registry?: RuntimeComponentRegistry
  moduleAllowlist?: string[]
  environment?: NodeJS.ProcessEnv
}

type ProfileCapabilityKind = "channels" | "models" | "sources" | "memory"

function assertObject(value: unknown, label: string): ConfigObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}_must_be_an_object`)
  }
  return value as ConfigObject
}

export async function loadConfig(configPath: string) {
  const absolutePath = path.resolve(configPath)
  const content = await readFile(absolutePath)
  if (content.length > MAX_CONFIG_BYTES) throw new Error("config_file_too_large")
  const config = JSON.parse(content.toString("utf8")) as unknown
  assertObject(config, "config")
  const typedConfig = config as RuntimeConfig
  if (typedConfig.model && "apiKey" in typedConfig.model) {
    throw new TypeError("model_api_key_must_use_an_environment_variable")
  }
  return {
    config: typedConfig,
    configPath: absolutePath,
    configDirectory: path.dirname(absolutePath),
  }
}

function profileReference(input: unknown): ResolvedProfileReference {
  if (typeof input === "string" && input.trim()) {
    return { name: input.trim(), version: null, legacy: true }
  }
  const reference = assertObject(input, "employee_profile_reference")
  const unknown = Object.keys(reference).filter(
    (key) => key !== "name" && key !== "version",
  )
  if (unknown.length > 0) {
    throw new TypeError(`employee_profile_reference_unknown_field:${unknown[0]}`)
  }
  if (typeof reference.name !== "string" || !reference.name.trim()) {
    throw new TypeError("employee_profile_reference_requires_name")
  }
  if (typeof reference.version !== "string" || !reference.version.trim()) {
    throw new TypeError("employee_profile_reference_requires_version")
  }
  return {
    name: reference.name.trim(),
    version: reference.version.trim(),
    legacy: false,
  }
}

export function assertProfileCapability(
  manifest: EmployeeProfileManifest,
  kind: ProfileCapabilityKind,
  identifier: string,
): void {
  const capabilities = manifest.capabilities[kind]
  if (!capabilities.includes(identifier)) {
    throw new TypeError(`profile_capability_not_declared:${kind}:${identifier}`)
  }
}

function assertReadOnlyProfile(
  manifest: EmployeeProfileManifest,
  profile: RuntimeProfileComponent,
  runtimeOptions: NonNullable<RuntimeConfig["runtime"]>,
): void {
  if (
    runtimeOptions.readOnly === false ||
    manifest.policy.readOnly !== true ||
    manifest.permissions.write.requested === true ||
    profile.readOnly !== true
  ) {
    throw new TypeError("write_capable_profiles_are_not_supported")
  }
}

export async function createRuntime(
  configPath: string,
  {
    registry: injectedRegistry,
    moduleAllowlist = [],
    environment = process.env,
  }: CreateRuntimeOptions = {},
) {
  const loaded = await loadConfig(configPath)
  const { config, configDirectory } = loaded
  if (!Array.isArray(config.sources) || config.sources.length === 0) {
    throw new TypeError("at_least_one_approved_source_is_required")
  }
  const registry = injectedRegistry ?? (await createBuiltInRegistry())
  await loadAllowedComponentModules(registry, {
    configDirectory,
    modules: config.extensions?.modules ?? [],
    moduleAllowlist,
  })

  const employeeConfig = assertObject(config.employee ?? {}, "employee")
  const reference = profileReference(employeeConfig.profile)
  const profileManifest = registry.metadata("profile", reference.name).manifest
  if (!profileManifest) {
    throw new TypeError(`profile_manifest_missing:${reference.name}`)
  }
  if (reference.version && reference.version !== profileManifest.version) {
    throw new TypeError(
      `profile_version_mismatch:${reference.version}:${profileManifest.version}`,
    )
  }
  const profile = await registry.create("profile", reference.name, {
    config: employeeConfig,
    configDirectory,
    environment,
  })
  const runtimeOptions = config.runtime ?? {}
  assertReadOnlyProfile(profileManifest, profile, runtimeOptions)

  const sources = await Promise.all(
    config.sources.map(async (input) => {
      const source = assertObject(input, "source")
      const type = String(source.type || "")
      assertProfileCapability(profileManifest, "sources", type)
      if (!profileManifest.permissions.read.sourceTypes.includes(type)) {
        throw new TypeError(`profile_source_read_not_allowed:${type}`)
      }
      return registry.create("source", type, {
        config: source,
        configDirectory,
        environment,
      })
    }),
  )
  const documentGroups = await Promise.all(sources.map((source) => source.load()))
  const documents = documentGroups.flat()
  const modelConfig = assertObject(
    config.model ?? { provider: "extractive" },
    "model",
  )
  const modelProvider = String(modelConfig.provider || "")
  assertProfileCapability(profileManifest, "models", modelProvider)
  const model = await registry.create("model", modelProvider, {
    config: modelConfig,
    configDirectory,
    environment,
  })
  const retriever = new LexicalRetriever(documents, {
    limit: runtimeOptions.topK || 5,
    minScore: runtimeOptions.minScore ?? 0.05,
  })
  const sessionStore = new SessionStore({
    ttlMs: runtimeOptions.sessionTtlMs,
    maxSessions: runtimeOptions.maxSessions,
    maxMessages: runtimeOptions.maxMessages,
  })
  const escalation = config.escalation ?? {}
  const escalationPolicy = new EscalationPolicy({
    minConfidence: escalation.threshold ?? 0.35,
    minEvidence: escalation.minEvidence ?? 1,
    minCitations: escalation.minCitations ?? 1,
    target: escalation.target || "human-support",
    message: escalation.message,
  })
  const employee = new DigitalEmployee({
    profile,
    model,
    retriever,
    faqStore: new VerifiedFaqStore(),
    sessionStore,
    escalationPolicy,
    readOnly: true,
    maxEvidence: runtimeOptions.topK || 5,
  })

  return {
    ...loaded,
    employee,
    profile,
    profileManifest,
    profileReference: reference,
    registry,
    retriever,
    sources,
    documents,
  }
}
