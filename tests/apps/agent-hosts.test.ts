import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  BUILT_IN_AGENT_HOST_IDS,
  executeVersionCommand,
  getCliAgentHostDefinition,
  isBuiltInAgentHostId,
  probeCliAgentHost,
} from "../../apps/cli/agent-hosts.js"

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      if ((await readFile(file, "utf8")).trim()) return
    } catch {
      // The probe has not published its process identities yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("version_probe_marker_timeout")
}

test("built-in Agent hosts have stable CLI identities", () => {
  assert.deepEqual(BUILT_IN_AGENT_HOST_IDS, [
    "claude-code",
    "qoder",
    "codex",
    "qwen-code",
    "codebuddy",
  ])
  assert.equal(isBuiltInAgentHostId("qoder"), true)
  assert.equal(isBuiltInAgentHostId("qwen-code"), true)
  assert.equal(isBuiltInAgentHostId("codebuddy"), true)
  assert.equal(isBuiltInAgentHostId("workbuddy"), false)
  assert.equal(getCliAgentHostDefinition("codex").command, "codex")
  assert.equal(getCliAgentHostDefinition("qwen-code").command, "qwen")
  assert.equal(getCliAgentHostDefinition("codebuddy").command, "codebuddy")
})

test("host probe is side-effect free beyond a bounded version command", async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const result = await probeCliAgentHost("qoder", async (command, args) => {
    calls.push({ command, args })
    return { status: "installed", output: "qodercli 1.2.3" }
  })

  assert.deepEqual(calls, [{ command: "qodercli", args: ["--version"] }])
  assert.equal(result.available, true)
  assert.equal(result.status, "installed")
  assert.equal(result.version, "qodercli 1.2.3")
  assert.equal(result.capabilities.tool_allowlist, "documented")
  assert.equal(result.adapterStatus, "probe_only")
  assert.equal(result.issues[0]?.code, "authentication_not_checked")
})

test("missing hosts return a structured blocking issue", async () => {
  const result = await probeCliAgentHost("claude-code", async () => ({
    status: "not_found",
  }))
  assert.equal(result.available, false)
  assert.equal(result.status, "not_found")
  assert.equal(result.issues[0]?.code, "host_executable_not_found")
  assert.equal(result.issues[0]?.blocking, true)
})

test("resolved-but-unspawnable hosts get a distinct blocking issue (REQ-002 in #223)", async () => {
  const result = await probeCliAgentHost("qoder", async () => ({
    status: "not_spawnable",
  }))
  assert.equal(result.available, false)
  assert.equal(result.status, "not_spawnable")
  assert.equal(result.issues[0]?.code, "host_executable_not_spawnable")
  assert.equal(result.issues[0]?.blocking, true)
  assert.notEqual(result.issues[0]?.code, "host_executable_not_found")
})

test("shared version probe resolves .cmd shims through PATHEXT on Windows (REQ-001 in #223)", async (t) => {
  if (process.platform !== "win32") {
    t.skip("PATHEXT resolution is a win32-only concern")
    return
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "host-pathext-probe-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const shim = path.join(temporary, "qodercli.cmd")
  await writeFile(
    shim,
    "@echo off\r\necho qodercli 1.2.3-shim\r\nexit /b 0\r\n",
  )
  const originalPath = process.env.PATH
  process.env.PATH = `${temporary}${path.delimiter}${originalPath ?? ""}`
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  })
  const result = await probeCliAgentHost("qoder")
  assert.equal(result.status, "installed")
  assert.equal(result.available, true)
  assert.ok(
    result.version?.includes("qodercli 1.2.3-shim"),
    `expected shim version output, got: ${String(result.version)}`,
  )
})

test("aborting a version probe reaps its signal-ignoring process group", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group cleanup is not available on Windows")
    return
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "host-version-abort-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const marker = path.join(temporary, "pids.json")
  const script = path.join(temporary, "probe.cjs")
  await writeFile(
    script,
    `const { spawn } = require("node:child_process")\n` +
      `const { writeFileSync } = require("node:fs")\n` +
      `const child = spawn(process.execPath, ["-e", ` +
      `"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], ` +
      `{ stdio: "ignore" })\n` +
      `writeFileSync(process.argv[2], JSON.stringify({ leader: process.pid, child: child.pid }))\n` +
      `process.on("SIGTERM", () => {})\n` +
      `setInterval(() => {}, 1000)\n`,
  )
  const controller = new AbortController()
  const execution = executeVersionCommand(
    process.execPath,
    [script, marker],
    { signal: controller.signal },
  )
  await waitForFile(marker)
  const pids = JSON.parse(await readFile(marker, "utf8")) as {
    leader: number
    child: number
  }
  assert.equal(processExists(pids.leader), true)
  assert.equal(processExists(pids.child), true)
  controller.abort()
  assert.deepEqual(await execution, { status: "probe_failed" })
  assert.equal(processExists(pids.leader), false)
  assert.equal(processExists(pids.child), false)
})

test("Codex tool allowlisting stays unknown until an adapter can enforce it", () => {
  const definition = getCliAgentHostDefinition("codex")
  assert.equal(definition.capabilities.sandbox, "documented")
  assert.equal(definition.capabilities.tool_allowlist, "unknown")
})

test("raw catalog claims remain documentation-only until a registry adapter probes", () => {
  for (const hostId of ["claude-code", "qwen-code", "codebuddy"] as const) {
    const definition = getCliAgentHostDefinition(hostId)
    assert.equal(definition.capabilities.non_interactive_run, "documented")
    assert.equal(definition.capabilities.event_stream, "documented")
  }
  assert.equal(
    getCliAgentHostDefinition("claude-code").capabilities.tool_allowlist,
    "documented",
  )
  assert.equal(
    getCliAgentHostDefinition("qwen-code").capabilities.tool_allowlist,
    "unknown",
  )
  assert.equal(
    getCliAgentHostDefinition("codebuddy").capabilities.tool_allowlist,
    "unknown",
  )
})
