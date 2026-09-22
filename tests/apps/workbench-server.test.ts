import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import test from "node:test"

import {
  createWorkbenchServer,
  type WorkbenchTurnExecutor,
} from "../../apps/cli/workbench/server.js"
import { parseTurnEnvelope } from "../../apps/cli/turn/envelope.js"

const positions = [
  { id: "repo-owner", name: "Repository Owner", reportTo: null },
  { id: "issue-researcher", name: "Issue Researcher", reportTo: "repo-owner" },
]

async function listen(server: ReturnType<typeof createWorkbenchServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

function cookieFrom(response: Response): string {
  const raw = response.headers.get("set-cookie")
  assert.ok(raw)
  return raw.split(";", 1)[0]!
}

test("#331 AC-001/AC-002: same-origin Workbench lists positions and executes the existing sealed turn contract", async (t) => {
  const calls: Array<Record<string, unknown>> = []
  const executeTurn: WorkbenchTurnExecutor = async (input) => {
    const envelope = parseTurnEnvelope(JSON.parse(input.envelopeText))
    calls.push({ ...input, envelope })
    input.writeEvent(JSON.stringify({
      schemaVersion: "engine.v1",
      type: "run.started",
      eventId: "event-1",
      runId: "run-1",
      turnId: envelope.turnId,
      positionId: envelope.positionId,
      sequence: 1,
      timestamp: "2026-09-22T00:00:00.000Z",
    }))
    input.writeEvent(JSON.stringify({
      schemaVersion: "engine.v1",
      type: "run.completed",
      eventId: "event-2",
      runId: "run-1",
      turnId: envelope.turnId,
      positionId: envelope.positionId,
      sequence: 2,
      timestamp: "2026-09-22T00:00:01.000Z",
      terminalReason: "goal_met",
      output: {
        answer: "Use the approved release checklist.",
        citations: [{ label: "Checklist", uri: "workspace://knowledge/release.md" }],
      },
    }))
    return { exitCode: 0, terminalEmitted: true }
  }
  const server = createWorkbenchServer({
    workspace: "/tmp/example-workspace",
    positions,
    executeTurn,
    newId: (() => {
      let value = 0
      return () => `generated-${++value}`
    })(),
  })
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const base = await listen(server)

  const page = await fetch(`${base}/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/)
  assert.match(await page.text(), /Digital Employee Workbench/)
  const cookie = cookieFrom(page)
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/)

  const catalog = await fetch(`${base}/v1/positions`, { headers: { cookie } })
  assert.equal(catalog.status, 200)
  assert.deepEqual(await catalog.json(), { positions })

  const response = await fetch(`${base}/v1/turns`, {
    method: "POST",
    headers: {
      cookie,
      origin: base,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      positionId: "repo-owner",
      message: "What should we release next?",
      conversationRef: "conversation-owner",
    }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    status: "completed",
    positionId: "repo-owner",
    conversationRef: "conversation-owner",
    output: {
      answer: "Use the approved release checklist.",
      citations: [{ label: "Checklist", uri: "workspace://knowledge/release.md" }],
    },
  })
  const workerResponse = await fetch(`${base}/v1/turns`, {
    method: "POST",
    headers: {
      cookie,
      origin: base,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      positionId: "issue-researcher",
      message: "Which issue is highest priority?",
      conversationRef: "conversation-worker",
    }),
  })
  assert.equal(workerResponse.status, 200)
  const workerBody = await workerResponse.json() as Record<string, unknown>
  assert.equal(workerBody.positionId, "issue-researcher")
  assert.equal(workerBody.conversationRef, "conversation-worker")

  assert.equal(calls.length, 2)
  const envelope = calls[0]!.envelope as ReturnType<typeof parseTurnEnvelope>
  assert.equal(envelope.schemaVersion, "turn-envelope.v1alpha2")
  assert.equal(envelope.positionId, "repo-owner")
  assert.equal(envelope.conversationRef, "conversation-owner")
  assert.deepEqual(envelope.input, { message: "What should we release next?" })
})

test("#331 AC-003: Workbench fails closed on auth, origin, position, input, and duplicate conversation turns", async (t) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let modelCalls = 0
  const executeTurn: WorkbenchTurnExecutor = async (input) => {
    modelCalls += 1
    await gate
    const envelope = parseTurnEnvelope(JSON.parse(input.envelopeText))
    input.writeEvent(JSON.stringify({
      schemaVersion: "engine.v1",
      type: "run.completed",
      eventId: "event-terminal",
      runId: "run-1",
      turnId: envelope.turnId,
      positionId: envelope.positionId,
      sequence: 1,
      timestamp: "2026-09-22T00:00:01.000Z",
      terminalReason: "goal_met",
      output: "done",
    }))
    return { exitCode: 0, terminalEmitted: true }
  }
  const server = createWorkbenchServer({
    workspace: "/tmp/example-workspace",
    positions,
    executeTurn,
  })
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const base = await listen(server)
  const page = await fetch(`${base}/`)
  const cookie = cookieFrom(page)

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })

  assert.equal((await post({ positionId: "repo-owner", message: "hello", conversationRef: "c1" }, { origin: base })).status, 401)
  assert.equal((await post({ positionId: "repo-owner", message: "hello", conversationRef: "c1" }, { cookie, origin: "https://attacker.example" })).status, 403)
  assert.equal((await post({ positionId: "unknown", message: "hello", conversationRef: "c1" }, { cookie, origin: base })).status, 404)
  assert.equal((await post({ positionId: "repo-owner", message: "x".repeat(20_001), conversationRef: "c1" }, { cookie, origin: base })).status, 400)
  assert.equal(modelCalls, 0)

  const first = post(
    { positionId: "repo-owner", message: "first", conversationRef: "same-conversation" },
    { cookie, origin: base },
  )
  while (modelCalls === 0) await new Promise((resolve) => setTimeout(resolve, 1))
  const duplicate = await post(
    { positionId: "repo-owner", message: "second", conversationRef: "same-conversation" },
    { cookie, origin: base },
  )
  assert.equal(duplicate.status, 409)
  assert.deepEqual(await duplicate.json(), { error: "conversation_busy" })
  assert.equal(modelCalls, 1)
  release()
  assert.equal((await first).status, 200)
})

test("#331 AC-003: Workbench refuses non-loopback listener addresses", () => {
  assert.throws(
    () => createWorkbenchServer({
      workspace: "/tmp/example-workspace",
      positions,
      executeTurn: async () => ({ exitCode: 1, terminalEmitted: false }),
      host: "0.0.0.0",
    }),
    /workbench_loopback_required/,
  )
})
