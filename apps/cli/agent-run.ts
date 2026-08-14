import { randomUUID } from "node:crypto"
import { Ajv2020 } from "ajv/dist/2020.js"

import {
  assessAgentHostCompatibility,
} from "../../packages/core/src/agent-host.js"
import { validateAgentHostProbeResult } from "../../packages/core/src/agent-host-registry.js"
import type { AgentHostRegistryPort } from "../../packages/core/src/agent-host-registry.js"
import {
  deriveEffectiveAgentHostPolicy,
  deriveEmployeeHostRequirements,
} from "../../packages/core/src/employee-package.js"
import type {
  AgentHostEvent,
  AgentHostMcpServer,
  AgentHostProbeResult,
  AgentHostRunRequest,
} from "../../packages/core/src/agent-host.js"
import { CoreError } from "../../packages/core/src/contracts.js"
import type { SafeValue } from "../../packages/core/src/contracts.js"
import { builtInAgentHostRegistry } from "./agent-host-registry.js"
import {
  computeEmployeePackageDirectoryDigest,
  inspectEmployeePackage,
} from "./employee-package.js"

export const EMPLOYEE_RUN_SCHEMA_VERSION = "employee-run.v1alpha1" as const

export type EmployeeRunResult =
  | {
      schemaVersion: typeof EMPLOYEE_RUN_SCHEMA_VERSION
      status: "completed"
      runId: string
      employee: { name: string; version: string }
      engine: string
      output: SafeValue
    }
  | {
      schemaVersion: typeof EMPLOYEE_RUN_SCHEMA_VERSION
      status: "failed"
      runId: string
      employee: { name: string; version: string }
      engine: string
      error: { code: string; message: string; retryable: boolean }
      issues?: Array<{ code: string }>
    }

export interface RunEmployeePackageOptions {
  directory: string
  engine: string
  /** Trusted operator registry; employee packages can never supply this. */
  hostRegistry?: AgentHostRegistryPort
  input: unknown
  runId?: string
  /** Fail closed if the exact local declared package bytes do not match. */
  expectedPackageDigest?: string
  deadline?: string
  signal?: AbortSignal
  /**
   * Keep the caller's lifecycle open until an aborted Host preflight settles.
   * Managed HTTP uses this barrier so an uncancellable version probe cannot
   * escape its admission and shutdown accounting. Lease-driven runners leave
   * it disabled so an untrusted custom adapter cannot block local settlement.
   */
  waitForPreflightCleanupOnAbort?: boolean
  onEvent?: (event: AgentHostEvent) => void | Promise<void>
}

export interface InspectEmployeeHostCompatibilityOptions {
  directory: string
  engine: string
  /** Trusted operator registry; employee packages can never supply this. */
  hostRegistry?: AgentHostRegistryPort
}

function invalidPreflightIdentity(expectedHostId: string): CoreError {
  return new CoreError(
    "AGENT_HOST_PREFLIGHT_INVALID",
    `agent host ${expectedHostId} returned preflight data for a different host`,
    {
      status: 500,
      retryable: false,
      details: { hostId: expectedHostId },
    },
  )
}

function hostInspectionFailure(
  code:
    | "AGENT_HOST_ADAPTER_RESOLUTION_FAILED"
    | "AGENT_HOST_PREFLIGHT_FAILED"
    | "AGENT_HOST_PROBE_FAILED",
  expectedHostId: string,
): CoreError {
  return new CoreError(
    code,
    `agent host ${expectedHostId} could not be inspected safely`,
    {
      status: 500,
      retryable: false,
      details: { hostId: expectedHostId },
    },
  )
}

async function cancelAdapterSafely(
  adapter: { cancel?(runId: string): Promise<void> },
  runId: string,
): Promise<void> {
  if (!adapter.cancel) return
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      adapter.cancel(runId),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 500)
        timeout.unref()
      }),
    ])
  } catch {
    // The outer result remains failed. Adapter cleanup failures must not turn
    // a fail-closed result into an unhandled rejection.
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function disposeAdapterSafely(adapter: unknown): Promise<void> {
  const disposable = adapter as { dispose?: () => Promise<void> } | undefined
  if (!disposable || typeof disposable.dispose !== "function") return
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      disposable.dispose(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 1_000)
        timeout.unref()
      }),
    ])
  } catch {
    // The run result is already settled; cleanup must not replace it.
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

type AbortableResult<T> =
  | { status: "resolved"; value: T }
  | { status: "rejected" }
  | { status: "aborted" }

/** Settles locally even when a trusted Host operation ignores AbortSignal. */
async function settleAbortably<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<AbortableResult<T>> {
  const settled = operation.then(
    (value): AbortableResult<T> => ({ status: "resolved", value }),
    (): AbortableResult<T> => ({ status: "rejected" }),
  )
  if (!signal) return settled
  if (signal.aborted) return { status: "aborted" }
  let onAbort: (() => void) | undefined
  const aborted = new Promise<AbortableResult<T>>((resolve) => {
    onAbort = () => resolve({ status: "aborted" })
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([settled, aborted])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

const TERMINAL_ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/

function validTerminalEvent(
  value: unknown,
  expectedRunId: string,
): value is Extract<
  AgentHostEvent,
  { type: "run.completed" | "run.failed" }
> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  if (
    event.runId !== expectedRunId ||
    typeof event.timestamp !== "string" ||
    !Number.isFinite(Date.parse(event.timestamp))
  ) {
    return false
  }
  if (event.type === "run.completed") {
    return Object.prototype.hasOwnProperty.call(event, "output")
  }
  if (event.type !== "run.failed") return false
  const error = event.error
  if (!error || typeof error !== "object" || Array.isArray(error)) return false
  const fields = error as Record<string, unknown>
  return (
    typeof fields.code === "string" &&
    TERMINAL_ERROR_CODE_PATTERN.test(fields.code) &&
    typeof fields.message === "string" &&
    fields.message.length <= 2_000 &&
    typeof fields.retryable === "boolean"
  )
}

function failed(
  options: {
    runId: string
    employee: { name: string; version: string }
    engine: string
  },
  code: string,
  retryable = false,
  issues?: Array<{ code: string }>,
): EmployeeRunResult {
  return {
    schemaVersion: EMPLOYEE_RUN_SCHEMA_VERSION,
    status: "failed",
    ...options,
    error: {
      code,
      message: "The digital employee run could not be completed safely",
      retryable,
    },
    ...(issues?.length ? { issues } : {}),
  }
}

function compileValidator(schema: Record<string, unknown>) {
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: false,
    validateSchema: true,
  })
  const validate = ajv.compile(schema)
  if ("$async" in validate && validate.$async === true) {
    throw new TypeError("employee_async_json_schema_unsupported")
  }
  return validate
}

function asSafeValue(value: unknown): SafeValue {
  // Package input/schema values were parsed from JSON. Round-tripping creates
  // an inert JSON tree and prevents prototype-bearing caller objects from
  // crossing into a host adapter.
  return JSON.parse(JSON.stringify(value)) as SafeValue
}

function toAgentHostMcpServers(
  inspection: Awaited<ReturnType<typeof inspectEmployeePackage>>,
): AgentHostMcpServer[] | undefined {
  const servers = inspection.artifacts.mcp?.servers.map((server) => {
    if (server.transport.type === "stdio") {
      return {
        name: server.name,
        transport: "stdio" as const,
        command: server.transport.command,
        args: [...server.transport.args],
        environment: [...server.transport.environment],
      }
    }
    return {
      name: server.name,
      transport: "http" as const,
      url: server.transport.url,
      headers: server.transport.headers.map((header) => ({ ...header })),
    }
  })
  return servers?.length ? servers : undefined
}

function buildAgentHostRunRequest(
  inspection: Awaited<ReturnType<typeof inspectEmployeePackage>>,
  options: {
    runId: string
    prompt: string
    deadline?: string
    signal?: AbortSignal
  },
): AgentHostRunRequest {
  const mcpServers = toAgentHostMcpServers(inspection)
  return {
    runId: options.runId,
    employeeId: inspection.manifest.name,
    workingDirectory: inspection.directory,
    workspaceFiles: [...inspection.manifest.assets],
    prompt: options.prompt,
    instructions: inspection.artifacts.skill,
    session: { mode: "new" },
    ...(mcpServers ? { mcpServers } : {}),
    outputSchema: asSafeValue(inspection.artifacts.outputSchema),
    policy: deriveEffectiveAgentHostPolicy(inspection.manifest),
    ...(options.deadline ? { deadline: options.deadline } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }
}

/** Package-aware and model-free host validation used by `validate --engine`. */
export async function inspectEmployeeHostCompatibility(
  options: InspectEmployeeHostCompatibilityOptions,
) {
  const inspection = await inspectEmployeePackage(options.directory)
  const registry = options.hostRegistry ?? builtInAgentHostRegistry
  const engine = registry.resolve(options.engine)
  let adapter
  try {
    adapter = registry.hasAdapter(engine)
      ? await registry.create(engine)
      : undefined
  } catch {
    throw hostInspectionFailure(
      "AGENT_HOST_ADAPTER_RESOLUTION_FAILED",
      engine,
    )
  }
  let host: AgentHostProbeResult
  if (adapter) {
    try {
      host = await adapter.preflight(
        buildAgentHostRunRequest(inspection, {
          runId: `validate-${randomUUID()}`,
          prompt: "Validate this employee package without starting a model run.",
        }),
      )
    } catch {
      throw hostInspectionFailure("AGENT_HOST_PREFLIGHT_FAILED", engine)
    } finally {
      await disposeAdapterSafely(adapter)
    }
  } else {
    try {
      host = await registry.probe(engine)
    } catch {
      throw hostInspectionFailure("AGENT_HOST_PROBE_FAILED", engine)
    }
  }
  try {
    host = validateAgentHostProbeResult(host, engine)
  } catch {
    throw invalidPreflightIdentity(engine)
  }
  const compatibility = assessAgentHostCompatibility(
    host,
    deriveEmployeeHostRequirements(inspection.manifest),
  )
  return { inspection, host, compatibility }
}

export async function runEmployeePackage(
  options: RunEmployeePackageOptions,
): Promise<EmployeeRunResult> {
  const inspection = await inspectEmployeePackage(options.directory)
  const runId = options.runId ?? `run-${randomUUID()}`
  const registry = options.hostRegistry ?? builtInAgentHostRegistry
  let engine = options.engine
  let registered = true
  try {
    engine = registry.resolve(options.engine)
  } catch {
    registered = false
  }
  const identity = {
    runId,
    employee: {
      name: inspection.manifest.name,
      version: inspection.manifest.version,
    },
    engine,
  }

  const packageDigestMatches = async (): Promise<boolean> => {
    if (!options.expectedPackageDigest) return true
    if (!/^sha256:[a-f0-9]{64}$/.test(options.expectedPackageDigest)) {
      return false
    }
    try {
      return (
        (await computeEmployeePackageDirectoryDigest(inspection.directory)) ===
        options.expectedPackageDigest
      )
    } catch {
      return false
    }
  }
  if (!(await packageDigestMatches())) {
    return failed(identity, "employee_package_digest_mismatch")
  }

  let validateInput: ReturnType<typeof compileValidator>
  try {
    validateInput = compileValidator(inspection.artifacts.inputSchema)
  } catch {
    return failed(identity, "employee_input_schema_invalid")
  }
  if (validateInput(options.input) !== true) {
    return failed(identity, "employee_input_schema_mismatch")
  }

  if (!registered) return failed(identity, "agent_host_not_registered")
  let runnable: boolean
  try {
    runnable = registry.hasAdapter(engine)
  } catch {
    return failed(identity, "agent_host_adapter_resolution_failed")
  }
  if (!runnable) {
    return failed(identity, "agent_host_adapter_not_runnable")
  }
  let adapter
  try {
    adapter = await registry.create(engine)
  } catch {
    return failed(identity, "agent_host_adapter_resolution_failed")
  }
  try {
  let input: SafeValue
  try {
    input = asSafeValue(options.input)
  } catch {
    return failed(identity, "employee_input_not_json")
  }
  const request = buildAgentHostRunRequest(inspection, {
    runId,
    prompt: `Complete this employee task. Task input JSON:\n${JSON.stringify(input)}`,
    ...(options.deadline ? { deadline: options.deadline } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const publishEvent = async (
    event: AgentHostEvent,
  ): Promise<AbortableResult<void>> => {
    if (!options.onEvent) return { status: "resolved", value: undefined }
    try {
      return await settleAbortably(
        Promise.resolve(options.onEvent(event)),
        options.signal,
      )
    } catch {
      return { status: "rejected" }
    }
  }

  let preflight: AgentHostProbeResult
  if (options.signal?.aborted) {
    await cancelAdapterSafely(adapter, runId)
    return failed(identity, "agent_host_cancelled", true)
  }
  let preflightResult: AbortableResult<AgentHostProbeResult>
  let preflightOperation: Promise<AgentHostProbeResult>
  try {
    preflightOperation = adapter.preflight(request)
    preflightResult = await settleAbortably(
      preflightOperation,
      options.signal,
    )
  } catch {
    return failed(identity, "agent_host_preflight_failed", true)
  }
  if (preflightResult.status === "aborted") {
    await cancelAdapterSafely(adapter, runId)
    if (options.waitForPreflightCleanupOnAbort) {
      try {
        await preflightOperation
      } catch {
        // The cancelled result is already fail-closed. Waiting here is only a
        // lifecycle barrier for the owner of the admission slot.
      }
    }
    return failed(identity, "agent_host_cancelled", true)
  }
  if (preflightResult.status === "rejected") {
    return failed(identity, "agent_host_preflight_failed", true)
  }
  preflight = preflightResult.value
  try {
    preflight = validateAgentHostProbeResult(preflight, engine)
  } catch {
    return failed(identity, "agent_host_preflight_invalid")
  }
  const compatibility = assessAgentHostCompatibility(
    preflight,
    deriveEmployeeHostRequirements(inspection.manifest),
  )
  if (!compatibility.compatible) {
    return failed(
      identity,
      "agent_host_incompatible",
      false,
      compatibility.issues
        .filter((entry) => entry.blocking)
        .map((entry) => ({ code: entry.code })),
    )
  }

  // Preflight is operator-trusted code, but a successful remotely-receipted
  // run must still execute the exact publisher package accepted above.
  if (!(await packageDigestMatches())) {
    return failed(identity, "employee_package_digest_mismatch")
  }

  let terminal: Extract<
    AgentHostEvent,
    { type: "run.completed" | "run.failed" }
  > | undefined
  let streamInvalid = false
  let removeAbortListener: (() => void) | undefined
  try {
    const iterator = adapter.run(request)[Symbol.asyncIterator]()
    const abortResult = { kind: "aborted" as const }
    const abortPromise = options.signal
      ? new Promise<typeof abortResult>((resolve) => {
          const onAbort = () => resolve(abortResult)
          if (options.signal!.aborted) {
            resolve(abortResult)
          } else {
            options.signal!.addEventListener("abort", onAbort, { once: true })
            removeAbortListener = () =>
              options.signal!.removeEventListener("abort", onAbort)
          }
        })
      : undefined
    while (true) {
      const nextPromise = Promise.resolve(iterator.next()).then(
        (result) => ({ kind: "event" as const, result }),
        () => ({ kind: "stream_error" as const }),
      )
      const next = abortPromise
        ? await Promise.race([nextPromise, abortPromise])
        : await nextPromise
      if (next.kind === "aborted") {
        await cancelAdapterSafely(adapter, runId)
        try {
          // Await the generator's finally block: built-in adapters reap their
          // process group and remove credential-bearing run roots there. The
          // request must remain active until that cleanup has completed.
          await iterator.return?.()
        } catch {
          // The cancelled result is already fail-closed.
        }
        return failed(identity, "agent_host_cancelled", true)
      }
      if (next.kind === "stream_error") throw new Error("agent_host_stream_failed")
      if (next.result.done) break
      const event = next.result.value
      if (
        event.runId !== runId ||
        !Number.isFinite(Date.parse(event.timestamp)) ||
        terminal
      ) {
        streamInvalid = true
        await cancelAdapterSafely(adapter, runId)
        break
      }
      if (event.type === "run.completed" || event.type === "run.failed") {
        if (!validTerminalEvent(event, runId)) {
          streamInvalid = true
          await cancelAdapterSafely(adapter, runId)
          break
        }
        terminal = event
        continue
      }
      const publication = await publishEvent(event)
      if (publication.status === "aborted") {
        await cancelAdapterSafely(adapter, runId)
        try {
          await iterator.return?.()
        } catch {
          // The cancelled result is already fail-closed.
        }
        return failed(identity, "agent_host_cancelled", true)
      }
      if (publication.status === "rejected") {
        throw new Error("agent_host_event_handler_failed")
      }
    }
  } catch {
    await cancelAdapterSafely(adapter, runId)
    return failed(identity, "agent_host_stream_failed", true)
  } finally {
    removeAbortListener?.()
  }

  if (streamInvalid || !terminal) {
    return failed(identity, "agent_host_terminal_contract_violated")
  }
  if (!(await packageDigestMatches())) {
    return failed(identity, "employee_package_digest_mismatch")
  }
  if (terminal.type === "run.failed") {
    const publication = await publishEvent(terminal)
    if (publication.status === "aborted") {
      await cancelAdapterSafely(adapter, runId)
      return failed(identity, "agent_host_cancelled", true)
    }
    if (publication.status === "rejected") {
      return failed(identity, "agent_host_event_handler_failed", true)
    }
    return failed(
      identity,
      terminal.error.code,
      terminal.error.retryable,
    )
  }

  try {
    const validateOutput = compileValidator(inspection.artifacts.outputSchema)
    if (validateOutput(terminal.output) !== true) {
      return failed(identity, "employee_output_schema_mismatch")
    }
  } catch {
    return failed(identity, "employee_output_schema_invalid")
  }

  const publication = await publishEvent(terminal)
  if (publication.status === "aborted") {
    await cancelAdapterSafely(adapter, runId)
    return failed(identity, "agent_host_cancelled", true)
  }
  if (publication.status === "rejected") {
    return failed(identity, "agent_host_event_handler_failed", true)
  }

  return {
    schemaVersion: EMPLOYEE_RUN_SCHEMA_VERSION,
    status: "completed",
    ...identity,
    output: terminal.output,
  }
  } finally {
    await disposeAdapterSafely(adapter)
  }
}
