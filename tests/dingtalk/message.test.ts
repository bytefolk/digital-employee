import test from "node:test"
import assert from "node:assert/strict"

import {
  createDingTalkDedupeCache,
  DingTalkPayloadError,
  normalizeDingTalkMessage,
} from "../../connectors/channels/dingtalk/message.js"

test("normalizeDingTalkMessage maps text, quote, identity, and reply metadata", () => {
  const envelope = {
    headers: { messageId: "transport-message-example" },
    data: JSON.stringify({
      msgId: "message-example",
      msgtype: "text",
      createAt: "1700000000000",
      conversationId: "conversation-example",
      conversationType: "2",
      senderStaffId: "user-example",
      senderId: "encrypted-user-example",
      senderNick: "Example User",
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=example",
      text: {
        content: "  How do I inspect the current configuration?  ",
        isReplyMsg: true,
        repliedMsg: {
          content: { text: "  The earlier answer  " },
        },
      },
    }),
  }

  const message = normalizeDingTalkMessage(envelope)

  assert.equal(message.channel, "dingtalk")
  assert.equal(message.messageId, "message-example")
  assert.equal(message.transportMessageId, "transport-message-example")
  assert.equal(message.text, "How do I inspect the current configuration?")
  assert.equal(message.quotedText, "The earlier answer")
  assert.equal(message.createdAt, 1700000000000)
  assert.deepEqual(message.sender, {
    userId: "user-example",
    encryptedId: "encrypted-user-example",
    displayName: "Example User",
  })
  assert.deepEqual(message.conversation, {
    id: "conversation-example",
    type: "2",
  })
  assert.match(message.dedupeKey, /^dingtalk:[a-f0-9]{32}$/)
  assert.equal(message.dedupeKey.includes("message-example"), false)
  assert.match(message.actorKey, /^dingtalk-actor:[a-f0-9]{32}$/)
  assert.match(message.threadKey, /^dingtalk-thread:[a-f0-9]{32}$/)
  assert.equal(message.actorKey.includes("user-example"), false)
  assert.equal(message.threadKey.includes("conversation-example"), false)
})

test("normalizeDingTalkMessage joins rich text and produces a stable fallback key", () => {
  const payload = {
    msgtype: "richText",
    content: {
      richText: [
        { text: "First line\n" },
        { pictureDownloadCode: "not-returned" },
        { text: "Second line" },
      ],
    },
    senderId: "encrypted-example",
    conversationId: "conversation-example",
    createAt: 1700000000001,
  }

  const first = normalizeDingTalkMessage(payload)
  const second = normalizeDingTalkMessage(structuredClone(payload))

  assert.equal(first.text, "First line\nSecond line")
  assert.equal(first.messageId, null)
  assert.equal(first.dedupeKey, second.dedupeKey)
  assert.equal("raw" in first, false)
})

test("normalizeDingTalkMessage rejects malformed JSON without echoing payload", () => {
  const sensitiveFragment = "should-not-appear"
  assert.throws(
    () => normalizeDingTalkMessage(`{"value":"${sensitiveFragment}"`),
    (error: unknown) => {
      assert.equal(error instanceof DingTalkPayloadError, true)
      if (!(error instanceof DingTalkPayloadError)) return false
      assert.equal(error.code, "DINGTALK_INVALID_PAYLOAD")
      assert.equal(error.message.includes(sensitiveFragment), false)
      return true
    },
  )
})

test("createDingTalkDedupeCache rejects duplicates, expires entries, and bounds size", () => {
  let timestamp = 1_000
  const cache = createDingTalkDedupeCache({
    ttlMs: 100,
    maxEntries: 2,
    now: () => timestamp,
  })

  assert.equal(cache.claim("key-a"), true)
  assert.equal(cache.claim("key-a"), false)
  assert.equal(cache.claim("key-b"), true)
  assert.equal(cache.claim("key-c"), true)
  assert.equal(cache.size, 2)

  timestamp += 101
  assert.equal(cache.claim("key-a"), true)
  assert.equal(cache.size, 1)
})
