import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

/**
 * End-to-end tests for the CLI `stdio-host` command (real subprocess, real
 * stdio framing, digest-pinned external host).
 *
 * Covers: probe-only mode, run (human and --json), deterministic run failure,
 * digest mismatch fail-closed, config read/parse errors, run timeout, probe
 * exchange timeout, and SIGINT cleanup of the detached host process tree.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const cli = path.join(root, "apps", "cli", "bin.ts")
const srcReferenceHost = path.join(root, "apps", "cli", "reference-stdio-host.ts")
const distReferenceHost = path.join(
  root,
  "dist",
  "apps",
  "cli",
  "reference-stdio-host.js",
)
const useDistHost = existsSync(distReferenceHost)
const hostExecutable = useDistHost
  ? process.execPath
  : path.join(root, "node_modules", ".bin", "tsx")
const hostScript = useDistHost ? distReferenceHost : srcReferenceHost
const executableDigest = createHash("sha256")
  .update(readFileSync(hostExecutable))
  .digest("hex")

// The CLI's own stdio is protocol-only; PATH isolation keeps the model CLI
// catalog deterministically unavailable without touching the real machine.
const ISOLATED_PATH = "/usr/bin:/bin"

function runCli(
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {},
) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root,
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, PATH: ISOLATED_PATH, ...options.env },
    timeout: 60_000,
  })
}

async function writeReferenceConfig(
  directory: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const config = {
    schema: "agent-host-stdio-config.v1",
    hostId: "reference-stdio-host",
    displayName: "Reference Stdio Host",
    executable: hostExecutable,
    args: [hostScript],
    digest: { algorithm: "sha256", hex: executableDigest },
    envAllowlist: ["PATH", "REFERENCE_STDIO_HANG"],
    workingDirectoryPolicy: "request",
    timeoutMs: 60_000,
    maxStderrBytes: 16_384,
    ...overrides,
  }
  const configPath = path.join(directory, "host.json")
  await writeFile(configPath, JSON.stringify(config))
  return configPath
}

/** Deterministic failing host: run always ends in a run.failed terminal. */
const fakeHostSource = (repoRoot: string) => `
import readline from "node:readline"
import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "${repoRoot}/packages/core/src/agent-host.js"
import {
  AGENT_HOST_STDIO_PROTOCOL_VERSION,
  encodeAgentHostStdioLine,
  parseAgentHostStdioRequest,
} from "${repoRoot}/packages/core/src/agent-host-stdio.js"

const HOST_ID = "fake-failing-host"
const capabilities = createUnknownAgentHostCapabilities()
capabilities.non_interactive_run = "supported"
capabilities.event_stream = "supported"
capabilities.tool_allowlist = "supported"
capabilities.filesystem_scope = "supported"
capabilities.network_policy = "supported"
const probe = {
  protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
  hostId: HOST_ID,
  displayName: "Fake Failing Host",
  status: "ready",
  available: true,
  adapterStatus: "runnable",
  version: "1.0.0",
  capabilities,
  capabilitySource: "conformance_test",
  issues: [],
}
const rl = readline.createInterface({ input: process.stdin })
rl.on("line", (line) => {
  let request
  try {
    request = parseAgentHostStdioRequest(line)
  } catch {
    return
  }
  const write = (message) =>
    process.stdout.write(\`\${encodeAgentHostStdioLine(message)}\\n\`)
  const emit = (body) =>
    write({
      protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
      id: request.id,
      kind: "event",
      event: {
        runId: request.payload.runId,
        timestamp: new Date().toISOString(),
        ...body,
      },
    })
  if (request.kind === "probe" || request.kind === "preflight") {
    write({
      protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
      id: request.id,
      kind: "response",
      ok: true,
      result: probe,
    })
    return
  }
  if (request.kind === "run") {
    emit({ type: "run.started" })
    emit({
      type: "run.failed",
      error: {
        code: "fake_host_refused",
        message: "fake deterministic failure",
        retryable: false,
      },
    })
    write({
      protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
      id: request.id,
      kind: "response",
      ok: true,
    })
    return
  }
  write({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id: request.id,
    kind: "response",
    ok: false,
    error: {
      code: "agent_host_stdio_unknown_message",
      message: "unknown message",
      retryable: false,
    },
  })
})
rl.on("close", () => process.exit(0))
`

/**
 * Silent host: stays alive but answers nothing. Every exchange must end in
 * the adapter timeout, and the CLI must report the timeout code rather than
 * mislabeling the probe phase as a host error.
 */
const silentHostSource = `setInterval(() => {}, 1000)\n`

async function writeFakeHostConfig(
  options: { hostId?: string; source?: string; timeoutMs?: number } = {},
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cli-stdio-fake-"))
  const hostId = options.hostId ?? "fake-failing-host"
  const script = path.join(directory, `${hostId}.ts`)
  await writeFile(script, options.source ?? fakeHostSource(root))
  // The fake script is always fresh TypeScript, driven by the absolute node
  // binary with --import tsx: module resolution does not depend on PATH, so
  // this survives the isolated-PATH env the CLI children run under.
  const executable = process.execPath
  const digest = createHash("sha256")
    .update(readFileSync(executable))
    .digest("hex")
  const configPath = path.join(directory, "host.json")
  await writeFile(
    configPath,
    JSON.stringify({
      schema: "agent-host-stdio-config.v1",
      hostId,
      displayName: "Fake Failing Host",
      executable,
      args: ["--import", "tsx", script],
      digest: { algorithm: "sha256", hex: digest },
      envAllowlist: ["PATH"],
      workingDirectoryPolicy: "request",
      timeoutMs: options.timeoutMs ?? 30_000,
      maxStderrBytes: 16_384,
    }),
  )
  return configPath
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function childPids(parent: number): number[] {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
  })
  const pids: number[] = []
  for (const line of result.stdout.split("\n")) {
    const [pid, ppid] = line
      .trim()
      .split(/\s+/)
      .map((entry) => Number(entry))
    if (ppid === parent) pids.push(pid)
  }
  return pids
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`child did not exit within ${timeoutMs}ms`)),
      timeoutMs,
    )
    child.once("exit", (code) => {
      clearTimeout(timer)
      resolve(code ?? -1)
    })
  })
}

test("stdio-host probes an external host and prints its probe result", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cli-stdio-probe-"))
  const configPath = await writeReferenceConfig(directory)
  const result = runCli(["stdio-host", configPath])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, "")
  const probe = JSON.parse(result.stdout)
  assert.equal(probe.hostId, "reference-stdio-host")
  assert.equal(probe.status, "ready")
  assert.equal(probe.available, true)
  assert.equal(probe.capabilities.non_interactive_run, "supported")
})

test("stdio-host runs a question through the host and prints the terminal output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cli-stdio-run-"))
  const configPath = await writeReferenceConfig(directory)
  const result = runCli(["stdio-host", configPath, "--question", "hello"])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, "")
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "answered",
    answer: "reference host",
    citations: [],
  })
})

test("stdio-host --json emits the full event stream", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cli-stdio-json-"))
  const configPath = await writeReferenceConfig(directory)
  const result = runCli([
    "stdio-host",
    configPath,
    "--question",
    "hello",
    "--json",
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, "")
  const events = JSON.parse(result.stdout)
  assert.ok(Array.isArray(events) && events.length >= 2)
  assert.equal(events[0].type, "run.started")
  assert.equal(events[events.length - 1].type, "run.completed")
})

test("stdio-host exits 1 and prints run_failed when the run ends in failure", async () => {
  const configPath = await writeFakeHostConfig()
  const result = runCli(["stdio-host", configPath, "--question", "boom"])
  assert.equal(result.status, 1)
  assert.equal(result.stderr, "")
  assert.equal(result.stdout, "run_failed\n")
})

test("stdio-host --json exits 1 when the terminal event is run.failed", async () => {
  const configPath = await writeFakeHostConfig()
  const result = runCli([
    "stdio-host",
    configPath,
    "--question",
    "boom",
    "--json",
  ])
  assert.equal(result.status, 1)
  assert.equal(result.stderr, "")
  const events = JSON.parse(result.stdout)
  assert.equal(events[events.length - 1].type, "run.failed")
  assert.equal(events[events.length - 1].error.code, "fake_host_refused")
})

test("stdio-host fails closed with a stable code when the pinned digest mismatches", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cli-stdio-digest-"))
  const configPath = await writeReferenceConfig(directory, {
    digest: { algorithm: "sha256", hex: "0".repeat(64) },
  })
  const result = runCli(["stdio-host", configPath, "--question", "hello"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(
    result.stderr,
    "digital-employee: agent_host_stdio_digest_mismatch\n",
  )
})

test("stdio-host maps an unreadable config file to a stable code", () => {
  const missing = path.join(os.tmpdir(), `no-such-config-${process.pid}.json`)
  const result = runCli(["stdio-host", missing])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(
    result.stderr,
    "digital-employee: stdio_host_config_unreadable\n",
  )
})

test("stdio-host maps invalid config JSON to a stable code", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cli-stdio-badjson-"))
  const configPath = path.join(directory, "host.json")
  await writeFile(configPath, "not json at all")
  const result = runCli(["stdio-host", configPath])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(
    result.stderr,
    "digital-employee: stdio_host_config_invalid\n",
  )
})

test("stdio-host maps a schema-invalid config to a stable code", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cli-stdio-badschema-"))
  const configPath = await writeReferenceConfig(directory, {
    hostId: "Not A Valid Host Id!",
  })
  const result = runCli(["stdio-host", configPath])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(
    result.stderr,
    "digital-employee: stdio_host_config_invalid\n",
  )
})

test("stdio-host fails closed with a stable code when the run hangs past timeoutMs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cli-stdio-hang-"))
  const configPath = await writeReferenceConfig(directory, {
    timeoutMs: 1_000,
  })
  const result = runCli(["stdio-host", configPath, "--question", "hang"], {
    env: { REFERENCE_STDIO_HANG: "1" },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(
    result.stderr,
    "digital-employee: agent_host_stdio_timeout\n",
  )
})

test("stdio-host reports a silent host probe as a timeout, not a host error", async () => {
  const configPath = await writeFakeHostConfig({
    hostId: "fake-silent-host",
    source: silentHostSource,
    timeoutMs: 1_000,
  })
  const result = runCli(["stdio-host", configPath])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(
    result.stderr,
    "digital-employee: agent_host_stdio_timeout\n",
  )
})

test("SIGINT cancels the run, reaps the detached host tree, and exits 130", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cli-stdio-int-"))
  const configPath = await writeReferenceConfig(directory)
  const cliChild = spawn(
    process.execPath,
    ["--import", "tsx", cli, "stdio-host", configPath, "--question", "hang"],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: ISOLATED_PATH,
        REFERENCE_STDIO_HANG: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let stdout = ""
  let stderr = ""
  cliChild.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8")
  })
  cliChild.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
  })
  const cliPid = cliChild.pid
  assert.ok(cliPid, "CLI child pid missing")

  // The only child of the CLI is the detached host process; wait for it so
  // SIGINT lands after the signal handlers and the host are in place.
  let hostPid = 0
  const deadline = Date.now() + 10_000
  while (hostPid === 0 && Date.now() < deadline) {
    const children = childPids(cliPid)
    if (children.length > 0) hostPid = children[0]
    else await sleep(100)
  }
  assert.ok(hostPid !== 0, `host child of CLI ${cliPid} never appeared`)

  cliChild.kill("SIGINT")
  const exitCode = await waitForExit(cliChild, 15_000)
  assert.equal(exitCode, 130)
  assert.equal(stdout, "")
  assert.ok(!stderr.includes("digital-employee:"), stderr)

  const reapDeadline = Date.now() + 5_000
  while (alive(hostPid) && Date.now() < reapDeadline) {
    await sleep(100)
  }
  assert.ok(!alive(hostPid), `host process ${hostPid} was orphaned`)
})
