import { ValidationError, sanitizeDetails } from "./contracts.js"
import type { SafeValue, UnknownRecord } from "./contracts.js"

const ALLOWED_ROLES = new Set(["user", "assistant", "tool", "system"])
type SessionRole = "user" | "assistant" | "tool" | "system"
interface SessionMessage {
  role: SessionRole
  content: string
  name?: string
  metadata?: SafeValue
  at: number
}
interface Session {
  id: string
  state: string
  messages: SessionMessage[]
  metadata: SafeValue
  createdAt: number
  lastActiveAt: number
}
interface SessionOptions {
  ttlMs?: number
  maxSessions?: number
  maxMessages?: number
  clock?: () => number
}

export class SessionStore {
  #ttlMs
  #maxSessions
  #maxMessages
  #clock
  #sessions = new Map<string, Session>()

  constructor(options: SessionOptions = {}) {
    this.#ttlMs = this.#validatePositive(
      options.ttlMs ?? 5 * 60_000,
      "ttlMs",
    )
    this.#maxSessions = this.#validatePositive(
      options.maxSessions ?? 1_000,
      "maxSessions",
    )
    this.#maxMessages = this.#validatePositive(
      options.maxMessages ?? 20,
      "maxMessages",
    )
    this.#clock = options.clock ?? (() => Date.now())
  }

  get(sessionId: unknown): Session | null {
    const id = this.#validateId(sessionId)
    const session = this.#sessions.get(id)
    if (!session) return null
    if (this.#isExpired(session)) {
      this.#sessions.delete(id)
      return null
    }
    return this.#copy(session)
  }

  getOrCreate(sessionId: unknown, metadata: unknown = {}): Session {
    const id = this.#validateId(sessionId)
    this.prune()
    let session = this.#sessions.get(id)
    if (!session) {
      this.#ensureCapacity()
      const now = this.#clock()
      session = {
        id,
        state: "idle",
        messages: [],
        metadata: sanitizeDetails(metadata),
        createdAt: now,
        lastActiveAt: now,
      }
      this.#sessions.set(id, session)
    }
    return this.#copy(session)
  }

  append(sessionId: unknown, message: unknown): Session {
    const id = this.#validateId(sessionId)
    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message)
    ) {
      throw new ValidationError("message must be an object")
    }
    const candidate = message as UnknownRecord
    if (typeof candidate.role !== "string" || !ALLOWED_ROLES.has(candidate.role)) {
      throw new ValidationError(
        `message.role must be one of: ${[...ALLOWED_ROLES].join(", ")}`,
      )
    }
    if (
      typeof candidate.content !== "string" ||
      candidate.content.trim().length === 0
    ) {
      throw new ValidationError("message.content must be a non-empty string")
    }

    this.getOrCreate(id)
    const session = this.#sessions.get(id)
    if (!session) throw new ValidationError("session could not be created")
    session.messages.push({
      role: candidate.role as SessionRole,
      content: candidate.content.trim(),
      ...(candidate.name ? { name: String(candidate.name) } : {}),
      ...(candidate.metadata
        ? { metadata: sanitizeDetails(candidate.metadata) }
        : {}),
      at: this.#clock(),
    })
    if (session.messages.length > this.#maxMessages) {
      session.messages.splice(
        0,
        session.messages.length - this.#maxMessages,
      )
    }
    session.lastActiveAt = this.#clock()
    return this.#copy(session)
  }

  setState(sessionId: unknown, state: unknown): Session {
    const id = this.#validateId(sessionId)
    if (typeof state !== "string" || !state.trim()) {
      throw new ValidationError("state must be a non-empty string")
    }
    this.getOrCreate(id)
    const session = this.#sessions.get(id)
    if (!session) throw new ValidationError("session could not be created")
    session.state = state.trim()
    session.lastActiveAt = this.#clock()
    return this.#copy(session)
  }

  history(sessionId: unknown, limit = this.#maxMessages): SessionMessage[] {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new ValidationError("history limit must be a non-negative integer")
    }
    const session = this.get(sessionId)
    if (!session || limit === 0) return []
    return session.messages.slice(-limit)
  }

  lastExchange(sessionId: unknown) {
    const session = this.get(sessionId)
    if (!session) return null
    for (let index = session.messages.length - 1; index > 0; index -= 1) {
      const answer = session.messages[index]
      const question = session.messages[index - 1]
      if (answer.role === "assistant" && question.role === "user") {
        return {
          question: question.content,
          answer: answer.content,
          answerMetadata: answer.metadata ?? {},
        }
      }
    }
    return null
  }

  close(sessionId: unknown): boolean {
    return this.#sessions.delete(this.#validateId(sessionId))
  }

  prune() {
    let removed = 0
    for (const [id, session] of this.#sessions) {
      if (this.#isExpired(session)) {
        this.#sessions.delete(id)
        removed += 1
      }
    }
    return removed
  }

  get size() {
    this.prune()
    return this.#sessions.size
  }

  #ensureCapacity() {
    if (this.#sessions.size < this.#maxSessions) return
    let oldest: Session | undefined
    for (const session of this.#sessions.values()) {
      if (!oldest || session.lastActiveAt < oldest.lastActiveAt) {
        oldest = session
      }
    }
    if (oldest) this.#sessions.delete(oldest.id)
  }

  #isExpired(session: Session): boolean {
    return this.#clock() - session.lastActiveAt >= this.#ttlMs
  }

  #copy(session: Session): Session {
    return {
      ...session,
      metadata: sanitizeDetails(session.metadata),
      messages: session.messages.map((message) => ({
        ...message,
        ...(message.metadata
          ? { metadata: sanitizeDetails(message.metadata) }
          : {}),
      })),
    }
  }

  #validateId(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new ValidationError("sessionId must be a non-empty string")
    }
    return value.trim()
  }

  #validatePositive(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new ValidationError(`${name} must be a positive integer`)
    }
    return value
  }
}
