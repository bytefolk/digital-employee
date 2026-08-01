import assert from "node:assert/strict"
import test from "node:test"

import {
  LexicalRetriever,
  SessionStore,
  VerifiedFaqStore,
  tokenize,
} from "../../packages/core/index.js"

test("SessionStore expires inactive sessions by TTL", () => {
  let now = 10_000
  const sessions = new SessionStore({
    ttlMs: 100,
    maxSessions: 2,
    clock: () => now,
  })
  sessions.append("session-1", { role: "user", content: "hello" })
  assert.equal(sessions.size, 1)

  now += 99
  assert.equal(sessions.get("session-1").messages.length, 1)
  now += 1
  assert.equal(sessions.get("session-1"), null)
  assert.equal(sessions.size, 0)
})

test("SessionStore evicts the least recently active session at capacity", () => {
  let now = 1
  const sessions = new SessionStore({
    ttlMs: 1_000,
    maxSessions: 2,
    clock: () => now,
  })
  sessions.append("oldest", { role: "user", content: "one" })
  now += 1
  sessions.append("newer", { role: "user", content: "two" })
  now += 1
  sessions.append("newest", { role: "user", content: "three" })

  assert.equal(sessions.get("oldest"), null)
  assert.ok(sessions.get("newer"))
  assert.ok(sessions.get("newest"))
})

test("LexicalRetriever uses CJK bigrams and returns provenance-rich citations", () => {
  const tokens = tokenize("如何申请年假")
  assert.ok(tokens.has("申请"))
  assert.ok(tokens.has("年假"))

  const retriever = new LexicalRetriever([
    {
      id: "leave-policy",
      title: "Leave policy",
      text: "需要申请年假时，请提前提交休假申请。",
      source: {
        type: "workspace-document",
        id: "doc-42",
        updatedAt: "2026-01-02T03:04:05.000Z",
      },
      metadata: { section: "Time off" },
    },
    {
      id: "expense-policy",
      title: "Expense policy",
      text: "差旅费用需要在出差结束后提交。",
      source: {
        type: "git",
        uri: "https://example.test/docs/expenses.md",
      },
    },
  ])

  const [result] = retriever.search("年假要怎么申请？")
  assert.equal(result.id, "leave-policy")
  assert.deepEqual(result.citation, {
    id: "leave-policy",
    label: "Leave policy",
    uri: "workspace-document://doc-42",
    sourceType: "workspace-document",
    sourceId: "doc-42",
    sourceUpdatedAt: "2026-01-02T03:04:05.000Z",
    metadata: { section: "Time off" },
  })
})

test("VerifiedFaqStore never learns from unverified feedback", () => {
  const store = new VerifiedFaqStore()
  assert.deepEqual(
    store.add({
      question: "How do I request leave?",
      answer: "Open the leave form.",
      feedback: { verified: false },
    }),
    { stored: false, reason: "unverified_feedback" },
  )
  assert.equal(store.stats().count, 0)

  const stored = store.add({
    question: "How do I request leave?",
    answer: "Open the leave form.",
    feedback: { verified: true, note: "Confirmed by the requester" },
  })
  assert.equal(stored.stored, true)
  assert.equal(store.stats().count, 1)

  const [match] = store.search("request leave")
  assert.equal(match.source.type, "verified-faq")
  assert.equal(match.metadata.verified, true)
  assert.equal(match.citation.metadata.verified, true)
})
