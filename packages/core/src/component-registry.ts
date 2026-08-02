import { ValidationError, assertPlainObject } from "./contracts.js"
import type { UnknownRecord } from "./contracts.js"
import {
  validateProfileManifest,
} from "./profile-manifest.js"
import type { EmployeeProfileManifest } from "./profile-manifest.js"

export type RuntimeComponentKind =
  | "profile"
  | "source"
  | "model"
  | "channel"
  | "tool"

export interface RuntimeProfileComponent extends UnknownRecord {
  id: string
  instructions: string
  readOnly: boolean
}

export interface RuntimeSourceComponent {
  load: () => unknown[] | Promise<unknown[]>
}

export interface RuntimeModelComponent {
  generate: (input?: unknown) => unknown | Promise<unknown>
}

export interface RuntimeChannelMessage {
  id: string
  threadId: string
  actorId?: string
  text: string
  channel?: string
}

export interface RuntimeChannelComponent {
  start: (
    handler: (message: RuntimeChannelMessage) => unknown | Promise<unknown>,
  ) => unknown | Promise<unknown>
  stop: () => unknown | Promise<unknown>
  reply?: (message: RuntimeChannelMessage, result: unknown) => unknown | Promise<unknown>
}

export interface RuntimeToolComponent {
  mode: "read" | "write"
  execute: (input?: unknown) => unknown | Promise<unknown>
}

export interface RuntimeComponentMap {
  profile: RuntimeProfileComponent
  source: RuntimeSourceComponent
  model: RuntimeModelComponent
  channel: RuntimeChannelComponent
  tool: RuntimeToolComponent
}

export interface RuntimeComponentContext extends UnknownRecord {
  config?: UnknownRecord
  configDirectory?: string
  environment?: NodeJS.ProcessEnv
}

export interface RuntimeComponentMetadata extends UnknownRecord {
  manifest?: EmployeeProfileManifest
}

export type RuntimeComponentFactory<K extends RuntimeComponentKind> = (
  context: RuntimeComponentContext,
  metadata: RuntimeComponentMetadata,
) => unknown | Promise<unknown>

interface RegistryEntry<K extends RuntimeComponentKind = RuntimeComponentKind> {
  factory: RuntimeComponentFactory<K>
  metadata: RuntimeComponentMetadata
}

const KINDS: readonly RuntimeComponentKind[] = Object.freeze([
  "profile",
  "source",
  "model",
  "channel",
  "tool",
])
const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/

function isComponentKind(value: unknown): value is RuntimeComponentKind {
  return typeof value === "string" && KINDS.includes(value as RuntimeComponentKind)
}

function validateIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new ValidationError(`invalid_component_identifier:${label}`)
  }
  return value
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)

  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor && "value" in descriptor) {
      deepFreeze(descriptor.value, seen)
    }
  }
  Object.freeze(object)
  return value
}

function validateInstance<K extends RuntimeComponentKind>(
  kind: K,
  id: string,
  instance: unknown,
): RuntimeComponentMap[K] {
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
    throw new ValidationError(`invalid_${kind}_component:${id}`)
  }
  const value = instance as UnknownRecord
  if (kind === "profile") {
    if (
      typeof value.id !== "string" ||
      typeof value.instructions !== "string" ||
      typeof value.readOnly !== "boolean"
    ) {
      throw new ValidationError(`invalid_profile_component:${id}`)
    }
  } else if (kind === "source" && typeof value.load !== "function") {
    throw new ValidationError(`invalid_source_component:${id}`)
  } else if (kind === "model" && typeof value.generate !== "function") {
    throw new ValidationError(`invalid_model_component:${id}`)
  } else if (
    kind === "channel" &&
    (typeof value.start !== "function" || typeof value.stop !== "function")
  ) {
    throw new ValidationError(`invalid_channel_component:${id}`)
  } else if (
    kind === "tool" &&
    (typeof value.execute !== "function" ||
      (value.mode !== "read" && value.mode !== "write"))
  ) {
    throw new ValidationError(`invalid_tool_component:${id}`)
  }
  return instance as RuntimeComponentMap[K]
}

export class RuntimeComponentRegistry {
  #components: Map<RuntimeComponentKind, Map<string, RegistryEntry>>

  constructor() {
    this.#components = new Map(
      KINDS.map((kind) => [kind, new Map<string, RegistryEntry>()]),
    )
  }

  register<K extends RuntimeComponentKind>(
    kind: K,
    id: string,
    factory: RuntimeComponentFactory<K>,
    metadata: RuntimeComponentMetadata = {},
  ): this {
    if (!isComponentKind(kind)) {
      throw new ValidationError(`unsupported_component_kind:${String(kind)}`)
    }
    const identifier = validateIdentifier(id, kind)
    if (typeof factory !== "function") {
      throw new ValidationError(`component_factory_required:${kind}:${identifier}`)
    }
    assertPlainObject(metadata, "component metadata")
    const collection = this.#components.get(kind)
    if (!collection) throw new ValidationError(`unsupported_component_kind:${kind}`)
    if (collection.has(identifier)) {
      throw new ValidationError(`duplicate_component:${kind}:${identifier}`)
    }

    let normalizedMetadata = structuredClone(metadata) as RuntimeComponentMetadata
    if (kind === "profile") {
      const manifest = validateProfileManifest(metadata.manifest)
      if (manifest.name !== identifier) {
        throw new ValidationError(
          `profile_manifest_name_mismatch:${identifier}:${manifest.name}`,
        )
      }
      normalizedMetadata = { ...normalizedMetadata, manifest }
    }
    collection.set(identifier, {
      factory: factory as RuntimeComponentFactory<RuntimeComponentKind>,
      metadata: deepFreeze(normalizedMetadata),
    })
    return this
  }

  has(kind: RuntimeComponentKind, id: string): boolean {
    return this.#components.get(kind)?.has(id) ?? false
  }

  list(kind: RuntimeComponentKind): readonly string[] {
    if (!isComponentKind(kind)) {
      throw new ValidationError(`unsupported_component_kind:${String(kind)}`)
    }
    return Object.freeze([...(this.#components.get(kind)?.keys() ?? [])].sort())
  }

  metadata(kind: RuntimeComponentKind, id: string): RuntimeComponentMetadata {
    const entry = this.#components.get(kind)?.get(id)
    if (!entry) {
      throw new ValidationError(
        `unsupported_component:${kind}:${String(id || "missing")}`,
      )
    }
    return entry.metadata
  }

  async create<K extends RuntimeComponentKind>(
    kind: K,
    id: string,
    context: RuntimeComponentContext = {},
  ): Promise<RuntimeComponentMap[K]> {
    const entry = this.#components.get(kind)?.get(id)
    if (!entry) {
      throw new ValidationError(
        `unsupported_component:${kind}:${String(id || "missing")}`,
      )
    }
    const instance = await entry.factory(context, entry.metadata)
    return validateInstance(kind, id, instance)
  }
}
