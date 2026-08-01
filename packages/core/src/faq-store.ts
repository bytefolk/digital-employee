import {
  ValidationError,
  sanitizeDetails,
  validateFeedback,
} from "./contracts.js"
import type { SafeValue, UnknownRecord } from "./contracts.js"
import { lexicalSimilarity } from "./lexical-retriever.js"

const UNSAFE_PATTERNS = [
  /ignore.{0,20}(instruction|policy|prompt|rule)/i,
  /system\s*prompt/i,
  /忽略.{0,10}(指令|规则|约束|提示|系统)/u,
  /重置.{0,8}(角色|身份|指令)/u,
]

function unsafe(text: string): boolean {
  return UNSAFE_PATTERNS.some((pattern) => pattern.test(text))
}

export class VerifiedFaqStore {
  #entries = new Map<string, {
    id: string
    question: string
    answer: string
    feedback: ReturnType<typeof validateFeedback>
    citations: SafeValue[]
    hits: number
    createdAt: number
    updatedAt: number
  }>()
  #maxEntries
  #minScore
  #clock
  #nextId = 1

  constructor(options: {
    maxEntries?: number
    minScore?: number
    clock?: () => number
  } = {}) {
    this.#maxEntries = options.maxEntries ?? 100
    this.#minScore = options.minScore ?? 0.3
    this.#clock = options.clock ?? (() => Date.now())
    if (!Number.isInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new ValidationError("maxEntries must be a positive integer")
    }
    if (
      typeof this.#minScore !== "number" ||
      this.#minScore < 0 ||
      this.#minScore > 1
    ) {
      throw new ValidationError("minScore must be between 0 and 1")
    }
  }

  add(input: unknown) {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input)
    ) {
      throw new ValidationError("FAQ entry must be an object")
    }
    const entryInput = input as UnknownRecord
    const feedback = validateFeedback(entryInput.feedback ?? {})
    if (!feedback.verified) {
      return { stored: false, reason: "unverified_feedback" }
    }

    const question =
      typeof entryInput.question === "string" ? entryInput.question.trim() : ""
    const answer = typeof entryInput.answer === "string" ? entryInput.answer.trim() : ""
    if (!question || !answer) {
      throw new ValidationError(
        "FAQ question and answer must be non-empty strings",
      )
    }
    if (unsafe(question) || unsafe(answer)) {
      return { stored: false, reason: "unsafe_content" }
    }

    const now = this.#clock()
    const existing = [...this.#entries.values()]
      .map((entry) => ({
        entry,
        score: lexicalSimilarity(question, entry.question),
      }))
      .filter(({ score }) => score >= 0.75)
      .sort((left, right) => right.score - left.score)[0]

    if (existing) {
      existing.entry.answer = answer
      existing.entry.feedback = feedback
      existing.entry.citations = this.#normalizeCitations(entryInput.citations)
      existing.entry.updatedAt = now
      existing.entry.hits += 1
      return { stored: true, id: existing.entry.id, updated: true }
    }

    const id =
      typeof entryInput.id === "string" && entryInput.id.trim()
        ? entryInput.id.trim()
        : `faq-${this.#nextId++}`
    this.#entries.set(id, {
      id,
      question,
      answer,
      feedback,
      citations: this.#normalizeCitations(entryInput.citations),
      hits: 0,
      createdAt: now,
      updatedAt: now,
    })
    this.#evict()
    return { stored: true, id, updated: false }
  }

  addVerified(input: UnknownRecord) {
    return this.add({
      ...input,
      feedback: { ...(input.feedback ?? {}), verified: true },
    })
  }

  search(query: unknown, options: { minScore?: number; limit?: number } = {}) {
    if (typeof query !== "string" || !query.trim()) return []
    const minScore = options.minScore ?? this.#minScore
    const limit = options.limit ?? 3
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError("FAQ search limit must be a positive integer")
    }

    const results = [...this.#entries.values()]
      .map((entry) => ({
        entry,
        score: lexicalSimilarity(query, entry.question),
      }))
      .filter(({ score }) => score >= minScore)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.entry.updatedAt - left.entry.updatedAt,
      )
      .slice(0, limit)

    for (const result of results) result.entry.hits += 1
    return results.map(({ entry, score }) => ({
      id: entry.id,
      title: entry.question,
      text: entry.answer,
      score,
      source: { type: "verified-faq", uri: `faq://${entry.id}` },
      metadata: {
        verified: true,
        verifiedAt: entry.updatedAt,
        feedback: sanitizeDetails(entry.feedback),
      },
      citation: {
        id: entry.id,
        label: entry.question,
        uri: `faq://${entry.id}`,
        sourceType: "verified-faq",
        metadata: {
          verified: true,
          supportingCitations: entry.citations,
        },
      },
    }))
  }

  stats() {
    return {
      count: this.#entries.size,
      totalHits: [...this.#entries.values()].reduce(
        (sum, entry) => sum + entry.hits,
        0,
      ),
    }
  }

  #normalizeCitations(citations: unknown): SafeValue[] {
    if (!Array.isArray(citations)) return []
    return citations
      .filter(
        (citation) =>
          citation &&
          typeof citation === "object" &&
          "id" in citation && typeof citation.id === "string",
      )
      .map((citation) => sanitizeDetails(citation))
  }

  #evict() {
    while (this.#entries.size > this.#maxEntries) {
      const oldest = [...this.#entries.values()].sort(
        (left, right) =>
          left.hits - right.hits || left.updatedAt - right.updatedAt,
      )[0]
      if (!oldest) return
      this.#entries.delete(oldest.id)
    }
  }
}
