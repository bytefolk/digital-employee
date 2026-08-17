/**
 * HTTP outbound transport for the Runner.
 *
 * Wire contract (the private platform implements the server side):
 *
 *   POST {endpoint}/v1/runner/next-task     body: NextTaskRequest
 *   POST {endpoint}/v1/runner/claim         body: ClaimRequest
 *   POST {endpoint}/v1/runner/heartbeat     body: HeartbeatRequest
 *   POST {endpoint}/v1/runner/events        body: EventAppendRequest
 *   POST {endpoint}/v1/runner/receipt       body: ReceiptSubmitRequest
 *   POST {endpoint}/v1/runner/device/enroll body: EnrollDeviceRequest
 *   POST {endpoint}/v1/runner/device/rotate body: RotateKeyRequest
 *   POST {endpoint}/v1/runner/device/revoke body: RevokeKeyRequest
 *   GET  {endpoint}/v1/keys/:keyId          -> { keyId, publicKeyPem }
 *
 * Success responses carry the matching contract response body with
 * version === "runner-transport.v1". Errors carry a JSON body
 * { code, message } with a semantic HTTP status:
 *   400/422 -> PAYLOAD_REJECTED   401 -> UNAUTHORIZED   403 -> FORBIDDEN
 *   404 -> PAYLOAD_REJECTED       409 -> CONFLICT
 *   429 -> RATE_LIMITED (honours Retry-After)           5xx -> UNAVAILABLE
 *
 * Security invariants: outbound-only (no inbound port), per-request timeouts,
 * transient-failure retry with exponential backoff, platform public keys
 * cached by keyId and used to verify every signed envelope.
 */

import { createPublicKey, type KeyObject } from "node:crypto"

import { CoreError } from "./contracts.js"
import {
  RUNNER_TRANSPORT_MAX_BACKOFF_MS,
  RUNNER_TRANSPORT_MAX_RETRIES,
  RUNNER_TRANSPORT_REQUEST_TIMEOUT_MS,
  RUNNER_TRANSPORT_VERSION,
  RunnerTransportError,
  computeTransportBackoff,
} from "./runner-transport.js"
import type {
  ClaimRequest,
  ClaimResponse,
  EnrollDeviceRequest,
  EnrollDeviceResponse,
  EventAppendRequest,
  EventAppendResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  NextTaskRequest,
  NextTaskResponse,
  ReceiptSubmitRequest,
  ReceiptSubmitResponse,
  RevokeKeyRequest,
  RevokeKeyResponse,
  RotateKeyRequest,
  RotateKeyResponse,
  RunnerTransportPort,
} from "./runner-transport.js"

export interface HttpRunnerTransportOptions {
  /** Platform base URL, e.g. https://platform.example.com. */
  endpoint: string
  /** Per-request timeout (ms). Defaults to RUNNER_TRANSPORT_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number
  /** Inject for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Maximum transient retries per call. Defaults to RUNNER_TRANSPORT_MAX_RETRIES. */
  maxRetries?: number
  /**
   * External abort signal. When aborted, in-flight requests and retry backoff
   * sleep are interrupted immediately. The transport rejects the current call
   * with RUNNER_TRANSPORT_ABORTED (non-retryable).
   */
  signal?: AbortSignal
}

interface ErrorBody {
  code?: unknown
  message?: unknown
}

export class HttpRunnerTransport implements RunnerTransportPort {
  readonly #endpoint: string
  readonly #timeoutMs: number
  readonly #fetchImpl: typeof fetch
  readonly #maxRetries: number
  readonly #signal: AbortSignal | undefined
  readonly #platformKeys = new Map<string, KeyObject>()

  constructor(options: HttpRunnerTransportOptions) {
    if (!options || typeof options !== "object") {
      throw new CoreError("RUNNER_TRANSPORT_CONFIG_INVALID", "transport options required", {
        retryable: false,
      })
    }
    if (!options.endpoint || typeof options.endpoint !== "string") {
      throw new CoreError("RUNNER_TRANSPORT_CONFIG_INVALID", "endpoint is required", {
        retryable: false,
      })
    }
    let endpoint = options.endpoint
    try {
      endpoint = new URL(endpoint).origin === "null" ? endpoint : new URL(endpoint).toString().replace(/\/+$/, "")
    } catch {
      throw new CoreError("RUNNER_TRANSPORT_CONFIG_INVALID", "endpoint must be a valid URL", {
        retryable: false,
      })
    }
    this.#endpoint = endpoint
    this.#timeoutMs = options.timeoutMs ?? RUNNER_TRANSPORT_REQUEST_TIMEOUT_MS
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#maxRetries = options.maxRetries ?? RUNNER_TRANSPORT_MAX_RETRIES
    this.#signal = options.signal
  }

  /** Resolves (and caches) the platform verification key for a keyId. */
  async platformKey(keyId: string): Promise<KeyObject> {
    if (typeof keyId !== "string" || !keyId || keyId.length > 256) {
      throw new CoreError("RUNNER_PLATFORM_KEY_INVALID", "invalid platform keyId", {
        retryable: false,
      })
    }
    const cached = this.#platformKeys.get(keyId)
    if (cached) return cached
    const data = (await this.#requestOnce(
      "GET",
      `/v1/keys/${encodeURIComponent(keyId)}`,
      undefined,
      { validateVersion: false },
    )) as { keyId?: unknown; publicKeyPem?: unknown }
    if (!data || typeof data.publicKeyPem !== "string" || data.keyId !== keyId) {
      throw new CoreError("RUNNER_PLATFORM_KEY_INVALID", "platform key response invalid", {
        retryable: false,
      })
    }
    let key: KeyObject
    try {
      key = createPublicKey(data.publicKeyPem)
    } catch {
      throw new CoreError("RUNNER_PLATFORM_KEY_INVALID", "platform key PEM invalid", {
        retryable: false,
      })
    }
    this.#platformKeys.set(keyId, key)
    return key
  }

  async nextTask(request: NextTaskRequest): Promise<NextTaskResponse> {
    return this.#request("POST", "/v1/runner/next-task", request)
  }

  async claim(request: ClaimRequest): Promise<ClaimResponse> {
    return this.#request("POST", "/v1/runner/claim", request)
  }

  async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.#request("POST", "/v1/runner/heartbeat", request)
  }

  async appendEvents(request: EventAppendRequest): Promise<EventAppendResponse> {
    return this.#request("POST", "/v1/runner/events", request)
  }

  async submitReceipt(request: ReceiptSubmitRequest): Promise<ReceiptSubmitResponse> {
    return this.#request("POST", "/v1/runner/receipt", request)
  }

  async enrollDevice(request: EnrollDeviceRequest): Promise<EnrollDeviceResponse> {
    return this.#request("POST", "/v1/runner/device/enroll", request)
  }

  async rotateKey(request: RotateKeyRequest): Promise<RotateKeyResponse> {
    return this.#request("POST", "/v1/runner/device/rotate", request)
  }

  async revokeKey(request: RevokeKeyRequest): Promise<RevokeKeyResponse> {
    return this.#request("POST", "/v1/runner/device/revoke", request)
  }

  async #request<T>(
    method: "POST",
    path: string,
    body: unknown,
  ): Promise<T> {
    let attempt = 0
    for (;;) {
      if (this.#signal?.aborted) {
        throw new RunnerTransportError("RUNNER_TRANSPORT_ABORTED", "transport aborted")
      }
      try {
        return await this.#requestOnce<T>(method, path, body)
      } catch (error) {
        if (!(error instanceof RunnerTransportError) || !error.retryable) throw error
        attempt++
        const { shouldRetry, delayMs } = computeTransportBackoff(error, attempt)
        if (!shouldRetry || attempt > this.#maxRetries) throw error
        await this.#sleepWithSignal(delayMs)
      }
    }
  }

  /** Sleep that races against the external abort signal. */
  #sleepWithSignal(ms: number): Promise<void> {
    if (this.#signal?.aborted) {
      return Promise.reject(
        new RunnerTransportError("RUNNER_TRANSPORT_ABORTED", "transport aborted"),
      )
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      if (!this.#signal) return // no external signal: plain timer keeps event loop alive
      const onAbort = () => {
        clearTimeout(timer)
        reject(new RunnerTransportError("RUNNER_TRANSPORT_ABORTED", "transport aborted"))
      }
      this.#signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  async #requestOnce<T>(
    method: string,
    path: string,
    body: unknown,
    options?: { validateVersion?: boolean },
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("runner_transport_timeout")), this.#timeoutMs)
    timer.unref()
    const onExternalAbort = () => controller.abort(this.#signal?.reason)
    this.#signal?.addEventListener("abort", onExternalAbort, { once: true })
    try {
      const response = await this.#fetchImpl(`${this.#endpoint}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      })
      return await this.#consumeResponse<T>(response, options)
    } catch (error) {
      if (error instanceof RunnerTransportError) throw error
      if (this.#signal?.aborted) {
        throw new RunnerTransportError("RUNNER_TRANSPORT_ABORTED", "transport aborted")
      }
      if (controller.signal.aborted) {
        throw new RunnerTransportError("RUNNER_TRANSPORT_TIMEOUT", `request to ${path} timed out`)
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new RunnerTransportError(
        "RUNNER_TRANSPORT_UNAVAILABLE",
        `request to ${path} failed: ${message}`,
      )
    } finally {
      clearTimeout(timer)
      this.#signal?.removeEventListener("abort", onExternalAbort)
    }
  }

  #consumeResponse<T>(
    response: Response,
    options?: { validateVersion?: boolean },
  ): Promise<T> {
    return response
      .json()
      .then((data: unknown) => {
        if (response.ok) {
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new RunnerTransportError(
              "RUNNER_TRANSPORT_PAYLOAD_REJECTED",
              "platform response body must be an object",
            )
          }
          if (
            options?.validateVersion !== false &&
            (data as { version?: unknown }).version !== RUNNER_TRANSPORT_VERSION
          ) {
            throw new RunnerTransportError(
              "RUNNER_TRANSPORT_PAYLOAD_REJECTED",
              `platform response version mismatch (expected ${RUNNER_TRANSPORT_VERSION})`,
            )
          }
          return data as T
        }
        throw this.#errorFromStatus(response.status, response.headers.get("retry-after"), data)
      })
      .catch((error: unknown) => {
        if (error instanceof RunnerTransportError) throw error
        throw new RunnerTransportError(
          "RUNNER_TRANSPORT_PAYLOAD_REJECTED",
          "platform returned a non-JSON response",
        )
      })
  }

  #errorFromStatus(status: number, retryAfter: string | null, data: unknown): RunnerTransportError {
    const body: ErrorBody = data && typeof data === "object" ? (data as ErrorBody) : {}
    const detail = typeof body.message === "string" ? `: ${body.message}` : ""
    switch (status) {
      case 400:
      case 404:
      case 422:
        return new RunnerTransportError(
          "RUNNER_TRANSPORT_PAYLOAD_REJECTED",
          `platform rejected payload (${status})${detail}`,
        )
      case 401:
        return new RunnerTransportError(
          "RUNNER_TRANSPORT_UNAUTHORIZED",
          `device key not authorized${detail}`,
        )
      case 403:
        return new RunnerTransportError(
          "RUNNER_TRANSPORT_FORBIDDEN",
          `request forbidden${detail}`,
        )
      case 409:
        return new RunnerTransportError(
          "RUNNER_TRANSPORT_CONFLICT",
          `state conflict${detail}`,
        )
      case 429: {
        const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : Number.NaN
        return new RunnerTransportError(
          "RUNNER_TRANSPORT_RATE_LIMITED",
          `rate limited${detail}`,
          {
            retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined,
          },
        )
      }
      default:
        if (status >= 500) {
          return new RunnerTransportError(
            "RUNNER_TRANSPORT_UNAVAILABLE",
            `platform error (${status})${detail}`,
          )
        }
        return new RunnerTransportError(
          "RUNNER_TRANSPORT_PAYLOAD_REJECTED",
          `unexpected status ${status}${detail}`,
        )
    }
  }
}
