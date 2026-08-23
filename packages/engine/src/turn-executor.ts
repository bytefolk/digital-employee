import type { SafeValue } from "../../core/src/contracts.js"

import {
  terminalError,
  validateTurnRequest,
  type EngineEvent,
  type EngineTurnRequest,
} from "./contracts.js"
import { assembleContext } from "./context-assembler.js"
import type { ModelPort, OutputViolation } from "./model-port.js"
import {
  OutputSchemaGuardError,
  prepareTerminalSchema,
} from "./output-schema-guard.js"

export interface TurnExecutorOptions {
  model: ModelPort
  now?: () => Date
}

function timestamp(now: () => Date): string {
  return now().toISOString()
}

/**
 * Executes exactly one turn and yields a stream with a single trusted
 * terminal event (`run.completed` or `run.failed`).
 *
 * S1 loop shape — the ONLY iteration source in the read-only core is the
 * output validate/repair cycle: the model produces text, the terminal schema
 * validates it, and a violation feeds a bounded repair attempt. There is no
 * tool dispatch branch anywhere in this path; the model port returns text
 * only. Budget and doom-loop machinery is layered on by the loop-control
 * slice without relaxing this guarantee.
 */
export async function* executeTurn(
  rawRequest: EngineTurnRequest,
  options: TurnExecutorOptions,
): AsyncGenerator<EngineEvent> {
  const now = options.now ?? (() => new Date())
  const runId = typeof rawRequest.runId === "string" ? rawRequest.runId : ""
  let terminated = false

  const fail = (
    code: string,
    message: string,
    terminalReason: Parameters<typeof terminalError>[2],
    retryable = false,
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

  // Fail-closed request validation and terminal-schema preparation happen
  // before any model consumption.
  let request: EngineTurnRequest
  try {
    request = validateTurnRequest(rawRequest)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "turn request rejected"
    yield fail("engine.input_invalid", message, "engine_internal_error")
    return
  }

  let schema
  try {
    schema = prepareTerminalSchema(request.outputSchema)
  } catch (error) {
    if (error instanceof OutputSchemaGuardError) {
      yield fail(error.code, error.message, "engine_internal_error")
      return
    }
    yield fail(
      "engine.output_schema_invalid",
      "output schema preparation failed",
      "engine_internal_error",
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

  const violations: OutputViolation[] = []
  const maxIterations = request.budget.maxIterations

  try {
    for (let attempt = 1; attempt <= maxIterations; attempt += 1) {
      if (request.signal?.aborted) {
        yield fail("engine.cancelled", "turn cancelled", "cancelled")
        return
      }
      if (
        request.deadline !== undefined &&
        now().getTime() > Date.parse(request.deadline)
      ) {
        yield fail(
          "engine.deadline_exceeded",
          "turn deadline exceeded",
          "deadline_exceeded",
          true,
        )
        return
      }

      const result = await options.model.complete(
        { blocks: assembled.blocks, priorViolations: [...violations] },
        request.signal,
      )

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
      yield {
        type: "model.delta",
        runId,
        timestamp: timestamp(now),
        text: result.text,
      }

      if (schema === undefined) {
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
        violations.push({
          attempt,
          summary: "output is not valid JSON",
        })
        continue
      }

      if (schema.validate(candidate)) {
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

    // Repair attempts exhausted: fail closed, never fabricate a passing value.
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
    yield fail("engine.internal_error", message, "engine_internal_error", true)
  }
}
