import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import test from "node:test"

import { hasExactHttpReadback } from "../../apps/cli/deploy/index.js"
import type {
  DeployConfig,
  DeployPackageBinding,
} from "../../apps/cli/deploy/config.js"

const MATCHING_DIGEST = `sha256:${"a".repeat(64)}`

function httpConfig(pid: number): DeployConfig {
  return {
    channel: "http",
    engine: "qoder",
    runtime: "agent-native",
    package: {
      name: "readback-bot",
      version: "1.0.0",
      digest: MATCHING_DIGEST,
      localReference: "/tmp/readback-bot",
    },
    endpoint: {
      protocol: "http",
      host: "127.0.0.1",
      port: 8899,
      askPath: "/v1/ask",
      healthPath: "/health",
    },
    process: {
      pid,
      startedAt: new Date().toISOString(),
      launchId: "c".repeat(32),
      activationFence: "d".repeat(32),
      activationState: "authorized",
    },
  }
}

const binding: DeployPackageBinding = {
  name: "readback-bot",
  version: "1.0.0",
  digest: MATCHING_DIGEST,
  localReference: "/tmp/readback-bot",
}

test("hasExactHttpReadback rejects a mismatched package binding immediately", async () => {
  const mismatched: DeployPackageBinding = {
    ...binding,
    localReference: "/tmp/other-package",
  }
  assert.equal(await hasExactHttpReadback(httpConfig(process.pid), mismatched), false)
})

test("hasExactHttpReadback stays fail-closed for a process with a mismatched argv", async () => {
  // The test runner's own process is alive but its argv never matches the
  // tracked runtime invocation, so every attempt observes "unverified".
  assert.equal(await hasExactHttpReadback(httpConfig(process.pid), binding), false)
})

test("hasExactHttpReadback stays fail-closed for a dead process", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"])
  await once(child, "exit")
  assert.equal(await hasExactHttpReadback(httpConfig(child.pid!), binding), false)
})

test("hasExactHttpReadback aborts the bounded window on signal", async () => {
  const controller = new AbortController()
  controller.abort()
  assert.equal(
    await hasExactHttpReadback(httpConfig(process.pid), binding, controller.signal),
    false,
  )
})
