import assert from "node:assert/strict";
import test from "node:test";
import { createHttpServer } from "../../apps/server/server.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

test("HTTP server exposes health and protects ask with a token", async () => {
  let receivedRequest: Record<string, unknown> | undefined;
  const employee = {
    answer: async (request: Record<string, unknown>) => {
      receivedRequest = request;
      return {
        ok: true,
        status: "answered",
        answer: `answer:${String(request.message)}`,
        citations: []
      };
    }
  };
  const server = createHttpServer({ employee, token: "test-token" });
  const base = await listen(server);

  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const unauthorized = await fetch(`${base}/v1/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" })
    });
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${base}/v1/ask`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ message: "hello" })
    });
    assert.equal(response.status, 200);
    const responseBody = await response.json() as { answer: string };
    assert.equal(responseBody.answer, "answer:hello");
    assert.ok(receivedRequest);
    const requestId = String(receivedRequest.requestId);
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    assert.equal(receivedRequest.sessionId, `http-${requestId}`);
    assert.equal(receivedRequest.actorId, `http-${requestId}`);

    const clientSelectedSession = await fetch(`${base}/v1/ask`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        message: "read another session",
        sessionId: "another-user"
      })
    });
    assert.equal(clientSelectedSession.status, 400);
    assert.deepEqual(await clientSelectedSession.json(), {
      error: "client_identity_fields_not_allowed"
    });
  } finally {
    await close(server);
  }
});

test("HTTP server isolates concurrent callers with unique actors", async () => {
  const activeActors = new Set<string>();
  const actorIds: string[] = [];
  const employee = {
    answer: async (request: Record<string, unknown>) => {
      const actorId = String(request.actorId);
      if (activeActors.has(actorId)) throw new Error("actor_busy");
      activeActors.add(actorId);
      actorIds.push(actorId);
      await new Promise((resolve) => setTimeout(resolve, 30));
      activeActors.delete(actorId);
      return { status: "answered", answer: "ok", citations: [] };
    }
  };
  const server = createHttpServer({ employee });
  const base = await listen(server);

  try {
    const ask = () =>
      fetch(`${base}/v1/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" })
      });
    const responses = await Promise.all([ask(), ask()]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200]
    );
    assert.equal(new Set(actorIds).size, 2);
  } finally {
    await close(server);
  }
});

test("HTTP server rejects oversized input without echoing it", async () => {
  const employee = { answer: async () => ({ status: "answered" }) };
  const server = createHttpServer({ employee, maxBodyBytes: 32 });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "sensitive-value".repeat(10) })
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "request_body_too_large" });
  } finally {
    await close(server);
  }
});
