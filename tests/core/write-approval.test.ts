import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  WRITE_APPROVAL_VERSION,
  classifyApprovalGuard,
  computePreviewDigest,
  deriveIdempotencyKey,
  validateWritePreviewRequest,
  validateWriteApprovalDecision,
  WriteApprovalValidationError,
} from "../../packages/core/src/write-approval.js"
import type {
  WriteApprovalDecision,
  WritePreview,
  WriteTarget,
  WriteEffect,
} from "../../packages/core/src/write-approval.js"
import { WriteApprovalEngine } from "../../packages/core/src/write-approval-engine.js"

const fixturesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/write-approval-vectors/v1",
)

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesRoot, name), "utf8"))
}

// --- Manifest integrity ---

test("manifest digests match fixture files", () => {
  const manifest = readJson("manifest.json") as {
    files: Array<{ file: string; sha256: string }>
  }
  for (const entry of manifest.files) {
    const raw = readFileSync(path.join(fixturesRoot, entry.file))
    const digest = createHash("sha256").update(raw).digest("hex")
    assert.equal(digest, entry.sha256, `digest mismatch for ${entry.file}`)
  }
})

// --- Lifecycle vectors ---

test("lifecycle: happy_path_create", async () => {
  const engine = new WriteApprovalEngine()
  const preview = engine.createPreview({
    taskId: "task-001",
    toolName: "file_write",
    target: { uri: "file:///tmp/hello.txt", baseRevision: "rev-0" },
    effect: { type: "create", canonicalPayload: '{"content":"hello world"}' },
  })

  assert.equal(preview.state, "preview_validated")
  assert.equal(preview.version, WRITE_APPROVAL_VERSION)

  engine.submitDecision({
    previewId: preview.previewId,
    approved: true,
    previewDigest: preview.previewDigest,
    attempt: preview.attempt,
    fencingToken: preview.fencingToken,
    expiresAt: Date.now() + 60_000,
    decidedBy: "human-reviewer",
  })

  const result = await engine.execute(preview.previewId, async () => ({
    success: true,
    revision: "rev-1",
  }))

  assert.equal(result.success, true)
  assert.equal(result.state, "success")
  assert.equal(result.revision, "rev-1")
})

test("lifecycle: happy_path_update", async () => {
  const engine = new WriteApprovalEngine()
  const preview = engine.createPreview({
    taskId: "task-002",
    toolName: "file_write",
    target: { uri: "file:///tmp/hello.txt", baseRevision: "rev-1" },
    effect: { type: "update", canonicalPayload: '{"content":"updated"}' },
  })

  engine.submitDecision({
    previewId: preview.previewId,
    approved: true,
    previewDigest: preview.previewDigest,
    attempt: preview.attempt,
    fencingToken: preview.fencingToken,
    expiresAt: Date.now() + 60_000,
    decidedBy: "human-reviewer",
  })

  const result = await engine.execute(preview.previewId, async () => ({
    success: true,
    revision: "rev-2",
  }))

  assert.equal(result.success, true)
  assert.equal(result.state, "success")
  assert.equal(result.revision, "rev-2")
})

test("lifecycle: denial_terminal", () => {
  const engine = new WriteApprovalEngine()
  const preview = engine.createPreview({
    taskId: "task-003",
    toolName: "file_write",
    target: { uri: "file:///tmp/secret.txt" },
    effect: { type: "create", canonicalPayload: '{"content":"secret"}' },
  })

  engine.submitDecision({
    previewId: preview.previewId,
    approved: false,
    previewDigest: preview.previewDigest,
    attempt: preview.attempt,
    fencingToken: preview.fencingToken,
    expiresAt: Date.now() + 60_000,
    decidedBy: "human-reviewer",
  })

  const audit = engine.getAuditEvent(preview.previewId)
  assert.equal(audit.preview.state, "denied")

  // Cannot execute after denial
  assert.rejects(() =>
    engine.execute(preview.previewId, async () => ({ success: true })),
  )
})

// --- Guard vectors ---

test("guards: tampered_preview", () => {
  const engine = new WriteApprovalEngine()
  const preview = engine.createPreview({
    taskId: "task-g1",
    toolName: "file_write",
    target: { uri: "file:///tmp/a.txt" },
    effect: { type: "create", canonicalPayload: '{"a":1}' },
  })

  assert.throws(
    () =>
      engine.submitDecision({
        previewId: preview.previewId,
        approved: true,
        previewDigest: "wrong-digest",
        attempt: preview.attempt,
        fencingToken: preview.fencingToken,
        expiresAt: Date.now() + 60_000,
        decidedBy: "reviewer",
      }),
    (err: unknown) => {
      assert.ok(err instanceof WriteApprovalValidationError)
      assert.ok(err.message.includes("tampered_preview"))
      return true
    },
  )
})

test("guards: stale_attempt", () => {
  const engine = new WriteApprovalEngine()
  const preview = engine.createPreview({
    taskId: "task-g2",
    toolName: "file_write",
    target: { uri: "file:///tmp/b.txt" },
    effect: { type: "create", canonicalPayload: '{"b":1}' },
  })

  assert.throws(
    () =>
      engine.submitDecision({
        previewId: preview.previewId,
        approved: true,
        previewDigest: preview.previewDigest,
        attempt: 99,
        fencingToken: preview.fencingToken,
        expiresAt: Date.now() + 60_000,
        decidedBy: "reviewer",
      }),
    (err: unknown) => {
      assert.ok(err instanceof WriteApprovalValidationError)
      assert.ok(err.message.includes("stale_attempt"))
      return true
    },
  )
})

test("guards: fencing_mismatch", () => {
  const engine = new WriteApprovalEngine()
  const preview = engine.createPreview({
    taskId: "task-g3",
    toolName: "file_write",
    target: { uri: "file:///tmp/c.txt" },
    effect: { type: "create", canonicalPayload: '{"c":1}' },
  })

  assert.throws(
    () =>
      engine.submitDecision({
        previewId: preview.previewId,
        approved: true,
        previewDigest: preview.previewDigest,
        attempt: preview.attempt,
        fencingToken: "wrong-token",
        expiresAt: Date.now() + 60_000,
        decidedBy: "reviewer",
      }),
    (err: unknown) => {
      assert.ok(err instanceof WriteApprovalValidationError)
      assert.ok(err.message.includes("fencing_mismatch"))
      return true
    },
  )
})

test("guards: already_consumed", async () => {
  const engine = new WriteApprovalEngine()
  const preview = engine.createPreview({
    taskId: "task-g4",
    toolName: "file_write",
    target: { uri: "file:///tmp/d.txt" },
    effect: { type: "create", canonicalPayload: '{"d":1}' },
  })

  engine.submitDecision({
    previewId: preview.previewId,
    approved: true,
    previewDigest: preview.previewDigest,
    attempt: preview.attempt,
    fencingToken: preview.fencingToken,
    expiresAt: Date.now() + 60_000,
    decidedBy: "reviewer",
  })

  await engine.execute(preview.previewId, async () => ({
    success: true,
    revision: "rev-x",
  }))

  // Create another preview with the same parameters (same idempotency key)
  const preview2 = engine.createPreview({
    taskId: "task-g4",
    toolName: "file_write",
    target: { uri: "file:///tmp/d.txt" },
    effect: { type: "create", canonicalPayload: '{"d":1}' },
  })

  assert.throws(
    () =>
      engine.submitDecision({
        previewId: preview2.previewId,
        approved: true,
        previewDigest: preview2.previewDigest,
        attempt: preview2.attempt,
        fencingToken: preview2.fencingToken,
        expiresAt: Date.now() + 60_000,
        decidedBy: "reviewer",
      }),
    (err: unknown) => {
      assert.ok(err instanceof WriteApprovalValidationError)
      assert.ok(err.message.includes("already_consumed"))
      return true
    },
  )
})

test("guards: approval_expired", () => {
  const engine = new WriteApprovalEngine()
  const preview = engine.createPreview({
    taskId: "task-g5",
    toolName: "file_write",
    target: { uri: "file:///tmp/e.txt" },
    effect: { type: "create", canonicalPayload: '{"e":1}' },
  })

  assert.throws(
    () =>
      engine.submitDecision({
        previewId: preview.previewId,
        approved: true,
        previewDigest: preview.previewDigest,
        attempt: preview.attempt,
        fencingToken: preview.fencingToken,
        expiresAt: Date.now() - 1000, // already expired
        decidedBy: "reviewer",
      }),
    (err: unknown) => {
      assert.ok(err instanceof WriteApprovalValidationError)
      assert.ok(err.message.includes("approval_expired"))
      return true
    },
  )
})

test("guards: undeclared_tool", () => {
  const engine = new WriteApprovalEngine()

  assert.throws(
    () =>
      engine.createPreview({
        taskId: "task-g6",
        toolName: "secret_tool",
        target: { uri: "file:///tmp/f.txt" },
        effect: { type: "create", canonicalPayload: '{"f":1}' },
        declaredTools: ["file_write", "file_read"],
      }),
    (err: unknown) => {
      assert.ok(err instanceof WriteApprovalValidationError)
      assert.ok(err.message.includes("undeclared_tool"))
      return true
    },
  )
})

// --- Idempotency vectors ---

test("idempotency: idempotent_success", async () => {
  const engine = new WriteApprovalEngine()
  const preview = engine.createPreview({
    taskId: "task-i1",
    toolName: "file_write",
    target: { uri: "file:///tmp/idem.txt" },
    effect: { type: "create", canonicalPayload: '{"idem":1}' },
  })

  engine.submitDecision({
    previewId: preview.previewId,
    approved: true,
    previewDigest: preview.previewDigest,
    attempt: preview.attempt,
    fencingToken: preview.fencingToken,
    expiresAt: Date.now() + 60_000,
    decidedBy: "reviewer",
  })

  let callCount = 0
  const executor = async () => {
    callCount++
    return { success: true, revision: "rev-idem" }
  }

  const result1 = await engine.execute(preview.previewId, executor)
  assert.equal(result1.success, true)
  assert.equal(callCount, 1)

  // Second call returns cached, executor not called again
  const result2 = await engine.execute(preview.previewId, executor)
  assert.equal(result2.success, true)
  assert.equal(result2.revision, "rev-idem")
  assert.equal(callCount, 1) // not called again
})

test("idempotency: idempotent_retry_after_fail", async () => {
  const engine = new WriteApprovalEngine()
  const preview = engine.createPreview({
    taskId: "task-i2",
    toolName: "file_write",
    target: { uri: "file:///tmp/retry.txt" },
    effect: { type: "create", canonicalPayload: '{"retry":1}' },
  })

  engine.submitDecision({
    previewId: preview.previewId,
    approved: true,
    previewDigest: preview.previewDigest,
    attempt: preview.attempt,
    fencingToken: preview.fencingToken,
    expiresAt: Date.now() + 60_000,
    decidedBy: "reviewer",
  })

  // First execution fails
  const result1 = await engine.execute(preview.previewId, async () => ({
    success: false,
    errorCode: "network_timeout",
  }))
  assert.equal(result1.success, false)
  assert.equal(result1.state, "failed")

  // After failure, preview state is back to preview_validated with bumped attempt
  const audit = engine.getAuditEvent(preview.previewId)
  assert.equal(audit.preview.attempt, 2)

  // Re-approve with new attempt and fencing token
  engine.submitDecision({
    previewId: preview.previewId,
    approved: true,
    previewDigest: audit.preview.previewDigest,
    attempt: audit.preview.attempt,
    fencingToken: audit.preview.fencingToken,
    expiresAt: Date.now() + 60_000,
    decidedBy: "reviewer",
  })

  // Retry succeeds
  const result2 = await engine.execute(preview.previewId, async () => ({
    success: true,
    revision: "rev-retry",
  }))
  assert.equal(result2.success, true)
  assert.equal(result2.state, "success")
})

test("idempotency: partial_fail_compensation", async () => {
  const engine = new WriteApprovalEngine()
  const preview = engine.createPreview({
    taskId: "task-i3",
    toolName: "file_write",
    target: { uri: "file:///tmp/partial.txt" },
    effect: { type: "create", canonicalPayload: '{"partial":1}' },
  })

  engine.submitDecision({
    previewId: preview.previewId,
    approved: true,
    previewDigest: preview.previewDigest,
    attempt: preview.attempt,
    fencingToken: preview.fencingToken,
    expiresAt: Date.now() + 60_000,
    decidedBy: "reviewer",
  })

  const result = await engine.execute(preview.previewId, async () => ({
    success: false,
    errorCode: "partial_write",
    compensation: { required: true, description: "Delete partially written file" },
  }))

  assert.equal(result.success, false)
  assert.equal(result.state, "partial_fail")
  assert.equal(result.compensation?.required, true)
  assert.equal(result.compensation?.description, "Delete partially written file")
})

// --- Unit tests for pure functions ---

test("computePreviewDigest is deterministic", () => {
  const target: WriteTarget = { uri: "file:///a.txt", baseRevision: "r1" }
  const effect: WriteEffect = { type: "create", canonicalPayload: '{"x":1}' }
  const d1 = computePreviewDigest(target, effect)
  const d2 = computePreviewDigest(target, effect)
  assert.equal(d1, d2)
  assert.equal(d1.length, 64) // hex SHA-256
})

test("computePreviewDigest varies with input", () => {
  const target: WriteTarget = { uri: "file:///a.txt" }
  const e1: WriteEffect = { type: "create", canonicalPayload: '{"x":1}' }
  const e2: WriteEffect = { type: "create", canonicalPayload: '{"x":2}' }
  assert.notEqual(computePreviewDigest(target, e1), computePreviewDigest(target, e2))
})

test("deriveIdempotencyKey is deterministic and varies with input", () => {
  const k1 = deriveIdempotencyKey("t1", "tool", "uri", "create", "digest1")
  const k2 = deriveIdempotencyKey("t1", "tool", "uri", "create", "digest1")
  const k3 = deriveIdempotencyKey("t2", "tool", "uri", "create", "digest1")
  assert.equal(k1, k2)
  assert.notEqual(k1, k3)
})

test("validateWritePreviewRequest rejects invalid input", () => {
  assert.throws(() => validateWritePreviewRequest(null))
  assert.throws(() => validateWritePreviewRequest({}))
  assert.throws(() => validateWritePreviewRequest({ taskId: "" }))
})
