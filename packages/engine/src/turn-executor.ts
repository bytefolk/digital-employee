import { randomUUID } from "node:crypto"

import type { SafeValue } from "../../core/src/contracts.js"

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
  OutputSchemaGuardError,
  prepareTerminalSchema,
} from "./output-schema-guard.js"
import {
  digestOutputValue,
  TURN_EVIDENCE_VERSION,
  type EvidenceSinkPort,
  type TurnEvidenceApprovalRef,
  type TurnEvidenceRecord,
} from "./turn-evidence.js"

export interface TurnExecutorOptions {
  model: ModelPort
  now?: () => Date
  budgetLedger?: BudgetLedgerPort
  escalationSink?: EscalationSinkPort
  evidenceSink?: EvidenceSinkPort
  orgLookup?: OrgReportingLookup
  doomLoop?: Partial<DoomLoopConfig>
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
  engine_internal_error: "engine.internal_error",
}

const RETRYABLE_REASONS: ReadonlySet<TerminalReason> = new Set([
  "invalid_output_exhausted",
  "deadline_exceeded",
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

  const assembled = assembleContext({
    positionId: request.positionId,
    turnId: request.turnId,
    instructions: request.position?.instructions,
    spec: request.position?.spec,
    turnInput:
      typeof request.input === "string"
        ? request.input
        : JSON.stringify(request.input),
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
