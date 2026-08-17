import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

/**
 * End-to-end tests for the CLI `validate` command: static package validation
 * plus host-compatibility validation with the engine missing from PATH.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const cli = path.join(root, "apps", "cli", "bin.ts")

// codex/qoder live outside /usr/bin:/bin; an isolated PATH makes the
// host-compatibility path deterministically report the engine as not found.
const ISOLATED_PATH = "/usr/bin:/bin"

function runCli(
  args: string[],
  options: { env?: Record<string, string> } = {},
) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    timeout: 60_000,
  })
}

async function createPackage(name: string): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "cli-validate-e2e-"))
  const directory = path.join(parent, name)
  const initialized = runCli(["init", directory, "--recipe", "minimal-answer.v1", "--json"])
  assert.equal(initialized.status, 0, initialized.stderr)
  return directory
}

test("validate reports a valid package as JSON with the declared files", async () => {
  const directory = await createPackage("valid")
  const result = runCli(["validate", directory, "--json"])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, "")
  const output = JSON.parse(result.stdout) as {
    status: string
    employee: { name: string; version: string }
    files: string[]
  }
  assert.equal(output.status, "valid")
  assert.equal(output.employee.name, "valid")
  assert.equal(output.employee.version, "0.1.0")
  assert.deepEqual(output.files, [
    "./SKILL.md",
    "./schemas/input.schema.json",
    "./schemas/output.schema.json",
    "./knowledge/README.md",
    "./evals/cases.json",
  ])
})

test("validate prints a human summary without engine selection", async () => {
  const directory = await createPackage("human")
  const result = runCli(["validate", directory])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Static package valid: human@0\.1\.0/)
  assert.match(result.stdout, /Checked 5 declared file\(s\)\./)
})

test("validate rejects a broken package with a stable error code", async () => {
  const directory = await createPackage("broken")
  await writeFile(
    path.join(directory, "schemas", "input.schema.json"),
    JSON.stringify({ type: "not-a-json-schema-type" }),
  )
  const result = runCli(["validate", directory, "--json"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(
    result.stderr,
    "digital-employee: employee_package_invalid_json_schema:./schemas/input.schema.json\n",
  )
})

test("validate --engine reports incompatibility when the host is missing", async () => {
  const directory = await createPackage("host-missing")
  const result = runCli(
    ["validate", directory, "--engine", "codex", "--json"],
    { env: { PATH: ISOLATED_PATH } },
  )
  assert.equal(result.status, 1)
  assert.equal(result.stderr, "")
  const output = JSON.parse(result.stdout) as {
    status: string
    host: { hostId: string; status: string; available: boolean }
    compatibility: { compatible: boolean }
  }
  assert.equal(output.status, "incompatible")
  assert.equal(output.host.hostId, "codex")
  assert.equal(output.host.status, "not_found")
  assert.equal(output.host.available, false)
  assert.equal(output.compatibility.compatible, false)
})

test("validate rejects unknown engines at the CLI boundary", async () => {
  const directory = await createPackage("unknown-engine")
  const result = runCli(["validate", directory, "--engine", "real-local-stdio-host", "--json"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(
    result.stderr,
    "digital-employee: unknown_agent_host:real-local-stdio-host\n",
  )
})

test("validate accepts exactly one directory", async () => {
  const result = runCli(["validate", "a", "b"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(
    result.stderr,
    "digital-employee: validate_accepts_one_directory\n",
  )
})
