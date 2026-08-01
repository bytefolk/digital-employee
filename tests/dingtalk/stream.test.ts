import test from "node:test"
import assert from "node:assert/strict"

import {
  createDingTalkChannelAdapter,
  DingTalkChannel,
  DingTalkDependencyError,
  loadDingTalkStreamSdk,
} from "../../connectors/channels/dingtalk/index.js"
import {
  createDingTalkStreamSupervisor,
  DingTalkConnectionError,
} from "../../connectors/channels/dingtalk/stream.js"
import type { DingTalkNormalizedMessage } from "../../connectors/channels/dingtalk/message.js"
import type { DingTalkReplier } from "../../connectors/channels/dingtalk/reply.js"

type EnvelopeListener = (envelope: unknown) => unknown | Promise<unknown>

class FakeStreamClient {
  connected: boolean
  connectCalls: number
  disconnectCalls: number
  acks: Array<{ messageId: unknown; status: unknown }>
  listeners: Map<unknown, EnvelopeListener>
  heartbeatCalls: number
  downstreamCalls: number

  constructor() {
    this.connected = false
    this.connectCalls = 0
    this.disconnectCalls = 0
    this.acks = []
    this.listeners = new Map()
    this.heartbeatCalls = 0
    this.downstreamCalls = 0
  }

  registerCallbackListener(topic: unknown, listener: EnvelopeListener) {
    this.listeners.set(topic, listener)
    return () => this.listeners.delete(topic)
  }

  async emit(topic: unknown, envelope: unknown) {
    return this.listeners.get(topic)?.(envelope)
  }

  async connect() {
    this.connectCalls++
    this.connected = true
  }

  disconnect() {
    this.disconnectCalls++
    this.connected = false
  }

  socketCallBackResponse(messageId: unknown, status: unknown) {
    this.acks.push({ messageId, status })
  }

  heartbeat() {
    this.heartbeatCalls++
  }

  onDownStream() {
    this.downstreamCalls++
  }
}

const TEST_SDK = {
  TOPIC_ROBOT: "robot-topic",
  EventAck: { SUCCESS: "SUCCESS" },
}

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    headers: { messageId: "transport-example" },
    data: {
      msgId: "message-example",
      msgtype: "text",
      text: { content: "sensitive-example-body" },
      senderStaffId: "sensitive-example-user",
      senderNick: "Example Sender",
      conversationId: "conversation-example",
      sessionWebhook:
        "https://oapi.dingtalk.com/robot/sendBySession?session=sensitive-example-webhook",
      ...overrides,
    },
  }
}

test("channel adapter starts with injected SDK/client, ACKs, normalizes, and deduplicates", async () => {
  const client = new FakeStreamClient()
  const received: Array<{
    message: DingTalkNormalizedMessage
    context: { reply: DingTalkReplier | null }
  }> = []
  const logEntries: Array<{ level: string; event: string; details: unknown }> = []
  const logger = Object.fromEntries(
    ["debug", "info", "warn", "error"].map((level) => [
      level,
      (event: string, details: unknown) => logEntries.push({ level, event, details }),
    ]),
  )
  const adapter = createDingTalkChannelAdapter({
    sdk: TEST_SDK,
    client,
    logger,
    fetchImpl: async () => ({ ok: true, status: 200 }),
    supervisorOptions: { startTimer: false },
    onMessage: async (message, context) => {
      received.push({ message, context })
    },
  })

  await adapter.start()
  assert.equal(adapter.state, "running")
  assert.equal(client.connectCalls, 1)

  const envelope = makeEnvelope()
  await client.emit(TEST_SDK.TOPIC_ROBOT, envelope)
  await client.emit(TEST_SDK.TOPIC_ROBOT, envelope)

  assert.equal(received.length, 1)
  assert.equal(received[0]?.message.text, "sensitive-example-body")
  assert.equal(typeof received[0]?.context.reply?.replyText, "function")
  assert.deepEqual(client.acks, [
    { messageId: "transport-example", status: "SUCCESS" },
    { messageId: "transport-example", status: "SUCCESS" },
  ])

  const logs = JSON.stringify(logEntries)
  assert.equal(logs.includes("sensitive-example-body"), false)
  assert.equal(logs.includes("sensitive-example-user"), false)
  assert.equal(logs.includes("sensitive-example-webhook"), false)

  await adapter.stop()
  assert.equal(adapter.state, "stopped")
  assert.equal(client.disconnectCalls, 1)
  await client.emit(TEST_SDK.TOPIC_ROBOT, makeEnvelope({ msgId: "later" }))
  assert.equal(received.length, 1)
})

test("channel adapter ACKs malformed input and reports a sanitized error stage", async () => {
  const client = new FakeStreamClient()
  const errors: Array<{ error: unknown; context: { stage: string } }> = []
  const adapter = createDingTalkChannelAdapter({
    sdk: TEST_SDK,
    client,
    supervisorOptions: { startTimer: false },
    onMessage: async () => assert.fail("malformed messages must not be delivered"),
    onError: (error, context) => errors.push({ error, context }),
  })
  await adapter.start()

  await client.emit(TEST_SDK.TOPIC_ROBOT, {
    headers: { messageId: "malformed-example" },
    data: '{"private":"must-not-be-reflected"',
  })

  assert.deepEqual(client.acks, [
    { messageId: "malformed-example", status: "SUCCESS" },
  ])
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.context.stage, "message")
  const deliveredError = errors[0]?.error
  assert.ok(deliveredError instanceof Error)
  assert.equal(deliveredError.message.includes("must-not-be-reflected"), false)
  await adapter.stop()
})

test("channel adapter can run with only an injected client and explicit protocol constants", async () => {
  const client = new FakeStreamClient()
  let sdkLoaderCalled = false
  const adapter = createDingTalkChannelAdapter({
    client,
    topic: "robot-topic",
    successAck: "SUCCESS",
    sdkLoader: async () => {
      sdkLoaderCalled = true
      throw new Error("must not load")
    },
    supervisorOptions: { startTimer: false },
    onMessage: async () => {},
  })

  await adapter.start()
  assert.equal(sdkLoaderCalled, false)
  assert.equal(adapter.state, "running")
  await adapter.stop()
})

test("channel adapter disables SDK auto reconnect and owns the reconnect policy", async () => {
  const client = new FakeStreamClient()
  let clientConfig: object | undefined
  const adapter = createDingTalkChannelAdapter({
    sdk: TEST_SDK,
    clientId: "client-example",
    clientSecret: "secret-example",
    clientFactory: (config) => {
      clientConfig = config
      return client
    },
    supervisorOptions: { startTimer: false },
    onMessage: async () => {},
  })

  await adapter.start()
  assert.deepEqual(clientConfig, {
    clientId: "client-example",
    clientSecret: "secret-example",
    autoReconnect: false,
    keepAlive: true,
    debug: false,
  })
  await adapter.stop()
})

test("DingTalkChannel exposes the shared start(handler)/stop lifecycle", async () => {
  const client = new FakeStreamClient()
  const received: string[] = []
  const channel = new DingTalkChannel({
    sdk: TEST_SDK,
    client,
    supervisorOptions: { startTimer: false },
  })

  await channel.start(async (message) => received.push(message.text))
  await client.emit(TEST_SDK.TOPIC_ROBOT, makeEnvelope())
  assert.equal(channel.state, "running")
  assert.deepEqual(received, ["sensitive-example-body"])

  await channel.stop()
  assert.equal(channel.state, "stopped")
})

test("DingTalkChannel maps the runtime contract and replies within the handler", async () => {
  const client = new FakeStreamClient()
  const requests: Array<Record<string, unknown>> = []
  const channel = new DingTalkChannel({
    sdk: TEST_SDK,
    client,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return { ok: true, status: 200 }
    },
    replierOptions: { segmentDelayMs: 0 },
    supervisorOptions: { startTimer: false },
  })

  await channel.start(async (message) => {
    assert.match(message.id, /^dingtalk:[a-f0-9]{32}$/)
    assert.match(message.threadId, /^dingtalk-thread:[a-f0-9]{32}$/)
    assert.match(message.actorId, /^dingtalk-actor:[a-f0-9]{32}$/)
    assert.equal(message.text, "sensitive-example-body")
    await channel.reply(message, {
      answer: "A bounded answer",
      citations: [{
        id: "source-example",
        title: "Approved source",
        uri: "https://docs.example.test/approved",
      }],
    })
  })
  await client.emit(TEST_SDK.TOPIC_ROBOT, makeEnvelope())

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.msgtype, "text")
  const requestText = requests[0]?.text as { content?: string } | undefined
  assert.equal(
    requestText?.content,
    "A bounded answer\n\nReferences:\n- Approved source: https://docs.example.test/approved",
  )
  assert.deepEqual(requests[0]?.at, {
    isAtAll: false,
    atUserIds: ["sensitive-example-user"],
  })
  await channel.stop()
})

test("stream supervisor reconnects after activity timeout and becomes inert after stop", async () => {
  const client = new FakeStreamClient()
  const originalHeartbeat = client.heartbeat
  let timestamp = 0
  const supervisor = createDingTalkStreamSupervisor(client, {
    now: () => timestamp,
    startTimer: false,
    watchdogIntervalMs: 10,
    staleAfterMs: 30,
    wakeDriftMs: 100,
    connectTimeoutMs: 100,
    reconnectAttempts: 2,
    reconnectBackoffMs: 0,
  })

  await supervisor.start()
  assert.equal(client.connectCalls, 1)
  assert.notEqual(client.heartbeat, originalHeartbeat)

  timestamp = 41
  assert.equal(await supervisor.watchdogTick(), true)
  assert.equal(client.disconnectCalls, 1)
  assert.equal(client.connectCalls, 2)
  assert.equal(supervisor.state, "running")

  await supervisor.stop()
  assert.equal(supervisor.state, "stopped")
  assert.equal(client.heartbeat, originalHeartbeat)
  const callsAfterStop = client.connectCalls
  timestamp = 1_000
  assert.equal(await supervisor.watchdogTick(), false)
  assert.equal(client.connectCalls, callsAfterStop)
})

test("stream supervisor reconnects when the SDK reports a closed connection", async () => {
  const client = new FakeStreamClient()
  const supervisor = createDingTalkStreamSupervisor(client, {
    startTimer: false,
    connectTimeoutMs: 100,
    reconnectAttempts: 1,
  })
  await supervisor.start()

  client.connected = false
  assert.equal(await supervisor.watchdogTick(), true)
  assert.equal(client.connectCalls, 2)
  await supervisor.stop()
})

test("stream supervisor bounds reconnect attempts and surfaces failure", async () => {
  const client = new FakeStreamClient()
  client.connect = async function connectWithoutState(this: FakeStreamClient) {
    this.connectCalls++
    this.connected = false
  }
  const supervisor = createDingTalkStreamSupervisor(client, {
    startTimer: false,
    connectTimeoutMs: 100,
    reconnectAttempts: 2,
    reconnectBackoffMs: 0,
  })

  await assert.rejects(
    supervisor.forceReconnect("test"),
    (error: unknown) => {
      assert.equal(error instanceof DingTalkConnectionError, true)
      if (!(error instanceof DingTalkConnectionError)) return false
      assert.equal(error.code, "DINGTALK_RECONNECT_EXHAUSTED")
      assert.equal(error.attempts, 2)
      return true
    },
  )
  assert.equal(client.connectCalls, 2)
  await supervisor.stop()
})

test("stream supervisor times out a hung connect", async () => {
  const client = new FakeStreamClient()
  client.connect = async () => new Promise<never>(() => {})
  const supervisor = createDingTalkStreamSupervisor(client, {
    startTimer: false,
    connectTimeoutMs: 10,
  })

  await assert.rejects(
    supervisor.start(),
    { code: "DINGTALK_CONNECT_TIMEOUT" },
  )
  await supervisor.stop()
})

test("optional SDK loader wraps missing dependency errors", async () => {
  await assert.rejects(
    loadDingTalkStreamSdk(async () => {
      throw new Error("module unavailable")
    }),
    (error: unknown) => {
      assert.equal(error instanceof DingTalkDependencyError, true)
      if (!(error instanceof DingTalkDependencyError)) return false
      assert.equal(error.code, "DINGTALK_STREAM_DEPENDENCY_MISSING")
      return true
    },
  )
})
