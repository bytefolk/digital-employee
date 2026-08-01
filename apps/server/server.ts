import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function authorized(request: IncomingMessage, token?: string) {
  if (!token) return true;
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(String(request.headers.authorization || ""));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("request_body_too_large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function createHttpServer({
  employee,
  token,
  maxBodyBytes = 32 * 1024,
  health = () => ({ status: "ok" })
}: {
  employee: { answer: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }
  token?: string
  maxBodyBytes?: number
  health?: () => unknown
}) {
  if (!employee || typeof employee.answer !== "function") {
    throw new TypeError("http_server_requires_employee");
  }

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, health());
        return;
      }
      if (!authorized(request, token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/ask") {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      const payload = await readJson(request, maxBodyBytes);
      if (
        ["requestId", "sessionId", "actorId"].some((field) =>
          Object.prototype.hasOwnProperty.call(payload, field)
        )
      ) {
        sendJson(response, 400, { error: "client_identity_fields_not_allowed" });
        return;
      }
      const requestId = randomUUID();
      const result = await employee.answer({
        requestId,
        sessionId: `http-${requestId}`,
        actorId: `http-${requestId}`,
        message: payload.message,
        metadata: { channel: "http" }
      });
      sendJson(response, result.status === "rejected" ? 400 : 200, result);
    } catch (error) {
      const status = error instanceof Error && error.message === "request_body_too_large" ? 413 : 400;
      sendJson(response, status, { error: status === 413 ? "request_body_too_large" : "invalid_request" });
    }
  });
}
