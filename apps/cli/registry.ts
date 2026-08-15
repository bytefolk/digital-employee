import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  RuntimeComponentRegistry,
  validateProfileManifest,
} from "../../packages/core/index.js"
import type {
  EmployeeProfileManifest,
  RuntimeComponentContext,
} from "../../packages/core/index.js"
import { ConsoleChannel } from "../../connectors/channels/console/index.js"
import { ExtractiveModel } from "../../connectors/models/extractive/index.js"
import { OpenAICompatibleModel } from "../../connectors/models/openai-compatible/index.js"
import { FileSystemSource } from "../../connectors/sources/filesystem/index.js"
import { GitSource } from "../../connectors/sources/git/index.js"
import type { GitSourcePolicy } from "../../connectors/sources/git/index.js"
import { createAnswerAgentProfile } from "../../profiles/answer-agent/index.js"

type ConfigObject = Record<string, unknown>

interface ModuleLoadOptions {
  configDirectory: string
  modules?: unknown[]
  moduleAllowlist?: unknown[]
}

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
)
const answerAgentManifestPath = path.join(
  packageRoot,
  "profiles",
  "answer-agent",
  "profile.json",
)

async function readManifest(manifestPath: string): Promise<EmployeeProfileManifest> {
  const content = await readFile(manifestPath, "utf8")
  return validateProfileManifest(JSON.parse(content) as unknown)
}

function requireConfig(context: RuntimeComponentContext): ConfigObject {
  return context.config ?? {}
}

function requireConfigDirectory(context: RuntimeComponentContext): string {
  if (typeof context.configDirectory !== "string" || !context.configDirectory) {
    throw new TypeError("component_config_directory_required")
  }
  return context.configDirectory
}

function resolveFromConfig(configDirectory: string, value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new TypeError("config_path_must_be_a_string")
  }
  return path.isAbsolute(value) ? value : path.resolve(configDirectory, value)
}

function registerBuiltInProfiles(
  registry: RuntimeComponentRegistry,
  answerAgentManifest: EmployeeProfileManifest,
): void {
  registry.register(
    "profile",
    answerAgentManifest.name,
    ({ config = {} }) =>
      createAnswerAgentProfile({
        id: typeof config.id === "string" ? config.id : answerAgentManifest.name,
        displayName:
          typeof config.displayName === "string" ? config.displayName : undefined,
        domain: typeof config.domain === "string" ? config.domain : undefined,
        instructions:
          typeof config.instructions === "string" ? config.instructions : undefined,
        manifest: answerAgentManifest,
      }),
    { manifest: answerAgentManifest },
  )
}

function registerBuiltInSources(registry: RuntimeComponentRegistry): void {
  registry.register("source", "filesystem", (context) => {
    const config = requireConfig(context)
    return new FileSystemSource({
      id: typeof config.id === "string" ? config.id : "filesystem",
      root: resolveFromConfig(requireConfigDirectory(context), config.root),
      include: Array.isArray(config.include) ? config.include : undefined,
      publicBaseUrl:
        typeof config.publicBaseUrl === "string" ? config.publicBaseUrl : undefined,
    })
  })
  registry.register("source", "git", (context) => {
    const config = requireConfig(context)
    if (typeof config.remote !== "string" || !config.remote) {
      throw new TypeError("git_source_remote_is_required")
    }
    return new GitSource({
      id: typeof config.id === "string" ? config.id : "git",
      remote: config.remote,
      ref: typeof config.ref === "string" ? config.ref : undefined,
      cacheDir: resolveFromConfig(
        requireConfigDirectory(context),
        config.cacheDir ?? "../.cache/git",
      ),
      subdirectory:
        typeof config.subdirectory === "string" ? config.subdirectory : undefined,
      include: Array.isArray(config.include) ? config.include : undefined,
      publicBaseUrl:
        typeof config.publicBaseUrl === "string" ? config.publicBaseUrl : undefined,
      timeoutMs:
        typeof config.timeoutMs === "number" ? config.timeoutMs : undefined,
      policy: config.policy as GitSourcePolicy | undefined,
      maxStaleMs: config.maxStaleMs as number | undefined,
    })
  })
  registry.register("source", "dws", async ({ config = {} }) => {
    if ("env" in config) {
      throw new TypeError("dws_source_environment_must_not_be_stored_in_config")
    }
    const { DwsKnowledgeSource } = await import(
      "../../connectors/sources/dws/index.js"
    )
    return new DwsKnowledgeSource({
      id: typeof config.id === "string" ? config.id : undefined,
      profile: config.profile,
      executable: config.executable,
      approvedQueries: config.approvedQueries,
      timeoutMs: config.timeoutMs,
      maxOutputBytes: config.maxOutputBytes,
      maxDocumentsPerQuery: config.maxDocumentsPerQuery,
    })
  })
}

function registerBuiltInModels(registry: RuntimeComponentRegistry): void {
  registry.register("model", "extractive", ({ config = {} }) =>
    new ExtractiveModel({
      prefix: typeof config.prefix === "string" ? config.prefix : undefined,
    }),
  )
  registry.register(
    "model",
    "openai-compatible",
    ({ config = {}, environment = process.env }) => {
      const apiKeyEnv = String(config.apiKeyEnv || "")
      const apiKey = apiKeyEnv ? environment[apiKeyEnv] : ""
      if (!apiKey) {
        throw new Error(`missing_model_credential:${apiKeyEnv || "apiKeyEnv"}`)
      }
      return new OpenAICompatibleModel({
        baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : undefined,
        apiKey,
        model: typeof config.model === "string" ? config.model : undefined,
        allowPrivateNetwork: config.allowPrivateNetwork === true,
        timeoutMs:
          typeof config.timeoutMs === "number" ? config.timeoutMs : undefined,
        maxResponseBytes:
          typeof config.maxResponseBytes === "number"
            ? config.maxResponseBytes
            : undefined,
        temperature:
          typeof config.temperature === "number" ? config.temperature : undefined,
      })
    },
  )
}

function registerBuiltInChannels(registry: RuntimeComponentRegistry): void {
  registry.register("channel", "console", ({ config = {} }) =>
    new ConsoleChannel({
      prompt: typeof config.prompt === "string" ? config.prompt : undefined,
    }),
  )
  registry.register(
    "channel",
    "dingtalk",
    async ({ config = {}, environment = process.env }) => {
      const clientIdEnv =
        typeof config.clientIdEnv === "string"
          ? config.clientIdEnv
          : "DINGTALK_CLIENT_ID"
      const clientSecretEnv =
        typeof config.clientSecretEnv === "string"
          ? config.clientSecretEnv
          : "DINGTALK_CLIENT_SECRET"
      const clientId = environment[clientIdEnv]
      const clientSecret = environment[clientSecretEnv]
      if (!clientId || !clientSecret) {
        throw new Error("missing_dingtalk_credentials")
      }
      const { DingTalkChannel } = await import(
        "../../connectors/channels/dingtalk/index.js"
      )
      return new DingTalkChannel({ clientId, clientSecret })
    },
  )
}

export async function createBuiltInRegistry(): Promise<RuntimeComponentRegistry> {
  const registry = new RuntimeComponentRegistry()
  const answerAgentManifest = await readManifest(answerAgentManifestPath)
  registerBuiltInProfiles(registry, answerAgentManifest)
  registerBuiltInSources(registry)
  registerBuiltInModels(registry)
  registerBuiltInChannels(registry)
  return registry
}

function containsParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).includes("..")
}

function resolveRequestedModule(configDirectory: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("extension_module_path_must_be_a_string")
  }
  if (!path.isAbsolute(value) && /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new TypeError("extension_remote_specifier_not_allowed")
  }
  if (containsParentSegment(value)) {
    throw new TypeError("extension_module_path_escape_not_allowed")
  }
  return path.resolve(configDirectory, value)
}

async function assertRegularFileWithoutSymlinks(absolutePath: string): Promise<void> {
  const parsed = path.parse(absolutePath)
  let current = parsed.root
  for (const segment of absolutePath.slice(parsed.root.length).split(path.sep)) {
    if (!segment) continue
    current = path.join(current, segment)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) {
      throw new TypeError("extension_module_symlink_not_allowed")
    }
  }
  const stat = await lstat(absolutePath)
  if (!stat.isFile()) throw new TypeError("extension_module_must_be_a_file")
}

export async function loadAllowedComponentModules(
  registry: RuntimeComponentRegistry,
  {
    configDirectory,
    modules = [],
    moduleAllowlist = [],
  }: ModuleLoadOptions,
): Promise<RuntimeComponentRegistry> {
  if (!(registry instanceof RuntimeComponentRegistry)) {
    throw new TypeError("runtime_component_registry_required")
  }
  if (!Array.isArray(modules) || !Array.isArray(moduleAllowlist)) {
    throw new TypeError("extension_modules_and_allowlist_must_be_arrays")
  }
  const allowed = new Set(
    moduleAllowlist.map((entry) => {
      if (typeof entry !== "string" || !path.isAbsolute(entry)) {
        throw new TypeError("extension_allowlist_paths_must_be_absolute")
      }
      return path.normalize(entry)
    }),
  )

  for (const requested of modules) {
    const absolutePath = resolveRequestedModule(configDirectory, requested)
    if (!allowed.has(path.normalize(absolutePath))) {
      throw new TypeError("extension_module_not_allowlisted")
    }
    await assertRegularFileWithoutSymlinks(absolutePath)
    const extension = await import(pathToFileURL(absolutePath).href) as unknown
    if (
      !extension ||
      typeof extension !== "object" ||
      !("register" in extension) ||
      typeof extension.register !== "function"
    ) {
      throw new TypeError("extension_module_must_export_register")
    }
    await extension.register(registry)
  }
  return registry
}
