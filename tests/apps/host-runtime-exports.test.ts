import assert from "node:assert/strict"
import { access } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import * as hostRuntime from "../../apps/cli/host-runtime.js"

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
)
const compiledHostRuntime = path.join(
  repositoryRoot,
  "dist",
  "apps",
  "cli",
  "host-runtime.js",
)

test("source host-runtime exposes the one-stop Runner embedding API", () => {
  assert.equal(typeof hostRuntime.executeOneShotRunnerTask, "function")
  assert.equal(typeof hostRuntime.runEmployeePackage, "function")
  assert.equal(typeof hostRuntime.createBuiltInAgentHostRegistry, "function")
  assert.equal(typeof hostRuntime.computeEmployeePackageDirectoryDigest, "function")
  assert.equal(typeof hostRuntime.RunnerLeaseState, "function")
  assert.equal(typeof hostRuntime.InMemoryRunnerReplayGuard, "function")
  assert.equal(hostRuntime.RUNNER_LEASE_SAFETY_MARGIN_MS, 5_000)
})

test("compiled host-runtime exposes the one-stop Runner embedding API", async () => {
  await access(compiledHostRuntime)

  const runtime = await import(
    `${pathToFileURL(compiledHostRuntime).href}?test=${Date.now()}`
  )
  assert.equal(typeof runtime.executeOneShotRunnerTask, "function")
  assert.equal(typeof runtime.RunnerLeaseState, "function")
  assert.equal(typeof runtime.InMemoryRunnerReplayGuard, "function")
  assert.equal(runtime.RUNNER_LEASE_SAFETY_MARGIN_MS, 5_000)
})
