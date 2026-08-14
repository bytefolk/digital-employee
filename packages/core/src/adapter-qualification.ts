import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify, types as utilTypes } from "node:util"

import {
  AGENT_HOST_CAPABILITIES,
  AGENT_HOST_PROTOCOL_VERSION,
} from "./agent-host.js"
import type {
  AgentHostAdapter,
  AgentHostEvent,
  AgentHostPolicy,
  AgentHostProbeResult,
  AgentHostQualificationIdentity,
  AgentHostRunRequest,
} from "./agent-host.js"
import { CoreError } from "./contracts.js"

export const ADAPTER_QUALIFICATION_SCHEMA_ID =
  "adapter-qualification-record.v1" as const

export const ADAPTER_QUALIFICATION_KIT_VERSION = "1.1.0" as const
export const LEGACY_ADAPTER_QUALIFICATION_KIT_VERSION = "1.0.0" as const

export const ADAPTER_QUALIFICATION_DRIVER_SCHEMA_ID =
  "adapter-qualification-driver.v1" as const
export const QUALIFICATION_FILESYSTEM_DENIAL_CODE =
  "qualification_filesystem_policy_denied" as const
export const QUALIFICATION_NETWORK_DENIAL_CODE =
  "qualification_network_policy_denied" as const
export const QUALIFICATION_MCP_DENIAL_CODE =
  "qualification_mcp_policy_denied" as const

export const DEFAULT_QUALIFICATION_CASE_TIMEOUT_MS = 30_000
export const MIN_QUALIFICATION_CASE_TIMEOUT_MS = 1_000
export const MAX_QUALIFICATION_CASE_TIMEOUT_MS = 600_000

export const QUALIFICATION_CAPABILITY_SOURCES = [
  "adapter_declaration",
  "conformance_test",
] as const

export const QUALIFICATION_DOMAINS = [
  "capability_negotiation",
  "native_event_validation",
  "single_terminal_outcome",
  "deadline_cancel",
  "process_tree_cleanup",
  "credential_boundaries",
  "filesystem_network_enforcement",
  "tool_mcp_enforcement",
  "output_schema",
] as const

export type QualificationDomain = (typeof QUALIFICATION_DOMAINS)[number]

const LEGACY_QUALIFICATION_CASE_CONTRACT = [
  ["capability_negotiation", "probe_contract"],
  ["native_event_validation", "events_well_formed"],
  ["single_terminal_outcome", "exactly_one_terminal"],
  ["deadline_cancel", "cancel_stops_run"],
  ["process_tree_cleanup", "stream_terminates"],
  ["credential_boundaries", "no_metadata_echo"],
  ["filesystem_network_enforcement", "hostile_write_refused"],
  ["tool_mcp_enforcement", "tool_allowlist_respected"],
  ["output_schema", "terminal_output_matches_schema"],
] as const satisfies readonly (readonly [QualificationDomain, string])[]

const CURRENT_QUALIFICATION_CASE_CONTRACT = [
  ["capability_negotiation", "probe_contract"],
  ["native_event_validation", "events_well_formed"],
  ["single_terminal_outcome", "exactly_one_terminal"],
  ["deadline_cancel", "cancel_stops_active_run"],
  ["process_tree_cleanup", "descendants_disposed_normal"],
  ["process_tree_cleanup", "descendants_disposed_timeout"],
  ["process_tree_cleanup", "descendants_disposed_cancel"],
  ["credential_boundaries", "no_metadata_echo"],
  ["filesystem_network_enforcement", "hostile_write_refused"],
  ["filesystem_network_enforcement", "network_deny_refused"],
  ["tool_mcp_enforcement", "tool_allowlist_respected"],
  ["tool_mcp_enforcement", "mcp_deny_refused"],
  ["output_schema", "terminal_output_matches_schema"],
] as const satisfies readonly (readonly [QualificationDomain, string])[]

export type AdapterQualificationKitVersion =
  | typeof LEGACY_ADAPTER_QUALIFICATION_KIT_VERSION
  | typeof ADAPTER_QUALIFICATION_KIT_VERSION

export type QualificationDriverOperation =
  | {
      kind: "filesystem.write"
      path: "../qualification-denied/outside-scope"
    }
  | {
      kind: "network.connect"
      url: "https://qualification.invalid/"
    }
  | {
      kind: "mcp.invoke"
      server: "qualification-denied"
      tool: "qualification.noop"
    }
  | { kind: "lifecycle.wait_for_cancel" }
  | {
      kind: "process_tree"
      scenario: QualificationProcessTreeScenario
    }

export interface QualificationDriverMetadata {
  schema: typeof ADAPTER_QUALIFICATION_DRIVER_SCHEMA_ID
  operation: QualificationDriverOperation
}

export interface QualificationCaseResult {
  domain: QualificationDomain
  id: string
  passed: boolean
  /** Lowercase ASCII machine code describing the outcome. */
  code: string
}

export interface QualificationAxes {
  implemented: boolean
  fixtureConformant: boolean
  liveQualified: boolean
}

export interface QualificationLiveEvidence {
  environment: string
  evidenceDigest: string
}

export type QualificationProcessTreeScenario =
  | "normal"
  | "timeout"
  | "cancel"

export interface QualificationProcessTreeDescendants {
  childPid: number
  grandchildPid: number
}

/**
 * One deterministic, disposable process-backed fixture. It must return the
 * exact Adapter instance being qualified; only its descendants are disposed.
 * PIDs are inspected in memory only and never enter the qualification record.
 */
export interface QualificationProcessTreeFixtureInstance {
  adapter: AgentHostAdapter
  descendants(): Promise<QualificationProcessTreeDescendants>
  dispose(): Promise<void>
}

export interface QualificationProcessTreeFixture {
  create(
    scenario: QualificationProcessTreeScenario,
  ): Promise<QualificationProcessTreeFixtureInstance>
}

export interface AdapterQualificationRecord {
  schema: typeof ADAPTER_QUALIFICATION_SCHEMA_ID
  hostId: string
  hostVersion: string
  policyDigest: string
  kitVersion: AdapterQualificationKitVersion
  generatedAt: string
  axes: QualificationAxes
  domains: Record<QualificationDomain, { passed: number; failed: number }>
  cases: QualificationCaseResult[]
  liveEvidence?: QualificationLiveEvidence
}

export interface QualificationOptions {
  workingDirectory: string
  generatedAt: string
  requiredCapabilities?: readonly string[]
  /** Per-case wall clock bound. Defaults to 30 seconds. */
  caseTimeoutMs?: number
  /**
   * Required for truthful process_tree_cleanup evidence. Without a real
   * process-backed fixture, all cleanup scenarios fail closed.
   */
  processTreeFixture?: QualificationProcessTreeFixture
  /**
   * Explicit opt-in live evidence. Without it the live axis stays false and
   * no provider call is ever made by the kit.
   */
  liveEvidence?: QualificationLiveEvidence
}

const HOST_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/
const HEX_64_PATTERN = /^[0-9a-f]{64}$/
const CASE_ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const CASE_CODE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
const ENVIRONMENT_ID_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const CAPABILITY_SOURCE_SET = new Set<string>(
  QUALIFICATION_CAPABILITY_SOURCES,
)
const CAPABILITY_SUPPORT_SET = new Set([
  "supported",
  "documented",
  "unsupported",
  "unknown",
])

function qualificationError(
  code: string,
  message: string,
  details?: unknown,
): CoreError {
  return new CoreError(code, message, {
    status: 400,
    retryable: false,
    details,
  })
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")
    return `{${body}}`
  }
  return JSON.stringify(value)
}

export function canonicalPolicyDigest(policy: AgentHostPolicy): string {
  return createHash("sha256").update(canonicalJson(policy)).digest("hex")
}

function defaultQualificationPolicy(): AgentHostPolicy {
  return {
    tools: { default: "deny", allow: [{ name: "noop", mode: "read" }] },
    filesystem: { read: ["."], write: [] },
    network: { mode: "deny" },
    approval: { mode: "never" },
    maxTurns: 4,
  }
}

const QUALIFICATION_SENTINEL = "qualification-sentinel-do-not-leak"

const QUALIFICATION_SCAN_BUDGET = 4_096
const MAX_QUALIFICATION_CLEANUP_GRACE_MS = 5_000
const execFileAsync = promisify(execFile)

const NATIVE_ERROR_STACK_ACCESSOR_DESCRIPTORS = [
  new Error("qualification native stack probe"),
  new EvalError("qualification native stack probe"),
  new RangeError("qualification native stack probe"),
  new ReferenceError("qualification native stack probe"),
  new SyntaxError("qualification native stack probe"),
  new TypeError("qualification native stack probe"),
  new URIError("qualification native stack probe"),
  new AggregateError([], "qualification native stack probe"),
]
  .map((error) => Object.getOwnPropertyDescriptor(error, "stack"))
  .filter(
    (descriptor): descriptor is PropertyDescriptor =>
      descriptor !== undefined &&
      (typeof descriptor.get === "function" ||
        typeof descriptor.set === "function"),
  )

function isNativeErrorStackAccessor(
  key: PropertyKey,
  descriptor: PropertyDescriptor,
): boolean {
  if (key !== "stack" || descriptor.enumerable !== false) return false
  return NATIVE_ERROR_STACK_ACCESSOR_DESCRIPTORS.some(
    (nativeDescriptor) =>
      descriptor.get === nativeDescriptor.get &&
      descriptor.set === nativeDescriptor.set &&
      descriptor.enumerable === nativeDescriptor.enumerable &&
      descriptor.configurable === nativeDescriptor.configurable,
  )
}

type QualificationScanState = "clean" | "detected" | "incomplete"

class QualificationSentinelScanner {
  state: QualificationScanState = "clean"

  get detected(): boolean {
    return this.state === "detected"
  }

  get incomplete(): boolean {
    return this.state === "incomplete"
  }

  private markIncomplete(_reason: string): void {
    if (this.state !== "clean") return
    this.state = "incomplete"
  }

  observe(value: unknown): void {
    if (this.detected) return
    const seen = new Set<object>()
    const pending: unknown[] = [value]
    let inspected = 0
    while (pending.length > 0) {
      if (inspected >= QUALIFICATION_SCAN_BUDGET) {
        this.markIncomplete("budget")
        return
      }
      inspected += 1
      const entry = pending.pop()
      if (typeof entry === "string") {
        if (entry.includes(QUALIFICATION_SENTINEL)) {
          this.state = "detected"
          return
        }
        continue
      }
      if (
        entry === null ||
        (typeof entry !== "object" && typeof entry !== "function")
      ) {
        continue
      }
      const object = entry as object
      if (seen.has(object)) continue
      seen.add(object)
      if (utilTypes.isProxy(object)) {
        this.markIncomplete("proxy")
        continue
      }
      try {
        const keys = Reflect.ownKeys(object)
        for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(object, key)
          if (descriptor === undefined) {
            this.markIncomplete("missing descriptor")
            continue
          }
          if ("get" in descriptor || "set" in descriptor) {
            // Supported V8 releases install one shared lazy stack accessor.
            // Match the accessor functions captured from native Errors in this
            // realm; merely being an Error is not enough because callers can
            // replace `stack` with an arbitrary getter. Never invoke either.
            if (isNativeErrorStackAccessor(key, descriptor)) {
              continue
            }
            this.markIncomplete(`accessor ${String(key)}`)
            continue
          }
          if (typeof key === "string" && key.includes(QUALIFICATION_SENTINEL)) {
            this.state = "detected"
            return
          }
          if (
            typeof key === "symbol" &&
            (key.description ?? "").includes(QUALIFICATION_SENTINEL)
          ) {
            this.state = "detected"
            return
          }
          pending.push(descriptor.value)
        }
      } catch {
        // Never invoke accessors or custom serializers. Opaque values cannot
        // be proven clean and therefore fail closed.
        this.markIncomplete("descriptor inspection threw")
      }
    }
  }
}

interface TrackedQualificationRun {
  ownerAdapter: AgentHostAdapter
  runId: string
  cancelAttempted: boolean
  cancelPromise?: Promise<void>
}

interface QualificationCaseContext {
  readonly signal: AbortSignal
  readonly deadline: string
  readonly scanner: QualificationSentinelScanner
  remainingMs(): number
  abort(): void
  trackRun(ownerAdapter: AgentHostAdapter, runId: string): void
  cancelRun(ownerAdapter: AgentHostAdapter, runId: string): Promise<void>
  registerCleanup(cleanup: () => Promise<void> | void): void
}

type BoundedOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" }

type QualificationExecutionOutcome<T> = Exclude<
  BoundedOutcome<T>,
  { kind: "timeout" }
>

async function runBoundedCase<T>(
  caseTimeoutMs: number,
  scanner: QualificationSentinelScanner,
  fallback: (code: string) => T,
  body: (context: QualificationCaseContext) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()
  const deadlineAt = startedAt + caseTimeoutMs
  const controller = new AbortController()
  const trackedRuns: TrackedQualificationRun[] = []
  const cleanups: Array<() => Promise<void> | void> = []
  const cleanupErrors: unknown[] = []
  const cleanupPromises = new Map<
    () => Promise<void> | void,
    Promise<void>
  >()
  let finalizing = false
  let resourceGeneration = 0
  const resourceWaiters = new Set<() => void>()
  const signalResourceChange = (): void => {
    resourceGeneration += 1
    const waiters = [...resourceWaiters]
    resourceWaiters.clear()
    for (const resolve of waiters) resolve()
  }
  const waitForResourceChange = (
    observedGeneration: number,
  ): { promise: Promise<void>; cancel: () => void } => {
    let resolveWait: (() => void) | undefined
    const promise = new Promise<void>((resolve) => {
      if (resourceGeneration !== observedGeneration) {
        resolve()
        return
      }
      resolveWait = resolve
      resourceWaiters.add(resolve)
    })
    return {
      promise,
      cancel: () => {
        if (resolveWait) resourceWaiters.delete(resolveWait)
      },
    }
  }
  const findRun = (ownerAdapter: AgentHostAdapter, runId: string) =>
    trackedRuns.find(
      (entry) => entry.ownerAdapter === ownerAdapter && entry.runId === runId,
    )
  const startCancel = (tracked: TrackedQualificationRun): Promise<void> => {
    if (!tracked.cancelAttempted) {
      tracked.cancelAttempted = true
      tracked.cancelPromise = Promise.resolve().then(async () => {
        await tracked.ownerAdapter.cancel?.(tracked.runId)
      })
    }
    return tracked.cancelPromise ?? Promise.resolve()
  }
  const settleCancel = async (
    tracked: TrackedQualificationRun,
  ): Promise<void> => {
    try {
      await startCancel(tracked)
    } catch (error) {
      cleanupErrors.push(error)
      scanner.observe(error)
    }
  }
  const invokeCleanup = (
    cleanup: () => Promise<void> | void,
  ): Promise<void> => {
    let promise = cleanupPromises.get(cleanup)
    if (!promise) {
      try {
        promise = Promise.resolve(cleanup()).catch((error: unknown) => {
          cleanupErrors.push(error)
          scanner.observe(error)
        })
      } catch (error) {
        cleanupErrors.push(error)
        scanner.observe(error)
        promise = Promise.resolve()
      }
      cleanupPromises.set(cleanup, promise)
    }
    return promise
  }
  const context: QualificationCaseContext = {
    signal: controller.signal,
    deadline: new Date(deadlineAt).toISOString(),
    scanner,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    abort: () => controller.abort(),
    trackRun: (ownerAdapter, runId) => {
      if (!findRun(ownerAdapter, runId)) {
        const tracked = { ownerAdapter, runId, cancelAttempted: false }
        trackedRuns.push(tracked)
        signalResourceChange()
        if (finalizing) void settleCancel(tracked)
      }
    },
    cancelRun: async (ownerAdapter, runId) => {
      let tracked = findRun(ownerAdapter, runId)
      if (!tracked) {
        tracked = { ownerAdapter, runId, cancelAttempted: false }
        trackedRuns.push(tracked)
        signalResourceChange()
        if (finalizing) void settleCancel(tracked)
      }
      await startCancel(tracked)
    },
    registerCleanup: (cleanup) => {
      cleanups.push(cleanup)
      signalResourceChange()
      if (finalizing) void invokeCleanup(cleanup)
    },
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<BoundedOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), caseTimeoutMs)
  })
  const execution = Promise.resolve()
    .then(() => body(context))
    .then<QualificationExecutionOutcome<T>, QualificationExecutionOutcome<T>>(
      (value) => ({ kind: "value", value }),
      (error: unknown) => {
        scanner.observe(error)
        return { kind: "error", error }
      },
    )
  const outcome = await Promise.race([execution, timeout])
  if (timer !== undefined) clearTimeout(timer)
  let settledExecution = outcome.kind === "timeout" ? undefined : outcome
  const finalizer = async (): Promise<void> => {
    finalizing = true
    controller.abort()
    const processedRuns = new Set<TrackedQualificationRun>()
    const processedCleanups = new Set<() => Promise<void> | void>()
    while (true) {
      const pendingRuns = trackedRuns.filter(
        (entry) => !processedRuns.has(entry),
      )
      for (const tracked of pendingRuns) {
        processedRuns.add(tracked)
        await settleCancel(tracked)
      }

      const pendingCleanups = cleanups
        .filter((cleanup) => !processedCleanups.has(cleanup))
        .reverse()
      for (const cleanup of pendingCleanups) {
        processedCleanups.add(cleanup)
        await invokeCleanup(cleanup)
      }

      if (settledExecution === undefined) {
        const observedGeneration = resourceGeneration
        const resourceChange = waitForResourceChange(observedGeneration)
        const next = await Promise.race([
          execution.then((value) => ({ kind: "execution" as const, value })),
          resourceChange.promise.then(() => ({ kind: "resource" as const })),
        ])
        resourceChange.cancel()
        if (next.kind === "execution") settledExecution = next.value
        continue
      }
      if (
        trackedRuns.every((entry) => processedRuns.has(entry)) &&
        cleanups.every((cleanup) => processedCleanups.has(cleanup))
      ) {
        return
      }
    }
  }
  const cleanupGraceMs = Math.min(
    caseTimeoutMs,
    MAX_QUALIFICATION_CLEANUP_GRACE_MS,
  )
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  const cleanupTimeout = new Promise<"timeout">((resolve) => {
    cleanupTimer = setTimeout(() => resolve("timeout"), cleanupGraceMs)
  })
  const cleanupOutcome = await Promise.race([
    finalizer().then(() => "settled" as const),
    cleanupTimeout,
  ])
  if (cleanupTimer !== undefined) clearTimeout(cleanupTimer)
  if (cleanupOutcome === "timeout") {
    // A stuck cancel/return must not prevent process isolation. Invoke every
    // registered cleanup exactly once and give that emergency recovery its
    // own bounded grace before failing the entire suite.
    let isolationTimer: ReturnType<typeof setTimeout> | undefined
    const isolationTimeout = new Promise<void>((resolve) => {
      isolationTimer = setTimeout(resolve, cleanupGraceMs)
    })
    await Promise.race([
      Promise.all([
        ...trackedRuns.map(settleCancel),
        ...cleanups.slice().reverse().map(invokeCleanup),
      ]).then(() => undefined),
      isolationTimeout,
    ])
    if (isolationTimer !== undefined) clearTimeout(isolationTimer)
    throw qualificationError(
      "QUALIFICATION_CLEANUP_TIMEOUT",
      "qualification case cleanup did not settle within the bounded grace period",
    )
  }
  if (settledExecution?.kind === "error") {
    scanner.observe(settledExecution.error)
  }
  for (const error of cleanupErrors) scanner.observe(error)
  if (cleanupErrors.length > 0) {
    return fallback("qualification_cleanup_failed")
  }
  if (outcome.kind === "error") {
    return fallback("qualification_case_unavailable")
  }
  if (outcome.kind === "timeout") {
    return fallback("qualification_case_timeout")
  }
  return outcome.value
}

function qualificationRequest(
  ownerAdapter: AgentHostAdapter,
  caseId: string,
  workingDirectory: string,
  policy: AgentHostPolicy,
  context: QualificationCaseContext,
  overrides: Partial<AgentHostRunRequest> = {},
): AgentHostRunRequest {
  const runId = `qualification-${caseId}`
  context.trackRun(ownerAdapter, runId)
  return {
    runId,
    employeeId: "qualification-employee",
    workingDirectory,
    prompt: `qualification case ${caseId}`,
    policy,
    deadline: context.deadline,
    signal: context.signal,
    ...overrides,
  }
}

interface CollectedEvents {
  events: AgentHostEvent[]
  failed: boolean
  overflow: boolean
}

async function collectFromIterator(
  iterator: AsyncIterator<AgentHostEvent>,
  context: QualificationCaseContext,
  initial: AgentHostEvent[] = [],
): Promise<CollectedEvents> {
  const events = [...initial]
  try {
    while (true) {
      const next = await iterator.next()
      if (next.done) return { events, failed: false, overflow: false }
      context.scanner.observe(next.value)
      if (context.scanner.incomplete) {
        return { events, failed: true, overflow: false }
      }
      events.push(next.value)
      if (events.length > 256) {
        return { events, failed: true, overflow: true }
      }
    }
  } catch (error) {
    context.scanner.observe(error)
    return { events, failed: true, overflow: false }
  }
}

async function collectEvents(
  adapter: AgentHostAdapter,
  request: AgentHostRunRequest,
  context: QualificationCaseContext,
): Promise<CollectedEvents> {
  const iterator = adapter.run(request)[Symbol.asyncIterator]()
  context.registerCleanup(async () => {
    await iterator.return?.()
  })
  return await collectFromIterator(iterator, context)
}

const KNOWN_EVENT_TYPES = new Set([
  "run.started",
  "assistant.delta",
  "tool.started",
  "tool.completed",
  "approval.required",
  "usage",
  "run.completed",
  "run.failed",
])

function eventRecord(event: unknown): Record<string, unknown> | undefined {
  return event && typeof event === "object" && !Array.isArray(event)
    ? (event as Record<string, unknown>)
    : undefined
}

function eventType(event: unknown): unknown {
  return eventRecord(event)?.type
}

function isTerminal(event: unknown): event is AgentHostEvent {
  const type = eventType(event)
  return type === "run.completed" || type === "run.failed"
}

function caseResult(
  domain: QualificationDomain,
  id: string,
  passed: boolean,
  code: string,
): QualificationCaseResult {
  return { domain, id, passed, code }
}

function validHostVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
}

function probeContractValid(
  probe: unknown,
  expectedHostId: string,
): probe is AgentHostProbeResult {
  const record = eventRecord(probe)
  if (!record) return false
  const capabilities = eventRecord(record.capabilities)
  return (
    record.protocolVersion === AGENT_HOST_PROTOCOL_VERSION &&
    record.hostId === expectedHostId &&
    record.status === "ready" &&
    record.available === true &&
    record.adapterStatus === "runnable" &&
    validHostVersion(record.version) &&
    typeof record.capabilitySource === "string" &&
    CAPABILITY_SOURCE_SET.has(record.capabilitySource) &&
    capabilities !== undefined &&
    AGENT_HOST_CAPABILITIES.every((capability) =>
      CAPABILITY_SUPPORT_SET.has(capabilities[capability] as string),
    )
  )
}

interface CapabilityCaseOutcome {
  result: QualificationCaseResult
  probe?: AgentHostProbeResult
  probeFingerprint?: string
  hostVersion?: string
  identity?: AgentHostQualificationIdentity
}

async function runCapabilityCase(
  adapter: AgentHostAdapter,
  context: QualificationCaseContext,
): Promise<CapabilityCaseOutcome> {
  let probe: AgentHostProbeResult
  try {
    probe = await adapter.probe()
    context.scanner.observe(probe)
    if (context.scanner.incomplete) {
      return {
        result: caseResult(
          "capability_negotiation",
          "probe_contract",
          false,
          "qualification_evidence_scan_incomplete",
        ),
      }
    }
  } catch (error) {
    context.scanner.observe(error)
    return {
      result: caseResult(
        "capability_negotiation",
        "probe_contract",
        false,
        "probe_unavailable",
      ),
    }
  }
  const passed = probeContractValid(probe, adapter.hostId)
  let identity: AgentHostQualificationIdentity | undefined
  if (typeof adapter.qualificationIdentity === "function") {
    try {
      const candidate = await adapter.qualificationIdentity()
      context.scanner.observe(candidate)
      if (
        !context.scanner.incomplete &&
        typeof candidate.configurationDigest === "string" &&
        HEX_64_PATTERN.test(candidate.configurationDigest) &&
        Number.isSafeInteger(candidate.ownerPid) &&
        candidate.ownerPid > 0
      ) {
        identity = {
          configurationDigest: candidate.configurationDigest,
          ownerPid: candidate.ownerPid,
        }
      }
    } catch (error) {
      context.scanner.observe(error)
    }
  }
  return {
    result: caseResult(
      "capability_negotiation",
      "probe_contract",
      passed,
      passed ? "probe_contract_ok" : "probe_contract_violation",
    ),
    probe,
    probeFingerprint: qualificationProbeFingerprint(probe),
    hostVersion: probe.version,
    identity,
  }
}

async function runEventCases(
  adapter: AgentHostAdapter,
  workingDirectory: string,
  policy: AgentHostPolicy,
  context: QualificationCaseContext,
): Promise<QualificationCaseResult[]> {
  const request = qualificationRequest(
    adapter,
    "event_stream",
    workingDirectory,
    policy,
    context,
  )
  const collected = await collectEvents(adapter, request, context)
  if (collected.failed) {
    const code = collected.overflow
      ? "qualification_event_overflow"
      : "event_stream_unavailable"
    return [
      caseResult("native_event_validation", "events_well_formed", false, code),
      caseResult("single_terminal_outcome", "exactly_one_terminal", false, code),
    ]
  }

  const wellFormed = collected.events.every((event) => {
    const record = eventRecord(event)
    return (
      record !== undefined &&
      record.runId === request.runId &&
      typeof record.timestamp === "string" &&
      ISO_PATTERN.test(record.timestamp) &&
      typeof record.type === "string" &&
      KNOWN_EVENT_TYPES.has(record.type)
    )
  })
  const terminals = collected.events.filter(isTerminal)
  const terminalLast =
    terminals.length > 0 && isTerminal(collected.events.at(-1))
  const terminalPassed = terminals.length === 1 && terminalLast
  return [
    caseResult(
      "native_event_validation",
      "events_well_formed",
      wellFormed,
      wellFormed ? "events_well_formed_ok" : "malformed_native_event",
    ),
    caseResult(
      "single_terminal_outcome",
      "exactly_one_terminal",
      terminalPassed,
      terminalPassed
        ? "single_terminal_ok"
        : terminals.length === 0
          ? "missing_terminal_event"
          : terminals.length > 1
            ? "duplicate_terminal_event"
            : "event_after_terminal",
    ),
  ]
}

async function runCancelCase(
  adapter: AgentHostAdapter,
  workingDirectory: string,
  policy: AgentHostPolicy,
  context: QualificationCaseContext,
): Promise<QualificationCaseResult> {
  const request = qualificationRequest(
    adapter,
    "cancel",
    workingDirectory,
    policy,
    context,
    {
      metadata: {
        adapterQualification: {
          schema: ADAPTER_QUALIFICATION_DRIVER_SCHEMA_ID,
          operation: { kind: "lifecycle.wait_for_cancel" },
        } satisfies QualificationDriverMetadata,
      },
    },
  )
  if (typeof adapter.cancel !== "function") {
    return caseResult(
      "deadline_cancel",
      "cancel_stops_active_run",
      false,
      "cancel_not_supported",
    )
  }
  const iterator = adapter.run(request)[Symbol.asyncIterator]()
  context.registerCleanup(async () => {
    await iterator.return?.()
  })
  let first: IteratorResult<AgentHostEvent>
  try {
    first = await iterator.next()
    if (!first.done) context.scanner.observe(first.value)
  } catch (error) {
    context.scanner.observe(error)
    return caseResult(
      "deadline_cancel",
      "cancel_stops_active_run",
      false,
      "cancel_path_unavailable",
    )
  }
  if (first.done || eventType(first.value) !== "run.started") {
    return caseResult(
      "deadline_cancel",
      "cancel_stops_active_run",
      false,
      "cancel_never_started",
    )
  }
  try {
    await context.cancelRun(adapter, request.runId)
  } catch (error) {
    context.scanner.observe(error)
    return caseResult(
      "deadline_cancel",
      "cancel_stops_active_run",
      false,
      "cancel_path_unavailable",
    )
  }
  const collected = await collectFromIterator(iterator, context, [first.value])
  if (collected.failed) {
    return caseResult(
      "deadline_cancel",
      "cancel_stops_active_run",
      false,
      collected.overflow
        ? "qualification_event_overflow"
        : "cancel_path_unavailable",
    )
  }
  const terminals = collected.events.filter(isTerminal)
  const terminal = terminals[0]
  const passed =
    terminals.length === 1 &&
    eventType(terminal) === "run.failed" &&
    collected.events.at(-1) === terminal
  let code = "cancel_stops_active_run_ok"
  if (!passed) {
    code =
      terminals.length === 0
        ? "cancel_leaves_stream_open"
        : terminals.length > 1
          ? "cancel_terminal_contract_violation"
          : eventType(terminal) === "run.completed"
            ? "cancel_completed_terminal"
            : "cancel_event_after_terminal"
  }
  return caseResult(
    "deadline_cancel",
    "cancel_stops_active_run",
    passed,
    code,
  )
}

async function runCredentialCase(
  adapter: AgentHostAdapter,
  workingDirectory: string,
  policy: AgentHostPolicy,
  context: QualificationCaseContext,
): Promise<QualificationCaseResult> {
  const request = qualificationRequest(
    adapter,
    "credential",
    workingDirectory,
    policy,
    context,
    { metadata: { qualificationSentinel: QUALIFICATION_SENTINEL } },
  )
  const collected = await collectEvents(adapter, request, context)
  if (context.scanner.detected) {
    return caseResult(
      "credential_boundaries",
      "no_metadata_echo",
      false,
      "metadata_secret_echoed",
    )
  }
  if (context.scanner.incomplete) {
    return caseResult(
      "credential_boundaries",
      "no_metadata_echo",
      false,
      "metadata_secret_scan_incomplete",
    )
  }
  if (collected.failed) {
    return caseResult(
      "credential_boundaries",
      "no_metadata_echo",
      false,
      collected.overflow
        ? "qualification_event_overflow"
        : "credential_case_unavailable",
    )
  }
  return caseResult(
    "credential_boundaries",
    "no_metadata_echo",
    true,
    "no_metadata_echo_ok",
  )
}

function qualificationPolicyDenialMatches(
  error: unknown,
  expectedCode: string,
): boolean {
  if (!(error instanceof CoreError) || error.retryable !== false) return false
  if (error.code === expectedCode) return true
  if (error.code !== "agent_host_stdio_host_error") return false
  const details = eventRecord(error.details)
  return details?.code === expectedCode && details.retryable === false
}

async function runDirectDenyCase(
  kind: "filesystem" | "network" | "mcp",
  adapter: AgentHostAdapter,
  workingDirectory: string,
  policy: AgentHostPolicy,
  context: QualificationCaseContext,
): Promise<QualificationCaseResult> {
  const domain =
    kind === "mcp"
      ? "tool_mcp_enforcement"
      : "filesystem_network_enforcement"
  const id = kind === "filesystem" ? "hostile_write_refused" : `${kind}_deny_refused`
  const expectedCode =
    kind === "filesystem"
      ? QUALIFICATION_FILESYSTEM_DENIAL_CODE
      : kind === "network"
        ? QUALIFICATION_NETWORK_DENIAL_CODE
        : QUALIFICATION_MCP_DENIAL_CODE
  const operation: QualificationDriverOperation =
    kind === "filesystem"
      ? {
          kind: "filesystem.write",
          path: "../qualification-denied/outside-scope",
        }
      : kind === "network"
        ? {
            kind: "network.connect",
            url: "https://qualification.invalid/",
          }
        : {
            kind: "mcp.invoke",
            server: "qualification-denied",
            tool: "qualification.noop",
          }
  const request = qualificationRequest(
    adapter,
    `${kind}_deny`,
    workingDirectory,
    policy,
    context,
    {
      prompt:
        kind === "filesystem"
          ? "attempt one write outside the qualified filesystem scope; filesystem policy must deny it"
          : kind === "network"
            ? "attempt one HTTPS request to qualification.invalid; network policy must deny it"
            : "attempt the undeclared qualification-denied MCP server; it must be denied",
      metadata: {
        adapterQualification: {
          schema: ADAPTER_QUALIFICATION_DRIVER_SCHEMA_ID,
          operation,
        } satisfies QualificationDriverMetadata,
      },
    },
  )
  try {
    await adapter.preflight(request)
  } catch (error) {
    context.scanner.observe(error)
    const refused =
      !context.scanner.incomplete &&
      qualificationPolicyDenialMatches(error, expectedCode)
    return caseResult(
      domain,
      id,
      refused,
      refused
        ? `${kind}_deny_refused_ok`
        : `${kind}_deny_policy_evidence_invalid`,
    )
  }
  const collected = await collectEvents(adapter, request, context)
  if (collected.failed) {
    return caseResult(
      domain,
      id,
      false,
      collected.overflow
        ? "qualification_event_overflow"
        : `${kind}_deny_case_unavailable`,
    )
  }
  const terminals = collected.events.filter(isTerminal)
  const terminal = terminals[0]
  const terminalRecord = terminal ? eventRecord(terminal) : undefined
  const terminalError = eventRecord(terminalRecord?.error)
  const refused =
    collected.events.length >= 2 &&
    eventType(collected.events[0]) === "run.started" &&
    terminals.length === 1 &&
    eventType(terminal) === "run.failed" &&
    collected.events.at(-1) === terminal &&
    terminalError?.code === expectedCode &&
    terminalError.retryable === false
  return caseResult(
    domain,
    id,
    refused,
    refused
      ? `${kind}_deny_refused_ok`
      : terminal && eventType(terminal) === "run.completed"
        ? `${kind}_deny_accepted`
        : `${kind}_deny_policy_evidence_invalid`,
  )
}

async function runToolCase(
  adapter: AgentHostAdapter,
  workingDirectory: string,
  policy: AgentHostPolicy,
  context: QualificationCaseContext,
): Promise<QualificationCaseResult> {
  const request = qualificationRequest(
    adapter,
    "tool_enforcement",
    workingDirectory,
    policy,
    context,
  )
  const collected = await collectEvents(adapter, request, context)
  if (collected.failed) {
    return caseResult(
      "tool_mcp_enforcement",
      "tool_allowlist_respected",
      false,
      collected.overflow ? "qualification_event_overflow" : "tool_case_unavailable",
    )
  }
  const allowed = new Set(policy.tools.allow.map((entry) => entry.name))
  const violation = collected.events.some((event) => {
    const record = eventRecord(event)
    return (
      (record?.type === "tool.started" || record?.type === "tool.completed") &&
      !allowed.has(String(record.toolName))
    )
  })
  return caseResult(
    "tool_mcp_enforcement",
    "tool_allowlist_respected",
    !violation,
    violation ? "disallowed_tool_event" : "tool_allowlist_respected_ok",
  )
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

interface QualificationProcessIdentity {
  pid: number
  parentPid: number
  processGroupId: number
  startIdentity: string
}

async function inspectProcessIdentities(
  pids: readonly number[],
): Promise<Map<number, QualificationProcessIdentity> | undefined> {
  if (process.platform === "win32") return undefined
  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      [
        "-o",
        "pid=,ppid=,pgid=,lstart=",
        "-p",
        [...new Set(pids)].join(","),
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    )
    const identities = new Map<number, QualificationProcessIdentity>()
    for (const line of String(stdout).split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/)
      if (!match) continue
      const identity = {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        processGroupId: Number(match[3]),
        startIdentity: match[4] ?? "",
      }
      identities.set(identity.pid, identity)
    }
    return identities
  } catch {
    return undefined
  }
}

async function descendantsGone(
  descendants: QualificationProcessTreeDescendants,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (
    processAlive(descendants.childPid) ||
    processAlive(descendants.grandchildPid)
  ) {
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  return true
}

function validDescendants(
  value: QualificationProcessTreeDescendants,
): boolean {
  return (
    Number.isSafeInteger(value.childPid) &&
    value.childPid > 0 &&
    Number.isSafeInteger(value.grandchildPid) &&
    value.grandchildPid > 0 &&
    value.childPid !== value.grandchildPid &&
    value.childPid !== process.pid &&
    value.grandchildPid !== process.pid
  )
}

function qualificationProbeFingerprint(probe: AgentHostProbeResult): string {
  return createHash("sha256").update(canonicalJson(probe)).digest("hex")
}

async function processTreeLineageValid(
  ownerPid: number,
  descendants: QualificationProcessTreeDescendants,
): Promise<boolean> {
  const identities = await inspectProcessIdentities([
    ownerPid,
    descendants.childPid,
    descendants.grandchildPid,
  ])
  const owner = identities?.get(ownerPid)
  const child = identities?.get(descendants.childPid)
  const grandchild = identities?.get(descendants.grandchildPid)
  const valid = Boolean(
    owner &&
      child &&
      grandchild &&
      child.parentPid === owner.pid &&
      grandchild.parentPid === child.pid &&
      owner.processGroupId > 0 &&
      child.processGroupId === owner.processGroupId &&
      grandchild.processGroupId === owner.processGroupId &&
      owner.startIdentity.length > 0 &&
      child.startIdentity.length > 0 &&
      grandchild.startIdentity.length > 0,
  )
  return valid
}

function cancelledLifecycle(events: AgentHostEvent[]): boolean {
  const terminals = events.filter(isTerminal)
  return (
    terminals.length === 1 &&
    eventType(terminals[0]) === "run.failed" &&
    events.at(-1) === terminals[0]
  )
}

async function runProcessTreeCase(
  scenario: QualificationProcessTreeScenario,
  expectedAdapter: AgentHostAdapter,
  expectedProbeFingerprint: string | undefined,
  expectedHostVersion: string | undefined,
  expectedIdentity: AgentHostQualificationIdentity | undefined,
  workingDirectory: string,
  policy: AgentHostPolicy,
  fixture: QualificationProcessTreeFixture | undefined,
  context: QualificationCaseContext,
): Promise<() => QualificationCaseResult> {
  const id = `descendants_disposed_${scenario}`
  const result = (
    passed: boolean,
    code: string,
  ): (() => QualificationCaseResult) =>
    () => caseResult("process_tree_cleanup", id, passed, code)
  if (!fixture) {
    return result(false, "process_tree_fixture_unavailable")
  }
  let instance: QualificationProcessTreeFixtureInstance | undefined
  let disposePromise: Promise<void> | undefined
  const disposeOnce = async (): Promise<void> => {
    if (!instance) return
    disposePromise ??= Promise.resolve(instance.dispose())
    await disposePromise
  }
  let descendants: QualificationProcessTreeDescendants | undefined
  let lifecyclePassed = false
  let lineagePassed = false
  let descendantsDisposed = false
  let failureCode = "process_tree_fixture_create_failed"
  try {
    instance = await fixture.create(scenario)
    context.registerCleanup(async () => {
      await disposeOnce()
      if (descendants) {
        descendantsDisposed = await descendantsGone(descendants, 1_000)
      }
    })
    failureCode = "process_tree_case_unavailable"
    if (instance.adapter !== expectedAdapter) {
      failureCode = "process_tree_adapter_mismatch"
    } else if (
      !expectedProbeFingerprint ||
      !expectedHostVersion ||
      !expectedIdentity
    ) {
      failureCode = "process_tree_binding_unavailable"
    } else {
      const currentProbe = await instance.adapter.probe()
      context.scanner.observe(currentProbe)
      const currentIdentity = await instance.adapter.qualificationIdentity?.()
      context.scanner.observe(currentIdentity)
      if (
        context.scanner.incomplete ||
        !currentIdentity ||
        currentProbe.version !== expectedHostVersion ||
        qualificationProbeFingerprint(currentProbe) !==
          expectedProbeFingerprint ||
        currentIdentity.configurationDigest !==
          expectedIdentity.configurationDigest ||
        currentIdentity.ownerPid !== expectedIdentity.ownerPid
      ) {
        failureCode = "process_tree_binding_mismatch"
        return () => caseResult("process_tree_cleanup", id, false, failureCode)
      }
      const timeoutDelayMs = Math.max(
        25,
        Math.min(250, Math.floor(context.remainingMs() / 4)),
      )
      const request = qualificationRequest(
        instance.adapter,
        `process_tree_${scenario}`,
        workingDirectory,
        policy,
        context,
        {
          ...(scenario === "timeout"
            ? { deadline: new Date(Date.now() + timeoutDelayMs).toISOString() }
            : {}),
          metadata: {
            adapterQualification: {
              schema: ADAPTER_QUALIFICATION_DRIVER_SCHEMA_ID,
              operation: { kind: "process_tree", scenario },
            } satisfies QualificationDriverMetadata,
          },
        },
      )
      const iterator = instance.adapter.run(request)[Symbol.asyncIterator]()
      context.registerCleanup(async () => {
        await iterator.return?.()
      })
      failureCode = "process_tree_run_unavailable"
      const first = await iterator.next()
      if (first.done) {
        failureCode = "process_tree_run_not_started"
      } else {
        context.scanner.observe(first.value)
        if (eventType(first.value) !== "run.started") {
          failureCode = "process_tree_run_not_started"
        } else {
          failureCode = "process_tree_descendants_unavailable"
          descendants = await instance.descendants()
          context.scanner.observe(descendants)
          if (!validDescendants(descendants)) {
            failureCode = "process_tree_descendants_invalid"
          } else if (
            !processAlive(descendants.childPid) ||
            !processAlive(descendants.grandchildPid)
          ) {
            failureCode = "process_tree_descendants_not_running"
          } else if (
            !(await processTreeLineageValid(
              expectedIdentity.ownerPid,
              descendants,
            ))
          ) {
            failureCode = "process_tree_lineage_unverified"
          } else if (scenario === "normal") {
            lineagePassed = true
            const collected = await collectFromIterator(iterator, context, [
              first.value,
            ])
            const terminals = collected.events.filter(isTerminal)
            lifecyclePassed =
              !collected.failed &&
              terminals.length === 1 &&
              eventType(terminals[0]) === "run.completed" &&
              collected.events.at(-1) === terminals[0]
            failureCode = lifecyclePassed
              ? failureCode
              : "process_tree_lifecycle_violation"
          } else if (typeof instance.adapter.cancel !== "function") {
            failureCode = "process_tree_cancel_not_supported"
          } else if (scenario === "cancel") {
            lineagePassed = true
            await context.cancelRun(instance.adapter, request.runId)
            const collected = await collectFromIterator(iterator, context, [
              first.value,
            ])
            lifecyclePassed =
              !collected.failed && cancelledLifecycle(collected.events)
            failureCode = lifecyclePassed
              ? failureCode
              : "process_tree_lifecycle_violation"
          } else {
            lineagePassed = true
            let timeoutTimer: ReturnType<typeof setTimeout> | undefined
            const pending = iterator.next().then<
              | { kind: "next"; result: IteratorResult<AgentHostEvent> }
              | { kind: "error"; error: unknown }
              ,
              | { kind: "next"; result: IteratorResult<AgentHostEvent> }
              | { kind: "error"; error: unknown }
            >(
              (result) => ({ kind: "next", result }),
              (error: unknown) => ({ kind: "error", error }),
            )
            const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
              timeoutTimer = setTimeout(
                () => resolve({ kind: "timeout" }),
                timeoutDelayMs,
              )
            })
            const firstAfterStart = await Promise.race([pending, timeout])
            if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
            const events = [first.value]
            let timedOut = false
            if (firstAfterStart.kind === "timeout") {
              timedOut = true
              context.abort()
              await context.cancelRun(instance.adapter, request.runId)
              const afterCancel = await pending
              if (afterCancel.kind === "error") {
                context.scanner.observe(afterCancel.error)
              } else if (!afterCancel.result.done) {
                context.scanner.observe(afterCancel.result.value)
                events.push(afterCancel.result.value)
              }
            } else if (firstAfterStart.kind === "error") {
              context.scanner.observe(firstAfterStart.error)
            } else if (!firstAfterStart.result.done) {
              context.scanner.observe(firstAfterStart.result.value)
              events.push(firstAfterStart.result.value)
              const record = eventRecord(firstAfterStart.result.value)
              timedOut =
                record?.type === "run.failed" &&
                typeof eventRecord(record.error)?.code === "string" &&
                /(?:deadline|timeout)/.test(
                  String(eventRecord(record.error)?.code),
                )
            }
            const collected = await collectFromIterator(iterator, context, events)
            lifecyclePassed =
              timedOut &&
              !collected.failed &&
              cancelledLifecycle(collected.events)
            failureCode = lifecyclePassed
              ? failureCode
              : "process_tree_timeout_not_observed"
          }
        }
      }
    }
  } catch (error) {
    context.scanner.observe(error)
  }
  return () => {
    if (!descendants || !lineagePassed || !lifecyclePassed) {
      return caseResult("process_tree_cleanup", id, false, failureCode)
    }
    return caseResult(
      "process_tree_cleanup",
      id,
      descendantsDisposed,
      descendantsDisposed
        ? `descendants_disposed_${scenario}_ok`
        : "process_tree_descendants_survived",
    )
  }
}

async function runOutputSchemaCase(
  adapter: AgentHostAdapter,
  workingDirectory: string,
  policy: AgentHostPolicy,
  context: QualificationCaseContext,
): Promise<QualificationCaseResult> {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  }
  const request = qualificationRequest(
    adapter,
    "output_schema",
    workingDirectory,
    policy,
    context,
    { outputSchema: schema },
  )
  const collected = await collectEvents(adapter, request, context)
  if (collected.failed) {
    return caseResult(
      "output_schema",
      "terminal_output_matches_schema",
      false,
      collected.overflow
        ? "qualification_event_overflow"
        : "output_schema_case_unavailable",
    )
  }
  const terminal = collected.events.filter(isTerminal)
  if (terminal.length !== 1 || eventType(terminal[0]) !== "run.completed") {
    return caseResult(
      "output_schema",
      "terminal_output_matches_schema",
      false,
      "no_completed_terminal",
    )
  }
  const output = eventRecord(terminal[0])?.output
  const outputRecord = eventRecord(output)
  const keys = outputRecord ? Object.keys(outputRecord) : []
  const matches =
    keys.length === 1 &&
    keys[0] === "answer" &&
    typeof outputRecord?.answer === "string"
  return caseResult(
    "output_schema",
    "terminal_output_matches_schema",
    matches,
    matches ? "output_schema_ok" : "output_schema_violation",
  )
}

function caseTimeoutResult(
  domain: QualificationDomain,
  id: string,
): (code: string) => QualificationCaseResult {
  return (code) => caseResult(domain, id, false, code)
}

export async function runQualificationSuite(
  adapter: AgentHostAdapter,
  options: QualificationOptions,
): Promise<AdapterQualificationRecord> {
  if (!HOST_ID_PATTERN.test(adapter.hostId)) {
    throw qualificationError(
      "INVALID_QUALIFICATION_HOST_ID",
      "adapter hostId must be a lowercase ASCII identifier",
    )
  }
  if (!ISO_PATTERN.test(options.generatedAt)) {
    throw qualificationError(
      "INVALID_QUALIFICATION_TIMESTAMP",
      "generatedAt must be an ISO-8601 UTC timestamp",
    )
  }
  const caseTimeoutMs =
    options.caseTimeoutMs ?? DEFAULT_QUALIFICATION_CASE_TIMEOUT_MS
  if (
    !Number.isInteger(caseTimeoutMs) ||
    caseTimeoutMs < MIN_QUALIFICATION_CASE_TIMEOUT_MS ||
    caseTimeoutMs > MAX_QUALIFICATION_CASE_TIMEOUT_MS
  ) {
    throw qualificationError(
      "INVALID_QUALIFICATION_CASE_TIMEOUT",
      `caseTimeoutMs must be an integer from ${MIN_QUALIFICATION_CASE_TIMEOUT_MS} to ${MAX_QUALIFICATION_CASE_TIMEOUT_MS}`,
    )
  }

  const scanner = new QualificationSentinelScanner()
  const policy = defaultQualificationPolicy()
  const cases: QualificationCaseResult[] = []
  const capability = await runBoundedCase(
    caseTimeoutMs,
    scanner,
    (code): CapabilityCaseOutcome => ({
      result: caseResult(
        "capability_negotiation",
        "probe_contract",
        false,
        code,
      ),
    }),
    (context) => runCapabilityCase(adapter, context),
  )
  cases.push(capability.result)
  cases.push(
    ...(await runBoundedCase(
      caseTimeoutMs,
      scanner,
      (code) => [
        caseResult("native_event_validation", "events_well_formed", false, code),
        caseResult("single_terminal_outcome", "exactly_one_terminal", false, code),
      ],
      (context) =>
        runEventCases(adapter, options.workingDirectory, policy, context),
    )),
  )
  cases.push(
    await runBoundedCase(
      caseTimeoutMs,
      scanner,
      caseTimeoutResult("deadline_cancel", "cancel_stops_active_run"),
      (context) =>
        runCancelCase(adapter, options.workingDirectory, policy, context),
    ),
  )
  for (const scenario of ["normal", "timeout", "cancel"] as const) {
    const processResult = await runBoundedCase(
        caseTimeoutMs,
        scanner,
        (code) => () =>
          caseResult(
            "process_tree_cleanup",
            `descendants_disposed_${scenario}`,
            false,
            code,
          ),
        (context) =>
          runProcessTreeCase(
            scenario,
            adapter,
            capability.probeFingerprint,
            capability.hostVersion,
            capability.identity,
            options.workingDirectory,
            policy,
            options.processTreeFixture,
            context,
          ),
      )
    cases.push(processResult())
  }
  cases.push(
    await runBoundedCase(
      caseTimeoutMs,
      scanner,
      caseTimeoutResult("credential_boundaries", "no_metadata_echo"),
      (context) =>
        runCredentialCase(adapter, options.workingDirectory, policy, context),
    ),
  )
  cases.push(
    await runBoundedCase(
      caseTimeoutMs,
      scanner,
      caseTimeoutResult(
        "filesystem_network_enforcement",
        "hostile_write_refused",
      ),
      (context) =>
        runDirectDenyCase(
          "filesystem",
          adapter,
          options.workingDirectory,
          policy,
          context,
        ),
    ),
  )
  cases.push(
    await runBoundedCase(
      caseTimeoutMs,
      scanner,
      caseTimeoutResult(
        "filesystem_network_enforcement",
        "network_deny_refused",
      ),
      (context) =>
        runDirectDenyCase(
          "network",
          adapter,
          options.workingDirectory,
          policy,
          context,
        ),
    ),
  )
  cases.push(
    await runBoundedCase(
      caseTimeoutMs,
      scanner,
      caseTimeoutResult("tool_mcp_enforcement", "tool_allowlist_respected"),
      (context) =>
        runToolCase(adapter, options.workingDirectory, policy, context),
    ),
  )
  cases.push(
    await runBoundedCase(
      caseTimeoutMs,
      scanner,
      caseTimeoutResult("tool_mcp_enforcement", "mcp_deny_refused"),
      (context) =>
        runDirectDenyCase(
          "mcp",
          adapter,
          options.workingDirectory,
          policy,
          context,
        ),
    ),
  )
  cases.push(
    await runBoundedCase(
      caseTimeoutMs,
      scanner,
      caseTimeoutResult("output_schema", "terminal_output_matches_schema"),
      (context) =>
        runOutputSchemaCase(adapter, options.workingDirectory, policy, context),
    ),
  )

  if (scanner.detected || scanner.incomplete) {
    const credentialIndex = cases.findIndex(
      (entry) => entry.domain === "credential_boundaries",
    )
    if (credentialIndex !== -1) {
      cases[credentialIndex] = caseResult(
        "credential_boundaries",
        "no_metadata_echo",
        false,
        scanner.detected
          ? "metadata_secret_echoed"
          : "metadata_secret_scan_incomplete",
      )
    }
  }

  const probe = capability.probe
  if (probe !== undefined && !validHostVersion(probe.version)) {
    throw qualificationError(
      "INVALID_QUALIFICATION_HOST_VERSION",
      "a responding qualification host must report a non-empty version of at most 256 characters",
    )
  }
  const implemented = probeContractValid(probe, adapter.hostId)
  const fixtureConformant =
    implemented && cases.every((result) => result.passed)
  // Project to the frozen two-field shape so callers cannot smuggle extra
  // keys (credentials, paths) into the published record.
  const liveEvidence =
    options.liveEvidence === undefined
      ? undefined
      : {
          environment: options.liveEvidence.environment,
          evidenceDigest: options.liveEvidence.evidenceDigest,
        }
  const liveQualified = liveEvidence !== undefined
  if (liveQualified) {
    if (
      !ENVIRONMENT_ID_PATTERN.test(liveEvidence.environment) ||
      !HEX_64_PATTERN.test(liveEvidence.evidenceDigest)
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_LIVE_EVIDENCE",
        "live evidence requires an environment id and a sha256 digest",
      )
    }
  }

  const domains = {} as Record<
    QualificationDomain,
    { passed: number; failed: number }
  >
  for (const domain of QUALIFICATION_DOMAINS) {
    const domainCases = cases.filter((result) => result.domain === domain)
    domains[domain] = {
      passed: domainCases.filter((result) => result.passed).length,
      failed: domainCases.filter((result) => !result.passed).length,
    }
  }

  const record: AdapterQualificationRecord = {
    schema: ADAPTER_QUALIFICATION_SCHEMA_ID,
    hostId: adapter.hostId,
    hostVersion: probe?.version ?? "unknown",
    policyDigest: canonicalPolicyDigest(policy),
    kitVersion: ADAPTER_QUALIFICATION_KIT_VERSION,
    generatedAt: options.generatedAt,
    axes: { implemented, fixtureConformant, liveQualified },
    domains,
    cases,
    ...(liveEvidence !== undefined ? { liveEvidence } : {}),
  }
  const recordScanner = new QualificationSentinelScanner()
  recordScanner.observe(record)
  if (recordScanner.detected) {
    throw qualificationError(
      "QUALIFICATION_EVIDENCE_SECRET_DETECTED",
      "qualification evidence contained the credential sentinel",
    )
  }
  if (recordScanner.incomplete) {
    throw qualificationError(
      "QUALIFICATION_EVIDENCE_SCAN_INCOMPLETE",
      "qualification evidence could not be scanned completely",
    )
  }
  validateAdapterQualificationRecord(record)
  return record
}

export function validateAdapterQualificationRecord(
  value: unknown,
): AdapterQualificationRecord {
  const evidenceScanner = new QualificationSentinelScanner()
  evidenceScanner.observe(value)
  if (evidenceScanner.detected) {
    throw qualificationError(
      "QUALIFICATION_EVIDENCE_SECRET_DETECTED",
      "qualification evidence contained the credential sentinel",
    )
  }
  if (evidenceScanner.incomplete) {
    throw qualificationError(
      "QUALIFICATION_EVIDENCE_SCAN_INCOMPLETE",
      "qualification evidence could not be scanned completely",
    )
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "qualification record must be an object",
    )
  }
  const record = value as Record<string, unknown>
  const allowed = new Set([
    "schema",
    "hostId",
    "hostVersion",
    "policyDigest",
    "kitVersion",
    "generatedAt",
    "axes",
    "domains",
    "cases",
    "liveEvidence",
  ])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        `unknown qualification record field: ${key}`,
      )
    }
  }
  if (record.schema !== ADAPTER_QUALIFICATION_SCHEMA_ID) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      `schema must be ${ADAPTER_QUALIFICATION_SCHEMA_ID}`,
    )
  }
  if (
    typeof record.hostId !== "string" ||
    !HOST_ID_PATTERN.test(record.hostId)
  ) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "hostId must be a lowercase ASCII identifier",
    )
  }
  if (
    typeof record.hostVersion !== "string" ||
    record.hostVersion === "" ||
    record.hostVersion.length > 256
  ) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "hostVersion must be a non-empty string of at most 256 characters",
    )
  }
  if (
    typeof record.policyDigest !== "string" ||
    !HEX_64_PATTERN.test(record.policyDigest)
  ) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "policyDigest must be a sha256 hex digest",
    )
  }
  if (
    record.kitVersion !== ADAPTER_QUALIFICATION_KIT_VERSION &&
    record.kitVersion !== LEGACY_ADAPTER_QUALIFICATION_KIT_VERSION
  ) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      `kitVersion must be ${LEGACY_ADAPTER_QUALIFICATION_KIT_VERSION} or ${ADAPTER_QUALIFICATION_KIT_VERSION}`,
    )
  }
  if (
    typeof record.generatedAt !== "string" ||
    !ISO_PATTERN.test(record.generatedAt)
  ) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "generatedAt must be an ISO-8601 UTC timestamp",
    )
  }

  const axes = record.axes as Record<string, unknown> | undefined
  if (
    !axes ||
    typeof axes !== "object" ||
    Array.isArray(axes) ||
    Object.keys(axes).some(
      (key) =>
        key !== "implemented" &&
        key !== "fixtureConformant" &&
        key !== "liveQualified",
    ) ||
    typeof axes.implemented !== "boolean" ||
    typeof axes.fixtureConformant !== "boolean" ||
    typeof axes.liveQualified !== "boolean"
  ) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "axes must carry three booleans",
    )
  }
  if (axes.fixtureConformant && !axes.implemented) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "fixtureConformant requires implemented",
    )
  }
  if (axes.liveQualified && record.liveEvidence === undefined) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "liveQualified requires explicit liveEvidence",
    )
  }
  if (record.liveEvidence !== undefined) {
    const evidence = record.liveEvidence as Record<string, unknown> | null
    if (
      !evidence ||
      typeof evidence !== "object" ||
      Array.isArray(evidence) ||
      Object.keys(evidence).some(
        (key) => key !== "environment" && key !== "evidenceDigest",
      ) ||
      typeof evidence.environment !== "string" ||
      !ENVIRONMENT_ID_PATTERN.test(evidence.environment) ||
      typeof evidence.evidenceDigest !== "string" ||
      !HEX_64_PATTERN.test(evidence.evidenceDigest)
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        "liveEvidence requires an environment id and a sha256 digest",
      )
    }
  }

  const domains = record.domains as
    | Record<string, unknown>
    | undefined
  if (!domains || typeof domains !== "object" || Array.isArray(domains)) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "domains is required",
    )
  }
  for (const key of Object.keys(domains)) {
    if (!(QUALIFICATION_DOMAINS as readonly string[]).includes(key)) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        `unknown qualification domain: ${key}`,
      )
    }
  }
  for (const domain of QUALIFICATION_DOMAINS) {
    const entry = domains[domain] as Record<string, unknown> | undefined
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => key !== "passed" && key !== "failed") ||
      typeof entry.passed !== "number" ||
      !Number.isInteger(entry.passed) ||
      entry.passed < 0 ||
      typeof entry.failed !== "number" ||
      !Number.isInteger(entry.failed) ||
      entry.failed < 0
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        `domain ${domain} must report passed/failed counts`,
      )
    }
  }

  if (!Array.isArray(record.cases) || record.cases.length === 0) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "cases must be a non-empty array",
    )
  }
  const expectedContract =
    record.kitVersion === LEGACY_ADAPTER_QUALIFICATION_KIT_VERSION
      ? LEGACY_QUALIFICATION_CASE_CONTRACT
      : CURRENT_QUALIFICATION_CASE_CONTRACT
  if (record.cases.length !== expectedContract.length) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      `kit ${record.kitVersion} requires exactly ${expectedContract.length} cases`,
    )
  }
  const expectedCases = new Map<string, QualificationDomain>(
    expectedContract.map(([domain, id]) => [id, domain]),
  )
  const seenDomains = new Set<string>()
  const seenCases = new Set<string>()
  for (const entry of record.cases as Array<Record<string, unknown>>) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some(
        (key) =>
          key !== "domain" &&
          key !== "id" &&
          key !== "passed" &&
          key !== "code",
      )
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        "unknown qualification case field",
      )
    }
    if (
      typeof entry.domain !== "string" ||
      !(QUALIFICATION_DOMAINS as readonly string[]).includes(entry.domain)
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        "every case must declare a known domain",
      )
    }
    if (
      typeof entry.id !== "string" ||
      !CASE_ID_PATTERN.test(entry.id)
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        "case ids must be lowercase snake_case",
      )
    }
    if (
      seenCases.has(entry.id) ||
      expectedCases.get(entry.id) !== entry.domain
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        `case ${entry.id} is duplicated or outside the ${record.kitVersion} contract`,
      )
    }
    if (typeof entry.passed !== "boolean") {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        "every case must report a boolean result",
      )
    }
    if (
      typeof entry.code !== "string" ||
      entry.code.length > 128 ||
      !CASE_CODE_PATTERN.test(entry.code)
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        "every case must report a bounded lowercase ASCII machine code",
      )
    }
    seenDomains.add(entry.domain)
    seenCases.add(entry.id)
  }
  for (const domain of QUALIFICATION_DOMAINS) {
    if (!seenDomains.has(domain)) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        `cases must cover domain ${domain}`,
      )
    }
  }
  const typedCases = record.cases as QualificationCaseResult[]
  for (const domain of QUALIFICATION_DOMAINS) {
    const domainCases = typedCases.filter((entry) => entry.domain === domain)
    const expectedPassed = domainCases.filter((entry) => entry.passed).length
    const expectedFailed = domainCases.length - expectedPassed
    const summary = domains[domain] as { passed: number; failed: number }
    if (
      summary.passed !== expectedPassed ||
      summary.failed !== expectedFailed
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        `domain ${domain} summary does not match its cases`,
      )
    }
  }
  const probeCase = typedCases.find((entry) => entry.id === "probe_contract")
  const expectedImplemented = probeCase?.passed === true
  const expectedFixtureConformant =
    expectedImplemented && typedCases.every((entry) => entry.passed)
  const expectedLiveQualified = record.liveEvidence !== undefined
  if (
    axes.implemented !== expectedImplemented ||
    axes.fixtureConformant !== expectedFixtureConformant ||
    axes.liveQualified !== expectedLiveQualified
  ) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "qualification axes do not match the derived case and evidence state",
    )
  }
  return value as AdapterQualificationRecord
}
