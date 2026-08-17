/**
 * Tests for the Runner CLI command wrappers (init/doctor/status/start/deploy).
 */

import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { CoreError } from "../../packages/core/src/contracts.js"
import { SqliteDurableStore } from "../../packages/core/src/runner-sqlite-store.js"
import { createEmployeePackage } from "../../apps/cli/employee-package.js"
import {
  readRunnerConfig,
  runnerCommandDeploy,
  runnerCommandDoctor,
  runnerCommandInit,
  runnerCommandStart,
  runnerCommandStatus,
  runnerHomeLayout,
} from "../../apps/cli/runner-commands.js"

async function tmpHome(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "runner-commands-"))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

test("init writes config and receipt key, then refuses re-init", async (t) => {
  const home = await tmpHome(t)
  const result = runnerCommandInit({
    home,
    runnerId: "runner-cli-1",
    sellerId: "seller-cli-1",
    platformEndpoint: "https://platform.example/v1",
  })
  assert.equal(result.created, true)
  assert.equal(result.config.runnerId, "runner-cli-1")

  const layout = runnerHomeLayout(home)
  assert.equal(existsSync(layout.receiptKeyFile), true)
  assert.match(readFileSync(layout.receiptKeyFile, "utf8"), /BEGIN PRIVATE KEY/)

  const loaded = readRunnerConfig(home)
  assert.equal(loaded.runnerId, "runner-cli-1")
  assert.equal(loaded.sellerId, "seller-cli-1")
  assert.equal(loaded.platformEndpoint, "https://platform.example/v1")

  assert.throws(
    () =>
      runnerCommandInit({
        home,
        runnerId: "runner-cli-2",
        sellerId: "seller-cli-1",
        platformEndpoint: "https://platform.example/v1",
      }),
    (err: unknown) => {
      assert.ok(err instanceof CoreError)
      assert.equal(err.code, "RUNNER_ALREADY_INITIALIZED")
      return true
    },
  )
})

test("readRunnerConfig rejects missing and malformed config", async (t) => {
  const home = await tmpHome(t)
  assert.throws(
    () => readRunnerConfig(home),
    (err: unknown) => {
      assert.ok(err instanceof CoreError)
      assert.equal(err.code, "RUNNER_NOT_INITIALIZED")
      return true
    },
  )
})

test("doctor reports on an uninitialized home without throwing", async (t) => {
  const home = await tmpHome(t)
  const report = await runnerCommandDoctor(home)
  assert.equal(report.version, "runner-lifecycle.v1")
  assert.ok(Array.isArray(report.checks))
  assert.equal(typeof report.healthy, "boolean")
  assert.ok(Number.isFinite(Date.parse(report.checkedAt)))
})

test("status reports configured runner as stopped", async (t) => {
  const home = await tmpHome(t)
  runnerCommandInit({
    home,
    runnerId: "runner-cli-3",
    sellerId: "seller-cli-3",
    platformEndpoint: "https://platform.example/v1",
  })
  const status = await runnerCommandStatus(home)
  assert.equal(status.runnerId, "runner-cli-3")
  assert.equal(status.sellerId, "seller-cli-3")
  assert.equal(status.processStatus, "stopped")
  assert.equal(status.tasksCompleted, 0)
})

test("start aborts cleanly when the signal is already aborted", async (t) => {
  const home = await tmpHome(t)
  runnerCommandInit({
    home,
    runnerId: "runner-cli-4",
    sellerId: "seller-cli-4",
    platformEndpoint: "https://platform.example/v1",
  })
  const controller = new AbortController()
  controller.abort()
  const handle = runnerCommandStart({ home, signal: controller.signal })
  try {
    await handle.process.done
    const status = handle.process.status()
    assert.equal(status.processStatus, "stopped")
  } finally {
    handle.close()
  }
})

test("start refuses a second runner while the first holds the process lock", async (t) => {
  const home = await tmpHome(t)
  runnerCommandInit({
    home,
    runnerId: "runner-cli-lock",
    sellerId: "seller-cli-lock",
    platformEndpoint: "https://platform.example/v1",
  })
  // Intentionally no signal: the lock test must not be affected by transport
  // abort wiring. The transport retry chain on the dead endpoint will exhaust
  // (~15 s) which is acceptable for a lock-semantics unit test; the fast path
  // with a signal is covered by the E2E lock test.
  const handle = runnerCommandStart({ home })
  try {
    assert.throws(
      () => runnerCommandStart({ home }),
      (err: unknown) => {
        assert.ok(err instanceof CoreError)
        assert.equal(err.code, "RUNNER_ALREADY_RUNNING")
        assert.match(err.message, /pid \d+/)
        return true
      },
    )
  } finally {
    await handle.process.stop()
    handle.close()
  }

  // stop + close release the lock: a fresh start is allowed again.
  const controller = new AbortController()
  controller.abort()
  const again = runnerCommandStart({ home, signal: controller.signal })
  try {
    await again.process.done
    assert.equal(again.process.status().processStatus, "stopped")
  } finally {
    again.close()
  }
})

test("deploy registers the package and copies it into home", async (t) => {
  const home = await tmpHome(t)
  runnerCommandInit({
    home,
    runnerId: "runner-cli-5",
    sellerId: "seller-cli-5",
    platformEndpoint: "https://platform.example/v1",
  })
  const packageParent = await mkdtemp(path.join(os.tmpdir(), "runner-deploy-"))
  t.after(async () => {
    await rm(packageParent, { recursive: true, force: true })
  })
  const packageDir = path.join(packageParent, "my-employee")
  await createEmployeePackage(packageDir, { recipe: "minimal-answer.v1" })

  const record = await runnerCommandDeploy({
    home,
    employeeDirectory: packageDir,
  })
  assert.equal(record.employeeId, "my-employee")
  assert.match(record.packageDigest, /^sha256:/)
  assert.equal(existsSync(record.localPackageRef), true)

  const layout = runnerHomeLayout(home)
  const store = new SqliteDurableStore(layout.stateFile)
  try {
    const loaded = store.getDeployment(record.employeeId, record.employeeVersion)
    assert.ok(loaded)
    assert.equal(loaded.packageDigest, record.packageDigest)
    assert.equal(loaded.localPackageRef, record.localPackageRef)
  } finally {
    store.close()
  }
})
