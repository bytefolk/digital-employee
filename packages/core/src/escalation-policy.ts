import { ValidationError, sanitizeDetails } from "./contracts.js"
import type { ModelResponse } from "./contracts.js"

interface EscalationContext {
  error?: unknown
  response?: ModelResponse | null
  evidence?: unknown[]
  citations?: unknown[]
  [key: string]: unknown
}
type EscalationRule = (
  context: EscalationContext,
) => boolean | { required: boolean; reason?: string; details?: unknown } | null
interface EscalationOptions {
  minConfidence?: number
  minEvidence?: number
  minCitations?: number
  escalateOnError?: boolean
  target?: string
  message?: string
  rules?: EscalationRule[]
}
export type EscalationDecision =
  | { required: false }
  | {
      required: true
      reason: string
      target: string
      message: string
      details?: ReturnType<typeof sanitizeDetails>
    }

export class EscalationPolicy {
  #minConfidence
  #minEvidence
  #minCitations
  #escalateOnError
  #target
  #message
  #rules: EscalationRule[]

  constructor(options: EscalationOptions = {}) {
    this.#minConfidence = options.minConfidence ?? 0.55
    this.#minEvidence = options.minEvidence ?? 1
    this.#minCitations = options.minCitations ?? 1
    this.#escalateOnError = options.escalateOnError ?? true
    this.#target = options.target ?? "human-support"
    this.#message =
      options.message ??
      "I could not answer this reliably, so I have requested human help."
    this.#rules = options.rules ?? []

    if (
      typeof this.#minConfidence !== "number" ||
      this.#minConfidence < 0 ||
      this.#minConfidence > 1
    ) {
      throw new ValidationError("minConfidence must be between 0 and 1")
    }
    if (!Number.isInteger(this.#minEvidence) || this.#minEvidence < 0) {
      throw new ValidationError(
        "minEvidence must be a non-negative integer",
      )
    }
    if (!Number.isInteger(this.#minCitations) || this.#minCitations < 0) {
      throw new ValidationError(
        "minCitations must be a non-negative integer",
      )
    }
    if (
      !Array.isArray(this.#rules) ||
      this.#rules.some((rule) => typeof rule !== "function")
    ) {
      throw new ValidationError("rules must be an array of functions")
    }
  }

  evaluate(context: EscalationContext = {}): EscalationDecision {
    let reason: string | null = null
    let details: unknown

    if (context.error && this.#escalateOnError) {
      reason = "execution_error"
    } else if (context.response?.escalate === true) {
      reason = "model_requested"
      details = context.response.escalationReason
        ? { modelReason: context.response.escalationReason }
        : undefined
    } else if (!context.response?.answer) {
      reason = "no_answer"
    } else if (
      typeof context.response.confidence === "number" &&
      context.response.confidence < this.#minConfidence
    ) {
      reason = "low_confidence"
      details = {
        confidence: context.response.confidence,
        threshold: this.#minConfidence,
      }
    } else if ((context.evidence?.length ?? 0) < this.#minEvidence) {
      reason = "insufficient_evidence"
      details = {
        evidenceCount: context.evidence?.length ?? 0,
        minimum: this.#minEvidence,
      }
    } else if ((context.citations?.length ?? 0) < this.#minCitations) {
      reason = "insufficient_citations"
      details = {
        citationCount: context.citations?.length ?? 0,
        minimum: this.#minCitations,
      }
    }

    if (!reason) {
      for (const rule of this.#rules) {
        const result = rule(context)
        if (result === true) {
          reason = "custom_rule"
          break
        }
        if (result && typeof result === "object" && result.required) {
          reason = result.reason ?? "custom_rule"
          details = result.details
          break
        }
      }
    }

    if (!reason) return { required: false as const }
    return {
      required: true as const,
      reason,
      target: this.#target,
      message: this.#message,
      ...(details ? { details: sanitizeDetails(details) } : {}),
    }
  }
}
