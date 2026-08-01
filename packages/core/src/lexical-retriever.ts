import { ValidationError, validateDocument } from "./contracts.js"
import type { Document, SafeValue } from "./contracts.js"

export function tokenize(input: unknown): Set<string> {
  const tokens = new Set<string>()
  const text = String(input ?? "").toLowerCase()

  for (const match of text.matchAll(/[a-z0-9][a-z0-9_-]*/g)) {
    tokens.add(match[0])
  }
  for (const segment of text.split(/[^\u3400-\u9fff]+/u)) {
    if (!segment) continue
    if (segment.length === 1) {
      tokens.add(segment)
      continue
    }
    for (let index = 0; index < segment.length - 1; index += 1) {
      tokens.add(segment.slice(index, index + 2))
    }
  }
  return tokens
}

export function lexicalSimilarity(left: unknown, right: unknown): number {
  const leftTokens = left instanceof Set ? left : tokenize(left)
  const rightTokens = right instanceof Set ? right : tokenize(right)
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0

  let overlap = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1
  }
  return overlap / Math.sqrt(leftTokens.size * rightTokens.size)
}

interface IndexedDocument extends Document { tokens: Set<string> }
export interface RetrievedEvidence {
  id: string
  title: string
  text: string
  source: Document["source"]
  metadata: { [key: string]: SafeValue }
  score: number
  citation: ReturnType<typeof citationFor>
}

function citationFor(document: Document) {
  return {
    id: document.id,
    label: document.title,
    uri: document.source.uri,
    sourceType: document.source.type,
    ...(document.source.name ? { sourceName: document.source.name } : {}),
    ...(document.source.id ? { sourceId: document.source.id } : {}),
    ...(document.source.updatedAt
      ? { sourceUpdatedAt: document.source.updatedAt }
      : {}),
    metadata: document.metadata,
  }
}

export class LexicalRetriever {
  #documents = new Map<string, IndexedDocument>()
  #defaultLimit
  #minScore

  constructor(
    documents: unknown[] = [],
    options: { limit?: number; minScore?: number } = {},
  ) {
    if (!Array.isArray(documents)) {
      throw new ValidationError("documents must be an array")
    }
    this.#defaultLimit = options.limit ?? 5
    this.#minScore = options.minScore ?? 0.05
    if (!Number.isInteger(this.#defaultLimit) || this.#defaultLimit < 1) {
      throw new ValidationError("retriever limit must be a positive integer")
    }
    if (
      typeof this.#minScore !== "number" ||
      this.#minScore < 0 ||
      this.#minScore > 1
    ) {
      throw new ValidationError(
        "retriever minScore must be between 0 and 1",
      )
    }
    this.addMany(documents)
  }

  add(input: unknown): this {
    const document = validateDocument(input)
    this.#documents.set(document.id, {
      ...document,
      tokens: tokenize(
        `${document.title}\n${document.text}\n${Object.values(document.metadata).join(" ")}`,
      ),
    })
    return this
  }

  addMany(documents: unknown[]): this {
    for (const document of documents) this.add(document)
    return this
  }

  remove(id: string): boolean {
    return this.#documents.delete(id)
  }

  clear() {
    this.#documents.clear()
  }

  search(
    query: unknown,
    options: { limit?: number; minScore?: number } = {},
  ): RetrievedEvidence[] {
    if (typeof query !== "string" || !query.trim()) return []
    const limit = options.limit ?? this.#defaultLimit
    const minScore = options.minScore ?? this.#minScore
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError("search limit must be a positive integer")
    }
    const queryTokens = tokenize(query)
    if (queryTokens.size === 0) return []

    return [...this.#documents.values()]
      .map((document) => ({
        id: document.id,
        title: document.title,
        text: document.text,
        source: document.source,
        metadata: document.metadata,
        score: lexicalSimilarity(queryTokens, document.tokens),
        citation: citationFor(document),
      }))
      .filter((result) => result.score >= minScore)
      .sort(
        (left, right) =>
          right.score - left.score || left.id.localeCompare(right.id),
      )
      .slice(0, limit)
  }

  get size() {
    return this.#documents.size
  }
}
