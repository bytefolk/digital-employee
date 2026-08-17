/**
 * Tests for the HTTP outbound Runner transport against a local server.
 *
 * Covers: endpoint wiring for every documented route, response version
 * enforcement, semantic error mapping (incl. 429 Retry-After), transient
 * retry, platform public-key caching, and request timeouts.
 */

import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"

import { CoreError } from "../../packages/core/src/contracts.js"
import { HttpRunnerTransport } from "../../packages/core/src/runner-http-transport.js"
import type { SignedEnvelope } from "../../packages/core/src/runner-protocol.js"
import { RUNNER_PROTOCOL_VERSION } from "../../packages/core/src/runner-protocol.js"
import {
  RUNNER_TRANSPORT_VERSION,
  RunnerTransportError,
} from "../../packages/core/src/runner-transport.js"
import type { NextTaskRequest } from "../../packages/core/src/runner-transport.js"

interface RequestLog {
  path: string
  body: unknown
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, log: RequestLog[]) => void,
  fn: (url: string, log: RequestLog[]) => Promise<void>,
) {
  const log: RequestLog[] = []
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8")
    })
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as unknown) : undefined
      log.push({ path: req.url ?? "", body })
      handler(req, res, log)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  try {
    await fn(`http://127.0.0.1:${port}`, log)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function json(res: ServerResponse, status: number, body: unknown, retryAfter?: string): void {
  res.writeHead(status, {
    "content-type": "application/json",
    ...(retryAfter !== undefined ? { "retry-after": retryAfter } : {}),
  })
  res.end(JSON.stringify(body))
}

function meta(): { deviceKeyId: string; requestNonce: string; requestedAt: string; runnerId: string } {
  return {
    deviceKeyId: "device:http-test",
    requestNonce: "req-1",
    requestedAt: "2026-08-04T00:00:00.000Z",
    runnerId: "runner-http-test",
  }
}

function makeTransport(url: string, options?: { timeoutMs?: number; maxRetries?: number }) {
  return new HttpRunnerTransport({
    endpoint: url,
    timeoutMs: options?.timeoutMs ?? 2_000,
    maxRetries: options?.maxRetries ?? 0,
  })
}

const version = RUNNER_TRANSPORT_VERSION

test("nextTask posts to /v1/runner/next-task and parses the response", async () => {
  await withServer(
    (_req, res) => {
      json(res, 200, { version, hasTask: false, polledAt: "2026-08-04T00:00:01.000Z" })
    },
    async (url, log) => {
      const transport = makeTransport(url)
      const response = await transport.nextTask({
        version,
        meta: meta(),
      })
      assert.equal(response.hasTask, false)
      assert.equal(log.length, 1)
      assert.equal(log[0].path, "/v1/runner/next-task")
      const body = log[0].body as NextTaskRequest
      assert.equal(body.meta.deviceKeyId, "device:http-test")
    },
  )
})

test("claim/heartbeat/events/receipt/enroll/rotate/revoke wire to documented paths", async () => {
  const envelope: SignedEnvelope = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    keyId: "platform-key-1",
    algorithm: "Ed25519",
    payload: "{}",
    signature: "sig",
  }
  await withServer(
    (req, res) => {
      const path = req.url ?? ""
      const bodies: Record<string, unknown> = {
        "/v1/runner/claim": {
          version,
          taskEnvelope: envelope,
          platformKeyId: "platform-key-1",
          grantedAt: "2026-08-04T00:00:01.000Z",
        },
        "/v1/runner/heartbeat": {
          version,
          renewedEnvelope: envelope,
          acknowledgedAt: "2026-08-04T00:00:01.000Z",
        },
        "/v1/runner/events": {
          version,
          accepted: 2,
          lastAcceptedDigest: "digest-2",
          acknowledgedAt: "2026-08-04T00:00:01.000Z",
        },
        "/v1/runner/receipt": {
          version,
          accepted: true,
          settledAt: "2026-08-04T00:00:01.000Z",
        },
        "/v1/runner/device/enroll": {
          version,
          accepted: true,
          platformKeyId: "platform-key-1",
          enrolledAt: "2026-08-04T00:00:01.000Z",
        },
        "/v1/runner/device/rotate": {
          version,
          ack: {
            version: "runner-device.v1",
            currentKeyId: "device:old",
            nextKeyId: "device:new",
            overlapExpiresAt: "2026-08-04T01:00:00.000Z",
            acknowledgedAt: "2026-08-04T00:00:01.000Z",
          },
        },
        "/v1/runner/device/revoke": {
          version,
          accepted: true,
          revokedAt: "2026-08-04T00:00:01.000Z",
        },
      }
      json(res, 200, bodies[path] ?? { error: "unexpected path" })
    },
    async (url, log) => {
      const transport = makeTransport(url)
      const m = meta()

      const claim = await transport.claim({
        version,
        meta: m,
        taskId: "task-1",
        runId: "run-1",
        attempt: 1,
        fencingToken: 1,
      })
      assert.equal(claim.platformKeyId, "platform-key-1")
      assert.deepEqual(claim.taskEnvelope, envelope)

      const heartbeat = await transport.heartbeat({
        version,
        meta: m,
        leaseId: "lease-1",
        taskId: "task-1",
        currentFencingToken: 1,
        eventDigests: ["digest-1"],
      })
      assert.deepEqual(heartbeat.renewedEnvelope, envelope)

      const events = await transport.appendEvents({
        version,
        meta: m,
        leaseId: "lease-1",
        taskId: "task-1",
        events: [],
      })
      assert.equal(events.accepted, 2)

      const receipt = await transport.submitReceipt({
        version,
        meta: m,
        leaseId: "lease-1",
        signedReceipt: envelope,
      })
      assert.equal(receipt.accepted, true)

      const enroll = await transport.enrollDevice({
        version,
        enrollment: {
          version: "runner-device.v1",
          runnerId: "runner-1",
          sellerId: "seller-1",
          keyId: "device:new",
          publicKeySpki: "pem",
          enrolledAt: "2026-08-04T00:00:00.000Z",
        },
      })
      assert.equal(enroll.accepted, true)

      const rotate = await transport.rotateKey({
        version,
        meta: m,
        rotation: {
          version: "runner-device.v1",
          runnerId: "runner-1",
          currentKeyId: "device:old",
          nextKeyId: "device:new",
          nextPublicKeySpki: "pem",
          requestedAt: "2026-08-04T00:00:00.000Z",
        },
      })
      assert.equal(rotate.ack.nextKeyId, "device:new")

      const revoke = await transport.revokeKey({
        version,
        meta: m,
        revocation: {
          version: "runner-device.v1",
          runnerId: "runner-1",
          keyId: "device:old",
          reason: "rotation_complete",
          revokedAt: "2026-08-04T00:00:00.000Z",
        },
      })
      assert.equal(revoke.accepted, true)

      const paths = log.map((entry) => entry.path)
      for (const expected of [
        "/v1/runner/claim",
        "/v1/runner/heartbeat",
        "/v1/runner/events",
        "/v1/runner/receipt",
        "/v1/runner/device/enroll",
        "/v1/runner/device/rotate",
        "/v1/runner/device/revoke",
      ]) {
        assert.ok(paths.includes(expected), `missing request to ${expected}`)
      }
      assert.ok(log.every((entry) => entry.body !== undefined))
    },
  )
})

test("response version mismatch is rejected as payload error", async () => {
  await withServer(
    (_req, res) => {
      json(res, 200, { version: "runner-transport.v2", hasTask: false })
    },
    async (url) => {
      const transport = makeTransport(url)
      await assert.rejects(
        transport.nextTask({ version, meta: meta() }),
        (err: unknown) => {
          assert.ok(err instanceof RunnerTransportError)
          assert.equal(err.code, "RUNNER_TRANSPORT_PAYLOAD_REJECTED")
          return true
        },
      )
    },
  )
})

test("error statuses map to semantic transport errors", async () => {
  const cases: Array<{ status: number; code: string; retryAfter?: string; retryAfterMs?: number }> = [
    { status: 400, code: "RUNNER_TRANSPORT_PAYLOAD_REJECTED" },
    { status: 404, code: "RUNNER_TRANSPORT_PAYLOAD_REJECTED" },
    { status: 422, code: "RUNNER_TRANSPORT_PAYLOAD_REJECTED" },
    { status: 401, code: "RUNNER_TRANSPORT_UNAUTHORIZED" },
    { status: 403, code: "RUNNER_TRANSPORT_FORBIDDEN" },
    { status: 409, code: "RUNNER_TRANSPORT_CONFLICT" },
    { status: 429, code: "RUNNER_TRANSPORT_RATE_LIMITED", retryAfter: "5", retryAfterMs: 5_000 },
    { status: 500, code: "RUNNER_TRANSPORT_UNAVAILABLE" },
  ]

  for (const c of cases) {
    await withServer(
      (_req, res) => {
        json(res, c.status, { code: "x", message: "boom" }, c.retryAfter)
      },
      async (url) => {
        const transport = makeTransport(url)
        await assert.rejects(
          transport.nextTask({ version, meta: meta() }),
          (err: unknown) => {
            assert.ok(err instanceof RunnerTransportError, `status ${c.status}`)
            assert.equal(err.code, c.code, `status ${c.status}`)
            assert.equal(err.retryable, err.code !== "RUNNER_TRANSPORT_PAYLOAD_REJECTED" && err.code !== "RUNNER_TRANSPORT_UNAUTHORIZED" && err.code !== "RUNNER_TRANSPORT_FORBIDDEN" && err.code !== "RUNNER_TRANSPORT_CONFLICT")
            if (c.retryAfterMs !== undefined) {
              assert.equal(err.retryAfterMs, c.retryAfterMs)
            }
            return true
          },
        )
      },
    )
  }
})

test("transient failures retry with backoff until success", async () => {
  let attempts = 0
  await withServer(
    (_req, res) => {
      attempts += 1
      if (attempts < 3) {
        json(res, 503, { code: "unavailable", message: "warming up" })
      } else {
        json(res, 200, { version, hasTask: false, polledAt: "2026-08-04T00:00:01.000Z" })
      }
    },
    async (url) => {
      const transport = new HttpRunnerTransport({
        endpoint: url,
        timeoutMs: 2_000,
        maxRetries: 5,
      })
      const response = await transport.nextTask({ version, meta: meta() })
      assert.equal(response.hasTask, false)
      assert.equal(attempts, 3)
    },
  )
})

test("platformKey resolves, caches, and validates the returned PEM", async () => {
  const { publicKey } = generateKeyPairSync("ed25519")
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString()
  let hits = 0

  await withServer(
    (req, res) => {
      hits += 1
      assert.equal(req.url, "/v1/keys/platform-key-1")
      json(res, 200, { keyId: "platform-key-1", publicKeyPem: pem })
    },
    async (url) => {
      const transport = makeTransport(url)
      const first = await transport.platformKey("platform-key-1")
      const second = await transport.platformKey("platform-key-1")
      assert.equal(first.export({ type: "spki", format: "pem" }).toString(), pem)
      assert.equal(second, first, "cached instance should be reused")
      assert.equal(hits, 1)
    },
  )
})

test("platformKey rejects invalid PEM and mismatched keyId", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/v1/keys/bad-pem") {
        json(res, 200, { keyId: "bad-pem", publicKeyPem: "not a pem" })
      } else {
        json(res, 200, { keyId: "other-key", publicKeyPem: "not a pem" })
      }
    },
    async (url) => {
      const transport = makeTransport(url)
      await assert.rejects(transport.platformKey("bad-pem"), (err: unknown) => {
        assert.ok(err instanceof CoreError)
        assert.equal(err.code, "RUNNER_PLATFORM_KEY_INVALID")
        return true
      })
      await assert.rejects(transport.platformKey("mismatch"), (err: unknown) => {
        assert.ok(err instanceof CoreError)
        assert.equal(err.code, "RUNNER_PLATFORM_KEY_INVALID")
        return true
      })
    },
  )
})

test("request timeout produces RUNNER_TRANSPORT_TIMEOUT", async () => {
  await withServer(
    (_req, res) => {
      setTimeout(() => json(res, 200, { version, hasTask: false }), 200)
    },
    async (url) => {
      const transport = makeTransport(url, { timeoutMs: 30 })
      await assert.rejects(
        transport.nextTask({ version, meta: meta() }),
        (err: unknown) => {
          assert.ok(err instanceof RunnerTransportError)
          assert.equal(err.code, "RUNNER_TRANSPORT_TIMEOUT")
          assert.equal(err.retryable, true)
          return true
        },
      )
    },
  )
})

test("connection failure produces RUNNER_TRANSPORT_UNAVAILABLE", async () => {
  const transport = makeTransport("http://127.0.0.1:1", { maxRetries: 0 })
  await assert.rejects(
    transport.nextTask({ version, meta: meta() }),
    (err: unknown) => {
      assert.ok(err instanceof RunnerTransportError)
      assert.equal(err.code, "RUNNER_TRANSPORT_UNAVAILABLE")
      return true
    },
  )
})
