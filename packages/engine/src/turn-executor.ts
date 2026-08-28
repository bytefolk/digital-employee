import { createHash, randomUUID } from "node:crypto"

import type { SafeValue } from "../../core/src/contracts.js"
import {
  ContextPortError,
  deriveContextPrincipal,
  type ContextBundle,
  type ContextPort,
} from "../../core/src/context-port.js"
import {
  derivePositionPrincipal,
  MemoryPortError,
  MEMORY_RECALL_SCHEMA_VERSION,
  type MemoryPort,
  type MemoryRecall,
  type MemoryRecallProvenance,
} from "../../core/src/memory-port.js"

import {
  checkPositionBudget,
  emptyBudgetUsage,
  type BudgetExceeded,
  type BudgetLedgerPort,
  type BudgetUsage,
} from "./budget.js"
import {
  APPROVAL_DENIED_CODE,
  APPROVAL_EXPIRED_CODE,
  APPROVAL_PREVIEW_INVALID_CODE,
  APPROVAL_REQUIRED_CODE,
  pendingApprovalExpired,
  previewGateAllows,
} from "./approval.js"
import {
  terminalError,
  validateTurnRequest,
  ENGINE_VERSION,
  type EngineEvent,
  type EngineTurnRequest,
  type TerminalReason,
} from "./contracts.js"
import { assembleContext } from "./context-assembler.js"
import { DoomLoopDetector, type DoomLoopConfig } from "./doom-loop.js"
import {
  resolveEscalationRouting,
  ESCALATION_RECORD_VERSION,
  type EscalationBudgetSnapshot,
  type EscalationCause,
  type EscalationRecord,
  type EscalationSinkPort,
  type OrgReportingLookup,
} from "./escalation.js"
import type { ModelPort, OutputViolation } from "./model-port.js"
import {
  createPermissionGate,
  validateOrganizationPermissionsArtifact,
  type OrganizationPermissions,
  type PermissionGate,
} from "./org-permissions.js"
import {
  OutputSchemaGuardError,
  prepareTerminalSchema,
} from "./output-schema-guard.js"
import {
  digestOutputValue,
  NO_ASSEMBLY_DIGEST,
  NO_CONTEXT_BUNDLE_DIGEST,
  TURN_EVIDENCE_VERSION,
  type EvidenceSinkPort,
  type TurnEvidenceApprovalRef,
  type TurnEvidenceContext,
  type TurnEvidenceMemory,
  type TurnEvidenceRecord,
} from "./turn-evidence.js"

/**
 * Memory-recall seam configuration (#180 wiring, consumed through #209).
 * Disabled by default: recall happens only when `enabled` is exactly true.
 * The port instance is pinned to one workspace instance + position +
 * memoryScope binding (#181); the engine passes the pinned scope through
 * unchanged and never accepts scope supplied or widened by turn input.
 * `adapterIdentity` is the bounded machine identity of the pinned adapter
 * (e.g. "mem-http.v1"); it is validated before any port call and recorded
 * in turn evidence (#209 REQ-001). The port contract itself stays frozen.
 */
export interface EngineMemoryOptions {
  port: MemoryPort
  enabled: boolean
  workspaceInstanceId: string
  sessionId: string
  memoryScope: string
  mode: "optional" | "required"
  adapterIdentity: string
  limit?: number
}

/**
 * Workbench-context seam configuration (#179). Disabled by default: recall
 * happens only when `enabled` is exactly true. The port instance is pinned
 * to one workspace + position binding through the granted runtime token;
 * the engine derives the principal itself and never accepts scope supplied
 * or widened by turn input. Recalled context is quoted untrusted data for
 * the context_bundle slot; evidence keeps digests only.
 */
export interface EngineContextOptions {
  port: ContextPort
  enabled: boolean
  workspaceId: string
  mode: "optional" | "required"
  adapterIdentity: string
  maxItems?: number
  maxBytes?: number
}

/** Bounded machine identity: leading alnum, then `[A-Za-z0-9._:@-]`, ≤128. */
const ADAPTER_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/

/**
 * Canonical digest over a recall item's provenance block (#209 REQ-001).
 * Provenance enters evidence only through this digest — never as raw
 * fields — keeping the evidence record digest-only and identity-free.
 */
function digestProvenance(provenance: MemoryRecallProvenance): string {
  const canonical = JSON.stringify(provenance, Object.keys(provenance).sort())
  return createHash("sha256").update(canonical ?? "{}", "utf8").digest("hex")
}

export interface TurnExecutorOptions {
  model: ModelPort
  now?: () => Date
  budgetLedger?: BudgetLedgerPort
  escalationSink?: EscalationSinkPort
  evidenceSink?: EvidenceSinkPort
  orgLookup?: OrgReportingLookup
  doomLoop?: Partial<DoomLoopConfig>
  memory?: EngineMemoryOptions
  context?: EngineContextOptions
  newId?: () => string
}

function timestamp(now: () => Date): string {
  return now().toISOString()
}

const REASON_TO_CODE: Readonly<Record<TerminalReason, string>> = {
  goal_met: "engine.goal_met",
  invalid_output_exhausted: "engine.output_invalid",
  turn_budget_exceeded: "engine.turn_budget_exceeded",
  position_budget_exceeded: "engine.position_budget_exceeded",
  iteration_cap: "engine.iteration_cap_reached",
  doom_loop: "engine.doom_loop_detected",
  deadline_exceeded: "engine.deadline_exceeded",
  cancelled: "engine.cancelled",
  permission_denied: "engine.permission_denied",
  memory_unavailable: "engine.memory_unavailable",
  memory_denied: "engine.memory_denied",
  context_unavailable: "engine.context_unavailable",
  context_denied: "engine.context_denied",
  engine_internal_error: "engine.internal_error",
}

const RETRYABLE_REASONS: ReadonlySet<TerminalReason> = new Set([
  "invalid_output_exhausted",
  "deadline_exceeded",
  "memory_unavailable",
  "context_unavailable",
  "engine_internal_error",
])

/**
 * Executes exactly one turn and yields a stream with a single trusted
 * terminal event (`run.completed` or `run.failed`).
 *
 * S1 loop shape — the ONLY iteration source in the read-only core is the
 * output validate/repair cycle. There is no tool dispatch branch anywhere in
 * this path; the model port returns text only. On top of that loop this slice
 * layers dual-dimension budget consumption (turn + position), deterministic
 * doom-loop detection, and the fail-safe stop sequence: stop consuming ->
 * escalation record along the reporting line -> per-turn evidence -> stable
 * terminal. A turn without evidence is a failed turn.
 */
export async function* executeTurn(
  rawRequest: EngineTurnRequest,
  options: TurnExecutorOptions,
): AsyncGenerator<EngineEvent> {
  const now = options.now ?? (() => new Date())
  const newId = options.newId ?? (() => randomUUID())
  const runId = typeof rawRequest.runId === "string" ? rawRequest.runId : ""
  const startedAt = timestamp(now)
  let terminated = false
  let approvalRef: TurnEvidenceApprovalRef | undefined

  const fail = (
    code: string,
    message: string,
    terminalReason: TerminalReason,
    retryable = RETRYABLE_REASONS.has(terminalReason),
  ): EngineEvent => {
    terminated = true
    return {
      type: "run.failed",
      runId,
      timestamp: timestamp(now),
      error: terminalError(code, message, terminalReason, retryable),
    }
  }

  // Permission pre-check (#159 REQ-004(a)): enforced before any lifecycle
  // event is emitted and before any model consumption. Unknown positions and
  // out-of-scope requests fail closed with stable workspace_org_* codes; each
  // denial is recorded in turn evidence with zero content from the denied
  // resource (#159 REQ-005, AC-006, AC-007).
  let permissionGate: PermissionGate | undefined
  if (rawRequest.permissions !== undefined) {
    let parsedPermissions: OrganizationPermissions
    try {
      parsedPermissions = validateOrganizationPermissionsArtifact(
        rawRequest.permissions,
      )
    } catch {
      yield fail(
        "engine.permissions_invalid",
        "permissions artifact is missing or malformed",
        "engine_internal_error",
        false,
      )
      return
    }
    permissionGate = createPermissionGate(parsedPermissions)
    let deniedCode:
      | "workspace_org_position_unknown"
      | "workspace_org_context_denied"
      | "workspace_org_authority_denied"
      | undefined
    let deniedMessage = ""
    const positionCheck = permissionGate.checkPosition(rawRequest.positionId)
    if (!positionCheck.ok) {
      deniedCode = "workspace_org_position_unknown"
      deniedMessage = `position not present in the permissions artifact: ${positionCheck.unknown}`
    } else {
      for (const requested of rawRequest.contextReadRequests ?? []) {
        const decision = permissionGate.evaluateContextRead(
          rawRequest.positionId,
          requested,
        )
        if (decision.status === "denied") {
          deniedCode = decision.code
          deniedMessage = `context read out of scope: ${requested}`
          break
        }
      }
      if (deniedCode === undefined) {
        for (const tool of rawRequest.toolRequests ?? []) {
          const decision = permissionGate.evaluateToolCall(
            rawRequest.positionId,
            tool,
          )
          if (decision.status === "denied") {
            deniedCode = decision.code
            deniedMessage = `tool call out of authority: ${tool}`
            break
          }
        }
      }
    }
    if (deniedCode !== undefined) {
      const ownerRedirect = rawRequest.permissions.owner
      const denials =
        deniedCode === "workspace_org_position_unknown"
          ? [
              {
                positionId: rawRequest.positionId,
                requested: rawRequest.positionId,
                code: deniedCode,
                redirectTo: ownerRedirect,
              },
            ]
          : [...permissionGate.denialAttempts()]
      const summary =
        deniedCode === "workspace_org_position_unknown"
          ? {
              allowCount: 0,
              denyCount: 1,
              codesSeen: [deniedCode],
              redirectToTargets: [ownerRedirect],
            }
          : permissionGate.summary()
      if (options.evidenceSink) {
        const record: TurnEvidenceRecord = {
          schemaVersion: TURN_EVIDENCE_VERSION,
          evidenceId: newId(),
          workspaceRef: rawRequest.workspaceRef,
          positionId: rawRequest.positionId,
          turnId: rawRequest.turnId,
          runId,
          engineVersion: ENGINE_VERSION,
          inputDigest: digestOutputValue(rawRequest.input),
          outputDigest: digestOutputValue(null),
          budget: {
            turn: {
              iterationsUsed: 0,
              tokensUsed: 0,
              maxIterations: rawRequest.budget?.maxIterations ?? 0,
              ...(rawRequest.budget?.maxTokens !== undefined
                ? { maxTokens: rawRequest.budget.maxTokens }
                : {}),
            },
          },
          terminal: {
            status: "failed",
            reason: "permission_denied",
            errorCode: deniedCode,
          },
          permissions: { summary, denials },
          assemblyManifestDigest: NO_ASSEMBLY_DIGEST,
          timeBounds: { startedAt, completedAt: timestamp(now) },
        }
        try {
          await options.evidenceSink.write(record)
        } catch {
          yield fail(
            "engine.internal_error",
            "permission denial evidence write failed",
            "engine_internal_error",
            false,
          )
          return
        }
      }
      yield fail(deniedCode, deniedMessage, "permission_denied", false)
      return
    }
  }

  yield { type: "run.started", runId, timestamp: timestamp(now) }

  let request: EngineTurnRequest
  try {
    request = validateTurnRequest(rawRequest)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "turn request rejected"
    yield fail("engine.input_invalid", message, "engine_internal_error", false)
    return
  }

  let schema
  try {
    schema = prepareTerminalSchema(request.outputSchema)
  } catch (error) {
    if (error instanceof OutputSchemaGuardError) {
      yield fail(error.code, error.message, "engine_internal_error", false)
      return
    }
    yield fail(
      "engine.output_schema_invalid",
      "output schema preparation failed",
      "engine_internal_error",
      false,
    )
    return
  }

  // Memory-recall seam (#180): runs before any model consumption. Disabled
  // by default; when enabled the pinned port is called with the pinned scope
  // (never supplied or widened by turn input). Recalled text is untrusted
  // data for the memory_recall slot; evidence keeps digests only.
  let recallLines: string[] = []
  let memoryEvidence: TurnEvidenceMemory | undefined
  if (options.memory && options.memory.enabled === true) {
    const memoryOptions = options.memory
    // Bad configuration fails closed before any port call (#209 REQ-004):
    // the adapter identity must be a bounded machine identifier.
    if (!ADAPTER_IDENTITY_PATTERN.test(memoryOptions.adapterIdentity ?? "")) {
      yield fail(
        REASON_TO_CODE.memory_denied,
        "memory adapter identity is missing or malformed",
        "memory_denied",
        false,
      )
      return
    }
    let recall: MemoryRecall | undefined
    try {
      recall = await memoryOptions.port.recall({
        workspaceInstanceId: memoryOptions.workspaceInstanceId,
        sessionId: memoryOptions.sessionId,
        positionId: request.positionId,
        principal: derivePositionPrincipal(request.positionId),
        memoryScope: memoryOptions.memoryScope,
        mode: memoryOptions.mode,
        ...(memoryOptions.limit !== undefined
          ? { limit: memoryOptions.limit }
          : {}),
      })
    } catch (error) {
      const portCode =
        error instanceof MemoryPortError ? error.code : undefined
      if (
        memoryOptions.mode === "optional" &&
        portCode === "MEMORY_UNAVAILABLE"
      ) {
        // Typed outage in optional mode: empty recall plus one warning; the
        // turn proceeds without memory.
        memoryEvidence = {
          mode: "optional",
          adapterIdentity: memoryOptions.adapterIdentity,
          retrievedAt: timestamp(now),
          itemCount: 0,
          totalBytes: 0,
          items: [],
          warnings: [{ code: "MEMORY_UNAVAILABLE" }],
        }
      } else if (portCode === "MEMORY_UNAVAILABLE") {
        // Required-mode outage: stable retryable failure before model call.
        yield fail(
          REASON_TO_CODE.memory_unavailable,
          "durable memory is unavailable in required mode",
          "memory_unavailable",
          true,
        )
        return
      } else {
        // Denial, scope mismatch, malformed record, bad configuration, or
        // unsupported contract: fail closed in both modes.
        yield fail(
          REASON_TO_CODE.memory_denied,
          portCode !== undefined
            ? `memory recall failed closed: ${portCode}`
            : "memory recall failed closed",
          "memory_denied",
          false,
        )
        return
      }
    }
    if (recall !== undefined) {
      if (recall.schemaVersion !== MEMORY_RECALL_SCHEMA_VERSION) {
        yield fail(
          REASON_TO_CODE.memory_denied,
          "memory recall returned an unexpected wire schema version",
          "memory_denied",
          false,
        )
        return
      }
      recallLines = recall.items.map((item) => item.text)
      memoryEvidence = {
        mode: memoryOptions.mode,
        adapterIdentity: memoryOptions.adapterIdentity,
        retrievedAt: recall.retrievedAt,
        itemCount: recall.items.length,
        totalBytes: recall.items.reduce(
          (sum, item) => sum + Buffer.byteLength(item.text, "utf8"),
          0,
        ),
        items: recall.items.map((item) => ({
          digest: item.digest,
          locator: item.locator,
          kind: item.kind,
          stateVersion: item.stateVersion,
          byteLength: Buffer.byteLength(item.text, "utf8"),
          provenanceDigest: digestProvenance(item.provenance),
        })),
        warnings: recall.warnings.map((warning) => ({ code: warning.code })),
      }
    }
  }

  // Workbench-context seam (#179): runs before any model consumption.
  // Disabled by default; when enabled the pinned port is called with the
  // derived principal (never supplied or widened by turn input). Recalled
  // context is untrusted data for the context_bundle slot; evidence keeps
  // digests only.
  let contextLines: string[] = []
  let contextEvidence: TurnEvidenceContext | undefined
  if (options.context && options.context.enabled === true) {
    const contextOptions = options.context
    // Bad configuration fails closed before any port call: the adapter
    // identity must be a bounded machine identifier.
    if (!ADAPTER_IDENTITY_PATTERN.test(contextOptions.adapterIdentity ?? "")) {
      yield fail(
        REASON_TO_CODE.context_denied,
        "context adapter identity is missing or malformed",
        "context_denied",
        false,
      )
      return
    }
    let bundle: ContextBundle | undefined
    try {
      bundle = await contextOptions.port.recall({
        workspaceId: contextOptions.workspaceId,
        positionId: request.positionId,
        principal: deriveContextPrincipal(request.positionId),
        mode: contextOptions.mode,
        ...(contextOptions.maxItems !== undefined
          ? { maxItems: contextOptions.maxItems }
          : {}),
        ...(contextOptions.maxBytes !== undefined
          ? { maxBytes: contextOptions.maxBytes }
          : {}),
      })
    } catch (error) {
      const portCode =
        error instanceof ContextPortError ? error.code : undefined
      if (
        contextOptions.mode === "optional" &&
        portCode === "CONTEXT_UNAVAILABLE"
      ) {
        // Typed outage in optional mode: empty context plus one warning;
        // the turn proceeds without workbench context.
        contextEvidence = {
          mode: "optional",
          adapterIdentity: contextOptions.adapterIdentity,
          retrievedAt: timestamp(now),
          bundleDigest: NO_CONTEXT_BUNDLE_DIGEST,
          watermarkRevision: 0,
          itemCount: 0,
          totalBytes: 0,
          items: [],
          warnings: [{ code: "CONTEXT_UNAVAILABLE" }],
        }
      } else if (portCode === "CONTEXT_UNAVAILABLE") {
        // Required-mode outage: stable retryable failure before model call.
        yield fail(
          REASON_TO_CODE.context_unavailable,
          "workbench context is unavailable in required mode",
          "context_unavailable",
          true,
        )
        return
      } else {
        // Denial, scope mismatch, corrupt record, bad configuration, or an
        // invalid envelope: fail closed in both modes.
        yield fail(
          REASON_TO_CODE.context_denied,
          portCode !== undefined
            ? `context recall failed closed: ${portCode}`
            : "context recall failed closed",
          "context_denied",
          false,
        )
        return
      }
    }
    if (bundle !== undefined) {
      // Defense in depth: the pinned port already enforced the exact scope,
      // and the engine re-asserts it before projection.
      if (
        bundle.scope.workspaceId !== contextOptions.workspaceId ||
        bundle.scope.positionId !== request.positionId ||
        bundle.scope.principal !== deriveContextPrincipal(request.positionId)
      ) {
        yield fail(
          REASON_TO_CODE.context_denied,
          "context recall returned a bundle outside the pinned scope",
          "context_denied",
          false,
        )
        return
      }
      contextLines = bundle.items.map((item) => item.text)
      contextEvidence = {
        mode: contextOptions.mode,
        adapterIdentity: contextOptions.adapterIdentity,
        retrievedAt: bundle.retrievedAt,
        bundleDigest: bundle.bundleDigest,
        watermarkRevision: bundle.completedWatermark.occurrenceRevision,
        itemCount: bundle.items.length,
        totalBytes: bundle.items.reduce(
          (sum, item) => sum + Buffer.byteLength(item.text, "utf8"),
          0,
        ),
        items: bundle.items.map((item) => ({
          artifactDigest: item.artifactDigest,
          locator: item.locator,
          kind: item.kind,
          sourceRevision: item.sourceRevision,
          derivedRevision: item.derivedRevision,
          byteLength: Buffer.byteLength(item.text, "utf8"),
        })),
        warnings: bundle.warnings.map((code) => ({ code })),
      }
    }
  }

  const assembled = assembleContext({
    positionId: request.positionId,
    turnId: request.turnId,
    instructions: request.position?.instructions,
    spec: request.position?.spec,
    turnInput:
      typeof request.input === "string"
        ? request.input
        : JSON.stringify(request.input),
    memoryRecall: recallLines,
    contextBundle: contextLines,
  })

  const detector = new DoomLoopDetector(options.doomLoop)
  const violations: OutputViolation[] = []
  const maxIterations = request.budget.maxIterations
  const maxTokens = request.budget.maxTokens
  const ledger = options.budgetLedger
  const declaration = request.positionBudget
  const usePositionBudget = Boolean(
    declaration && ledger && request.taskId && request.dayKey,
  )

  let iterationsUsed = 0
  let tokensUsed = 0
  let positionUsage: BudgetUsage = emptyBudgetUsage()

  if (usePositionBudget) {
    positionUsage = await ledger!.read(
      request.positionId,
      request.taskId!,
      request.dayKey!,
    )
  }

  const writeEscalation = async (
    cause: EscalationCause,
    snapshot: EscalationBudgetSnapshot,
  ): Promise<string | undefined> => {
    if (!options.escalationSink) return undefined
    const escalationId = newId()
    const record: EscalationRecord = {
      schemaVersion: ESCALATION_RECORD_VERSION,
      escalationId,
      workspaceRef: request.workspaceRef,
      positionId: request.positionId,
      turnId: request.turnId,
      runId: request.runId,
      cause,
      budgetSnapshot: snapshot,
      routing: resolveEscalationRouting(request.positionId, options.orgLookup),
      occurredAt: timestamp(now),
    }
    await options.escalationSink.write(record)
    return escalationId
  }

  const writeEvidence = async (
    terminal: {
      status: "completed" | "failed"
      reason: string
      errorCode?: string
    },
    output: SafeValue,
    escalationRef?: string,
  ): Promise<void> => {
    if (!options.evidenceSink) return
    const record: TurnEvidenceRecord = {
      schemaVersion: TURN_EVIDENCE_VERSION,
      evidenceId: newId(),
      workspaceRef: request.workspaceRef,
      positionId: request.positionId,
      turnId: request.turnId,
      runId: request.runId,
      engineVersion: ENGINE_VERSION,
      inputDigest: assembled.manifest.digest,
      outputDigest: digestOutputValue(output),
      budget: {
        turn: {
          iterationsUsed,
          tokensUsed,
          maxIterations,
          ...(maxTokens !== undefined ? { maxTokens } : {}),
        },
        ...(usePositionBudget ? { position: positionUsage } : {}),
      },
      terminal,
      ...(escalationRef !== undefined ? { escalationRef } : {}),
      ...(approvalRef !== undefined ? { approvalRef } : {}),
      ...(permissionGate !== undefined
        ? {
            permissions: {
              summary: permissionGate.summary(),
              denials: [...permissionGate.denialAttempts()],
            },
          }
        : {}),
      ...(memoryEvidence !== undefined ? { memory: memoryEvidence } : {}),
      ...(contextEvidence !== undefined ? { context: contextEvidence } : {}),
      assemblyManifestDigest: assembled.manifest.digest,
      timeBounds: { startedAt, completedAt: timestamp(now) },
    }
    await options.evidenceSink.write(record)
  }

  /**
   * The single fail-safe stop path for governance stops: persist the
   * escalation record along the reporting line and the per-turn evidence
   * first, then surface the stable terminal. Persistence precedes the
   * terminal event so an unrecorded stop can never masquerade as a clean
   * one; if side effects fail, the turn fails closed instead.
   */
  const stopWithEscalation = async function* (
    terminalReason: TerminalReason,
    message: string,
    cause: EscalationCause,
    snapshot: EscalationBudgetSnapshot,
  ): AsyncGenerator<EngineEvent> {
    let escalationRef: string | undefined
    try {
      escalationRef = await writeEscalation(cause, snapshot)
      await writeEvidence(
        {
          status: "failed",
          reason: terminalReason,
          errorCode: REASON_TO_CODE[terminalReason],
        },
        null,
        escalationRef,
      )
    } catch {
      yield fail(
        "engine.internal_error",
        "stop sequence side effects failed",
        "engine_internal_error",
        false,
      )
      return
    }
    yield fail(REASON_TO_CODE[terminalReason], message, terminalReason)
  }

  // --- Approval gate (#187, Option 1 terminal-and-resume) ---
  // Runs before any model consumption. The resume turn consumes the
  // operator verdict carried by its sealed envelope; the request turn
  // settles as a retryable failure carrying approval.requested. Approval
  // settlement reuses the existing TerminalReason enumeration ("cancelled":
  // a governed, operator-visible stop) and is distinguished by error code —
  // no new terminal reasons are introduced.
  const pendingApproval = request.pendingApproval
  const approvalAction = request.approvalAction
  if (pendingApproval !== undefined) {
    if (pendingApprovalExpired(pendingApproval, now().getTime())) {
      approvalRef = {
        approvalId: pendingApproval.approvalId,
        outcome: "expired",
      }
      try {
        await writeEvidence(
          {
            status: "failed",
            reason: "cancelled",
            errorCode: APPROVAL_EXPIRED_CODE,
          },
          null,
        )
      } catch {
        yield fail(
          "engine.internal_error",
          "approval settlement side effects failed",
          "engine_internal_error",
          false,
        )
        return
      }
      yield fail(
        APPROVAL_EXPIRED_CODE,
        "pending approval verdict is expired or unusable; fail closed, re-issue the verdict",
        "cancelled",
        false,
      )
      return
    }
    if (pendingApproval.decision === "denied") {
      // Denied terminal (#187 AC-003): no automatic retry, no downgrade to
      // an unapproved write. Evidence precedes the event and the terminal so
      // an unrecorded denial can never masquerade as a clean settlement.
      approvalRef = {
        approvalId: pendingApproval.approvalId,
        outcome: "denied",
      }
      try {
        await writeEvidence(
          {
            status: "failed",
            reason: "cancelled",
            errorCode: APPROVAL_DENIED_CODE,
          },
          null,
        )
      } catch {
        yield fail(
          "engine.internal_error",
          "approval settlement side effects failed",
          "engine_internal_error",
          false,
        )
        return
      }
      yield {
        type: "approval.denied",
        runId,
        timestamp: timestamp(now),
        approvalId: pendingApproval.approvalId,
        deniedBy: "operator",
        ...(pendingApproval.reason !== undefined
          ? { reason: pendingApproval.reason }
          : {}),
      }
      yield fail(
        APPROVAL_DENIED_CODE,
        "operator denied the approval; the turn settles without retry",
        "cancelled",
        false,
      )
      return
    }
    // Granted: the event is the authoritative record of the verdict being
    // consumed at the trust boundary, emitted before executing the action.
    approvalRef = {
      approvalId: pendingApproval.approvalId,
      outcome: "granted",
    }
    yield {
      type: "approval.granted",
      runId,
      timestamp: timestamp(now),
      approvalId: pendingApproval.approvalId,
      grantedBy: "operator",
      scope: pendingApproval.scope ?? "once",
    }
  } else if (approvalAction !== undefined) {
    const gate = previewGateAllows(approvalAction)
    if (!gate.allowed) {
      // Preview-first fail-closed (#187 AC-001): a write action without a
      // validated write-approval.v1 preview cannot express an approval
      // request, aligned with undeclared_tool / approval_not_configured
      // guard semantics.
      try {
        await writeEvidence(
          {
            status: "failed",
            reason: "engine_internal_error",
            errorCode: gate.code,
          },
          null,
        )
      } catch {
        yield fail(
          "engine.internal_error",
          "approval settlement side effects failed",
          "engine_internal_error",
          false,
        )
        return
      }
      yield fail(gate.code!, gate.message!, "engine_internal_error", false)
      return
    }
    const approvalId = newId()
    approvalRef = {
      approvalId,
      previewId: approvalAction.preview.previewId,
      outcome: "requested",
    }
    try {
      await writeEvidence(
        {
          status: "failed",
          reason: "cancelled",
          errorCode: APPROVAL_REQUIRED_CODE,
        },
        null,
      )
    } catch {
      yield fail(
        "engine.internal_error",
        "approval settlement side effects failed",
        "engine_internal_error",
        false,
      )
      return
    }
    yield {
      type: "approval.requested",
      runId,
      timestamp: timestamp(now),
      approvalId,
      action: {
        kind: approvalAction.kind,
        description: approvalAction.description,
        ...(approvalAction.target !== undefined
          ? { target: approvalAction.target }
          : {}),
      },
      ...(request.deadline !== undefined
        ? { expiresAt: request.deadline }
        : {}),
    }
    yield fail(
      APPROVAL_REQUIRED_CODE,
      "turn stopped at the capability gate awaiting an operator approval verdict; resume with a turn carrying pendingApproval",
      "cancelled",
      true,
    )
    return
  }

  try {
    for (let attempt = 1; attempt <= maxIterations; attempt += 1) {
      if (request.signal?.aborted) {
        await writeEvidence(
          {
            status: "failed",
            reason: "cancelled",
            errorCode: REASON_TO_CODE.cancelled,
          },
          null,
        ).catch(() => undefined)
        yield fail("engine.cancelled", "turn cancelled", "cancelled", false)
        return
      }
      if (
        request.deadline !== undefined &&
        now().getTime() > Date.parse(request.deadline)
      ) {
        yield* stopWithEscalation(
          "deadline_exceeded",
          "turn deadline exceeded",
          "deadline_exceeded",
          { dimension: "none", used: 0, limit: 0 },
        )
        return
      }

      // Turn token budget is checked before consuming another iteration.
      if (maxTokens !== undefined && tokensUsed > maxTokens) {
        yield* stopWithEscalation(
          "turn_budget_exceeded",
          "turn token budget exceeded",
          "turn_budget_exceeded",
          { dimension: "turn_tokens", used: tokensUsed, limit: maxTokens },
        )
        return
      }

      // Position budget pre-check (day -> task) before consuming the
      // iteration.
      if (usePositionBudget) {
        const preExceeded = checkPositionBudget(declaration!, positionUsage, {
          tokens: 0,
          iterations: 1,
        })
        if (preExceeded) {
          yield* stopWithEscalation(
            "position_budget_exceeded",
            "position budget exceeded",
            "position_budget_exceeded",
            preExceeded,
          )
          return
        }
      }

      const result = await options.model.complete(
        { blocks: assembled.blocks, priorViolations: [...violations] },
        request.signal,
      )

      iterationsUsed += 1
      const callTokens =
        (typeof result.inputTokens === "number" ? result.inputTokens : 0) +
        (typeof result.outputTokens === "number" ? result.outputTokens : 0)
      tokensUsed += callTokens

      if (
        typeof result.inputTokens === "number" ||
        typeof result.outputTokens === "number"
      ) {
        yield {
          type: "usage",
          runId,
          timestamp: timestamp(now),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        }
      }

      // Commit actual consumption, then re-check the position budget.
      if (usePositionBudget) {
        await ledger!.commit({
          positionId: request.positionId,
          taskId: request.taskId!,
          dayKey: request.dayKey!,
          tokens: callTokens,
          iterations: 1,
        })
        positionUsage = await ledger!.read(
          request.positionId,
          request.taskId!,
          request.dayKey!,
        )
        const postExceeded = checkPositionBudget(declaration!, positionUsage, {
          tokens: 0,
          iterations: 0,
        })
        if (postExceeded) {
          yield* stopWithEscalation(
            "position_budget_exceeded",
            "position budget exceeded",
            "position_budget_exceeded",
            postExceeded,
          )
          return
        }
      }

      // Turn token budget after consumption.
      if (maxTokens !== undefined && tokensUsed > maxTokens) {
        yield* stopWithEscalation(
          "turn_budget_exceeded",
          "turn token budget exceeded",
          "turn_budget_exceeded",
          { dimension: "turn_tokens", used: tokensUsed, limit: maxTokens },
        )
        return
      }

      yield {
        type: "model.delta",
        runId,
        timestamp: timestamp(now),
        text: result.text,
      }

      // Deterministic doom-loop detection on the output stream.
      const doomSignal = detector.observe(result.text)
      if (doomSignal !== "none") {
        yield* stopWithEscalation(
          "doom_loop",
          `doom loop detected (${doomSignal})`,
          "doom_loop",
          { dimension: "none", used: 0, limit: 0 },
        )
        return
      }

      if (schema === undefined) {
        await writeEvidence(
          { status: "completed", reason: "goal_met" },
          result.text,
        )
        terminated = true
        yield {
          type: "run.completed",
          runId,
          timestamp: timestamp(now),
          output: result.text,
          terminalReason: "goal_met",
        }
        return
      }

      let candidate: unknown
      try {
        candidate = JSON.parse(result.text)
      } catch {
        violations.push({ attempt, summary: "output is not valid JSON" })
        continue
      }

      if (schema.validate(candidate)) {
        await writeEvidence(
          { status: "completed", reason: "goal_met" },
          candidate as SafeValue,
        )
        terminated = true
        yield {
          type: "run.completed",
          runId,
          timestamp: timestamp(now),
          output: candidate as SafeValue,
          terminalReason: "goal_met",
        }
        return
      }

      violations.push({
        attempt,
        summary: "output failed terminal schema validation",
      })
    }

    // Loop exhausted: distinguish schema-repair exhaustion from a bare cap.
    if (schema === undefined) {
      yield* stopWithEscalation(
        "iteration_cap",
        "iteration budget exhausted",
        "iteration_cap",
        { dimension: "none", used: iterationsUsed, limit: maxIterations },
      )
      return
    }
    await writeEvidence(
      {
        status: "failed",
        reason: "invalid_output_exhausted",
        errorCode: REASON_TO_CODE.invalid_output_exhausted,
      },
      null,
    )
    yield fail(
      "engine.output_invalid",
      "output failed terminal schema validation after bounded repair attempts",
      "invalid_output_exhausted",
      true,
    )
  } catch (error) {
    if (terminated) return
    const message =
      error instanceof Error ? error.message : "engine execution failed"
    await writeEvidence(
      {
        status: "failed",
        reason: "engine_internal_error",
        errorCode: REASON_TO_CODE.engine_internal_error,
      },
      null,
    ).catch(() => undefined)
    yield fail("engine.internal_error", message, "engine_internal_error", true)
  }
}
