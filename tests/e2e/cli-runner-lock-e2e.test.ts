import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

/**
 * End-to-end test: two real `runner start` CLI processes against the same
 * home. The second must fail fast with the stable RUNNER_ALREADY_RUNNING
 * code, and stopping the first must release the lock for future starts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const cli = path.join(root, "apps", "cli", "bin.ts")
const ISOLATED_PATH = "/usr/bin:/bin"

function runCli(
  args: string[],
  options: { env?: Record<string, string> } = {},
) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: ISOLATED_PATH, ...options.env },
    timeout: 60_000,
  })
}

function spawnCli(
  args: string[],
  options: { env?: Record<string, string> } = {},
): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: ISOLATED_PATH, ...options.env },
  })
}

/** Reads the runner lock holder pid from state.db (null when free). */
function lockHolderPid(stateDb: string): number | null {
  const probe = `
    const { DatabaseSync } = require("node:sqlite")
    const db = new DatabaseSync(process.argv[1], { readOnly: true })
    const row = db.prepare("SELECT pid FROM runner_lock WHERE id = 1").get()
    db.close()
    console.log(row ? String(row.pid) : "")
  `
  const result = spawnSync(process.execPath, ["-e", probe, stateDb], {
    encoding: "utf8",
    timeout: 15_000,
  })
  const value = result.stdout?.trim()
  return value ? Number.parseInt(value, 10) : null
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(message)
}

// The transport retry chain is wired to the CLI's SIGTERM/SIGINT
// AbortSignal (via HttpRunnerTransport.signal → bin.ts controller),
// so a graceful stop interrupts inflight retries in <1s.
function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    child.once("exit", (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

test(
  "cli runner lock e2e: second `runner start` fails fast, lock released on stop",
  { timeout: 20_000 },
  async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), "runner-lock-e2e-"))
    t.after(async () => {
      await rm(home, { recursive: true, force: true })
    })
    const env = { DIGITAL_EMPLOYEE_RUNNER_HOME: home }

    const init = runCli(
      [
        "runner", "init",
        "--home", home,
        "--runner-id", "lock-e2e-1",
        "--seller-id", "seller-lock-e2e",
        "--endpoint", "http://127.0.0.1:1/v1",
      ],
      { env },
    )
    assert.equal(init.status, 0, init.stderr)
    const stateDb = path.join(home, "state.db")

    // First runner: no --once; keeps polling a dead endpoint and stays alive.
    const first = spawnCli(["runner", "start", "--home", home], { env })
    t.after(() => {
      first.kill("SIGTERM")
    })
    assert.ok(first.pid)
    await waitFor(
      () => lockHolderPid(stateDb) === first.pid,
      `runner lock was never acquired by pid ${first.pid}`,
    )

    // Second runner on the same home fails fast with the stable code.
    const second = runCli(["runner", "start", "--home", home], { env })
    assert.equal(second.status, 1)
    assert.match(
      second.stderr,
      /digital-employee: RUNNER_ALREADY_RUNNING\n/,
      second.stderr,
    )

    // Stopping the first runner releases the lock; a fresh start is allowed.
    first.kill("SIGTERM")
    const exitCode = await waitForExit(first)
    assert.equal(exitCode, 0)
    await waitFor(
      () => lockHolderPid(stateDb) === null,
      "runner lock was never released after stop",
    )
  },
)
