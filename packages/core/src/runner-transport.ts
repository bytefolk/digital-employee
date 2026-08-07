/**
 * Runner outbound transport port.
 *
 * Defines the transport-neutral contract for authenticated outbound
 * communication between a Runner and the platform. All methods are
 * outbound-only (no listening port required on the seller machine).
 *
 * Concrete implementations (HTTP/gRPC) are injected at deployment time.
 * This module only specifies the port interface, request/response shapes,
 * and the retry/idempotency semantics that any implementation must honour.
 */

import type { SignedEnvelope, RunnerEvent, OpaqueData } from "./runner-protocol.js"
import type { DeviceEnrollment, DeviceRotationRequest, DeviceRotationAck, DeviceRevocation } from "./runner-device.js"
import { CoreError } from "./contracts.js"

// --- Constants ---

export const RUNNER_TRANSPORT_VERSION = "runner-transport.v1" as const

/** Maximum retry attempts for transient failures. */
export const RUNNER_TRANSPORT_MAX_RETRIES = 5

/** Base backoff delay (ms) for exponential retry. */
export const RUNNER_TRANSPORT_BASE_BACKOFF_MS = 500

/** Maximum backoff delay (ms). */
export const RUNNER_TRANSPORT_MAX_BACKOFF_MS = 30_000

/** Request timeout (ms). */
export const RUNNER_TRANSPORT_REQUEST_TIMEOUT_MS = 30_000

// --- Error codes ---

export type RunnerTransportErrorCode =
  | "RUNNER_TRANSPORT_UNAVAILABLE"
  | "RUNNER_TRANSPORT_TIMEOUT"
  | "RUNNER_TRANSPORT_UNAUTHORIZED"
  | "RUNNER_TRANSPORT_FORBIDDEN"
  | "RUNNER_TRANSPORT_CONFLICT"
  | "RUNNER_TRANSPORT_RATE_LIMITED"
  | "RUNNER_TRANSPORT_PAYLOAD_REJECTED"

export class RunnerTransportError extends CoreError {
  readonly retryAfterMs?: number

  constructor(
    code: RunnerTransportErrorCode,
    message?: string,
    options?: { retryAfterMs?: number },
  ) {
    super(code, message ?? "Runner transport request failed", {
      status: code === "RUNNER_TRANSPORT_UNAVAILABLE" ? 503 : 400,
      retryable:
        code === "RUNNER_TRANSPORT_UNAVAILABLE" ||
        code === "RUNNER_TRANSPORT_TIMEOUT" ||
        code === "RUNNER_TRANSPORT_RATE_LIMITED",
    })
    this.name = "RunnerTransportError"
    this.retryAfterMs = options?.retryAfterMs
  }
}

// --- Request/response types ---

export interface TransportRequestMeta {
  /** Device keyId used to authenticate this request. */
  deviceKeyId: string
  /** Monotonic request nonce for replay prevention. */
  requestNonce: string
  /** ISO timestamp of request creation. */
  requestedAt: string
  /** Runner identifier. */
  runnerId: string
}

export interface ClaimRequest {
  version: typeof RUNNER_TRANSPORT_VERSION
  meta: TransportRequestMeta
  taskId: string
  runId: string
  attempt: number
  fencingToken: number
}

export interface ClaimResponse {
  version: typeof RUNNER_TRANSPORT_VERSION
  taskEnvelope: SignedEnvelope
  platformKeyId: string
  grantedAt: string
}

export interface HeartbeatRequest {
  version: typeof RUNNER_TRANSPORT_VERSION
  meta: TransportRequestMeta
  leaseId: string
  taskId: string
  currentFencingToken: number
  /** Events accumulated since last heartbeat (bounded). */
  eventDigests: string[]
}

export interface HeartbeatResponse {
  version: typeof RUNNER_TRANSPORT_VERSION
  /** Fully re-signed lease envelope (not just a timestamp). */
  renewedEnvelope: SignedEnvelope
  acknowledgedAt: string
}

export interface EventAppendRequest {
  version: typeof RUNNER_TRANSPORT_VERSION
  meta: TransportRequestMeta
  leaseId: string
  taskId: string
  events: RunnerEvent[]
}

export interface EventAppendResponse {
  version: typeof RUNNER_TRANSPORT_VERSION
  accepted: number
  lastAcceptedDigest: string
  acknowledgedAt: string
}

export interface ReceiptSubmitRequest {
  version: typeof RUNNER_TRANSPORT_VERSION
  meta: TransportRequestMeta
  leaseId: string
  signedReceipt: SignedEnvelope
}

export interface ReceiptSubmitResponse {
  version: typeof RUNNER_TRANSPORT_VERSION
  accepted: boolean
  settledAt: string
}

export interface EnrollDeviceRequest {
  version: typeof RUNNER_TRANSPORT_VERSION
  enrollment: DeviceEnrollment
}

export interface EnrollDeviceResponse {
  version: typeof RUNNER_TRANSPORT_VERSION
  accepted: boolean
  platformKeyId: string
  enrolledAt: string
}

export interface RotateKeyRequest {
  version: typeof RUNNER_TRANSPORT_VERSION
  meta: TransportRequestMeta
  rotation: DeviceRotationRequest
}

export interface RotateKeyResponse {
  version: typeof RUNNER_TRANSPORT_VERSION
  ack: DeviceRotationAck
}

export interface RevokeKeyRequest {
  version: typeof RUNNER_TRANSPORT_VERSION
  meta: TransportRequestMeta
  revocation: DeviceRevocation
}

export interface RevokeKeyResponse {
  version: typeof RUNNER_TRANSPORT_VERSION
  accepted: boolean
  revokedAt: string
}

// --- Transport port interface ---

/**
 * Abstract outbound transport port. Implementations must:
 *
 * 1. Authenticate every request with the device key (sign request body).
 * 2. Retry transient failures with exponential backoff.
 * 3. Honour idempotency: duplicate requests with the same nonce are safe.
 * 4. Never open inbound listening ports.
 * 5. Reject responses that fail signature verification against the
 *    platform's public key.
 */
export interface RunnerTransportPort {
  // --- Task lifecycle ---

  /** Claim a task assignment from the platform. */
  claim(request: ClaimRequest): Promise<ClaimResponse>

  /** Send heartbeat and receive renewed lease. */
  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse>

  /** Append events to the platform event log. */
  appendEvents(request: EventAppendRequest): Promise<EventAppendResponse>

  /** Submit final signed receipt. */
  submitReceipt(request: ReceiptSubmitRequest): Promise<ReceiptSubmitResponse>

  // --- Device lifecycle ---

  /** Enroll a new device with the platform. */
  enrollDevice(request: EnrollDeviceRequest): Promise<EnrollDeviceResponse>

  /** Request key rotation (begins overlap window). */
  rotateKey(request: RotateKeyRequest): Promise<RotateKeyResponse>

  /** Revoke an old key (ends overlap window or emergency revocation). */
  revokeKey(request: RevokeKeyRequest): Promise<RevokeKeyResponse>
}

// --- Retry helper ---

/**
 * Determines whether a transport error is retryable and the backoff delay.
 */
export function computeTransportBackoff(
  error: RunnerTransportError,
  attempt: number,
): { shouldRetry: boolean; delayMs: number } {
  if (!error.retryable || attempt >= RUNNER_TRANSPORT_MAX_RETRIES) {
    return { shouldRetry: false, delayMs: 0 }
  }
  const baseDelay = error.retryAfterMs ?? RUNNER_TRANSPORT_BASE_BACKOFF_MS
  const exponentialDelay = Math.min(
    baseDelay * Math.pow(2, attempt),
    RUNNER_TRANSPORT_MAX_BACKOFF_MS,
  )
  // Add jitter (±25%)
  const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1)
  const delayMs = Math.max(0, Math.round(exponentialDelay + jitter))
  return { shouldRetry: true, delayMs }
}

// --- Fake transport for testing ---

export interface FakeTransportOptions {
  platformKeyId: string
  /** Function to produce a valid signed task envelope on claim. */
  produceTaskEnvelope: (request: ClaimRequest) => SignedEnvelope
  /** Function to produce a renewed envelope on heartbeat. */
  produceRenewal: (request: HeartbeatRequest) => SignedEnvelope
}

/**
 * In-memory fake transport for local testing. Does NOT perform real
 * network requests or cryptographic authentication.
 */
export class FakeRunnerTransport implements RunnerTransportPort {
  private readonly options: FakeTransportOptions
  private readonly events: RunnerEvent[] = []
  private receipt: SignedEnvelope | null = null

  constructor(options: FakeTransportOptions) {
    this.options = options
  }

  get submittedEvents(): readonly RunnerEvent[] {
    return this.events
  }

  get submittedReceipt(): SignedEnvelope | null {
    return this.receipt
  }

  async claim(request: ClaimRequest): Promise<ClaimResponse> {
    return {
      version: RUNNER_TRANSPORT_VERSION,
      taskEnvelope: this.options.produceTaskEnvelope(request),
      platformKeyId: this.options.platformKeyId,
      grantedAt: new Date().toISOString(),
    }
  }

  async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    return {
      version: RUNNER_TRANSPORT_VERSION,
      renewedEnvelope: this.options.produceRenewal(request),
      acknowledgedAt: new Date().toISOString(),
    }
  }

  async appendEvents(request: EventAppendRequest): Promise<EventAppendResponse> {
    this.events.push(...request.events)
    const lastDigest =
      request.events.length > 0
        ? request.events[request.events.length - 1].digest
        : ""
    return {
      version: RUNNER_TRANSPORT_VERSION,
      accepted: request.events.length,
      lastAcceptedDigest: lastDigest,
      acknowledgedAt: new Date().toISOString(),
    }
  }

  async submitReceipt(request: ReceiptSubmitRequest): Promise<ReceiptSubmitResponse> {
    this.receipt = request.signedReceipt
    return {
      version: RUNNER_TRANSPORT_VERSION,
      accepted: true,
      settledAt: new Date().toISOString(),
    }
  }

  async enrollDevice(_request: EnrollDeviceRequest): Promise<EnrollDeviceResponse> {
    return {
      version: RUNNER_TRANSPORT_VERSION,
      accepted: true,
      platformKeyId: this.options.platformKeyId,
      enrolledAt: new Date().toISOString(),
    }
  }

  async rotateKey(request: RotateKeyRequest): Promise<RotateKeyResponse> {
    const overlapExpires = new Date(
      Date.now() + 3600 * 1000,
    ).toISOString()
    return {
      version: RUNNER_TRANSPORT_VERSION,
      ack: {
        version: "runner-device.v1",
        currentKeyId: request.rotation.currentKeyId,
        nextKeyId: request.rotation.nextKeyId,
        overlapExpiresAt: overlapExpires,
        acknowledgedAt: new Date().toISOString(),
      },
    }
  }

  async revokeKey(_request: RevokeKeyRequest): Promise<RevokeKeyResponse> {
    return {
      version: RUNNER_TRANSPORT_VERSION,
      accepted: true,
      revokedAt: new Date().toISOString(),
    }
  }
}
