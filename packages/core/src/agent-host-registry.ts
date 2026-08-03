import { CoreError } from "./contracts.js"
import { AGENT_HOST_CAPABILITIES } from "./agent-host.js"
import type {
  AgentHostAdapter,
  AgentHostProbeResult,
} from "./agent-host.js"

const AGENT_HOST_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/

export type AgentHostAdapterFactory =
  () => AgentHostAdapter | Promise<AgentHostAdapter>

export interface AgentHostRegistration {
  readonly id: string
  readonly aliases?: readonly string[]
  readonly probe: () => Promise<AgentHostProbeResult>
  readonly createAdapter?: AgentHostAdapterFactory
}

/**
 * Structural registry boundary used by runners and embedders.
 *
 * Keeping the consumer-facing port free of private class fields lets the root
 * package interoperate with the separately published core package without
 * creating two incompatible nominal `AgentHostRegistry` identities.
 */
export interface AgentHostRegistryPort {
  resolve(hostId: string): string
  hasAdapter(hostId: string): boolean
  probe(hostId: string): Promise<AgentHostProbeResult>
  create(hostId: string): Promise<AgentHostAdapter>
}

interface StoredAgentHostRegistration {
  readonly id: string
  readonly aliases: readonly string[]
  readonly probe: () => Promise<AgentHostProbeResult>
  readonly createAdapter?: AgentHostAdapterFactory
}

function registryError(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): CoreError {
  return new CoreError(code, message, {
    status,
    retryable: false,
    details,
  })
}

function validateAgentHostId(value: unknown, field: string): string {
  if (typeof value !== "string" || !AGENT_HOST_ID_PATTERN.test(value)) {
    throw registryError(
      "INVALID_AGENT_HOST_ID",
      `${field} must be a lowercase ASCII identifier of 1 to 128 characters`,
      400,
      { field },
    )
  }
  return value
}

function validateRegistration(
  value: AgentHostRegistration,
): StoredAgentHostRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw registryError(
      "INVALID_AGENT_HOST_REGISTRATION",
      "agent host registration must be an object",
      400,
    )
  }

  const id = validateAgentHostId(value.id, "registration.id")
  if (typeof value.probe !== "function") {
    throw registryError(
      "INVALID_AGENT_HOST_REGISTRATION",
      `agent host ${id} must provide a probe function`,
      400,
      { hostId: id, field: "registration.probe" },
    )
  }
  if (
    value.createAdapter !== undefined &&
    typeof value.createAdapter !== "function"
  ) {
    throw registryError(
      "INVALID_AGENT_HOST_REGISTRATION",
      `agent host ${id} createAdapter must be a function when provided`,
      400,
      { hostId: id, field: "registration.createAdapter" },
    )
  }
  if (value.aliases !== undefined && !Array.isArray(value.aliases)) {
    throw registryError(
      "INVALID_AGENT_HOST_REGISTRATION",
      `agent host ${id} aliases must be an array when provided`,
      400,
      { hostId: id, field: "registration.aliases" },
    )
  }

  const aliases = Object.freeze(
    [...(value.aliases ?? [])]
      .map((alias, index) =>
        validateAgentHostId(alias, `registration.aliases[${index}]`),
      )
      .sort(),
  )

  return Object.freeze({
    id,
    aliases,
    probe: value.probe,
    ...(value.createAdapter
      ? { createAdapter: value.createAdapter }
      : {}),
  })
}

const PROBE_STATUSES = new Set([
  "installed",
  "ready",
  "not_ready",
  "not_found",
  "probe_failed",
])
const ADAPTER_STATUSES = new Set(["probe_only", "runnable"])
const CAPABILITY_SOURCES = new Set([
  "adapter_declaration",
  "conformance_test",
])
const CAPABILITY_SUPPORT = new Set([
  "supported",
  "documented",
  "unsupported",
  "unknown",
])

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function boundedString(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
}

/** Validates the complete runtime shape returned by a trusted host adapter. */
export function validateAgentHostProbeResult(
  value: unknown,
  expectedHostId: string,
): AgentHostProbeResult {
  let valid = false
  try {
    if (plainRecord(value)) {
      const capabilities = value.capabilities
      const issues = value.issues
      valid =
        boundedString(value.protocolVersion, 64) &&
        value.hostId === expectedHostId &&
        boundedString(value.displayName, 256) &&
        PROBE_STATUSES.has(value.status as string) &&
        typeof value.available === "boolean" &&
        ADAPTER_STATUSES.has(value.adapterStatus as string) &&
        (value.version === undefined || boundedString(value.version, 256)) &&
        plainRecord(capabilities) &&
        AGENT_HOST_CAPABILITIES.every((capability) =>
          CAPABILITY_SUPPORT.has(capabilities[capability] as string),
        ) &&
        CAPABILITY_SOURCES.has(value.capabilitySource as string) &&
        Array.isArray(issues) &&
        issues.length <= 256 &&
        issues.every(
          (entry) =>
            plainRecord(entry) &&
            boundedString(entry.code, 128) &&
            boundedString(entry.message, 2_000, true) &&
            typeof entry.blocking === "boolean",
        )
    }
  } catch {
    valid = false
  }

  if (!valid) {
    throw registryError(
      "AGENT_HOST_PROBE_INVALID",
      `agent host ${expectedHostId} returned an invalid probe result`,
      500,
      { hostId: expectedHostId },
    )
  }
  return value as unknown as AgentHostProbeResult
}

function validateAdapterIdentity(
  value: AgentHostAdapter,
  expectedHostId: string,
): AgentHostAdapter {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.hostId !== expectedHostId ||
    typeof value.probe !== "function" ||
    typeof value.preflight !== "function" ||
    typeof value.run !== "function" ||
    (value.respondToApproval !== undefined &&
      typeof value.respondToApproval !== "function") ||
    (value.cancel !== undefined && typeof value.cancel !== "function")
  ) {
    throw registryError(
      "AGENT_HOST_ADAPTER_INVALID",
      `agent host ${expectedHostId} factory returned an invalid adapter`,
      500,
      { hostId: expectedHostId },
    )
  }
  return value
}

/**
 * An explicit, in-memory registry for Agent host adapters.
 *
 * The registry never discovers adapters, loads modules, or launches processes.
 * Registration is atomic and identifiers can never shadow an existing ID or
 * alias. Adapter lifecycle and probe side effects remain owned by the
 * explicitly supplied callbacks.
 */
export class AgentHostRegistry implements AgentHostRegistryPort {
  readonly #registrations = new Map<string, StoredAgentHostRegistration>()
  readonly #identifiers = new Map<string, string>()

  register(registration: AgentHostRegistration): this {
    const normalized = validateRegistration(registration)
    const claimedIdentifiers = [normalized.id, ...normalized.aliases]
    const localIdentifiers = new Set<string>()

    for (const identifier of claimedIdentifiers) {
      const existingHostId =
        localIdentifiers.has(identifier)
          ? normalized.id
          : this.#identifiers.get(identifier)
      if (existingHostId !== undefined) {
        throw registryError(
          "AGENT_HOST_IDENTIFIER_CONFLICT",
          `agent host identifier ${identifier} is already registered`,
          409,
          {
            identifier,
            existingHostId,
            requestedHostId: normalized.id,
          },
        )
      }
      localIdentifiers.add(identifier)
    }

    this.#registrations.set(normalized.id, normalized)
    for (const identifier of claimedIdentifiers) {
      this.#identifiers.set(identifier, normalized.id)
    }
    return this
  }

  list(): readonly string[] {
    return Object.freeze([...this.#registrations.keys()].sort())
  }

  resolve(hostId: string): string {
    const identifier = validateAgentHostId(hostId, "hostId")
    const resolved = this.#identifiers.get(identifier)
    if (resolved === undefined) {
      throw registryError(
        "AGENT_HOST_NOT_REGISTERED",
        `agent host ${identifier} is not registered`,
        404,
        { hostId: identifier },
      )
    }
    return resolved
  }

  hasAdapter(hostId: string): boolean {
    const identifier = validateAgentHostId(hostId, "hostId")
    const canonicalId = this.#identifiers.get(identifier)
    if (canonicalId === undefined) return false
    return this.#registrations.get(canonicalId)?.createAdapter !== undefined
  }

  async probe(hostId: string): Promise<AgentHostProbeResult> {
    const registration = this.#registered(hostId)
    return validateAgentHostProbeResult(
      await registration.probe(),
      registration.id,
    )
  }

  async create(hostId: string): Promise<AgentHostAdapter> {
    const registration = this.#registered(hostId)
    if (!registration.createAdapter) {
      throw registryError(
        "AGENT_HOST_ADAPTER_NOT_RUNNABLE",
        `agent host ${registration.id} has no runnable adapter`,
        409,
        { hostId: registration.id },
      )
    }
    return validateAdapterIdentity(
      await registration.createAdapter(),
      registration.id,
    )
  }

  #registered(hostId: string): StoredAgentHostRegistration {
    const canonicalId = this.resolve(hostId)
    const registration = this.#registrations.get(canonicalId)
    if (!registration) {
      throw registryError(
        "AGENT_HOST_NOT_REGISTERED",
        `agent host ${canonicalId} is not registered`,
        404,
        { hostId: canonicalId },
      )
    }
    return registration
  }
}
