const DEFAULT_MAX_MESSAGE_LENGTH = 20_000
const DEFAULT_MAX_ID_LENGTH = 256

const SECRET_KEY_PATTERN =
  /(?:api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|session[-_]?key|token|webhook)/i

const TEXT_REDACTIONS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [
    /\b((?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi,
    "$1[REDACTED]",
  ],
  [
    /([?&](?:access_token|api_key|key|secret|signature|token)=)[^&#\s]+/gi,
    "$1[REDACTED]",
  ],
] as const

export type UnknownRecord = Record<string, unknown>
export type SafeValue =
  | null
  | undefined
  | string
  | number
  | boolean
  | SafeValue[]
  | { [key: string]: SafeValue }

export interface CoreErrorOptions {
  cause?: unknown
  retryable?: boolean
  status?: number
  details?: unknown
}

export interface AnswerRequest {
  requestId?: string
  actorId: string
  sessionId: string
  message: string
  metadata: { [key: string]: SafeValue }
}

export interface DocumentSource {
  type: string
  uri: string
  id?: string
  name?: string
  updatedAt?: SafeValue
}

export interface Document {
  id: string
  text: string
  title: string
  source: DocumentSource
  metadata: { [key: string]: SafeValue }
}

export interface ToolCall {
  id: string
  name: string
  input: SafeValue
}

export interface ModelResponse {
  answer: string | null
  confidence: number | null
  citationIds: string[]
  toolCalls: ToolCall[]
  escalate: boolean
  escalationReason?: string
}

export interface Tool {
  name: string
  description: string
  mode: "read" | "write"
  execute: (input: SafeValue, context?: UnknownRecord) => unknown | Promise<unknown>
  inputSchema?: SafeValue
}

export class CoreError extends Error {
  code: string
  retryable: boolean
  status: number
  details: unknown

  constructor(code: string, message: string, options: CoreErrorOptions = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = "CoreError"
    this.code = code || "CORE_ERROR"
    this.retryable = Boolean(options.retryable)
    this.status = options.status ?? 500
    this.details = options.details
  }
}

export class ValidationError extends CoreError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, {
      status: 400,
      retryable: false,
      details,
    })
    this.name = "ValidationError"
  }
}

export function assertPlainObject(
  value: unknown,
  label = "value",
): asserts value is UnknownRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ValidationError(`${label} must be a plain object`)
  }
}

function validateOptionalId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > DEFAULT_MAX_ID_LENGTH
  ) {
    throw new ValidationError(
      `${label} must be a non-empty string of at most ${DEFAULT_MAX_ID_LENGTH} characters`,
      { field: label },
    )
  }
  return value.trim()
}

function cloneMetadata(
  value: unknown,
  label = "metadata",
): { [key: string]: SafeValue } {
  if (value === undefined) return {}
  assertPlainObject(value, label)
  return sanitizeDetails(value) as { [key: string]: SafeValue }
}

export function validateAnswerRequest(
  input: unknown,
  options: { maxMessageLength?: number } = {},
): AnswerRequest {
  assertPlainObject(input, "request")
  const maxMessageLength =
    options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH
  if (
    typeof input.message !== "string" ||
    input.message.trim().length === 0
  ) {
    throw new ValidationError("message must be a non-empty string", {
      field: "message",
    })
  }
  if (input.message.length > maxMessageLength) {
    throw new ValidationError(
      `message must contain at most ${maxMessageLength} characters`,
      { field: "message", maxLength: maxMessageLength },
    )
  }

  const actorId = validateOptionalId(input.actorId, "actorId")
  const sessionId =
    validateOptionalId(input.sessionId, "sessionId") ?? actorId

  return {
    requestId: validateOptionalId(input.requestId, "requestId"),
    actorId: actorId ?? sessionId ?? "anonymous",
    sessionId: sessionId ?? "anonymous",
    message: input.message.trim(),
    metadata: cloneMetadata(input.metadata),
  }
}

export function validateDocument(input: unknown): Document {
  assertPlainObject(input, "document")
  const id = validateOptionalId(input.id, "document.id")
  if (!id) throw new ValidationError("document.id is required")

  const text = input.text ?? input.content
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ValidationError("document.text must be a non-empty string", {
      field: "document.text",
    })
  }

  let source: DocumentSource
  if (typeof input.source === "string") {
    source = { type: "unknown", uri: input.source }
  } else {
    assertPlainObject(input.source, "document.source")
    const type = validateOptionalId(input.source.type, "document.source.type")
    const sourceId = validateOptionalId(
      input.source.id,
      "document.source.id",
    )
    const uri =
      validateOptionalId(input.source.uri, "document.source.uri") ??
      (type && sourceId ? `${type}://${sourceId}` : undefined)
    if (!type || !uri) {
      throw new ValidationError(
        "document.source.type and either document.source.uri or document.source.id are required",
      )
    }
    source = {
      type,
      uri,
      ...(sourceId ? { id: sourceId } : {}),
      ...(input.source.name
        ? {
            name: validateOptionalId(
              input.source.name,
              "document.source.name",
            ),
          }
        : {}),
      ...(input.source.updatedAt !== undefined
        ? { updatedAt: sanitizeDetails(input.source.updatedAt) }
        : {}),
    }
  }

  return {
    id,
    text: text.trim(),
    title:
      typeof input.title === "string" && input.title.trim()
        ? input.title.trim()
        : id,
    source,
    metadata: cloneMetadata(input.metadata, "document.metadata"),
  }
}

export function validateFeedback(input: unknown) {
  assertPlainObject(input, "feedback")
  return {
    verified: input.verified === true,
    note:
      typeof input.note === "string" && input.note.trim()
        ? input.note.trim().slice(0, 2_000)
        : undefined,
    metadata: cloneMetadata(input.metadata, "feedback.metadata"),
  }
}

export function validateModelResponse(input: unknown): ModelResponse {
  if (typeof input === "string") {
    const answer = input.trim()
    if (!answer) {
      throw new ValidationError("model returned an empty answer")
    }
    return {
      answer,
      confidence: null,
      citationIds: [],
      toolCalls: [],
      escalate: false,
    }
  }

  assertPlainObject(input, "model response")
  const rawAnswer = input.answer ?? input.text
  const answer =
    typeof rawAnswer === "string" && rawAnswer.trim()
      ? rawAnswer.trim()
      : null

  let confidence: number | null = null
  if (input.confidence !== undefined && input.confidence !== null) {
    if (
      typeof input.confidence !== "number" ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1
    ) {
      throw new ValidationError(
        "model response confidence must be a number between 0 and 1",
      )
    }
    confidence = input.confidence
  }

  const rawCitationIds = input.citationIds ?? input.citations ?? []
  if (!Array.isArray(rawCitationIds)) {
    throw new ValidationError("model response citations must be an array")
  }
  const citationIds = rawCitationIds
    .map((citation: unknown) =>
      typeof citation === "string"
        ? citation
        : citation &&
            typeof citation === "object" &&
            "id" in citation &&
            typeof citation.id === "string"
          ? citation.id
          : null,
    )
    .filter((value): value is string => Boolean(value))

  const toolCalls = input.toolCalls ?? []
  if (!Array.isArray(toolCalls)) {
    throw new ValidationError("model response toolCalls must be an array")
  }
  for (const [index, call] of toolCalls.entries()) {
    assertPlainObject(call, `model response toolCalls[${index}]`)
    if (typeof call.name !== "string" || !call.name.trim()) {
      throw new ValidationError(
        `model response toolCalls[${index}].name is required`,
      )
    }
  }

  if (
    !answer &&
    toolCalls.length === 0 &&
    input.escalate !== true &&
    input.needsHuman !== true
  ) {
    throw new ValidationError(
      "model response must include an answer, tool call, or escalation request",
    )
  }

  return {
    answer,
    confidence,
    citationIds,
    toolCalls: toolCalls.map((rawCall, index) => {
      assertPlainObject(rawCall, `model response toolCalls[${index}]`)
      const call = rawCall
      return {
      id:
        typeof call.id === "string" && call.id.trim()
          ? call.id.trim()
          : `tool-call-${index + 1}`,
      name: String(call.name).trim(),
      input:
        call.input && typeof call.input === "object"
          ? sanitizeDetails(call.input)
          : {},
      }
    }),
    escalate: input.escalate === true || input.needsHuman === true,
    escalationReason:
      typeof input.escalationReason === "string"
        ? input.escalationReason.trim().slice(0, 500)
        : undefined,
  }
}

export function validateTool(input: unknown): Tool {
  assertPlainObject(input, "tool")
  const name = validateOptionalId(input.name, "tool.name")
  if (!name) throw new ValidationError("tool.name is required")
  if (typeof input.execute !== "function") {
    throw new ValidationError(`tool "${name}" must provide execute(input)`)
  }
  const mode = input.mode ?? "read"
  if (mode !== "read" && mode !== "write") {
    throw new ValidationError(`tool "${name}" mode must be "read" or "write"`)
  }
  return {
    name,
    description:
      typeof input.description === "string" ? input.description.trim() : "",
    mode,
    execute: input.execute as Tool["execute"],
    inputSchema:
      input.inputSchema &&
      typeof input.inputSchema === "object" &&
      !Array.isArray(input.inputSchema)
        ? sanitizeDetails(input.inputSchema)
        : undefined,
  }
}

export function redactText(value: unknown): string {
  let text = String(value ?? "")
  for (const [pattern, replacement] of TEXT_REDACTIONS) {
    text = text.replace(pattern, replacement)
  }
  return text
}

export function sanitizeDetails(
  value: unknown,
  seen = new WeakSet<object>(),
): SafeValue {
  if (value === null || value === undefined) return value
  if (typeof value === "string") return redactText(value)
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function" || typeof value === "symbol") {
    return undefined
  }
  if (typeof value !== "object") return redactText(value)
  if (seen.has(value)) return "[Circular]"
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDetails(item, seen))
  }

  const output: { [key: string]: SafeValue } = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED]"
    } else {
      const safeValue = sanitizeDetails(item, seen)
      if (safeValue !== undefined) output[key] = safeValue
    }
  }
  return output
}

export function structuredError(error: unknown) {
  if (error instanceof CoreError) {
    return {
      code: error.code,
      message: redactText(error.message),
      retryable: error.retryable,
      ...(error.details !== undefined
        ? { details: sanitizeDetails(error.details) }
        : {}),
    }
  }

  return {
    code: "INTERNAL_ERROR",
    message: "The request could not be completed.",
    retryable: false,
  }
}
