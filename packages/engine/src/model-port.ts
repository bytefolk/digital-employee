import type { ContextBlock } from "./context-assembler.js"

/**
 * The model port is the engine's only outward seam for inference. The
 * read-only engine core has no tool surface: the port returns text and usage,
 * nothing executable.
 */
export interface OutputViolation {
  attempt: number
  /** Bounded, sanitized violation summary fed back into the repair loop. */
  summary: string
}

export interface ModelTurnInput {
  blocks: readonly ContextBlock[]
  priorViolations: readonly OutputViolation[]
}

export interface ModelTurnResult {
  text: string
  inputTokens?: number
  outputTokens?: number
}

export interface ModelPort {
  complete(
    input: ModelTurnInput,
    signal?: AbortSignal,
  ): Promise<ModelTurnResult>
}

/**
 * Deterministic reference model port for fixtures and zero-credential
 * acceptance: replays a scripted response list, one entry per call. A call
 * beyond the script fails closed.
 */
export function createDeterministicModelPort(
  script: readonly string[],
): ModelPort {
  let call = 0
  return {
    async complete(_input, signal) {
      if (signal?.aborted) {
        throw new Error("deterministic model port aborted")
      }
      if (call >= script.length) {
        throw new Error("deterministic model port script exhausted")
      }
      const text = script[call]!
      call += 1
      return { text }
    },
  }
}
