import {
  createDingTalkDedupeCache,
  normalizeDingTalkMessage,
} from "./message.js"
import {
  createDingTalkReplier,
} from "./reply.js"
import type {
  DingTalkAtOptions,
  DingTalkFetch,
  DingTalkReplier,
} from "./reply.js"
import {
  createDingTalkStreamSupervisor,
  DingTalkConnectionError,
} from "./stream.js"
import type {
  DingTalkStreamClient,
  DingTalkStreamSupervisor,
} from "./stream.js"
import type { DingTalkNormalizedMessage } from "./message.js"

type UnknownRecord = Record<string, unknown>
type ChannelLogger = Record<string, ((event: string, details?: unknown) => void) | undefined>
type ChannelState = "idle" | "starting" | "running" | "failed" | "stopping" | "stopped"

interface DingTalkDependencyErrorOptions extends ErrorOptions {
  code?: string
}

interface RuntimeChannelMessage {
  id: string
  threadId: string
  actorId: string
  text: string
  channel: "dingtalk"
  metadata: { messageType: string; quotedText: string | null }
}

type RuntimeMessageHandler = (message: RuntimeChannelMessage) => unknown | Promise<unknown>

interface DingTalkSdk {
  TOPIC_ROBOT?: unknown
  EventAck?: { SUCCESS?: unknown }
  DWClient?: new (config: ClientFactoryConfig) => DingTalkClient
}

interface DingTalkClient extends DingTalkStreamClient {
  registerCallbackListener?: (topic: unknown, listener: EnvelopeListener) => unknown
  unregisterCallbackListener?: (topic: unknown, listener: EnvelopeListener) => unknown
  off?: (topic: unknown, listener: EnvelopeListener) => unknown
  removeListener?: (topic: unknown, listener: EnvelopeListener) => unknown
  socketCallBackResponse?: (messageId: unknown, ack: unknown) => unknown
}

interface ClientFactoryConfig {
  clientId: string
  clientSecret: string
  autoReconnect: false
  keepAlive: true
  debug: false
}

type ClientFactory = (config: ClientFactoryConfig) => DingTalkClient
type EnvelopeListener = (envelope: unknown) => Promise<void>

interface DedupeCache {
  claim: (key: string) => boolean
  clear?: () => void
}

interface ChannelAdapterOptions {
  clientId?: string
  clientSecret?: string
  sdk?: DingTalkSdk
  client?: DingTalkClient
  clientFactory?: ClientFactory
  sdkLoader?: () => Promise<unknown>
  onMessage: (
    message: DingTalkNormalizedMessage,
    context: { reply: DingTalkReplier | null },
  ) => unknown | Promise<unknown>
  onError?: (error: unknown, context: { stage: string }) => void
  logger?: ChannelLogger
  fetchImpl?: DingTalkFetch
  dedupe?: DedupeCache
  dedupeOptions?: Parameters<typeof createDingTalkDedupeCache>[0]
  replierOptions?: Omit<Parameters<typeof createDingTalkReplier>[0], "webhookUrl">
  supervisorOptions?: Omit<
    Parameters<typeof createDingTalkStreamSupervisor>[1],
    "logger" | "onError"
  >
  topic?: unknown
  successAck?: unknown
}

interface ChannelOptions extends Omit<ChannelAdapterOptions, "onMessage"> {
  onMessage?: RuntimeMessageHandler
}

interface ChannelAdapter {
  start: () => Promise<ChannelAdapter>
  stop: () => Promise<void>
  readonly state: ChannelState
  readonly client: DingTalkClient | null
}

export * from "./message.js"
export * from "./reply.js"
export * from "./stream.js"

export class DingTalkDependencyError extends Error {
  code: string

  constructor(message: string, options: DingTalkDependencyErrorOptions = {}) {
    super(message, options)
    this.name = "DingTalkDependencyError"
    this.code = options.code ?? "DINGTALK_DEPENDENCY_ERROR"
  }
}

/**
 * Channel-shaped wrapper that mirrors the runtime's start(handler)/stop()
 * lifecycle while preserving the lower-level adapter for advanced use.
 */
export class DingTalkChannel {
  options: ChannelOptions
  adapter: ChannelAdapter | null
  replyTargets: Map<string, { reply: DingTalkReplier | null; at: DingTalkAtOptions }>

  constructor(options: ChannelOptions = {}) {
    this.options = { ...options }
    this.adapter = null
    this.replyTargets = new Map()
  }

  async start(handler: RuntimeMessageHandler | undefined = this.options.onMessage): Promise<this> {
    if (typeof handler !== "function") {
      throw new TypeError("DingTalk channel requires a message handler")
    }
    if (this.adapter && this.adapter.state !== "stopped") {
      throw new DingTalkConnectionError(
        "DingTalk channel has already been started",
        { code: "DINGTALK_CHANNEL_ALREADY_STARTED" },
      )
    }

    const { onMessage: _ignored, ...adapterOptions } = this.options
    this.adapter = createDingTalkChannelAdapter({
      ...adapterOptions,
      onMessage: async (transportMessage, context) => {
        const message: RuntimeChannelMessage = {
          id: transportMessage.dedupeKey,
          threadId: transportMessage.threadKey,
          actorId: transportMessage.actorKey,
          text: transportMessage.text,
          channel: "dingtalk",
          metadata: {
            messageType: transportMessage.messageType,
            quotedText: transportMessage.quotedText,
          },
        }
        this.replyTargets.set(message.id, {
          reply: context.reply,
          at: buildSenderAt(transportMessage.sender),
        })
        try {
          return await handler(message)
        } finally {
          this.replyTargets.delete(message.id)
        }
      },
    })
    await this.adapter.start()
    return this
  }

  async reply(
    message: { id?: string } | null | undefined,
    result: unknown,
  ) {
    const target = message?.id ? this.replyTargets.get(message.id) : undefined
    if (!target?.reply) {
      throw new DingTalkConnectionError(
        "DingTalk reply target is unavailable",
        { code: "DINGTALK_REPLY_TARGET_UNAVAILABLE" },
      )
    }
    const text = formatRuntimeReply(result)
    if (!text) {
      throw new TypeError("DingTalk reply requires an answer or escalation message")
    }
    return target.reply.replyText(text, target.at)
  }

  async stop(): Promise<void> {
    try {
      await this.adapter?.stop()
    } finally {
      this.replyTargets.clear()
    }
  }

  get state() {
    return this.adapter?.state ?? "idle"
  }
}

/**
 * Lazy loader keeps dingtalk-stream optional for offline tests and other
 * channel-only installations.
 */
export async function loadDingTalkStreamSdk(
  importer: () => Promise<unknown> = () => import("dingtalk-stream"),
): Promise<unknown> {
  try {
    return await importer()
  } catch (error) {
    throw new DingTalkDependencyError(
      "The optional dingtalk-stream dependency is required to start this channel",
      {
        code: "DINGTALK_STREAM_DEPENDENCY_MISSING",
        cause: error,
      },
    )
  }
}

/**
 * Create a DingTalk Stream channel adapter.
 *
 * Tests may inject sdk, client, clientFactory, fetchImpl, clocks, and sleep.
 */
export function createDingTalkChannelAdapter(
  options: ChannelAdapterOptions,
): ChannelAdapter {
  const {
    clientId,
    clientSecret,
    sdk: injectedSdk,
    client: injectedClient,
    clientFactory,
    sdkLoader = loadDingTalkStreamSdk,
    onMessage,
    onError,
    logger,
    fetchImpl = globalThis.fetch as DingTalkFetch,
    dedupe = createDingTalkDedupeCache(options.dedupeOptions),
    replierOptions = {},
    supervisorOptions = {},
  } = options

  if (typeof onMessage !== "function") {
    throw new TypeError("onMessage must be a function")
  }
  if (!dedupe || typeof dedupe.claim !== "function") {
    throw new TypeError("dedupe.claim must be a function")
  }

  let state: ChannelState = "idle"
  let client: DingTalkClient | null = null
  let sdk: DingTalkSdk | null = null
  let supervisor: DingTalkStreamSupervisor | null = null
  let unsubscribe: (() => void) | null = null
  let listener: EnvelopeListener | null = null

  async function start(): Promise<ChannelAdapter> {
    if (state === "running") return adapter
    if (state !== "idle") {
      throw new DingTalkConnectionError(
        `DingTalk channel cannot start from state ${state}`,
        { code: "DINGTALK_CHANNEL_INVALID_STATE" },
      )
    }
    state = "starting"

    try {
      sdk = injectedSdk ?? (
        (injectedClient || clientFactory) && options.topic
          ? {}
          : await sdkLoader() as DingTalkSdk
      )
      client = injectedClient ?? createClient({
        sdk,
        clientId,
        clientSecret,
        clientFactory,
      })

      const topic = options.topic ?? sdk?.TOPIC_ROBOT
      if (typeof client.registerCallbackListener !== "function") {
        throw new DingTalkDependencyError(
          "DingTalk Stream client does not support callback listeners",
          { code: "DINGTALK_STREAM_CLIENT_INCOMPATIBLE" },
        )
      }
      if (topic === undefined || topic === null || topic === "") {
        throw new DingTalkDependencyError(
          "DingTalk Stream robot topic is unavailable",
          { code: "DINGTALK_STREAM_TOPIC_UNAVAILABLE" },
        )
      }

      const activeClient = client
      listener = async (envelope) => {
        acknowledgeEnvelope(activeClient, envelope, {
          successAck: options.successAck ?? sdk?.EventAck?.SUCCESS,
          onError: (error) => reportError(error, "ack"),
        })
        supervisor?.markAlive()
        if (state !== "running" && state !== "starting") return

        try {
          const message = normalizeDingTalkMessage(envelope)
          if (!dedupe.claim(message.dedupeKey)) {
            safeLog(logger, "debug", "dingtalk.message.duplicate")
            return
          }

          let reply = null
          if (message.reply.sessionWebhook) {
            try {
              reply = createDingTalkReplier({
                webhookUrl: message.reply.sessionWebhook,
                fetchImpl,
                logger,
                ...replierOptions,
              })
            } catch (error) {
              reportError(error, "reply-target")
            }
          }

          await onMessage(message, { reply })
          safeLog(logger, "debug", "dingtalk.message.handled")
        } catch (error) {
          reportError(error, "message")
        }
      }

      const registration = client.registerCallbackListener(topic, listener)
      if (typeof registration === "function") {
        unsubscribe = registration as () => void
      }

      supervisor = createDingTalkStreamSupervisor(client, {
        logger,
        onError: (error, context) => {
          reportError(error, context?.stage ?? "connection")
        },
        ...supervisorOptions,
      })
      await supervisor.start()
      state = "running"
      safeLog(logger, "info", "dingtalk.channel.started")
      return adapter
    } catch (error) {
      state = "failed"
      try {
        await supervisor?.stop()
      } catch {}
      safeUnsubscribe()
      reportError(error, "start")
      throw error
    }
  }

  async function stop(): Promise<void> {
    if (state === "stopped") return
    state = "stopping"
    safeUnsubscribe()
    try {
      await supervisor?.stop()
    } finally {
      listener = null
      state = "stopped"
      dedupe.clear?.()
      safeLog(logger, "info", "dingtalk.channel.stopped")
    }
  }

  function reportError(error: unknown, stage: string): void {
    safeLog(logger, "error", "dingtalk.channel.error", {
      stage,
      errorCode: safeErrorCode(error),
    })
    try {
      onError?.(error, { stage })
    } catch {}
  }

  function safeUnsubscribe(): void {
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch {}
      unsubscribe = null
      return
    }
    if (listener && typeof client?.unregisterCallbackListener === "function") {
      try {
        client.unregisterCallbackListener(options.topic ?? sdk?.TOPIC_ROBOT, listener)
      } catch {}
      return
    }
    if (listener && typeof client?.off === "function") {
      try {
        client.off(options.topic ?? sdk?.TOPIC_ROBOT, listener)
      } catch {}
      return
    }
    if (listener && typeof client?.removeListener === "function") {
      try {
        client.removeListener(options.topic ?? sdk?.TOPIC_ROBOT, listener)
      } catch {}
    }
  }

  const adapter = {
    start,
    stop,
    get state() {
      return state
    },
    get client() {
      return client
    },
  }
  return adapter
}

function createClient({
  sdk,
  clientId,
  clientSecret,
  clientFactory,
}: {
  sdk: DingTalkSdk
  clientId?: string
  clientSecret?: string
  clientFactory?: ClientFactory
}): DingTalkClient {
  if (!clientId || !clientSecret) {
    throw new DingTalkDependencyError(
      "DingTalk client credentials are required when no client is injected",
      { code: "DINGTALK_CREDENTIALS_MISSING" },
    )
  }
  const ClientConstructor = sdk.DWClient
  const factory = clientFactory ?? (
    typeof ClientConstructor === "function"
      ? (config: ClientFactoryConfig) => new ClientConstructor(config)
      : null
  )
  if (!factory) {
    throw new DingTalkDependencyError(
      "DingTalk Stream client constructor is unavailable",
      { code: "DINGTALK_STREAM_CLIENT_UNAVAILABLE" },
    )
  }
  return factory({
    clientId,
    clientSecret,
    autoReconnect: false,
    keepAlive: true,
    debug: false,
  })
}

function acknowledgeEnvelope(
  client: DingTalkClient,
  envelope: unknown,
  options: { successAck: unknown; onError: (error: unknown) => void },
): void {
  const envelopeRecord = asRecord(envelope)
  const headers = asRecord(envelopeRecord?.headers)
  const messageId = headers?.messageId ?? headers?.messageid
  if (!messageId || typeof client.socketCallBackResponse !== "function") return
  try {
    const result = client.socketCallBackResponse(messageId, options.successAck)
    Promise.resolve(result).catch(options.onError)
  } catch (error) {
    options.onError(error)
  }
}

function buildSenderAt(sender: DingTalkNormalizedMessage["sender"]): DingTalkAtOptions {
  if (sender?.userId) return { atUserIds: [sender.userId] }
  if (sender?.encryptedId) return { atDingtalkIds: [sender.encryptedId] }
  return {}
}

function formatRuntimeReply(result: unknown): string {
  const resultRecord = asRecord(result)
  const escalation = asRecord(resultRecord?.escalation)
  const answer = typeof resultRecord?.answer === "string" && resultRecord.answer.trim()
    ? resultRecord.answer.trim()
    : typeof escalation?.message === "string"
      ? escalation.message.trim()
      : ""
  if (!answer) return ""

  const citations = Array.isArray(resultRecord?.citations)
    ? resultRecord.citations
      .map((citation) => {
        const citationRecord = asRecord(citation)
        const label = firstNonEmptyString(
          citationRecord?.label,
          citationRecord?.title,
          citationRecord?.id,
        )
        const uri = firstNonEmptyString(citationRecord?.uri)
        if (!label && !uri) return null
        if (label && uri) return `- ${label}: ${uri}`
        return `- ${label ?? uri}`
      })
      .filter(Boolean)
    : []
  return citations.length > 0
    ? `${answer}\n\nReferences:\n${citations.join("\n")}`
    : answer
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

function safeErrorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
  ) {
    return error.code
  }
  return "DINGTALK_UNKNOWN_ERROR"
}

function safeLog(
  logger: ChannelLogger | undefined,
  level: string,
  event: string,
  details?: unknown,
): void {
  try {
    logger?.[level]?.(event, details)
  } catch {}
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}
