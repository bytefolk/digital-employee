import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type {
  IncomingMessage,
  Server,
  ServerResponse
} from "node:http";
const HTTP_JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
export const HTTP_MESSAGE_MAX_CHARACTERS = 20_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_MAX_QUEUED_REQUESTS = 8;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;

interface HttpEmployeeRequest extends Record<string, unknown> {
  requestId: string
  sessionId: string
  actorId: string
  message: string
  metadata: { channel: "http" }
  signal: AbortSignal
}

interface AdmissionWaiter {
  request: IncomingMessage
  response: ServerResponse
  resolve: (admitted: boolean) => void
  onAborted: () => void
  onClosed: () => void
}

export interface ManagedHttpServer extends Server {
  /** Stops admission, aborts Agent Host work, and waits a bounded time. */
  shutdown(options?: { timeoutMs?: number }): Promise<boolean>
  /** Read-only counts used by runtime health and focused tests. */
  workload(): { active: number; queued: number; stopping: boolean }
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function distinctHeaderValues(
  request: IncomingMessage,
  name: "authorization" | "content-type"
): string[] {
  const distinct = request.headersDistinct?.[name];
  if (distinct) return distinct;
  const value = request.headers[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function authorized(request: IncomingMessage, token?: string) {
  if (!token) return true;
  const values = distinctHeaderValues(request, "authorization");
  if (values.length !== 1) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(values[0]!);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function hasJsonMediaType(request: IncomingMessage): boolean {
  const values = distinctHeaderValues(request, "content-type");
  return values.length === 1 && HTTP_JSON_MEDIA_TYPE.test(values[0]!.trim());
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("request_body_too_large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as unknown : undefined;
}

function exactMessagePayload(
  value: unknown
): value is { message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    Object.keys(payload).length === 1 &&
    typeof payload.message === "string" &&
    payload.message.length > 0 &&
    payload.message.length <= HTTP_MESSAGE_MAX_CHARACTERS
  );
}

function validLimit(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= 1_024;
}

/**
 * Keeps the transport result authoritative while retaining non-reserved
 * top-level fields for v0.3 HTTP consumers. A domain `status` is available
 * only below `output` and can never replace the transport status.
 */
export function completedHttpAnswer(output: unknown): Record<string, unknown> {
  const compatibility: Record<string, unknown> = {};
  if (output && typeof output === "object" && !Array.isArray(output)) {
    for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
      if (key !== "status" && key !== "output" && key !== "error") {
        compatibility[key] = value;
      }
    }
  }
  return {
    ...compatibility,
    status: "answered",
    output
  };
}

/**
 * Proves that the package accepts every payload admitted by message.v1.
 *
 * This is deliberately structural rather than a sample validation: JSON
 * Schema conditionals, patterns, constants, or composition could accept one
 * probe string while rejecting ordinary HTTP messages. Unknown constraint
 * keywords therefore fail closed.
 */
export function acceptsHttpMessageInputSchema(
  schema: Record<string, unknown>
): boolean {
  const rootKeys = new Set([
    "$schema",
    "$id",
    "$comment",
    "title",
    "description",
    "type",
    "additionalProperties",
    "required",
    "properties"
  ]);
  if (
    Object.keys(schema).some((key) => !rootKeys.has(key)) ||
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !Array.isArray(schema.required) ||
    schema.required.length !== 1 ||
    schema.required[0] !== "message" ||
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  ) {
    return false;
  }
  const message = (schema.properties as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const messageSchema = message as Record<string, unknown>;
  const messageKeys = new Set([
    "$comment",
    "title",
    "description",
    "default",
    "examples",
    "readOnly",
    "writeOnly",
    "deprecated",
    "type",
    "minLength",
    "maxLength"
  ]);
  if (
    Object.keys(messageSchema).some((key) => !messageKeys.has(key)) ||
    messageSchema.type !== "string"
  ) {
    return false;
  }
  const minLength = messageSchema.minLength;
  const maxLength = messageSchema.maxLength;
  return (
    (minLength === undefined ||
      (Number.isSafeInteger(minLength) && Number(minLength) <= 1)) &&
    (maxLength === undefined ||
      (Number.isSafeInteger(maxLength) &&
        Number(maxLength) >= HTTP_MESSAGE_MAX_CHARACTERS))
  );
}

export function createHttpServer({
  employee,
  token,
  requireToken = false,
  maxBodyBytes = 32 * 1024,
  maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS,
  maxQueuedRequests = DEFAULT_MAX_QUEUED_REQUESTS,
  health = () => ({ status: "ok" })
}: {
  employee: { answer: (input: HttpEmployeeRequest) => Promise<Record<string, unknown>> }
  token?: string
  requireToken?: boolean
  maxBodyBytes?: number
  maxConcurrentRequests?: number
  maxQueuedRequests?: number
  health?: () => unknown
}): ManagedHttpServer {
  if (!employee || typeof employee.answer !== "function") {
    throw new TypeError("http_server_requires_employee");
  }
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 2 ||
    maxBodyBytes > 1024 * 1024 ||
    !validLimit(maxConcurrentRequests, 1) ||
    !validLimit(maxQueuedRequests, 0)
  ) {
    throw new TypeError("http_server_limits_invalid");
  }
  const exactToken = token?.trim();
  if (
    (requireToken && !exactToken) ||
    (exactToken !== undefined &&
      (exactToken.length === 0 ||
        exactToken.length > 8_192 ||
        /[\u0000-\u001f\u007f]/.test(exactToken)))
  ) {
    throw new TypeError("http_server_token_required");
  }

  let active = 0;
  let stopping = false;
  let shutdownPromise: Promise<boolean> | undefined;
  const queue: AdmissionWaiter[] = [];
  const activeControllers = new Set<AbortController>();
  const idleWaiters = new Set<() => void>();

  const removeWaiterListeners = (waiter: AdmissionWaiter) => {
    waiter.request.removeListener("aborted", waiter.onAborted);
    waiter.response.removeListener("close", waiter.onClosed);
  };
  const removeQueuedWaiter = (waiter: AdmissionWaiter) => {
    const index = queue.indexOf(waiter);
    if (index < 0) return;
    queue.splice(index, 1);
    removeWaiterListeners(waiter);
    waiter.resolve(false);
  };
  const notifyIfIdle = () => {
    if (active !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };
  const pump = () => {
    while (!stopping && active < maxConcurrentRequests && queue.length > 0) {
      const waiter = queue.shift()!;
      removeWaiterListeners(waiter);
      if (waiter.request.aborted || waiter.response.destroyed) {
        waiter.resolve(false);
        continue;
      }
      active += 1;
      waiter.resolve(true);
    }
    notifyIfIdle();
  };
  const acquire = (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> => {
    if (stopping) {
      sendJson(response, 503, { error: "server_stopping" });
      request.resume();
      return Promise.resolve(false);
    }
    if (active < maxConcurrentRequests) {
      active += 1;
      return Promise.resolve(true);
    }
    if (queue.length >= maxQueuedRequests) {
      sendJson(response, 429, { error: "request_capacity_exceeded" });
      request.resume();
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: AdmissionWaiter = {
        request,
        response,
        resolve,
        onAborted: () => removeQueuedWaiter(waiter),
        onClosed: () => removeQueuedWaiter(waiter)
      };
      queue.push(waiter);
      request.once("aborted", waiter.onAborted);
      response.once("close", waiter.onClosed);
    });
  };
  const release = () => {
    active -= 1;
    if (stopping) server.closeIdleConnections();
    pump();
  };
  const waitForIdle = (): Promise<void> => {
    if (active === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, stopping ? 503 : 200, health());
        return;
      }
      if (!authorized(request, exactToken)) {
        sendJson(response, 401, { error: "unauthorized" });
        request.resume();
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/ask") {
        sendJson(response, 404, { error: "not_found" });
        request.resume();
        return;
      }
      if (!hasJsonMediaType(request)) {
        sendJson(response, 415, { error: "unsupported_media_type" });
        request.resume();
        return;
      }
      if (!await acquire(request, response)) return;

      const controller = new AbortController();
      activeControllers.add(controller);
      const abort = () => controller.abort();
      request.once("aborted", abort);
      response.once("close", abort);
      try {
        const payload = await readJson(request, maxBodyBytes);
        if (
          payload &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          ["requestId", "sessionId", "actorId"].some((field) =>
            Object.prototype.hasOwnProperty.call(payload, field)
          )
        ) {
          sendJson(response, 400, { error: "client_identity_fields_not_allowed" });
          return;
        }
        if (!exactMessagePayload(payload)) {
          sendJson(response, 400, { error: "invalid_request" });
          return;
        }
        if (controller.signal.aborted || stopping) {
          sendJson(response, 503, { error: "server_stopping" });
          return;
        }
        const requestId = randomUUID();
        const result = await employee.answer({
          requestId,
          sessionId: `http-${requestId}`,
          actorId: `http-${requestId}`,
          message: payload.message,
          metadata: { channel: "http" },
          signal: controller.signal
        });
        if (controller.signal.aborted) {
          sendJson(response, 503, { error: "server_stopping" });
          return;
        }
        if (response.destroyed) return;
        if (result.status !== "answered" && result.status !== "rejected") {
          sendJson(response, 500, { error: "invalid_employee_response" });
          return;
        }
        sendJson(response, result.status === "rejected" ? 400 : 200, result);
      } finally {
        request.removeListener("aborted", abort);
        response.removeListener("close", abort);
        activeControllers.delete(controller);
        release();
      }
    } catch (error) {
      const status = error instanceof Error && error.message === "request_body_too_large"
        ? 413
        : 400;
      sendJson(response, status, {
        error: status === 413 ? "request_body_too_large" : "invalid_request"
      });
    }
  }) as ManagedHttpServer;

  server.workload = () => ({ active, queued: queue.length, stopping });
  server.shutdown = ({ timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS } = {}) => {
    if (shutdownPromise) return shutdownPromise;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      return Promise.reject(new TypeError("http_server_shutdown_timeout_invalid"));
    }
    stopping = true;
    for (const waiter of queue.splice(0)) {
      removeWaiterListeners(waiter);
      sendJson(waiter.response, 503, { error: "server_stopping" });
      waiter.request.resume();
      waiter.resolve(false);
    }
    for (const controller of activeControllers) controller.abort();

    shutdownPromise = (async () => {
      const closed = new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref();
      });
      const outcome = await Promise.race([
        Promise.all([waitForIdle(), closed]).then(() => "drained" as const),
        timedOut
      ]);
      if (timer) clearTimeout(timer);
      if (outcome === "timeout") {
        server.closeAllConnections();
        return false;
      }
      return true;
    })();
    return shutdownPromise;
  };

  return server;
}
