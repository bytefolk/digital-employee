import assert from "node:assert/strict"
import test from "node:test"
import { generateKeyPairSync, createPublicKey } from "node:crypto"

import {
  RUNNER_DEVICE_VERSION,
  RUNNER_DEVICE_MIN_LIFETIME_SECONDS,
  deriveDeviceKeyId,
  validateDeviceEnrollment,
  validateRotationEligibility,
  validateRotationAck,
  RunnerDeviceError,
} from "../../packages/core/index.js"
import type { DeviceKeyRecord } from "../../packages/core/index.js"

function generateEd25519Pair() {
  return generateKeyPairSync("ed25519")
}

test("deriveDeviceKeyId produces deterministic id from public key", () => {
  const { publicKey } = generateEd25519Pair()
  const id1 = deriveDeviceKeyId(publicKey)
  const id2 = deriveDeviceKeyId(publicKey)
  assert.equal(id1, id2)
  assert.ok(id1.startsWith("device:"))
  assert.equal(id1.length, "device:".length + 16)
})

test("deriveDeviceKeyId produces different ids for different keys", () => {
  const { publicKey: pk1 } = generateEd25519Pair()
  const { publicKey: pk2 } = generateEd25519Pair()
  assert.notEqual(deriveDeviceKeyId(pk1), deriveDeviceKeyId(pk2))
})

test("validateDeviceEnrollment accepts valid enrollment", () => {
  const { publicKey } = generateEd25519Pair()
  const keyId = deriveDeviceKeyId(publicKey)
  const spki = publicKey.export({ type: "spki", format: "pem" }) as string

  const enrollment = validateDeviceEnrollment({
    version: RUNNER_DEVICE_VERSION,
    runnerId: "runner-001",
    sellerId: "seller-001",
    keyId,
    publicKeySpki: spki,
    enrolledAt: new Date().toISOString(),
  })

  assert.equal(enrollment.version, RUNNER_DEVICE_VERSION)
  assert.equal(enrollment.runnerId, "runner-001")
  assert.equal(enrollment.keyId, keyId)
})

test("validateDeviceEnrollment rejects missing fields", () => {
  assert.throws(
    () => validateDeviceEnrollment({ version: RUNNER_DEVICE_VERSION }),
    (err: unknown) => err instanceof RunnerDeviceError,
  )
  assert.throws(
    () => validateDeviceEnrollment(null),
    (err: unknown) => err instanceof RunnerDeviceError,
  )
  assert.throws(
    () => validateDeviceEnrollment("string"),
    (err: unknown) => err instanceof RunnerDeviceError,
  )
})

test("validateDeviceEnrollment rejects wrong version", () => {
  assert.throws(
    () =>
      validateDeviceEnrollment({
        version: "runner-device.v99",
        runnerId: "r",
        sellerId: "s",
        keyId: "k",
        publicKeySpki: "p",
        enrolledAt: "2026-01-01T00:00:00.000Z",
      }),
    (err: unknown) => err instanceof RunnerDeviceError,
  )
})

test("validateRotationEligibility allows rotation after minimum lifetime", () => {
  const activeSince = new Date(
    Date.now() - (RUNNER_DEVICE_MIN_LIFETIME_SECONDS + 1) * 1000,
  ).toISOString()
  const record: DeviceKeyRecord = {
    keyId: "device:abc123",
    status: "active",
    activeSince,
  }
  // Should not throw
  validateRotationEligibility(record, Date.now())
})

test("validateRotationEligibility rejects rotation too early", () => {
  const activeSince = new Date(Date.now() - 1000).toISOString()
  const record: DeviceKeyRecord = {
    keyId: "device:abc123",
    status: "active",
    activeSince,
  }
  assert.throws(
    () => validateRotationEligibility(record, Date.now()),
    (err: unknown) =>
      err instanceof RunnerDeviceError &&
      err.code === "RUNNER_DEVICE_ROTATION_TOO_EARLY",
  )
})

test("validateRotationEligibility rejects non-active keys", () => {
  const record: DeviceKeyRecord = {
    keyId: "device:abc123",
    status: "revoked",
    activeSince: new Date(0).toISOString(),
    revokedAt: new Date().toISOString(),
  }
  assert.throws(
    () => validateRotationEligibility(record, Date.now()),
    (err: unknown) =>
      err instanceof RunnerDeviceError &&
      err.code === "RUNNER_DEVICE_ROTATION_TOO_EARLY",
  )
})

test("validateRotationAck accepts valid ack", () => {
  const ack = validateRotationAck(
    {
      version: RUNNER_DEVICE_VERSION,
      currentKeyId: "device:current",
      nextKeyId: "device:next",
      overlapExpiresAt: "2026-08-08T00:00:00.000Z",
      acknowledgedAt: "2026-08-07T00:00:00.000Z",
    },
    "device:current",
    "device:next",
  )
  assert.equal(ack.currentKeyId, "device:current")
  assert.equal(ack.nextKeyId, "device:next")
})

test("validateRotationAck rejects mismatched keyIds", () => {
  assert.throws(
    () =>
      validateRotationAck(
        {
          version: RUNNER_DEVICE_VERSION,
          currentKeyId: "device:wrong",
          nextKeyId: "device:next",
          overlapExpiresAt: "2026-08-08T00:00:00.000Z",
          acknowledgedAt: "2026-08-07T00:00:00.000Z",
        },
        "device:current",
        "device:next",
      ),
    (err: unknown) => err instanceof RunnerDeviceError,
  )
})
