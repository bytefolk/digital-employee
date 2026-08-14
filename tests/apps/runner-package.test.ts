import assert from "node:assert/strict"
import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createEmployeePackage } from "../../apps/cli/employee-package.js"
import {
  computeEmployeePackageDirectoryDigest,
  createSealedEmployeePackageSnapshot,
} from "../../apps/cli/employee-package.js"
import { runEmployeePackage } from "../../apps/cli/agent-run.js"
import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import type {
  AgentHostAdapter,
  AgentHostProbeResult,
} from "../../packages/core/src/agent-host.js"
import { AgentHostRegistry } from "../../packages/core/src/agent-host-registry.js"

function readyProbe(): AgentHostProbeResult {
  const capabilities = createUnknownAgentHostCapabilities()
  capabilities.non_interactive_run = "supported"
  capabilities.event_stream = "supported"
  capabilities.tool_allowlist = "supported"
  capabilities.filesystem_scope = "supported"
  capabilities.network_policy = "supported"
  return {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId: "fixture-host",
    displayName: "Fixture Host",
    status: "ready",
    available: true,
    adapterStatus: "runnable",
    capabilities,
    capabilitySource: "conformance_test",
    issues: [],
  }
}

test("a sealed snapshot is independent from later source package swaps", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "runner-package-"))
  const source = path.join(parent, "answer-agent")
  await createEmployeePackage(source)
  const sourceDigest = await computeEmployeePackageDirectoryDigest(source)
  const snapshot = await createSealedEmployeePackageSnapshot(source)
  try {
    assert.equal(snapshot.digest, sourceDigest)
    await writeFile(
      path.join(source, "knowledge", "README.md"),
      "# Swapped after the task was accepted\n",
    )
    assert.notEqual(await computeEmployeePackageDirectoryDigest(source), sourceDigest)
    assert.equal(
      await computeEmployeePackageDirectoryDigest(snapshot.directory),
      sourceDigest,
    )
    assert.doesNotMatch(
      await readFile(path.join(snapshot.directory, "knowledge", "README.md"), "utf8"),
      /Swapped/,
    )
  } finally {
    await snapshot.cleanup()
  }
  await assert.rejects(() => access(snapshot.directory))
})

test("runEmployeePackage detects a package mutation made by preflight", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "runner-package-"))
  const directory = path.join(parent, "answer-agent")
  await createEmployeePackage(directory)
  const expectedPackageDigest =
    await computeEmployeePackageDirectoryDigest(directory)
  let runCalled = false
  const adapter: AgentHostAdapter = {
    hostId: "fixture-host",
    async probe() {
      return readyProbe()
    },
    async preflight() {
      await chmod(path.join(directory, "knowledge", "README.md"), 0o600)
      await writeFile(
        path.join(directory, "knowledge", "README.md"),
        "# Mutated by preflight\n",
      )
      return readyProbe()
    },
    async *run() {
      runCalled = true
    },
  }
  const registry = new AgentHostRegistry().register({
    id: "fixture-host",
    probe: () => adapter.probe(),
    createAdapter: () => adapter,
  })
  const result = await runEmployeePackage({
    directory,
    engine: "fixture-host",
    hostRegistry: registry,
    input: { message: "hello" },
    expectedPackageDigest,
  })
  assert.equal(result.status, "failed")
  assert.equal(
    result.status === "failed" && result.error.code,
    "employee_package_digest_mismatch",
  )
  assert.equal(runCalled, false)
})

test("managed callers retain cancellation accounting until Host preflight settles", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "runner-package-"))
  const directory = path.join(parent, "answer-agent")
  await createEmployeePackage(directory)
  let preflightStarted!: () => void
  const started = new Promise<void>((resolve) => {
    preflightStarted = resolve
  })
  let releasePreflight!: () => void
  const blocked = new Promise<void>((resolve) => {
    releasePreflight = resolve
  })
  let cancelled = false
  const adapter: AgentHostAdapter = {
    hostId: "fixture-host",
    async probe() {
      return readyProbe()
    },
    async preflight() {
      preflightStarted()
      await blocked
      return readyProbe()
    },
    async cancel() {
      cancelled = true
    },
    async *run() {
      throw new Error("cancelled preflight must not launch a run")
    },
  }
  const registry = new AgentHostRegistry().register({
    id: "fixture-host",
    probe: () => adapter.probe(),
    createAdapter: () => adapter,
  })
  const controller = new AbortController()
  let settled = false
  const execution = runEmployeePackage({
    directory,
    engine: "fixture-host",
    hostRegistry: registry,
    input: { message: "hello" },
    signal: controller.signal,
    waitForPreflightCleanupOnAbort: true,
  }).finally(() => {
    settled = true
  })
  await started
  controller.abort()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cancelled, true)
  assert.equal(settled, false)
  releasePreflight()
  const result = await execution
  assert.equal(result.status, "failed")
  assert.equal(
    result.status === "failed" && result.error.code,
    "agent_host_cancelled",
  )
})
