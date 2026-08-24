import { createHash, randomUUID } from "node:crypto"

import type { SafeValue } from "../../core/src/contracts.js"

export const DELEGATION_ENVELOPE_VERSION = "delegation-envelope.v1" as const
export const DELEGATION_EVENT_VERSION = "delegation-event.v1" as const
export const TASK_RECORD_VERSION = "task.v1" as const

export type DelegationEngine = "qoder" | "claude-code"

export interface DelegationEnvelope {
  schemaVersion: typeof DELEGATION_ENVELOPE_VERSION
  taskId: string
  parentTurnId: string
  childTurnId: string
  delegatedBy: string
  routedTo: string
  trigger: "user_explicit"
  delegationDepth: 1
  attempt: number
  retryOfTaskId: string | null
  engine: DelegationEngine
  instruction: string
  organizationDigest: string
  permissionsDigest: string
  deadline: string
  envelopeDigest: string
}

export interface DelegationOrganization {
  schemaVersion: string
  owner: string
  roles: Array<{ id: string; reportTo: string | null }>
  [key: string]: unknown
}

export interface DelegationPositionPermissions {
  contextScope: { read: string[] }
  authorityScope: {
    writes: "deny"
    tools: { allow: string[]; deny: string[] }
    delegation: {
      allow: boolean
      targets: string[]
      escalateTo: string | null
    }
  }
  [key: string]: unknown
}

export interface DelegationPermissions {
  schemaVersion: string
  owner: string
  positions: Record<string, DelegationPositionPermissions>
  [key: string]: unknown
}

export interface EffectiveDelegationScope {
  contextRead: string[]
  toolAllow: string[]
  toolDeny: string[]
  writes: "deny"
  delegation: "deny"
}

export interface RequestedTaskRecord {
  schemaVersion: typeof TASK_RECORD_VERSION
  taskId: string
  parentConversationId: string
  childConversationId: string
  parentTurnId: string
  childTurnId: string
  delegatedBy: string
  routedTo: string
  trigger: "user_explicit"
  delegationDepth: 1
  attempt: number
  retryOfTaskId: string | null
  engine: DelegationEngine
  instruction: string
  organizationDigest: string
  permissionsDigest: string
  effectiveScope: EffectiveDelegationScope
  scopeDigest: string
  status: "requested"
  createdAt: string
  startedAt: null
  cancelRequestedAt: null
  updatedAt: string
  finishedAt: null
  outputDigest: null
  evidenceDigest: null
  error: null
  events: []
}

export interface DelegationTerminalError {
  code: string
  message: string
  retryable: boolean
}

interface DelegationEventCommon {
  schemaVersion: typeof DELEGATION_EVENT_VERSION
  type:
    | "delegation.started"
    | "delegation.usage"
    | "delegation.completed"
    | "delegation.failed"
    | "delegation.cancelled"
  eventId: string
  sequence: number
  producer: "engine"
  taskId: string
  parentTurnId: string
  childTurnId: string
  delegatedBy: string
  routedTo: string
  delegationDepth: 1
  attempt: number
  timestamp: string
}

export type DelegationEvent =
  | (DelegationEventCommon & {
      type: "delegation.started"
      payload: { scopeDigest: string }
    })
  | (DelegationEventCommon & {
      type: "delegation.usage"
      payload: {
        inputTokens?: number
        outputTokens?: number
        totalTokens?: number
      }
    })
  | (DelegationEventCommon & {
      type: "delegation.completed"
      payload: {
        runId: string
        outputDigest: string
        evidenceDigest: string
      }
    })
  | (DelegationEventCommon & {
      type: "delegation.failed" | "delegation.cancelled"
      payload: { runId: string; error: DelegationTerminalError }
    })

export interface DelegationChildRunRequest {
  runId: string
  engine: DelegationEngine
  positionId: string
  instruction: string
  deadline: string
  effectiveScope: EffectiveDelegationScope
  signal?: AbortSignal
  /** Trusted child boundary: called only after a validated Host run.started. */
  onStarted: () => void
  onUsage?: (usage: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }) => void
}

export type DelegationChildRunResult =
  | { status: "completed"; output: SafeValue }
  | {
      status: "failed" | "cancelled"
      error: DelegationTerminalError
    }

export interface DelegationChildExecutorPort {
  run(request: DelegationChildRunRequest): Promise<DelegationChildRunResult>
}

export interface ExistingDelegationRef {
  taskId: string
  parentTurnId: string
  childTurnId: string
  attempt: number
  retryOfTaskId: string | null
}

export class DelegationContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "DelegationContractError"
  }
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const MAX_ID_BYTES = 256
const MAX_INSTRUCTION_BYTES = 20_000
const ENVELOPE_KEYS = [
  "schemaVersion",
  "taskId",
  "parentTurnId",
  "childTurnId",
  "delegatedBy",
  "routedTo",
  "trigger",
  "delegationDepth",
  "attempt",
  "retryOfTaskId",
  "engine",
  "instruction",
  "organizationDigest",
  "permissionsDigest",
  "deadline",
  "envelopeDigest",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalValue)
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = canonicalValue((value as Record<string, unknown>)[key])
  }
  return result
}

export function computeCanonicalDigest(value: unknown): string {
  const canonical = JSON.stringify(canonicalValue(value))
  return `sha256:${createHash("sha256").update(canonical ?? "null", "utf8").digest("hex")}`
}

export function computeDelegationEnvelopeDigest(
  body: Record<string, unknown>,
): string {
  const withoutDigest = { ...body }
  delete withoutDigest.envelopeDigest
  return computeCanonicalDigest(withoutDigest)
}

function requireId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_ID_BYTES ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new DelegationContractError(
      "delegation.envelope_invalid",
      `${field} must be a bounded non-empty identifier`,
    )
  }
  return value
}

function requireDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new DelegationContractError(
      "delegation.envelope_invalid",
      `${field} must be a sha256 digest`,
    )
  }
  return value
}

export function parseDelegationEnvelope(raw: unknown): DelegationEnvelope {
  if (!isRecord(raw)) {
    throw new DelegationContractError(
      "delegation.envelope_invalid",
      "delegation envelope must be an object",
    )
  }
  const allowed = new Set<string>(ENVELOPE_KEYS)
  if (
    Object.keys(raw).some((key) => !allowed.has(key)) ||
    ENVELOPE_KEYS.some((key) => !(key in raw))
  ) {
    throw new DelegationContractError(
      "delegation.envelope_invalid",
      "delegation envelope must use the exact v1 field set",
    )
  }
  if (raw.schemaVersion !== DELEGATION_ENVELOPE_VERSION) {
    throw new DelegationContractError(
      "delegation.envelope_invalid",
      `schemaVersion must be ${DELEGATION_ENVELOPE_VERSION}`,
    )
  }
  const taskId = requireId(raw.taskId, "taskId")
  const parentTurnId = requireId(raw.parentTurnId, "parentTurnId")
  const childTurnId = requireId(raw.childTurnId, "childTurnId")
  const delegatedBy = requireId(raw.delegatedBy, "delegatedBy")
  const routedTo = requireId(raw.routedTo, "routedTo")
  if (
    taskId === parentTurnId ||
    taskId === childTurnId ||
    parentTurnId === childTurnId
  ) {
    throw new DelegationContractError(
      "delegation.identity_invalid",
      "task and turn identities must be distinct",
    )
  }
  if (raw.trigger !== "user_explicit" || raw.delegationDepth !== 1) {
    throw new DelegationContractError(
      "delegation.route_denied",
      "v1 requires trigger=user_explicit and delegationDepth=1",
    )
  }
  if (!Number.isInteger(raw.attempt) || (raw.attempt as number) < 1) {
    throw new DelegationContractError(
      "delegation.attempt_invalid",
      "attempt must be a positive integer",
    )
  }
  const attempt = raw.attempt as number
  let retryOfTaskId: string | null
  if (raw.retryOfTaskId === null) retryOfTaskId = null
  else retryOfTaskId = requireId(raw.retryOfTaskId, "retryOfTaskId")
  if (
    (attempt === 1 && retryOfTaskId !== null) ||
    (attempt > 1 && retryOfTaskId === null) ||
    retryOfTaskId === taskId
  ) {
    throw new DelegationContractError(
      "delegation.attempt_invalid",
      "retry identity must match the explicit attempt",
    )
  }
  if (raw.engine !== "qoder" && raw.engine !== "claude-code") {
    throw new DelegationContractError(
      "delegation.engine_unsupported",
      "v1 supports only qoder and claude-code",
    )
  }
  if (
    typeof raw.instruction !== "string" ||
    raw.instruction.trim().length === 0 ||
    Buffer.byteLength(raw.instruction, "utf8") > MAX_INSTRUCTION_BYTES
  ) {
    throw new DelegationContractError(
      "delegation.instruction_invalid",
      "instruction must be non-empty and at most 20000 UTF-8 bytes",
    )
  }
  const organizationDigest = requireDigest(
    raw.organizationDigest,
    "organizationDigest",
  )
  const permissionsDigest = requireDigest(
    raw.permissionsDigest,
    "permissionsDigest",
  )
  if (
    typeof raw.deadline !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(raw.deadline) ||
    !Number.isFinite(Date.parse(raw.deadline))
  ) {
    throw new DelegationContractError(
      "delegation.deadline_invalid",
      "deadline must be an ISO 8601 timestamp",
    )
  }
  const envelopeDigest = requireDigest(raw.envelopeDigest, "envelopeDigest")
  if (envelopeDigest !== computeDelegationEnvelopeDigest(raw)) {
    throw new DelegationContractError(
      "delegation.envelope_digest_mismatch",
      "delegation envelope digest does not match its canonical body",
    )
  }
  return {
    schemaVersion: DELEGATION_ENVELOPE_VERSION,
    taskId,
    parentTurnId,
    childTurnId,
    delegatedBy,
    routedTo,
    trigger: "user_explicit",
    delegationDepth: 1,
    attempt,
    retryOfTaskId,
    engine: raw.engine,
    instruction: raw.instruction,
    organizationDigest,
    permissionsDigest,
    deadline: raw.deadline,
    envelopeDigest,
  }
}

function normalizeScope(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new DelegationContractError(
      "delegation.scope_invalid",
      "context scope must be workspace-relative",
    )
  }
  const directory = value.endsWith("/")
  const source = value.startsWith("./") ? value.slice(2) : value
  const segments = source.split("/").filter((segment) => segment && segment !== ".")
  if (segments.some((segment) => segment === "..")) {
    throw new DelegationContractError(
      "delegation.scope_invalid",
      "context scope must not traverse parents",
    )
  }
  if (segments.length === 0) return "./"
  return `./${segments.join("/")}${directory ? "/" : ""}`
}

function scopeContains(container: string, candidate: string): boolean {
  if (container === "./") return true
  const prefix = container.endsWith("/") ? container : `${container}/`
  return candidate === container || candidate.startsWith(prefix)
}

function intersectContextScopes(left: string[], right: string[]): string[] {
  const intersections: string[] = []
  for (const leftRaw of left) {
    const a = normalizeScope(leftRaw)
    for (const rightRaw of right) {
      const b = normalizeScope(rightRaw)
      if (scopeContains(a, b)) intersections.push(b)
      else if (scopeContains(b, a)) intersections.push(a)
    }
  }
  const ordered = [...new Set(intersections)].sort((a, b) =>
    a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length,
  )
  const minimal: string[] = []
  for (const scope of ordered) {
    if (!minimal.some((entry) => scopeContains(entry, scope))) minimal.push(scope)
  }
  return minimal.sort()
}

export function deriveEffectiveDelegationScope(
  parent: DelegationPositionPermissions,
  worker: DelegationPositionPermissions,
): EffectiveDelegationScope {
  const toolDeny = [
    ...new Set([
      ...parent.authorityScope.tools.deny,
      ...worker.authorityScope.tools.deny,
    ]),
  ].sort()
  const denied = new Set(toolDeny)
  const workerAllow = new Set(worker.authorityScope.tools.allow)
  const toolAllow = [
    ...new Set(
      parent.authorityScope.tools.allow.filter(
        (tool) => workerAllow.has(tool) && !denied.has(tool),
      ),
    ),
  ].sort()
  return {
    contextRead: intersectContextScopes(
      parent.contextScope.read,
      worker.contextScope.read,
    ),
    toolAllow,
    toolDeny,
    writes: "deny",
    delegation: "deny",
  }
}

export function validateDelegationAdmission(
  envelope: DelegationEnvelope,
  existing: readonly ExistingDelegationRef[],
): void {
  validateExistingDelegationHistory(existing)
  if (
    existing.some(
      (entry) =>
        entry.taskId === envelope.taskId ||
        entry.childTurnId === envelope.childTurnId,
    )
  ) {
    throw new DelegationContractError(
      "delegation.duplicate_identity",
      "taskId and childTurnId must be unique",
    )
  }
  const siblings = existing.filter(
    (entry) => entry.parentTurnId === envelope.parentTurnId,
  ).sort((left, right) => left.attempt - right.attempt)
  if (siblings.length === 0) {
    if (envelope.attempt !== 1 || envelope.retryOfTaskId !== null) {
      throw new DelegationContractError(
        "delegation.retry_invalid",
        "a retry must reference an existing attempt",
      )
    }
    return
  }
  if (envelope.retryOfTaskId === null) {
    throw new DelegationContractError(
      "delegation.second_child_denied",
      "v1 permits only one non-retry child per parent turn",
    )
  }
  const prior = siblings.at(-1)!
  if (
    envelope.retryOfTaskId !== prior.taskId ||
    envelope.attempt !== prior.attempt + 1
  ) {
    throw new DelegationContractError(
      "delegation.retry_invalid",
      "retry must reference the prior attempt and increment by one",
    )
  }
}

const HISTORY_KEYS = [
  "taskId",
  "parentTurnId",
  "childTurnId",
  "attempt",
  "retryOfTaskId",
] as const
const MAX_HISTORY_RECORDS = 1_024

function validateExistingDelegationHistory(
  existing: readonly ExistingDelegationRef[],
): void {
  if (existing.length > MAX_HISTORY_RECORDS) {
    throw new DelegationContractError(
      "delegation.history_invalid",
      "delegation history exceeds the bounded record count",
    )
  }
  const taskIds = new Set<string>()
  const childTurnIds = new Set<string>()
  const byParent = new Map<string, ExistingDelegationRef[]>()
  for (const entry of existing) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== HISTORY_KEYS.length ||
      HISTORY_KEYS.some((key) => !(key in entry))
    ) {
      throw new DelegationContractError(
        "delegation.history_invalid",
        "delegation history entries must use the exact v1 reference shape",
      )
    }
    let taskId: string
    let parentTurnId: string
    let childTurnId: string
    try {
      taskId = requireId(entry.taskId, "taskId")
      parentTurnId = requireId(entry.parentTurnId, "parentTurnId")
      childTurnId = requireId(entry.childTurnId, "childTurnId")
      if (entry.retryOfTaskId !== null) {
        requireId(entry.retryOfTaskId, "retryOfTaskId")
      }
    } catch {
      throw new DelegationContractError(
        "delegation.history_invalid",
        "delegation history contains an invalid identity",
      )
    }
    if (
      taskId === parentTurnId ||
      taskId === childTurnId ||
      parentTurnId === childTurnId ||
      taskIds.has(taskId) ||
      childTurnIds.has(childTurnId) ||
      !Number.isInteger(entry.attempt) ||
      entry.attempt < 1
    ) {
      throw new DelegationContractError(
        "delegation.history_invalid",
        "delegation history identities and attempts must be unique and bounded",
      )
    }
    taskIds.add(taskId)
    childTurnIds.add(childTurnId)
    const group = byParent.get(parentTurnId) ?? []
    group.push(entry)
    byParent.set(parentTurnId, group)
  }
  for (const entries of byParent.values()) {
    entries.sort((left, right) => left.attempt - right.attempt)
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!
      const prior = entries[index - 1]
      if (
        entry.attempt !== index + 1 ||
        (index === 0
          ? entry.retryOfTaskId !== null
          : entry.retryOfTaskId !== prior!.taskId)
      ) {
        throw new DelegationContractError(
          "delegation.history_invalid",
          "delegation history must be one contiguous linear retry chain",
        )
      }
    }
  }
}

export function parseExistingDelegationHistory(
  raw: unknown,
): ExistingDelegationRef[] {
  if (!Array.isArray(raw)) {
    throw new DelegationContractError(
      "delegation.history_invalid",
      "delegation history must be a JSON array",
    )
  }
  const history = raw as ExistingDelegationRef[]
  validateExistingDelegationHistory(history)
  return history.map((entry) => ({ ...entry }))
}

/**
 * Portable task.v1 initializer for the Workbench-owned durable task store.
 * This engine helper is pure: it never writes Workbench state.
 */
export function createRequestedTaskRecord(
  envelope: DelegationEnvelope,
  options: {
    parentConversationId: string
    childConversationId: string
    effectiveScope: EffectiveDelegationScope
    createdAt: string
  },
): RequestedTaskRecord {
  const parentConversationId = requireId(
    options.parentConversationId,
    "parentConversationId",
  )
  const childConversationId = requireId(
    options.childConversationId,
    "childConversationId",
  )
  if (!Number.isFinite(Date.parse(options.createdAt))) {
    throw new DelegationContractError(
      "delegation.task_invalid",
      "createdAt must be an ISO 8601 timestamp",
    )
  }
  const effectiveScope: EffectiveDelegationScope = {
    contextRead: [...options.effectiveScope.contextRead],
    toolAllow: [...options.effectiveScope.toolAllow],
    toolDeny: [...options.effectiveScope.toolDeny],
    writes: "deny",
    delegation: "deny",
  }
  return {
    schemaVersion: TASK_RECORD_VERSION,
    taskId: envelope.taskId,
    parentConversationId,
    childConversationId,
    parentTurnId: envelope.parentTurnId,
    childTurnId: envelope.childTurnId,
    delegatedBy: envelope.delegatedBy,
    routedTo: envelope.routedTo,
    trigger: "user_explicit",
    delegationDepth: 1,
    attempt: envelope.attempt,
    retryOfTaskId: envelope.retryOfTaskId,
    engine: envelope.engine,
    instruction: envelope.instruction,
    organizationDigest: envelope.organizationDigest,
    permissionsDigest: envelope.permissionsDigest,
    effectiveScope,
    scopeDigest: computeCanonicalDigest(effectiveScope),
    status: "requested",
    createdAt: options.createdAt,
    startedAt: null,
    cancelRequestedAt: null,
    updatedAt: options.createdAt,
    finishedAt: null,
    outputDigest: null,
    evidenceDigest: null,
    error: null,
    events: [],
  }
}

function validateRouteAndDigests(
  envelope: DelegationEnvelope,
  organization: DelegationOrganization,
  permissions: DelegationPermissions,
): EffectiveDelegationScope {
  if (
    envelope.organizationDigest !== computeCanonicalDigest(organization) ||
    envelope.permissionsDigest !== computeCanonicalDigest(permissions)
  ) {
    throw new DelegationContractError(
      "delegation.applied_state_stale",
      "organization or permission digest is stale",
    )
  }
  if (
    organization.owner !== permissions.owner ||
    envelope.delegatedBy !== organization.owner ||
    envelope.routedTo === envelope.delegatedBy
  ) {
    throw new DelegationContractError(
      "delegation.route_denied",
      "delegation must originate from the applied owner to another position",
    )
  }
  const workerRole = organization.roles.find(
    (role) => role.id === envelope.routedTo,
  )
  const parent = permissions.positions[envelope.delegatedBy]
  const worker = permissions.positions[envelope.routedTo]
  if (
    !workerRole ||
    workerRole.reportTo !== envelope.delegatedBy ||
    !parent ||
    !worker ||
    !parent.authorityScope.delegation.allow ||
    !parent.authorityScope.delegation.targets.includes(envelope.routedTo) ||
    worker.authorityScope.delegation.allow
  ) {
    throw new DelegationContractError(
      "delegation.route_denied",
      "target must be one declared direct report and downstream delegation must be denied",
    )
  }
  const scope = deriveEffectiveDelegationScope(parent, worker)
  if (scope.contextRead.length === 0) {
    throw new DelegationContractError(
      "delegation.context_denied",
      "parent and worker have no shared context scope",
    )
  }
  return scope
}

function validateTerminalError(error: DelegationTerminalError): void {
  if (
    !ERROR_CODE_PATTERN.test(error.code) ||
    typeof error.message !== "string" ||
    Buffer.byteLength(error.message, "utf8") > 2_000 ||
    typeof error.retryable !== "boolean"
  ) {
    throw new DelegationContractError(
      "delegation.child_terminal_invalid",
      "child terminal error violates the bounded contract",
    )
  }
}

export interface ExecuteDelegationOptions {
  organization: DelegationOrganization
  permissions: DelegationPermissions
  childExecutor: DelegationChildExecutorPort
  existingDelegations?: readonly ExistingDelegationRef[]
  now?: () => Date
  newId?: () => string
  runId?: () => string
  signal?: AbortSignal
}

export async function* executeDelegation(
  envelope: DelegationEnvelope,
  options: ExecuteDelegationOptions,
): AsyncGenerator<DelegationEvent> {
  validateDelegationAdmission(envelope, options.existingDelegations ?? [])
  const effectiveScope = validateRouteAndDigests(
    envelope,
    options.organization,
    options.permissions,
  )
  const now = options.now ?? (() => new Date())
  const newId = options.newId ?? (() => randomUUID())
  const childRunId = options.runId?.() ?? randomUUID()
  let sequence = 0
  const common = (timestamp = now().toISOString()) => ({
    schemaVersion: DELEGATION_EVENT_VERSION,
    eventId: newId(),
    sequence: ++sequence,
    producer: "engine" as const,
    taskId: envelope.taskId,
    parentTurnId: envelope.parentTurnId,
    childTurnId: envelope.childTurnId,
    delegatedBy: envelope.delegatedBy,
    routedTo: envelope.routedTo,
    delegationDepth: 1 as const,
    attempt: envelope.attempt,
    timestamp,
  })
  const scopeDigest = computeCanonicalDigest(effectiveScope)
  let startedAt: string | undefined
  const usage: Array<{
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }> = []
  let result: DelegationChildRunResult
  try {
    result = await options.childExecutor.run({
      runId: childRunId,
      engine: envelope.engine,
      positionId: envelope.routedTo,
      instruction: envelope.instruction,
      deadline: envelope.deadline,
      effectiveScope,
      ...(options.signal ? { signal: options.signal } : {}),
      onStarted: () => {
        startedAt ??= now().toISOString()
      },
      onUsage: (entry) => {
        if (!startedAt) return
        const bounded: typeof entry = {}
        for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
          const value = entry[key]
          if (value !== undefined && Number.isSafeInteger(value) && value >= 0) {
            bounded[key] = value
          }
        }
        if (Object.keys(bounded).length > 0) usage.push(bounded)
      },
    })
  } catch (error) {
    if (startedAt) {
      yield {
        ...common(startedAt),
        type: "delegation.started",
        payload: { scopeDigest },
      }
    }
    throw error
  }
  if (!startedAt) {
    throw new DelegationContractError(
      "delegation.child_indeterminate",
      "child Host settled without a validated run.started event",
    )
  }
  yield {
    ...common(startedAt),
    type: "delegation.started",
    payload: { scopeDigest },
  }
  for (const payload of usage) {
    yield { ...common(), type: "delegation.usage", payload }
  }

  if (result.status === "completed") {
    const outputDigest = computeCanonicalDigest(result.output)
    const evidenceDigest = computeCanonicalDigest({
      schemaVersion: "delegation-evidence.v1",
      taskId: envelope.taskId,
      parentTurnId: envelope.parentTurnId,
      childTurnId: envelope.childTurnId,
      runId: childRunId,
      engine: envelope.engine,
      organizationDigest: envelope.organizationDigest,
      permissionsDigest: envelope.permissionsDigest,
      scopeDigest,
      outputDigest,
    })
    yield {
      ...common(),
      type: "delegation.completed",
      payload: { runId: childRunId, outputDigest, evidenceDigest },
    }
    return
  }
  validateTerminalError(result.error)
  yield {
    ...common(),
    type:
      result.status === "cancelled"
        ? "delegation.cancelled"
        : "delegation.failed",
    payload: { runId: childRunId, error: { ...result.error } },
  }
}
