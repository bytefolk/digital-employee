import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

/**
 * End-to-end tests for the CLI `run` command (real subprocess, real stdin,
 * real stdio framing).
 *
 * The CLI deliberately exposes only the built-in agent-host catalog, so a
 * model-free success path does not exist at the CLI boundary: every built-in
 * engine invokes a real model CLI. These tests therefore exercise the full
 * init -> validate -> run pipeline with the engine missing from PATH, proving
 * that run fails closed deterministically instead of executing a model.
 * The success path with a registered external host is covered in-process by
 * tests/apps/real-local-host.test.ts.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const cli = path.join(root, "apps", "cli", "bin.ts")

// qoder/codex/codebuddy live outside /usr/bin:/bin; an isolated PATH makes
// every built-in engine deterministically unavailable without touching the
// real machine's toolchain.
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

async function createPackage(name: string): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "cli-run-e2e-"))
  const directory = path.join(parent, name)
  const initialized = runCli(["init", directory, "--recipe", "minimal-answer.v1", "--json"])
  assert.equal(initialized.status, 0, initialized.stderr)
  return directory
}

test("init -> validate -> run pipeline fails closed without a model engine", async () => {
  const directory = await createPackage("pipeline")

  const validated = runCli(["validate", directory, "--json"])
  assert.equal(validated.status, 0, validated.stderr)
  assert.equal(JSON.parse(validated.stdout).status, "valid")

  // qoder is real on this machine but absent from the isolated PATH: the run
  // must fail closed instead of invoking a model.
  const result = runCli(
    ["run", directory, "--engine", "qoder", "--stdin", "--json"],
    { input: JSON.stringify({ message: "answer from approved evidence" }) },
  )
  assert.equal(result.status, 1)
  assert.equal(result.stderr, "")
  const output = JSON.parse(result.stdout)
  assert.equal(output.status, "failed")
  assert.equal(output.error.code, "agent_host_incompatible")
})

test("probe-only engines without an adapter are never executed by run", async () => {
  const directory = await createPackage("probe-only")
  const result = runCli(
    ["run", directory, "--engine", "codex", "--stdin", "--json"],
    { input: JSON.stringify({ message: "anything" }) },
  )
  assert.equal(result.status, 1)
  assert.equal(result.stderr, "")
  const output = JSON.parse(result.stdout)
  assert.equal(output.status, "failed")
  assert.equal(output.error.code, "agent_host_adapter_not_runnable")
})

test("external stdio hosts stay unreachable through the CLI run command", async () => {
  const directory = await createPackage("external-host")
  const result = runCli(["run", directory, "--engine", "real-local-stdio-host", "--json"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(
    result.stderr,
    "digital-employee: unknown_agent_host:real-local-stdio-host\n",
  )
})

test("run with an unreadable input file fails with a stable error code", async () => {
  const directory = await createPackage("missing-input-file")
  const missing = path.join(directory, "no-such-input.json")
  const result = runCli(
    ["run", directory, "--engine", "qoder", "--input-file", missing, "--json"],
  )
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(
    result.stderr,
    "digital-employee: run_input_unreadable\n",
  )
})
