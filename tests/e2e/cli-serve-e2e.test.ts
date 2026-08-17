import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

/**
 * End-to-end tests for the CLI `serve` command: a real subprocess listens on a
 * real loopback socket and answers real HTTP requests against the demo
 * profile's extractive model (deterministic, no network).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const cli = path.join(root, "apps", "cli", "bin.ts")
const demoConfig = path.join(root, "configs", "demo.json")

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer()
    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as { port: number }
      probe.close(() => resolve(address.port))
    })
  })
}

interface RunningServer {
  child: ChildProcess
  baseUrl: string
  stop: () => Promise<void>
}

async function startServer(
  options: { config?: string; env?: Record<string, string> } = {},
): Promise<RunningServer> {
  const port = await getFreePort()
  const args = [
    "--import",
    "tsx",
    cli,
    "serve",
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
  ]
  if (options.config) args.push("--config", options.config)
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stderr = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`serve did not become ready; stderr: ${stderr.slice(0, 512)}`),
      )
    }, 15_000)
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening on")) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  await ready

  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve()
          return
        }
        const killer = setTimeout(() => child.kill("SIGKILL"), 5_000)
        child.once("exit", () => {
          clearTimeout(killer)
          resolve()
        })
        child.kill("SIGTERM")
      }),
  }
}

async function ask(
  baseUrl: string,
  message: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/v1/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof message === "string" ? message : JSON.stringify(message),
  })
}

test("serve answers from approved knowledge over real HTTP", async () => {
  const server = await startServer()
  try {
    const health = await fetch(`${server.baseUrl}/health`)
    assert.equal(health.status, 200)
    const healthBody = (await health.json()) as {
      status: string
      employee: string
      documents: number
    }
    assert.equal(healthBody.status, "ok")
    assert.equal(healthBody.employee, "team-answer")
    assert.ok(healthBody.documents >= 1)

    const response = await ask(server.baseUrl, {
      message: "What belongs in an incident report?",
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      status: string
      answer: string
      citations: Array<{ uri: string }>
    }
    assert.equal(body.status, "answered")
    assert.match(body.answer, /application version/i)
    assert.ok(body.citations.length >= 1)
    assert.ok(
      body.citations.some((citation) => citation.uri.endsWith("handbook.md")),
    )
  } finally {
    await server.stop()
  }
})

test("serve rejects malformed, oversized, and misplaced requests", async () => {
  const server = await startServer()
  try {
    const base = server.baseUrl

    const malformed = await ask(base, "{")
    assert.equal(malformed.status, 400)
    assert.equal(((await malformed.json()) as { error: string }).error, "invalid_request")

    const identityFields = await ask(base, {
      requestId: "client-set",
      message: "hello",
    })
    assert.equal(identityFields.status, 400)
    assert.equal(
      ((await identityFields.json()) as { error: string }).error,
      "client_identity_fields_not_allowed",
    )

    const wrongMethod = await fetch(`${base}/v1/ask`)
    assert.equal(wrongMethod.status, 404)
    const wrongPath = await fetch(`${base}/health`, { method: "POST" })
    assert.equal(wrongPath.status, 404)

    const oversized = await ask(base, JSON.stringify({ message: "x".repeat(40 * 1024) }))
    assert.equal(oversized.status, 413)
    assert.equal(
      ((await oversized.json()) as { error: string }).error,
      "request_body_too_large",
    )
  } finally {
    await server.stop()
  }
})

test("serve honors the configured API token without leaking secrets", async () => {
  const configPath = await withTokenConfig("E2E_SERVER_TOKEN")
  const server = await startServer({
    config: configPath,
    env: { E2E_SERVER_TOKEN: "e2e-secret" },
  })
  try {
    const base = server.baseUrl

    const noAuth = await ask(base, { message: "hello" })
    assert.equal(noAuth.status, 401)
    assert.deepEqual(await noAuth.json(), { error: "unauthorized" })

    const wrongAuth = await ask(
      base,
      { message: "hello" },
      { authorization: "Bearer wrong" },
    )
    assert.equal(wrongAuth.status, 401)

    const ok = await ask(
      base,
      { message: "What belongs in an incident report?" },
      { authorization: "Bearer e2e-secret" },
    )
    assert.equal(ok.status, 200)
    const body = (await ok.json()) as { answer: string }
    assert.match(body.answer, /application version/i)
  } finally {
    await server.stop()
  }
})

test("serve rejects invalid ports at the CLI boundary", () => {
  for (const [args, code] of [
    [["serve", "--port", "not-a-number"], "invalid_port"],
    [["serve", "--port", "0"], "invalid_port"],
    [["serve", "--port", "99999"], "invalid_port"],
  ] as const) {
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
      cwd: root,
      encoding: "utf8",
    })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, "")
    assert.ok(
      result.stderr.includes(`digital-employee: ${code}`),
      `expected ${code} in stderr: ${result.stderr}`,
    )
  }
})

test("serve terminates on SIGTERM without leaking the process", async () => {
  const server = await startServer()
  await server.stop()
  assert.ok(
    server.child.exitCode !== null || server.child.signalCode === "SIGTERM",
    `child neither exited nor terminated: exitCode=${server.child.exitCode} signal=${server.child.signalCode}`,
  )
})

async function withTokenConfig(apiTokenEnv: string): Promise<string> {
  const config = JSON.parse(await readFile(demoConfig, "utf8")) as {
    sources: Array<{ root: string }>
  }
  for (const source of config.sources) {
    source.root = path.resolve(root, "tests", "fixtures", "knowledge")
  }
  ;(config as { server?: { apiTokenEnv: string } }).server = { apiTokenEnv }
  const directory = await mkdtemp(path.join(os.tmpdir(), "cli-serve-e2e-"))
  const configPath = path.join(directory, "config.json")
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return configPath
}
