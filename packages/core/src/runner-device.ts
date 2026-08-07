/**
 * Runner device-key lifecycle: enrollment, authentication, rotation,
 * overlap, and revocation.
 *
 * A "device" is a seller-owned Runner instance with an Ed25519 key pair.
 * The platform identifies a device by its keyId (fingerprint of the public
 * key). Device keys are rotated periodically; during rotation, both the
 * current and next key are valid (overlap window).
 *
 * This module defines the contracts and a local key-store port. Actual
 * storage (Keychain, TPM, encrypted file) is injected by the deployment.
 */

import { createHash } from "node:crypto"
import type { KeyObject } from "node:crypto"

import { CoreError } from "./contracts.js"
import { RUNNER_SIGNATURE_ALGORITHM } from "./runner-protocol.js"

// --- Constants ---

export const RUNNER_DEVICE_VERSION = "runner-device.v1" as const

/** Maximum overlap window during key rotation (seconds). */
export const RUNNER_DEVICE_MAX_OVERLAP_SECONDS = 3600

/** Minimum key lifetime before rotation is allowed (seconds). */
export const RUNNER_DEVICE_MIN_LIFETIME_SECONDS = 86400

/** Maximum number of historical key entries retained. */
export const RUNNER_DEVICE_MAX_HISTORY = 16

// --- Error codes ---

export type RunnerDeviceErrorCode =
  | "RUNNER_DEVICE_NOT_ENROLLED"
  | "RUNNER_DEVICE_ALREADY_ENROLLED"
  | "RUNNER_DEVICE_KEY_EXPIRED"
  | "RUNNER_DEVICE_KEY_REVOKED"
  | "RUNNER_DEVICE_ROTATION_TOO_EARLY"
  | "RUNNER_DEVICE_OVERLAP_EXCEEDED"
  | "RUNNER_DEVICE_STORE_FAILED"

export class RunnerDeviceError extends CoreError {
  constructor(code: RunnerDeviceErrorCode, message?: string) {
    super(code, message ?? "Runner device operation failed", {
      status: 400,
      retryable: false,
    })
    this.name = "RunnerDeviceError"
  }
}

// --- Types ---

export type DeviceKeyStatus = "active" | "rotating" | "revoked" | "expired"

export interface DeviceKeyRecord {
  /** Deterministic identifier derived from the public key bytes. */
  keyId: string
  /** Status of this key in the lifecycle. */
  status: DeviceKeyStatus
  /** ISO timestamp when the key was enrolled or rotated in. */
  activeSince: string
  /** ISO timestamp when the key was revoked or expired (if applicable). */
  revokedAt?: string
  /** If status is "rotating", the replacement keyId. */
  nextKeyId?: string
}

export interface DeviceEnrollment {
  version: typeof RUNNER_DEVICE_VERSION
  runnerId: string
  sellerId: string
  keyId: string
  publicKeySpki: string
  enrolledAt: string
}

export interface DeviceRotationRequest {
  version: typeof RUNNER_DEVICE_VERSION
  runnerId: string
  currentKeyId: string
  nextKeyId: string
  nextPublicKeySpki: string
  requestedAt: string
}

export interface DeviceRotationAck {
  version: typeof RUNNER_DEVICE_VERSION
  currentKeyId: string
  nextKeyId: string
  overlapExpiresAt: string
  acknowledgedAt: string
}

export interface DeviceRevocation {
  version: typeof RUNNER_DEVICE_VERSION
  runnerId: string
  keyId: string
  reason: "rotation_complete" | "compromised" | "admin_revoke"
  revokedAt: string
}

// --- Key store port ---

/**
 * Abstract port for device key persistence. Implementations may use
 * Keychain, TPM, encrypted file, or any secure store.
 */
export interface RunnerDeviceKeyStorePort {
  /** Load the current active key record (or null if not enrolled). */
  loadActiveKey(): Promise<DeviceKeyRecord | null>

  /** Load a key record by keyId. */
  loadKey(keyId: string): Promise<DeviceKeyRecord | null>

  /** Load all key records (for diagnostics/rotation history). */
  loadHistory(): Promise<DeviceKeyRecord[]>

  /** Persist a new key record atomically. */
  saveKey(record: DeviceKeyRecord): Promise<void>

  /** Load the private key material for signing. */
  loadPrivateKey(keyId: string): Promise<KeyObject | null>

  /** Persist a new key pair. */
  saveKeyPair(keyId: string, privateKey: KeyObject, publicKey: KeyObject): Promise<void>

  /** Remove private key material (after revocation). */
  deletePrivateKey(keyId: string): Promise<void>
}

// --- Utility ---

/**
 * Derives a deterministic keyId from an Ed25519 public key.
 * Format: "device:<sha256-of-spki-der-hex-first-16-chars>"
 */
export function deriveDeviceKeyId(publicKey: KeyObject): string {
  const spkiDer = publicKey.export({ type: "spki", format: "der" })
  const hash = createHash("sha256").update(spkiDer).digest("hex")
  return `device:${hash.slice(0, 16)}`
}

// --- Device lifecycle operations ---

/**
 * Validates that a device enrollment request is well-formed.
 * Does NOT perform network enrollment — that is the transport layer's job.
 */
export function validateDeviceEnrollment(
  input: unknown,
): DeviceEnrollment {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RunnerDeviceError("RUNNER_DEVICE_STORE_FAILED", "enrollment must be an object")
  }
  const obj = input as Record<string, unknown>
  if (obj.version !== RUNNER_DEVICE_VERSION) {
    throw new RunnerDeviceError("RUNNER_DEVICE_STORE_FAILED", "unsupported device version")
  }
  if (typeof obj.runnerId !== "string" || !obj.runnerId) {
    throw new RunnerDeviceError("RUNNER_DEVICE_STORE_FAILED", "runnerId required")
  }
  if (typeof obj.sellerId !== "string" || !obj.sellerId) {
    throw new RunnerDeviceError("RUNNER_DEVICE_STORE_FAILED", "sellerId required")
  }
  if (typeof obj.keyId !== "string" || !obj.keyId) {
    throw new RunnerDeviceError("RUNNER_DEVICE_STORE_FAILED", "keyId required")
  }
  if (typeof obj.publicKeySpki !== "string" || !obj.publicKeySpki) {
    throw new RunnerDeviceError("RUNNER_DEVICE_STORE_FAILED", "publicKeySpki required")
  }
  if (typeof obj.enrolledAt !== "string" || !obj.enrolledAt) {
    throw new RunnerDeviceError("RUNNER_DEVICE_STORE_FAILED", "enrolledAt required")
  }
  return {
    version: RUNNER_DEVICE_VERSION,
    runnerId: obj.runnerId,
    sellerId: obj.sellerId,
    keyId: obj.keyId,
    publicKeySpki: obj.publicKeySpki,
    enrolledAt: obj.enrolledAt,
  }
}

/**
 * Validates a rotation request is well-formed and the current key is
 * eligible for rotation (past minimum lifetime).
 */
export function validateRotationEligibility(
  currentKey: DeviceKeyRecord,
  nowMs: number,
): void {
  if (currentKey.status !== "active") {
    throw new RunnerDeviceError(
      "RUNNER_DEVICE_ROTATION_TOO_EARLY",
      `cannot rotate key in status: ${currentKey.status}`,
    )
  }
  const activeMs = nowMs - new Date(currentKey.activeSince).getTime()
  if (activeMs < RUNNER_DEVICE_MIN_LIFETIME_SECONDS * 1000) {
    throw new RunnerDeviceError(
      "RUNNER_DEVICE_ROTATION_TOO_EARLY",
      `key active for ${Math.floor(activeMs / 1000)}s, minimum is ${RUNNER_DEVICE_MIN_LIFETIME_SECONDS}s`,
    )
  }
}

/**
 * Validates that a rotation acknowledgment is consistent.
 */
export function validateRotationAck(
  input: unknown,
  expectedCurrentKeyId: string,
  expectedNextKeyId: string,
): DeviceRotationAck {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RunnerDeviceError("RUNNER_DEVICE_STORE_FAILED", "ack must be an object")
  }
  const obj = input as Record<string, unknown>
  if (obj.version !== RUNNER_DEVICE_VERSION) {
    throw new RunnerDeviceError("RUNNER_DEVICE_STORE_FAILED", "unsupported device version")
  }
  if (obj.currentKeyId !== expectedCurrentKeyId) {
    throw new RunnerDeviceError("RUNNER_DEVICE_STORE_FAILED", "currentKeyId mismatch")
  }
  if (obj.nextKeyId !== expectedNextKeyId) {
    throw new RunnerDeviceError("RUNNER_DEVICE_STORE_FAILED", "nextKeyId mismatch")
  }
  if (typeof obj.overlapExpiresAt !== "string" || !obj.overlapExpiresAt) {
    throw new RunnerDeviceError("RUNNER_DEVICE_STORE_FAILED", "overlapExpiresAt required")
  }
  if (typeof obj.acknowledgedAt !== "string" || !obj.acknowledgedAt) {
    throw new RunnerDeviceError("RUNNER_DEVICE_STORE_FAILED", "acknowledgedAt required")
  }
  return {
    version: RUNNER_DEVICE_VERSION,
    currentKeyId: obj.currentKeyId,
    nextKeyId: obj.nextKeyId,
    overlapExpiresAt: obj.overlapExpiresAt,
    acknowledgedAt: obj.acknowledgedAt,
  }
}
