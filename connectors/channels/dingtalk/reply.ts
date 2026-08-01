export const DINGTALK_WEBHOOK_HOSTS = Object.freeze([
  "oapi.dingtalk.com",
  "api.dingtalk.com",
])

export const DEFAULT_DINGTALK_SEGMENT_LENGTH = 3_500
export const DEFAULT_DINGTALK_REQUEST_TIMEOUT_MS = 10_000
export const DEFAULT_DINGTALK_RESPONSE_PREVIEW_BYTES = 2_048

interface DingTalkWebhookErrorOptions extends ErrorOptions {
  code?: string
  status?: number | null
  bodyPreview?: string
  bodyTruncated?: boolean
}

interface WebhookResponse {
  ok: boolean
  status: number
  body?: { getReader: () => ReadableStreamDefaultReader<Uint8Array> } | null
  text?: () => Promise<string>
}

export type DingTalkFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<WebhookResponse>

type DingTalkLogger = Record<string, ((event: string, details: unknown) => void) | undefined>

interface WebhookUrlOptions {
  allowedHosts?: readonly string[]
}

interface WebhookPostOptions extends WebhookUrlOptions {
  webhookUrl?: string
  payload?: unknown
  fetchImpl?: DingTalkFetch
  timeoutMs?: number
  responsePreviewBytes?: number
}

export interface DingTalkAtOptions {
  atUserIds?: unknown
  atDingtalkIds?: unknown
  isAtAll?: boolean
}

interface ReplierOptions extends WebhookPostOptions {
  logger?: DingTalkLogger
  maxLength?: number
  segmentDelayMs?: number
  sleep?: (ms: number) => Promise<unknown>
}

export interface DingTalkWebhookResult {
  ok: true
  status: number
}

export interface DingTalkReplier {
  replyText: (text: string, at?: DingTalkAtOptions) => Promise<DingTalkWebhookResult[]>
  replyMarkdown: (
    title: string,
    text: string,
    at?: DingTalkAtOptions,
  ) => Promise<DingTalkWebhookResult[]>
}

export class DingTalkWebhookError extends Error {
  code: string
  status: number | null
  bodyPreview: string
  bodyTruncated: boolean

  constructor(message: string, options: DingTalkWebhookErrorOptions = {}) {
    super(message, options)
    this.name = "DingTalkWebhookError"
    this.code = options.code ?? "DINGTALK_WEBHOOK_ERROR"
    this.status = options.status ?? null
    this.bodyPreview = options.bodyPreview ?? ""
    this.bodyTruncated = options.bodyTruncated ?? false
  }
}

/**
 * Strictly validate a session webhook before any network access.
 */
export function parseDingTalkWebhookUrl(
  value: unknown,
  options: WebhookUrlOptions = {},
): URL {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidWebhookError()
  }

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw invalidWebhookError()
  }

  const allowedHosts = new Set(
    (options.allowedHosts ?? DINGTALK_WEBHOOK_HOSTS)
      .map((host) => String(host).toLowerCase()),
  )
  const hasAllowedPort = parsed.port === "" || parsed.port === "443"
  const isAllowed =
    parsed.protocol === "https:" &&
    allowedHosts.has(parsed.hostname.toLowerCase()) &&
    hasAllowedPort &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.hash === ""

  if (!isAllowed) throw invalidWebhookError()
  return parsed
}

export function isDingTalkWebhookUrlAllowed(
  value: unknown,
  options: WebhookUrlOptions = {},
): boolean {
  try {
    parseDingTalkWebhookUrl(value, options)
    return true
  } catch {
    return false
  }
}

/**
 * Split by Unicode code points, preferring a newline in the latter half.
 */
export function splitDingTalkText(
  value: unknown,
  maxLength = DEFAULT_DINGTALK_SEGMENT_LENGTH,
): string[] {
  if (typeof value !== "string") {
    throw new TypeError("reply text must be a string")
  }
  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    throw new RangeError("maxLength must be a positive integer")
  }

  const points = Array.from(value)
  if (points.length <= maxLength) return [value]

  const chunks: string[] = []
  let start = 0
  while (start < points.length) {
    let end = Math.min(start + maxLength, points.length)
    if (end < points.length) {
      const earliestBreak = start + Math.floor(maxLength / 2)
      for (let index = end - 1; index >= earliestBreak; index--) {
        if (points[index] === "\n") {
          end = index + 1
          break
        }
      }
    }
    chunks.push(points.slice(start, end).join(""))
    start = end
  }
  return chunks
}

/**
 * POST one already-constructed DingTalk webhook payload.
 */
export async function postDingTalkWebhook(
  options: WebhookPostOptions,
): Promise<DingTalkWebhookResult> {
  const {
    webhookUrl,
    payload,
    fetchImpl = globalThis.fetch as DingTalkFetch,
    allowedHosts = DINGTALK_WEBHOOK_HOSTS,
    timeoutMs = DEFAULT_DINGTALK_REQUEST_TIMEOUT_MS,
    responsePreviewBytes = DEFAULT_DINGTALK_RESPONSE_PREVIEW_BYTES,
  } = options ?? {}

  const parsedUrl = parseDingTalkWebhookUrl(webhookUrl, { allowedHosts })
  if (typeof fetchImpl !== "function") {
    throw new DingTalkWebhookError(
      "No fetch implementation is available",
      { code: "DINGTALK_FETCH_UNAVAILABLE" },
    )
  }
  requirePositiveInteger(timeoutMs, "timeoutMs")
  requireNonNegativeInteger(responsePreviewBytes, "responsePreviewBytes")

  return runWithTimeout(async (signal) => {
    let response
    try {
      response = await fetchImpl(parsedUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payload),
        redirect: "manual",
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw timeoutError(timeoutMs, error)
      throw new DingTalkWebhookError("DingTalk webhook request failed", {
        code: "DINGTALK_WEBHOOK_REQUEST_FAILED",
        cause: error,
      })
    }

    if (!response || typeof response.ok !== "boolean") {
      throw new DingTalkWebhookError("DingTalk webhook returned an invalid response", {
        code: "DINGTALK_WEBHOOK_INVALID_RESPONSE",
      })
    }
    if (response.ok) {
      return { ok: true, status: response.status }
    }

    const preview = await readResponsePreview(response, responsePreviewBytes)
    throw new DingTalkWebhookError(
      `DingTalk webhook returned HTTP ${response.status}`,
      {
        code: "DINGTALK_WEBHOOK_HTTP_ERROR",
        status: response.status,
        bodyPreview: preview.text,
        bodyTruncated: preview.truncated,
      },
    )
  }, timeoutMs)
}

export function createDingTalkReplier(options: ReplierOptions): DingTalkReplier {
  const {
    webhookUrl,
    fetchImpl = globalThis.fetch as DingTalkFetch,
    logger,
    allowedHosts = DINGTALK_WEBHOOK_HOSTS,
    maxLength = DEFAULT_DINGTALK_SEGMENT_LENGTH,
    segmentDelayMs = 250,
    sleep = defaultSleep,
    timeoutMs = DEFAULT_DINGTALK_REQUEST_TIMEOUT_MS,
    responsePreviewBytes = DEFAULT_DINGTALK_RESPONSE_PREVIEW_BYTES,
  } = options ?? {}

  const parsedUrl = parseDingTalkWebhookUrl(webhookUrl, { allowedHosts })
  if (typeof sleep !== "function") throw new TypeError("sleep must be a function")
  requireNonNegativeInteger(segmentDelayMs, "segmentDelayMs")
  splitDingTalkText("", maxLength)

  async function sendSegments(
    segments: string[],
    makePayload: (content: string, index: number) => unknown,
  ): Promise<DingTalkWebhookResult[]> {
    const results: DingTalkWebhookResult[] = []
    for (let index = 0; index < segments.length; index++) {
      const payload = makePayload(segments[index], index)
      const result = await postDingTalkWebhook({
        webhookUrl: parsedUrl.toString(),
        payload,
        fetchImpl,
        allowedHosts,
        timeoutMs,
        responsePreviewBytes,
      })
      results.push(result)
      safeLog(logger, "debug", "dingtalk.webhook.sent", {
        segment: index + 1,
        segmentCount: segments.length,
        status: result.status,
      })
      if (index < segments.length - 1 && segmentDelayMs > 0) {
        await sleep(segmentDelayMs)
      }
    }
    return results
  }

  return {
    async replyText(text, at = {}) {
      const segments = splitDingTalkText(text, maxLength)
      return sendSegments(segments, (content, index) => {
        const payload: Record<string, unknown> = {
          msgtype: "text",
          text: { content },
        }
        const atPayload = index === 0 ? buildAtPayload(at) : null
        if (atPayload) payload.at = atPayload
        return payload
      })
    },

    async replyMarkdown(title, text, at = {}) {
      if (typeof title !== "string" || title.length === 0) {
        throw new TypeError("markdown title must be a non-empty string")
      }
      const segments = splitDingTalkText(text, maxLength)
      return sendSegments(segments, (content, index) => {
        const payload: Record<string, unknown> = {
          msgtype: "markdown",
          markdown: { title, text: content },
        }
        const atPayload = index === 0 ? buildAtPayload(at) : null
        if (atPayload) payload.at = atPayload
        return payload
      })
    },
  }
}

async function runWithTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(timeoutError(timeoutMs))
    }, timeoutMs)
  })

  try {
    return await Promise.race([
      Promise.resolve().then(() => task(controller.signal)),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readResponsePreview(
  response: WebhookResponse,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (maxBytes === 0) return { text: "", truncated: true }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    let truncated = false
    try {
      while (size < maxBytes) {
        const { done, value } = await reader.read()
        if (done) break
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
        const remaining = maxBytes - size
        if (bytes.byteLength > remaining) {
          chunks.push(bytes.subarray(0, remaining))
          size += remaining
          truncated = true
          break
        }
        chunks.push(bytes)
        size += bytes.byteLength
      }
      if (size === maxBytes && !truncated) {
        const { done } = await reader.read()
        truncated = !done
      }
    } finally {
      if (truncated) {
        try {
          await reader.cancel()
        } catch {}
      }
    }
    return {
      text: new TextDecoder().decode(concatBytes(chunks, size)),
      truncated,
    }
  }

  if (typeof response.text === "function") {
    const text = await response.text()
    const bytes = new TextEncoder().encode(text)
    const truncated = bytes.byteLength > maxBytes
    return {
      text: new TextDecoder().decode(bytes.subarray(0, maxBytes)),
      truncated,
    }
  }
  return { text: "", truncated: false }
}

function buildAtPayload(value: DingTalkAtOptions) {
  const atUserIds = cleanIdList(value?.atUserIds)
  const atDingtalkIds = cleanIdList(value?.atDingtalkIds)
  const isAtAll = value?.isAtAll === true
  if (!isAtAll && atUserIds.length === 0 && atDingtalkIds.length === 0) {
    return null
  }

  const result: {
    isAtAll: boolean
    atUserIds?: string[]
    atDingtalkIds?: string[]
  } = { isAtAll }
  if (atUserIds.length > 0) result.atUserIds = atUserIds
  if (atDingtalkIds.length > 0) result.atDingtalkIds = atDingtalkIds
  return result
}

function cleanIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item) => (
    typeof item === "string" && item.length > 0
  )))]
}

function concatBytes(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const output = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function invalidWebhookError(): DingTalkWebhookError {
  return new DingTalkWebhookError("DingTalk webhook URL is not allowed", {
    code: "DINGTALK_WEBHOOK_URL_REJECTED",
  })
}

function timeoutError(timeoutMs: number, cause?: unknown): DingTalkWebhookError {
  return new DingTalkWebhookError(
    `DingTalk webhook timed out after ${timeoutMs}ms`,
    {
      code: "DINGTALK_WEBHOOK_TIMEOUT",
      cause,
    },
  )
}

function safeLog(
  logger: DingTalkLogger | undefined,
  level: string,
  event: string,
  details: unknown,
): void {
  try {
    logger?.[level]?.(event, details)
  } catch {}
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}
