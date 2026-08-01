import { createHash } from "node:crypto"

const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000
const DEFAULT_DEDUPE_MAX_ENTRIES = 10_000

type UnknownRecord = Record<string, unknown>

export interface DingTalkNormalizedMessage {
  channel: "dingtalk"
  messageId: string | null
  transportMessageId: string | null
  dedupeKey: string
  messageType: string
  text: string
  quotedText: string | null
  createdAt: number | null
  actorKey: string
  threadKey: string
  sender: {
    userId: string | null
    encryptedId: string | null
    displayName: string | null
  }
  conversation: { id: string | null; type: string | null }
  reply: { sessionWebhook: string | null }
}

interface DedupeParts {
  messageId?: unknown
  transportMessageId?: unknown
  senderUserId?: unknown
  senderEncryptedId?: unknown
  conversationId?: unknown
  createdAt?: unknown
  messageType?: unknown
  text?: unknown
  quotedText?: unknown
}

interface DedupeOptions {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
}

export class DingTalkPayloadError extends Error {
  code: string

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options)
    this.name = "DingTalkPayloadError"
    this.code = "DINGTALK_INVALID_PAYLOAD"
  }
}

/**
 * Convert a DingTalk Stream callback into a stable, transport-neutral shape.
 * The raw payload is intentionally not returned.
 */
export function normalizeDingTalkMessage(envelope: unknown): DingTalkNormalizedMessage {
  const headers = isRecord(envelope) && isRecord(envelope.headers)
    ? envelope.headers
    : {}
  const payload = parsePayload(envelope)

  const messageId = firstString(
    payload.msgId,
    headers.messageId,
    headers.messageid,
  )
  const transportMessageId = firstString(headers.messageId, headers.messageid)
  const senderUserId = firstString(payload.senderStaffId)
  const senderEncryptedId = firstString(payload.senderId)
  const conversationId = firstString(
    payload.conversationId,
    payload.openConversationId,
  )
  const text = extractText(payload)
  const quotedText = extractQuotedText(payload)
  const messageType = firstString(payload.msgtype, payload.msgType) || "unknown"
  const createdAt = normalizeTimestamp(payload.createAt ?? payload.createdAt)
  const sessionWebhook = firstString(payload.sessionWebhook)
  const actorKey = createDingTalkOpaqueKey(
    "actor",
    senderUserId,
    senderEncryptedId,
  )
  const threadKey = createDingTalkOpaqueKey(
    "thread",
    conversationId,
    actorKey,
  )

  return {
    channel: "dingtalk",
    messageId,
    transportMessageId,
    dedupeKey: createDingTalkDedupeKey({
      messageId,
      transportMessageId,
      senderUserId,
      senderEncryptedId,
      conversationId,
      createdAt,
      messageType,
      text,
      quotedText,
    }),
    messageType,
    text,
    quotedText,
    createdAt,
    actorKey,
    threadKey,
    sender: {
      userId: senderUserId,
      encryptedId: senderEncryptedId,
      displayName: firstString(payload.senderNick),
    },
    conversation: {
      id: conversationId,
      type: firstString(payload.conversationType),
    },
    reply: {
      sessionWebhook,
    },
  }
}

export function createDingTalkOpaqueKey(namespace: string, ...values: unknown[]): string {
  if (typeof namespace !== "string" || !/^[a-z][a-z0-9-]*$/.test(namespace)) {
    throw new TypeError("opaque key namespace is invalid")
  }
  const digest = createHash("sha256")
    .update(JSON.stringify(values.map((value) => firstString(value))))
    .digest("hex")
  return `dingtalk-${namespace}:${digest.slice(0, 32)}`
}

/**
 * Produce a non-reversible key so caches and diagnostics do not need raw IDs.
 */
export function createDingTalkDedupeKey(parts: DedupeParts): string {
  const primaryId = firstString(parts?.messageId, parts?.transportMessageId)
  const material = primaryId
    ? ["message", primaryId]
    : [
        "fallback",
        firstString(parts?.conversationId),
        firstString(parts?.senderUserId, parts?.senderEncryptedId),
        parts?.createdAt ?? null,
        firstString(parts?.messageType),
        firstString(parts?.text),
        firstString(parts?.quotedText),
      ]

  const digest = createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex")
  return `dingtalk:${digest.slice(0, 32)}`
}

/**
 * Small in-memory duplicate guard for Stream redeliveries.
 */
export function createDingTalkDedupeCache(options: DedupeOptions = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_DEDUPE_TTL_MS
  const maxEntries = options.maxEntries ?? DEFAULT_DEDUPE_MAX_ENTRIES
  const now = options.now ?? Date.now

  requirePositiveInteger(ttlMs, "ttlMs")
  requirePositiveInteger(maxEntries, "maxEntries")
  if (typeof now !== "function") {
    throw new TypeError("now must be a function")
  }

  const entries = new Map<string, number>()

  function pruneExpired(timestamp: number): void {
    for (const [key, expiresAt] of entries) {
      if (expiresAt > timestamp) break
      entries.delete(key)
    }
  }

  return {
    claim(key: string): boolean {
      if (typeof key !== "string" || key.length === 0) {
        throw new TypeError("dedupe key must be a non-empty string")
      }

      const timestamp = now()
      pruneExpired(timestamp)
      const existingExpiry = entries.get(key)
      if (existingExpiry !== undefined && existingExpiry > timestamp) {
        return false
      }

      entries.delete(key)
      entries.set(key, timestamp + ttlMs)
      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value
        if (oldestKey !== undefined) entries.delete(oldestKey)
      }
      return true
    },
    clear() {
      entries.clear()
    },
    get size() {
      pruneExpired(now())
      return entries.size
    },
  }
}

function parsePayload(envelope: unknown): UnknownRecord {
  const candidate = isRecord(envelope) && "data" in envelope
    ? envelope.data
    : envelope

  if (typeof candidate === "string") {
    try {
      const parsed = JSON.parse(candidate)
      if (!isRecord(parsed)) {
        throw new DingTalkPayloadError("DingTalk payload must be a JSON object")
      }
      return parsed
    } catch (error) {
      if (error instanceof DingTalkPayloadError) throw error
      throw new DingTalkPayloadError("DingTalk payload is not valid JSON", {
        cause: error,
      })
    }
  }

  if (!isRecord(candidate)) {
    throw new DingTalkPayloadError("DingTalk payload must be an object")
  }
  return candidate
}

function extractText(payload: UnknownRecord): string {
  const text = asRecord(payload.text)
  const content = asRecord(payload.content)
  const plainText = typeof text?.content === "string"
    ? text.content
    : ""
  if (plainText.trim()) return plainText.trim()

  const richText = Array.isArray(content?.richText)
    ? content.richText
    : []
  return richText.map((block) => {
    const value = asRecord(block)
    return typeof value?.text === "string" ? value.text : ""
  })
    .join("")
    .trim()
}

function extractQuotedText(payload: UnknownRecord): string | null {
  const text = asRecord(payload.text)
  const repliedMessage = text?.isReplyMsg
    ? asRecord(text.repliedMsg)
    : null
  const quotedText = asRecord(repliedMessage?.content)?.text
  return typeof quotedText === "string" && quotedText.trim()
    ? quotedText.trim()
    : null
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function asRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}
