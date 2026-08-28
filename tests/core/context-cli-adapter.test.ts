import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import {
  ContextPortError,
  createContextCliAdapter,
  type ContextReadRequest,
} from "../../packages/core/index.js"

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const FAKE_CLI = path.join(TEST_DIR, "..", "fixtures", "context-fake-cli.mjs")

const WORKSPACE = "workspace-instance"
const POSITION = "repo-owner"
const PRINCIPAL = "position.repo-owner"

function adapter(mode: string, overrides: Record<string, unknown> = {}) {
  return createContextCliAdapter({
    command: [process.execPath, FAKE_CLI],
    workspaceId: WORKSPACE,
    positionId: POSITION,
    env: { ...process.env, FAKE_CONTEXT_MODE: mode },
    ...overrides,
  })
}

function request(overrides: Partial<ContextReadRequest> = {}): ContextReadRequest {
  return {
    workspaceId: WORKSPACE,
    positionId: POSITION,
    principal: PRINCIPAL,
    mode: "optional",
    ...overrides,
  }
}

async function expectPortError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof ContextPortError, `expected ContextPortError, got ${error}`)
    assert.equal((error as ContextPortError).code, code)
    return
  }
  assert.fail(`expected ${code}, but the recall succeeded`)
}

test("happy path: pinned scope passes and the strict bundle validates", async () => {
  const bundle = await adapter("happy").recall(request())
  assert.equal(bundle.schemaVersion, "context-bundle.v1")
  assert.deepEqual(bundle.scope, {
    workspaceId: WORKSPACE,
    positionId: POSITION,
    principal: PRINCIPAL,
  })
  assert.equal(bundle.items.length, 2)
  assert.equal(bundle.items[0]!.text, "context fact one")
  assert.equal(bundle.items[0]!.trust, "untrusted-context-data")
  assert.ok(bundle.bundleDigest.startsWith("sha256:"))
  assert.deepEqual(bundle.warnings, ["UNTRUSTED_CONTEXT_DATA_NOT_INSTRUCTIONS"])
})

test("pinned binding rejects a mismatched request before any spawn", async () => {
  await expectPortError(
    adapter("happy").recall(request({ positionId: "other-position" })),
    "CONTEXT_SCOPE_MISMATCH",
  )
  await expectPortError(
    adapter("happy").recall(request({ principal: "position.other" })),
    "CONTEXT_SCOPE_MISMATCH",
  )
})

test("tampered artifact digest fails closed as corrupt record", async () => {
  await expectPortError(adapter("tampered").recall(request()), "CONTEXT_CORRUPT_RECORD")
})

test("wrong-scope envelope fails closed as scope mismatch", async () => {
  await expectPortError(adapter("wrong-scope").recall(request()), "CONTEXT_SCOPE_MISMATCH")
})

test("envelope exceeding the requested item bound fails closed", async () => {
  await expectPortError(
    adapter("over-items").recall(request({ maxItems: 2 })),
    "CONTEXT_BUNDLE_INVALID",
  )
})

test("malformed item timestamp fails closed", async () => {
  await expectPortError(adapter("bad-timestamp").recall(request()), "CONTEXT_BUNDLE_INVALID")
})

test("stale retrievedAt fails closed outside the freshness window", async () => {
  await expectPortError(adapter("stale").recall(request()), "CONTEXT_BUNDLE_INVALID")
})

test("unparseable stdout fails closed as invalid envelope", async () => {
  await expectPortError(adapter("invalid-json").recall(request()), "CONTEXT_BUNDLE_INVALID")
})

test("runtime authority denial maps to CONTEXT_AUTH_DENIED", async () => {
  await expectPortError(adapter("auth-denied").recall(request()), "CONTEXT_AUTH_DENIED")
})

test("unknown CLI failure fails closed as a denial, never an outage", async () => {
  await expectPortError(adapter("unknown-failure").recall(request()), "CONTEXT_DENIED")
})

test("missing CLI binary is a typed unavailable outage", async () => {
  const missing = createContextCliAdapter({
    command: ["/nonexistent/context-bin-does-not-exist"],
    workspaceId: WORKSPACE,
    positionId: POSITION,
  })
  try {
    await missing.recall(request())
    assert.fail("expected CONTEXT_UNAVAILABLE")
  } catch (error) {
    assert.ok(error instanceof ContextPortError)
    assert.equal((error as ContextPortError).code, "CONTEXT_UNAVAILABLE")
    assert.equal((error as ContextPortError).retryable, true)
  }
})

test("timeout is a typed unavailable outage", async () => {
  await expectPortError(
    adapter("slow", { timeoutMs: 300 }).recall(request()),
    "CONTEXT_UNAVAILABLE",
  )
})

test("invalid configuration fails closed at construction", () => {
  assert.throws(
    () =>
      createContextCliAdapter({
        command: [],
        workspaceId: WORKSPACE,
        positionId: POSITION,
      }),
    (error: unknown) =>
      error instanceof ContextPortError &&
      error.code === "CONTEXT_CONFIGURATION_INVALID",
  )
  assert.throws(
    () =>
      createContextCliAdapter({
        command: [process.execPath, FAKE_CLI],
        workspaceId: "has space",
        positionId: POSITION,
      }),
    (error: unknown) =>
      error instanceof ContextPortError &&
      error.code === "CONTEXT_CONFIGURATION_INVALID",
  )
})

test("invalid recall bounds fail closed before any spawn", async () => {
  await expectPortError(
    adapter("happy").recall(request({ maxItems: 0 })),
    "CONTEXT_CONFIGURATION_INVALID",
  )
  await expectPortError(
    adapter("happy").recall(request({ maxBytes: 999_999_999 })),
    "CONTEXT_CONFIGURATION_INVALID",
  )
})
