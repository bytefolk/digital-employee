import test from "node:test"
import assert from "node:assert/strict"

import {
  createDingTalkReplier,
  DingTalkWebhookError,
  isDingTalkWebhookUrlAllowed,
  parseDingTalkWebhookUrl,
  postDingTalkWebhook,
  splitDingTalkText,
} from "../../connectors/channels/dingtalk/reply.js"

const VALID_WEBHOOK =
  "https://oapi.dingtalk.com/robot/sendBySession?session=example"

test("splitDingTalkText preserves content and Unicode boundaries", () => {
  const input = "alpha\nbeta😀gamma\ndelta"
  const chunks = splitDingTalkText(input, 7)

  assert.equal(chunks.join(""), input)
  assert.equal(chunks.every((chunk) => Array.from(chunk).length <= 7), true)
  assert.equal(chunks.some((chunk) => chunk.endsWith("\n")), true)
  assert.equal(chunks.some((chunk) => chunk.endsWith("\ud83d")), false)
})

test("webhook validation accepts exact official hosts only", () => {
  assert.equal(parseDingTalkWebhookUrl(VALID_WEBHOOK).hostname, "oapi.dingtalk.com")
  assert.equal(
    isDingTalkWebhookUrlAllowed(
      "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
    ),
    true,
  )

  const rejected = [
    "http://oapi.dingtalk.com/robot/send",
    "https://oapi.dingtalk.com.evil.example/robot/send",
    "https://sub.oapi.dingtalk.com/robot/send",
    "https://user@oapi.dingtalk.com/robot/send",
    "https://oapi.dingtalk.com:8443/robot/send",
    "https://oapi.dingtalk.com/robot/send#fragment",
    "https://127.0.0.1/robot/send",
    "file:///etc/passwd",
  ]
  for (const url of rejected) {
    assert.equal(isDingTalkWebhookUrlAllowed(url), false, url)
  }
})

test("createDingTalkReplier sends ordered segments and mentions only on the first", async () => {
  const requests = []
  const sleeps = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init })
    return { ok: true, status: 200 }
  }
  const replier = createDingTalkReplier({
    webhookUrl: VALID_WEBHOOK,
    fetchImpl,
    maxLength: 5,
    segmentDelayMs: 20,
    sleep: async (ms) => sleeps.push(ms),
  })

  const results = await replier.replyText("abcdefghijk", {
    atUserIds: ["user-example", "user-example"],
  })

  assert.equal(results.length, 3)
  assert.equal(requests.length, 3)
  assert.equal(
    requests
      .map(({ init }) => JSON.parse(init.body).text.content)
      .join(""),
    "abcdefghijk",
  )
  assert.deepEqual(JSON.parse(requests[0].init.body).at, {
    isAtAll: false,
    atUserIds: ["user-example"],
  })
  assert.equal("at" in JSON.parse(requests[1].init.body), false)
  assert.equal(requests.every(({ init }) => init.redirect === "manual"), true)
  assert.equal(requests.every(({ init }) => init.signal instanceof AbortSignal), true)
  assert.deepEqual(sleeps, [20, 20])
})

test("postDingTalkWebhook truncates an error response body", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 502,
    text: async () => "0123456789-secret-tail",
  })

  await assert.rejects(
    postDingTalkWebhook({
      webhookUrl: VALID_WEBHOOK,
      payload: { msgtype: "text", text: { content: "example" } },
      fetchImpl,
      responsePreviewBytes: 8,
    }),
    (error) => {
      assert.equal(error instanceof DingTalkWebhookError, true)
      assert.equal(error.code, "DINGTALK_WEBHOOK_HTTP_ERROR")
      assert.equal(error.status, 502)
      assert.equal(error.bodyPreview, "01234567")
      assert.equal(error.bodyTruncated, true)
      assert.equal(error.message.includes("secret-tail"), false)
      return true
    },
  )
})

test("postDingTalkWebhook times out even if an injected fetch ignores abort", async () => {
  const fetchImpl = async () => new Promise(() => {})

  await assert.rejects(
    postDingTalkWebhook({
      webhookUrl: VALID_WEBHOOK,
      payload: { msgtype: "text", text: { content: "example" } },
      fetchImpl,
      timeoutMs: 10,
    }),
    (error) => {
      assert.equal(error.code, "DINGTALK_WEBHOOK_TIMEOUT")
      return true
    },
  )
})

test("postDingTalkWebhook rejects a URL before invoking fetch", async () => {
  let called = false
  await assert.rejects(
    postDingTalkWebhook({
      webhookUrl: "https://oapi.dingtalk.com.invalid/robot/send",
      payload: {},
      fetchImpl: async () => {
        called = true
      },
    }),
    { code: "DINGTALK_WEBHOOK_URL_REJECTED" },
  )
  assert.equal(called, false)
})
