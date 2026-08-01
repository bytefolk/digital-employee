import { randomUUID } from "node:crypto"

import {
  CoreError,
  ValidationError,
  sanitizeDetails,
  structuredError,
  validateAnswerRequest,
  validateFeedback,
  validateModelResponse,
  validateTool,
} from "./contracts.js"
import type {
  AnswerRequest,
  ModelResponse,
  SafeValue,
  Tool,
  ToolCall,
  UnknownRecord,
} from "./contracts.js"
import { EscalationPolicy } from "./escalation-policy.js"
import { VerifiedFaqStore } from "./faq-store.js"
import { JobRunner } from "./job-runner.js"
import { LexicalRetriever } from "./lexical-retriever.js"
import { SessionStore } from "./session-store.js"

interface RuntimeProfile extends UnknownRecord {
  id: string
  instructions: string
}
interface ModelProvider {
  generate: (input: UnknownRecord) => unknown | Promise<unknown>
}
interface Evidence {
  id: string
  title?: string
  text: string
  score?: number
  citation?: SafeValue
  [key: string]: unknown
}
interface SearchProvider {
  search: (query: string, options?: { limit?: number }) => unknown[] | Promise<unknown[]>
}
interface EscalationEvaluator {
  evaluate: EscalationPolicy["evaluate"]
}
interface EmployeeOptions {
  id?: string
  instructions?: string
  profile?: UnknownRecord
  model?: ModelProvider | ModelProvider["generate"]
  retriever?: SearchProvider
  faqStore?: VerifiedFaqStore
  sessionStore?: SessionStore
  escalationPolicy?: EscalationEvaluator
  jobRunner?: JobRunner
  tools?: unknown[]
  readOnly?: boolean
  maxSteps?: number
  maxHistory?: number
  maxEvidence?: number
  logger?: { error: (event: string, details: unknown) => void } | null
  authorizeFeedback?: ((context: UnknownRecord) => boolean) | null
}

export class DigitalEmployee {
  #id
  #instructions
  #profile: RuntimeProfile
  #model: ModelProvider
  #retriever: SearchProvider
  #faqStore: VerifiedFaqStore
  #sessionStore: SessionStore
  #escalationPolicy: EscalationEvaluator
  #jobRunner: JobRunner
  #tools: Map<string, Tool>
  #readOnly
  #maxSteps
  #maxHistory
  #maxEvidence
  #logger: EmployeeOptions["logger"]
  #authorizeFeedback: EmployeeOptions["authorizeFeedback"]

  constructor(options: EmployeeOptions = {}) {
    this.#profile = this.#normalizeProfile(options)
    this.#id = this.#profile.id
    this.#instructions = this.#profile.instructions
    this.#model = this.#normalizeModel(options.model)
    this.#retriever = (options.retriever ?? new LexicalRetriever()) as SearchProvider
    this.#faqStore = options.faqStore ?? new VerifiedFaqStore()
    this.#sessionStore = options.sessionStore ?? new SessionStore()
    this.#escalationPolicy =
      options.escalationPolicy ?? new EscalationPolicy()
    this.#jobRunner = options.jobRunner ?? new JobRunner()
    this.#readOnly = options.readOnly ?? true
    this.#maxSteps = options.maxSteps ?? 4
    this.#maxHistory = options.maxHistory ?? 10
    this.#maxEvidence = options.maxEvidence ?? 5
    this.#logger = options.logger ?? null
    this.#authorizeFeedback = options.authorizeFeedback ?? null
    this.#tools = new Map<string, Tool>()

    if (typeof this.#readOnly !== "boolean") {
      throw new ValidationError("readOnly must be a boolean")
    }
    if (!Number.isInteger(this.#maxSteps) || this.#maxSteps < 1) {
      throw new ValidationError("maxSteps must be a positive integer")
    }
    if (!Number.isInteger(this.#maxHistory) || this.#maxHistory < 0) {
      throw new ValidationError("maxHistory must be a non-negative integer")
    }
    if (!Number.isInteger(this.#maxEvidence) || this.#maxEvidence < 1) {
      throw new ValidationError("maxEvidence must be a positive integer")
    }
    if (!this.#retriever || typeof this.#retriever.search !== "function") {
      throw new ValidationError("retriever must provide search(query)")
    }
    if (!this.#faqStore || typeof this.#faqStore.search !== "function") {
      throw new ValidationError("faqStore must provide search(query)")
    }
    if (
      !this.#sessionStore ||
      typeof this.#sessionStore.append !== "function"
    ) {
      throw new ValidationError("sessionStore must provide append()")
    }
    if (
      !this.#escalationPolicy ||
      typeof this.#escalationPolicy.evaluate !== "function"
    ) {
      throw new ValidationError(
        "escalationPolicy must provide evaluate(context)",
      )
    }
    if (!this.#jobRunner || typeof this.#jobRunner.run !== "function") {
      throw new ValidationError("jobRunner must provide run(identity, task)")
    }
    if (
      this.#logger !== null &&
      (typeof this.#logger !== "object" ||
        typeof this.#logger.error !== "function")
    ) {
      throw new ValidationError(
        "logger must be null or provide an error() function",
      )
    }
    if (
      this.#authorizeFeedback !== null &&
      typeof this.#authorizeFeedback !== "function"
    ) {
      throw new ValidationError(
        "authorizeFeedback must be null or a function",
      )
    }

    for (const tool of options.tools ?? []) this.registerTool(tool)
  }

  registerTool(input: unknown): this {
    const tool = validateTool(input)
    this.#tools.set(tool.name, tool)
    return this
  }

  unregisterTool(name: string): boolean {
    return this.#tools.delete(name)
  }

  async answer(input: unknown) {
    let request: AnswerRequest
    try {
      request = validateAnswerRequest(input)
    } catch (error) {
      return this.#failureResult(
        {
          requestId:
            input && typeof input === "object" && "requestId" in input
              ? input.requestId
              : undefined,
          sessionId:
            input && typeof input === "object" && "sessionId" in input
              ? input.sessionId
              : undefined,
        },
        error,
      )
    }
    request.requestId ??= randomUUID()

    try {
      return await this.#jobRunner.run(
        { jobId: request.requestId, actorId: request.actorId },
        () => this.#runAnswerLoop(request),
      )
    } catch (error) {
      return this.#failureResult(request, error)
    }
  }

  recordFeedback(input: unknown, authorizationContext?: unknown) {
    try {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input)
      ) {
        throw new ValidationError("feedback request must be an object")
      }
      const feedbackInput = input as UnknownRecord
      const sessionId =
        typeof feedbackInput.sessionId === "string" ? feedbackInput.sessionId.trim() : ""
      if (!sessionId) {
        throw new ValidationError("sessionId is required")
      }
      const feedback = validateFeedback(feedbackInput)
      if (!feedback.verified) {
        return { stored: false, reason: "unverified_feedback" }
      }
      const exchange = this.#sessionStore.lastExchange(sessionId)
      if (!exchange) return { stored: false, reason: "no_completed_exchange" }
      const session =
        typeof this.#sessionStore.get === "function"
          ? this.#sessionStore.get(sessionId)
          : null
      const answerMetadata =
        exchange.answerMetadata &&
        typeof exchange.answerMetadata === "object" &&
        !Array.isArray(exchange.answerMetadata)
          ? exchange.answerMetadata
          : {}
      if (
        session?.state !== "idle" ||
        answerMetadata.outcome !== "answered"
      ) {
        return { stored: false, reason: "exchange_not_answered" }
      }
      if (
        !this.#authorizeFeedback ||
        this.#authorizeFeedback({
          sessionId,
          requestId: answerMetadata.requestId ?? null,
          feedback,
          authorization: authorizationContext,
          exchange: sanitizeDetails({
            question: exchange.question,
            answer: exchange.answer,
            citations: answerMetadata.citations ?? [],
          }),
        }) !== true
      ) {
        return { stored: false, reason: "feedback_not_authorized" }
      }
      return this.#faqStore.add({
        question: exchange.question,
        answer: exchange.answer,
        feedback,
        citations: answerMetadata.citations,
      })
    } catch (error) {
      return { stored: false, error: structuredError(error) }
    }
  }

  async #runAnswerLoop(request: AnswerRequest) {
    const previousHistory = this.#sessionStore.history(
      request.sessionId,
      this.#maxHistory,
    )
    this.#sessionStore.append(request.sessionId, {
      role: "user",
      content: request.message,
      metadata: { requestId: request.requestId },
    })
    this.#sessionStore.setState(request.sessionId, "working")

    let evidence: Evidence[] = []
    let response: ModelResponse | null = null
    const toolResults: UnknownRecord[] = []

    try {
      const [faqEvidence, retrievedEvidence] = await Promise.all([
        this.#faqStore.search(request.message, {
          limit: Math.min(3, this.#maxEvidence),
        }),
        this.#retriever.search(request.message, {
          limit: this.#maxEvidence,
        }),
      ])
      evidence = this.#mergeEvidence(
        faqEvidence as Evidence[],
        retrievedEvidence as Evidence[],
      )

      for (let step = 0; step < this.#maxSteps; step += 1) {
        const contexts = evidence.map((item) => ({
          id: item.id,
          title: item.title,
          text: item.text,
          score: item.score,
          citation: item.citation,
        }))
        const rawResponse = await this.#model.generate({
          question: request.message,
          contexts,
          history: previousHistory,
          profile: this.#profile,
          employee: {
            id: this.#id,
            instructions: this.#instructions,
            readOnly: this.#readOnly,
          },
          request: {
            requestId: request.requestId,
            sessionId: request.sessionId,
            actorId: request.actorId,
            message: request.message,
            metadata: request.metadata,
          },
          messages: [
            ...previousHistory,
            {
              role: "user",
              content: request.message,
              metadata: { requestId: request.requestId },
            },
          ],
          evidence: contexts,
          tools: [...this.#tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            mode: tool.mode,
            inputSchema: tool.inputSchema,
          })),
          toolResults: toolResults.map((result) => sanitizeDetails(result)),
          step,
        })
        response = validateModelResponse(rawResponse)

        if (response.toolCalls.length === 0) break
        for (const call of response.toolCalls) {
          toolResults.push(await this.#executeTool(call, request))
        }
      }

      if (response && response.toolCalls.length > 0 && !response.answer) {
        throw new CoreError(
          "MAX_STEPS_EXCEEDED",
          "The employee did not produce a final answer within the step limit.",
          { retryable: true, status: 503 },
        )
      }

      const citations = this.#resolveCitations(
        response?.citationIds ?? [],
        evidence,
      )
      const escalation = this.#escalationPolicy.evaluate({
        request,
        response,
        evidence,
        citations,
        toolResults,
      })
      const status = escalation.required ? "escalated" : "answered"
      const answer = escalation.required
        ? escalation.message
        : response?.answer

      if (answer) {
        this.#sessionStore.append(request.sessionId, {
          role: "assistant",
          content: answer,
          metadata: {
            requestId: request.requestId,
            outcome: status,
            citations,
            confidence: response?.confidence,
          },
        })
      }
      this.#sessionStore.setState(
        request.sessionId,
        escalation.required ? "waiting_for_human" : "idle",
      )

      return {
        ok: !escalation.required,
        status,
        requestId: request.requestId,
        sessionId: request.sessionId,
        answer,
        confidence: response?.confidence ?? null,
        citations,
        escalation: escalation.required ? escalation : null,
        error: null,
      }
    } catch (error) {
      try {
        this.#logger?.error?.("digital_employee_answer_failed", {
          requestId: request.requestId,
          error: structuredError(error),
        })
      } catch {
        // Observability must never change the answer or escalation outcome.
      }
      const escalation = this.#escalationPolicy.evaluate({
        request,
        response,
        evidence,
        toolResults,
        error,
      })
      this.#sessionStore.setState(
        request.sessionId,
        escalation.required ? "waiting_for_human" : "failed",
      )
      return {
        ok: false,
        status: escalation.required ? "escalated" : "failed",
        requestId: request.requestId,
        sessionId: request.sessionId,
        answer: escalation.required ? escalation.message : null,
        confidence: response?.confidence ?? null,
        citations: [],
        escalation: escalation.required ? escalation : null,
        error: structuredError(error),
      }
    }
  }

  async #executeTool(call: ToolCall, request: AnswerRequest): Promise<UnknownRecord> {
    const tool = this.#tools.get(call.name)
    if (!tool) {
      return {
        id: call.id,
        name: call.name,
        ok: false,
        error: structuredError(
          new CoreError("TOOL_NOT_FOUND", "The requested tool is unavailable.", {
            status: 404,
            details: { tool: call.name },
          }),
        ),
      }
    }
    if (this.#readOnly && tool.mode === "write") {
      return {
        id: call.id,
        name: call.name,
        ok: false,
        error: structuredError(
          new CoreError(
            "READ_ONLY_VIOLATION",
            "Write tools are disabled in read-only mode.",
            {
              status: 403,
              details: { tool: call.name },
            },
          ),
        ),
      }
    }

    try {
      const output = await tool.execute(call.input, {
        requestId: request.requestId,
        actorId: request.actorId,
        sessionId: request.sessionId,
        readOnly: this.#readOnly,
      })
      return {
        id: call.id,
        name: call.name,
        ok: true,
        output: sanitizeDetails(output),
      }
    } catch (error) {
      return {
        id: call.id,
        name: call.name,
        ok: false,
        error: structuredError(error),
      }
    }
  }

  #resolveCitations(citationIds: string[], evidence: Evidence[]): SafeValue[] {
    if (citationIds.length === 0) return []
    const requested = new Set(citationIds)
    return evidence
      .filter((item) => requested.has(item.id))
      .map((item) => sanitizeDetails(item.citation))
  }

  #mergeEvidence(...groups: Array<Evidence[] | undefined>): Evidence[] {
    const results = new Map<string, Evidence>()
    for (const group of groups) {
      for (const item of group ?? []) {
        if (
          !item ||
          typeof item.id !== "string" ||
          typeof item.text !== "string"
        ) {
          continue
        }
        const previous = results.get(item.id)
        if (!previous || (item.score ?? 0) > (previous.score ?? 0)) {
          results.set(item.id, item)
        }
      }
    }
    return [...results.values()]
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, this.#maxEvidence)
  }

  #normalizeModel(model: EmployeeOptions["model"]): ModelProvider {
    if (typeof model === "function") return { generate: model }
    if (model && typeof model.generate === "function") return model
    throw new ValidationError(
      "model must be a function or provide generate(input)",
    )
  }

  #normalizeProfile(options: EmployeeOptions): RuntimeProfile {
    const input = options.profile
    if (
      input !== undefined &&
      (input === null || typeof input !== "object" || Array.isArray(input))
    ) {
      throw new ValidationError("profile must be an object")
    }
    const profile = input ?? {}
    const idCandidate = profile.id ?? options.id
    const instructionsCandidate =
      profile.instructions ?? options.instructions
    return sanitizeDetails({
      ...profile,
      id:
        typeof idCandidate === "string" && idCandidate.trim()
          ? idCandidate.trim()
          : "digital-employee",
      instructions:
        typeof instructionsCandidate === "string"
          ? instructionsCandidate.trim()
          : "",
    }) as RuntimeProfile
  }

  #failureResult(
    request: { requestId?: unknown; sessionId?: unknown } | undefined,
    error: unknown,
  ) {
    return {
      ok: false,
      status:
        error instanceof CoreError && error.status < 500
          ? "rejected"
          : "failed",
      requestId: request?.requestId ?? null,
      sessionId: request?.sessionId ?? null,
      answer: null,
      confidence: null,
      citations: [],
      escalation: null,
      error: structuredError(error),
    }
  }
}
