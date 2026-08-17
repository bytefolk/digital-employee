import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import readline from "node:readline"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { AGENT_HOST_STDIO_PROTOCOL_VERSION } from "../../packages/core/src/agent-host-stdio.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const hostScript = path.join(root, "apps", "cli", "real-local-stdio-host.ts")

const REAL_LOCAL_ENV = [
  "REAL_LOCAL_MATRIX",
  "REAL_LOCAL_GRANT",
  "REAL_LOCAL_PRINCIPAL",
  "REAL_LOCAL_WORKSPACE",
  "REAL_LOCAL_SESSION_REF",
  "REAL_MEM_BASE_URL",
  "REAL_MEM_TOKEN",
  "REAL_DOC_BASE_URL",
  "REAL_DOC_TOKEN",
  "REAL_DOC_DOCUMENT_ID",
  "REAL_DOC_EXPECTED_ETAG",
] as const

interface HostSession {
  child: ChildProcess
  next: (timeoutMs?: number) => Promise<Record<string, unknown>>
  write: (message: Record<string, unknown>) => void
}

function startHost(t: test.TestContext, envOverrides: Record<string, string> = {}): HostSession {
  const env: Record<string, string> = {}
  for (const name of REAL_LOCAL_ENV) delete env[name]
  const child = spawn(process.execPath, ["--import", "tsx", hostScript], {
    cwd: root,
    env: { ...process.env, ...env, ...envOverrides },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const lines: string[] = []
  const waiters: Array<(line: string) => void> = []
  const reader = readline.createInterface({ input: child.stdout })
  reader.on("line", (line) => {
    const waiter = waiters.shift()
    if (waiter) waiter(line)
    else lines.push(line)
  })
  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })
  t.after(() => {
    child.kill()
  })
  return {
    child,
    next: (timeoutMs = 10_000) =>
      new Promise((resolve, reject) => {
        const queued = lines.shift()
        if (queued !== undefined) {
          resolve(JSON.parse(queued) as Record<string, unknown>)
          return
        }
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for host line; stderr: ${stderr}`))
        }, timeoutMs)
        waiters.push((line) => {
          clearTimeout(timer)
          resolve(JSON.parse(line) as Record<string, unknown>)
        })
      }),
    write: (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    },
  }
}

function request(id: string, kind: string, payload?: unknown) {
  return {
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id,
    kind,
    ...(payload === undefined ? {} : { payload }),
  }
}

const RUN_PAYLOAD = {
  runId: "proto-run-1",
  employeeId: "protocol-test",
  workingDirectory: ".",
  prompt: "resume approved context",
  policy: {
    tools: { default: "deny", allow: [] },
    filesystem: { read: ["."], write: [] },
    network: { mode: "deny" },
    approval: { mode: "never" },
  },
}

test("probe returns the real local host identity and capabilities", async (t) => {
  const host = startHost(t)
  host.write(request("probe-1", "probe"))
  const response = await host.next()
  assert.equal(response.kind, "response")
  assert.equal(response.ok, true)
  const result = response.result as {
    hostId: string
    status: string
    available: boolean
    capabilities: Record<string, string>
  }
  assert.equal(result.hostId, "real-local-stdio-host")
  assert.equal(result.status, "ready")
  assert.equal(result.available, true)
  assert.equal(result.capabilities.non_interactive_run, "supported")
  assert.equal(result.capabilities.event_stream, "supported")
})

test("a run without real-local MCP servers completes with the default answer", async (t) => {
  const host = startHost(t)
  host.write(request("run-1", "run", RUN_PAYLOAD))
  const started = await host.next()
  assert.equal(started.kind, "event")
  assert.equal((started.event as { type: string }).type, "run.started")
  const completed = await host.next()
  assert.equal(completed.kind, "event")
  assert.equal((completed.event as { type: string }).type, "run.completed")
  assert.deepEqual(
    (completed.event as { output: unknown }).output,
    { status: "answered", answer: "real local host", citations: [] },
  )
  const response = await host.next()
  assert.equal(response.kind, "response")
  assert.equal(response.ok, true)
})

test("a real-mem run without operator env fails closed with a real_local code", async (t) => {
  const host = startHost(t)
  host.write(request("run-2", "run", {
    ...RUN_PAYLOAD,
    runId: "proto-run-2",
    mcpServers: [{ name: "real-mem", transport: "http", url: "http://127.0.0.1:1" }],
  }))
  await host.next() // run.started
  const failed = await host.next()
  assert.equal(failed.kind, "event")
  assert.equal((failed.event as { type: string }).type, "run.failed")
  const error = (failed.event as { error: { code: string } }).error
  assert.equal(error.code, "real_local_service_unavailable")
  const response = await host.next()
  assert.equal(response.kind, "response")
  assert.equal(response.ok, true)
})

test("preflight with a write policy is refused", async (t) => {
  const host = startHost(t)
  host.write(request("pre-1", "preflight", {
    ...RUN_PAYLOAD,
    policy: {
      tools: { default: "deny", allow: [] },
      filesystem: { read: ["."], write: ["./scratch"] },
      network: { mode: "deny" },
      approval: { mode: "never" },
    },
  }))
  const response = await host.next()
  assert.equal(response.kind, "response")
  assert.equal(response.ok, false)
  assert.equal((response.error as { code: string }).code, "agent_host_preflight_invalid")
})

test("preflight with a read-only policy succeeds", async (t) => {
  const host = startHost(t)
  host.write(request("pre-2", "preflight", {
    ...RUN_PAYLOAD,
    policy: {
      tools: { default: "deny", allow: [] },
      filesystem: { read: ["."], write: [] },
      network: { mode: "deny" },
      approval: { mode: "never" },
    },
  }))
  const response = await host.next()
  assert.equal(response.ok, true)
})

test("a malformed request line is rejected with a stable framing error", async (t) => {
  const host = startHost(t)
  host.child.stdin!.write("this is not json\n")
  const response = await host.next()
  assert.equal(response.kind, "response")
  assert.equal(response.ok, false)
  assert.equal(response.id, "unparsed")
  assert.equal((response.error as { code: string }).code, "agent_host_stdio_bad_framing")
})

test("an unknown request kind is rejected with a stable error", async (t) => {
  const host = startHost(t)
  host.write(request("unk-1", "frobnicate"))
  const response = await host.next()
  assert.equal(response.kind, "response")
  assert.equal(response.ok, false)
  assert.equal(response.id, "unparsed")
  assert.equal((response.error as { code: string }).code, "agent_host_stdio_bad_framing")
})

test("a cancelled run fails with agent_host_cancelled", async (t) => {
  const host = startHost(t)
  host.write(request("cancel-1", "run", { ...RUN_PAYLOAD, runId: "cancel-me" }))
  await host.next() // run.started
  await host.next() // run.completed of the first run
  await host.next() // response of the first run
  host.write(request("cancel-2", "cancel", { runId: "cancel-me" }))
  host.write(request("cancel-3", "run", { ...RUN_PAYLOAD, runId: "cancel-me" }))
  const started = await host.next()
  assert.equal((started.event as { type: string }).type, "run.started")
  const failed = await host.next()
  assert.equal((failed.event as { type: string }).type, "run.failed")
  assert.equal(
    (failed.event as { error: { code: string } }).error.code,
    "agent_host_cancelled",
  )
  const response = await host.next()
  assert.equal(response.ok, true)
  assert.equal(response.id, "cancel-3")
})
