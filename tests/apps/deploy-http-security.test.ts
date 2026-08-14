import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type { AddressInfo } from "node:net"

import { deployHttp } from "../../apps/cli/deploy/channels.js"
import { createEmployeePackage } from "../../apps/cli/employee-package.js"
import {
  acceptsHttpMessageInputSchema,
  completedHttpAnswer,
  createHttpServer,
} from "../../apps/server/server.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

async function listen(
  server: ReturnType<typeof createHttpServer>,
): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition_not_reached_before_timeout")
}

function ask(base: string, message: string): Promise<Response> {
  return fetch(`${base}/v1/ask`, {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-http-test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ message }),
  })
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EPERM",
    )
  }
}

test("HTTP completion envelope prevents domain status collision", () => {
  const domain = {
    status: "needs_review",
    answer: "domain answer",
    citations: [],
  }
  const result = completedHttpAnswer(domain)
  assert.equal(result.status, "answered")
  assert.equal(result.answer, "domain answer")
  assert.deepEqual(result.output, domain)
  assert.notEqual(result.status, domain.status)
})

test("message-only HTTP readiness rejects a structured-action input schema", async () => {
  const minimal = JSON.parse(await readFile(path.join(
    root,
    "examples/recipes/minimal-answer.v1/minimal-answer/schemas/input.schema.json",
  ), "utf8")) as Record<string, unknown>
  const structured = JSON.parse(await readFile(path.join(
    root,
    "examples/recipes/structured-action.v1/structured-action/schemas/input.schema.json",
  ), "utf8")) as Record<string, unknown>

  assert.equal(acceptsHttpMessageInputSchema(minimal), true)
  assert.equal(acceptsHttpMessageInputSchema(structured), false)
  assert.equal(acceptsHttpMessageInputSchema({
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: { message: { type: "string" } },
    if: { properties: { message: { const: "http-readiness-probe" } } },
    else: { required: ["target"] },
  }), false)
  assert.equal(acceptsHttpMessageInputSchema({
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: {
      message: { type: "string", const: "http-readiness-probe" },
    },
  }), false)
  assert.equal(acceptsHttpMessageInputSchema({
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: {
      message: { type: "string", minLength: 1, maxLength: 19_999 },
    },
  }), false)
})

test("deploy HTTP fails before activation when symbolic token binding is absent", async () => {
  const previous = process.env.DIGITAL_EMPLOYEE_HTTP_TOKEN
  delete process.env.DIGITAL_EMPLOYEE_HTTP_TOKEN
  try {
    const result = await deployHttp({
      schemaVersion: "deploy-state.v1",
      locale: "en",
      channel: "http",
      botName: "No Token",
      engine: "qoder",
      runtime: "agent-native",
      package: {
        name: "no-token",
        version: "0.1.0",
        digest: `sha256:${"0".repeat(64)}`,
        localReference: root,
      },
      endpoint: {
        protocol: "http",
        host: "127.0.0.1",
        port: 30_001,
        askPath: "/v1/ask",
        healthPath: "/health",
      },
      outcome: "pending_external_action",
      updatedAt: "2026-08-13T00:00:00.000Z",
    })
    assert.equal(result.outcome, "failed")
    assert.equal(result.code, "http_token_required")
    assert.equal(result.process, undefined)
  } finally {
    if (previous === undefined) delete process.env.DIGITAL_EMPLOYEE_HTTP_TOKEN
    else process.env.DIGITAL_EMPLOYEE_HTTP_TOKEN = previous
  }
})

test("deploy HTTP requires auth and strict JSON media type", async (t) => {
  assert.throws(
    () => createHttpServer({
      requireToken: true,
      employee: { answer: async () => ({ status: "answered" }) },
    }),
    /http_server_token_required/,
  )
  const server = createHttpServer({
    token: "deploy-http-test-token",
    requireToken: true,
    employee: {
      answer: async (input) => completedHttpAnswer({ answer: input.message }),
    },
  })
  const base = await listen(server)
  t.after(() => server.shutdown())

  const plain = await fetch(`${base}/v1/ask`, {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-http-test-token",
      "content-type": "text/plain",
    },
    body: JSON.stringify({ message: "browser simple request" }),
  })
  assert.equal(plain.status, 415)
  assert.deepEqual(await plain.json(), { error: "unsupported_media_type" })

  const missing = await fetch(`${base}/v1/ask`, {
    method: "POST",
    body: JSON.stringify({ message: "missing headers" }),
  })
  assert.equal(missing.status, 401)

  const extra = await fetch(`${base}/v1/ask`, {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-http-test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: "hello", target: "not-expressible" }),
  })
  assert.equal(extra.status, 400)
  assert.deepEqual(await extra.json(), { error: "invalid_request" })
})

test("HTTP admission bounds active and queued Agent Host work", async (t) => {
  const releases: Array<() => void> = []
  let entered = 0
  const server = createHttpServer({
    token: "deploy-http-test-token",
    requireToken: true,
    maxConcurrentRequests: 1,
    maxQueuedRequests: 1,
    employee: {
      answer: async () => {
        entered += 1
        await new Promise<void>((resolve) => releases.push(resolve))
        return completedHttpAnswer({ answer: "ok" })
      },
    },
  })
  const base = await listen(server)
  t.after(() => server.shutdown())

  const first = ask(base, "first")
  await waitFor(() => entered === 1)
  const second = ask(base, "second")
  await waitFor(() => server.workload().queued === 1)
  const third = await ask(base, "third")
  assert.equal(third.status, 429)
  assert.deepEqual(await third.json(), { error: "request_capacity_exceeded" })
  assert.deepEqual(server.workload(), {
    active: 1,
    queued: 1,
    stopping: false,
  })

  releases.shift()!()
  assert.equal((await first).status, 200)
  await waitFor(() => entered === 2)
  releases.shift()!()
  assert.equal((await second).status, 200)
  await waitFor(() => server.workload().active === 0)
})

test("HTTP shutdown aborts an active ask and waits for bounded cleanup", async () => {
  let entered = false
  let aborted = false
  let cleanupComplete = false
  const server = createHttpServer({
    token: "deploy-http-test-token",
    requireToken: true,
    maxConcurrentRequests: 1,
    maxQueuedRequests: 0,
    employee: {
      answer: async (input) => {
        entered = true
        await new Promise<void>((resolve) => {
          const cancel = () => {
            aborted = true
            setTimeout(() => {
              cleanupComplete = true
              resolve()
            }, 25)
          }
          if (input.signal.aborted) cancel()
          else input.signal.addEventListener("abort", cancel, { once: true })
        })
        return {
          status: "rejected",
          error: { code: "agent_host_cancelled", retryable: true },
        }
      },
    },
  })
  const base = await listen(server)
  const request = ask(base, "long running")
  await waitFor(() => entered)

  const clean = await server.shutdown({ timeoutMs: 1_000 })
  assert.equal(clean, true)
  assert.equal(aborted, true)
  assert.equal(cleanupComplete, true)
  assert.deepEqual(server.workload(), {
    active: 0,
    queued: 0,
    stopping: true,
  })
  const response = await request
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "server_stopping" })
})

test("a disconnected caller retains its admission slot until Agent cleanup completes", async (t) => {
  let entered = 0
  let aborted = false
  let releaseCleanup!: () => void
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve
  })
  const server = createHttpServer({
    token: "deploy-http-test-token",
    requireToken: true,
    maxConcurrentRequests: 1,
    maxQueuedRequests: 1,
    employee: {
      answer: async (input) => {
        entered += 1
        if (entered === 1) {
          await new Promise<void>((resolve) => {
            const cancel = async () => {
              aborted = true
              await cleanup
              resolve()
            }
            if (input.signal.aborted) void cancel()
            else input.signal.addEventListener("abort", () => void cancel(), {
              once: true,
            })
          })
        }
        return completedHttpAnswer({ answer: "ok" })
      },
    },
  })
  const base = await listen(server)
  t.after(() => server.shutdown())
  const controller = new AbortController()
  const first = fetch(`${base}/v1/ask`, {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-http-test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: "disconnect" }),
    signal: controller.signal,
  })
  const firstRejected = assert.rejects(first)
  await waitFor(() => entered === 1)
  controller.abort()
  await waitFor(() => aborted)
  assert.deepEqual(server.workload(), {
    active: 1,
    queued: 0,
    stopping: false,
  })

  const second = ask(base, "queued while cleanup runs")
  await waitFor(() => server.workload().queued === 1)
  const overflow = await ask(base, "must be rejected")
  assert.equal(overflow.status, 429)
  assert.equal(entered, 1)

  releaseCleanup()
  await firstRejected
  assert.equal((await second).status, 200)
  await waitFor(() => server.workload().active === 0)
})

test("deployed runtime SIGTERM cancels the Agent Host and removes credentials and snapshot", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "deploy-http-signal-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const runtimeTemporary = path.join(temporary, "runtime-tmp")
  const employee = path.join(temporary, "signal-cleanup")
  const launchLog = path.join(temporary, "qoder-launch.jsonl")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const fixture = path.join(root, "tests/apps/fixtures/fake-qoder.mjs")
  const builtCli = path.join(root, "dist/apps/cli/bin.js")
  await Promise.all([
    mkdir(home),
    mkdir(bin),
    mkdir(runtimeTemporary),
  ])
  await createEmployeePackage(employee, { name: "signal-cleanup" })
  const qoder = path.join(bin, "qodercli")
  await writeFile(
    qoder,
      `#!/usr/bin/env node\n` +
      `if (process.argv[2] === "--version") { process.stdout.write("1.1.12\\n"); process.exit(0) }\n` +
      `const { spawnSync } = require("node:child_process")\n` +
      `const result = spawnSync(process.execPath, [` +
      `${JSON.stringify(fixture)}, "--fixture-mode", "hang-ignore-sigterm", ` +
      `"--launch-log", ${JSON.stringify(launchLog)}, ...process.argv.slice(2)], ` +
      `{ stdio: "inherit" })\n` +
      `process.exit(result.status ?? 1)\n`,
    { mode: 0o755 },
  )
  await chmod(qoder, 0o755)

  const probe = await new Promise<{ port: number; close(): Promise<void> }>(
    (resolve) => {
      const server = createHttpServer({
        employee: { answer: async () => ({ status: "answered" }) },
      })
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo
        resolve({
          port: address.port,
          close: async () => {
            await server.shutdown()
          },
        })
      })
    },
  )
  const port = probe.port
  await probe.close()
  const environment = {
    ...process.env,
    HOME: home,
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
      path.delimiter,
    ),
    TMPDIR: runtimeTemporary,
    TMP: runtimeTemporary,
    TEMP: runtimeTemporary,
    QODER_PERSONAL_ACCESS_TOKEN: "qoder-signal-secret-sentinel",
    DIGITAL_EMPLOYEE_HTTP_TOKEN: "deploy-http-test-token",
  }
  const deployed = spawnSync(process.execPath, [
    builtCli,
    "deploy",
    employee,
    "--channel",
    "http",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Signal Cleanup",
    "--port",
    String(port),
    "--yes",
  ], {
    cwd: temporary,
    env: environment,
    encoding: "utf8",
    timeout: 20_000,
  })
  assert.equal(deployed.status, 0, deployed.stderr)
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    process: { pid: number }
  }
  const runtimePid = config.process.pid
  t.after(() => {
    if (processExists(runtimePid)) process.kill(runtimePid, "SIGKILL")
  })

  const activeAsk = ask(`http://127.0.0.1:${port}`, "stay active")
  await waitFor(async () => {
    try {
      return (await readFile(launchLog, "utf8")).trim().length > 0
    } catch {
      return false
    }
  }, 10_000)
  await waitFor(async () =>
    (await readdir(runtimeTemporary)).some((entry) =>
      entry.startsWith("digital-employee-qoder-")
    ), 10_000)
  const launched = JSON.parse(
    (await readFile(launchLog, "utf8")).trim().split("\n").at(-1)!,
  ) as { pid: number }
  assert.equal(processExists(launched.pid), true)

  process.kill(runtimePid, "SIGTERM")
  await waitFor(() => !processExists(runtimePid), 10_000)
  await waitFor(() => !processExists(launched.pid), 10_000)
  const response = await activeAsk
  assert.equal(response.status, 503)
  await waitFor(async () =>
    (await readdir(runtimeTemporary)).every((entry) =>
      !entry.startsWith("digital-employee-qoder-") &&
      !entry.startsWith("digital-employee-runner-")
    ), 10_000)
  const persisted = await readFile(configPath, "utf8")
  assert.equal(persisted.includes("qoder-signal-secret-sentinel"), false)
  assert.equal(persisted.includes("deploy-http-test-token"), false)
})
