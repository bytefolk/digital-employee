/**
 * Black-box tests for `digital-employee hire validate` (#194, R4 freeze).
 *
 * AC-001: the hire channel exists and validates end-to-end through the
 * built CLI. Static only: the command never spawns, calls the engine, or
 * touches a provider; every violation exits 1 with a stable diagnostic.
 */

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const builtCli = path.join(root, "dist", "apps", "cli", "bin.js")

function cliEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  delete environment.LANG
  delete environment.LC_ALL
  return {
    ...environment,
    HOME: home,
    PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
  }
}

function runCli(
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  return spawnSync(process.execPath, [builtCli, ...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    input: "",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  })
}

function hireRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "hire-request.v1alpha1",
    workspaceRef: "ws-main",
    packageRef: {
      name: "team-answer",
      version: "v1alpha1",
      digest: "sha256:0123456789abcdef",
    },
    targetParentId: "pos-parent-1",
    budget: {
      perTask: { tokens: 50_000, iterations: 8 },
      perDay: { tokens: 500_000 },
    },
    requestedBy: "cto",
    envelopeDigest: "sha256:abcdef0123456789",
    ...overrides,
  }
}

async function writeHireRequest(
  directory: string,
  body: Record<string, unknown>,
): Promise<string> {
  const filePath = path.join(directory, "hire-request.json")
  await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8")
  return filePath
}

test("AC-001: hire validate accepts a frozen hire request end-to-end (#194)", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hire-cli-home-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const env = cliEnvironment(home)
  const file = await writeHireRequest(home, hireRequest())

  const plain = runCli(["hire", "validate", file], env, home)
  assert.equal(plain.status, 0, plain.stderr)
  assert.match(plain.stdout, /hire request valid: team-answer@v1alpha1/)

  const json = runCli(["hire", "validate", file, "--json"], env, home)
  assert.equal(json.status, 0, json.stderr)
  const parsed = JSON.parse(json.stdout) as Record<string, any>
  assert.equal(parsed.status, "valid")
  assert.equal(parsed.hire.schemaVersion, "hire-request.v1alpha1")
  assert.deepEqual(parsed.hire.budget, {
    perTask: { tokens: 50_000, iterations: 8 },
    perDay: { tokens: 500_000 },
  })
})

test("AC-001: hire validate fails closed with stable diagnostics (#194)", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hire-cli-home-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const env = cliEnvironment(home)

  const cases: Array<{
    name: string
    body: () => Record<string, unknown>
    code: string
  }> = [
    {
      name: "missing budget",
      body: () => {
        const body = hireRequest()
        delete body.budget
        return body
      },
      code: "hire_request_missing_budget",
    },
    {
      name: "empty budget scope",
      body: () => hireRequest({ budget: { perTask: {}, perDay: { tokens: 1 } } }),
      code: "hire_request_invalid_field:budget.perTask",
    },
    {
      name: "unknown root field",
      body: () => hireRequest({ approvedBy: "ceo" }),
      code: "hire_request_unknown_field:approvedBy",
    },
    {
      name: "localReference channel rejected",
      body: () =>
        hireRequest({
          packageRef: {
            name: "team-answer",
            version: "v1alpha1",
            digest: "sha256:0123456789abcdef",
            localReference: "./packages/team-answer",
          },
        }),
      code: "hire_request_unknown_field:packageRef.localReference",
    },
    {
      name: "bad package version pattern",
      body: () =>
        hireRequest({
          packageRef: {
            name: "team-answer",
            version: "v1alpha2",
            digest: "sha256:0123456789abcdef",
          },
        }),
      code: "hire_request_invalid_field:packageRef.version",
    },
    {
      name: "missing targetParentId",
      body: () => {
        const body = hireRequest()
        delete body.targetParentId
        return body
      },
      code: "hire_request_invalid_field:targetParentId",
    },
    {
      name: "missing workspaceRef",
      body: () => {
        const body = hireRequest()
        delete body.workspaceRef
        return body
      },
      code: "hire_request_invalid_field:workspaceRef",
    },
    {
      name: "missing requestedBy",
      body: () => {
        const body = hireRequest()
        delete body.requestedBy
        return body
      },
      code: "hire_request_invalid_field:requestedBy",
    },
    {
      name: "missing envelopeDigest",
      body: () => {
        const body = hireRequest()
        delete body.envelopeDigest
        return body
      },
      code: "hire_request_invalid_field:envelopeDigest",
    },
  ]

  for (const testCase of cases) {
    const file = await writeHireRequest(home, testCase.body())

    const plain = runCli(["hire", "validate", file], env, home)
    assert.equal(plain.status, 1, `${testCase.name}: ${plain.stdout}`)
    assert.match(
      plain.stderr,
      new RegExp(testCase.code.replace(/[.[\]]/g, "\\$&")),
      testCase.name,
    )

    const json = runCli(["hire", "validate", file, "--json"], env, home)
    assert.equal(json.status, 1, `${testCase.name}: ${json.stdout}`)
    const parsed = JSON.parse(json.stdout) as Record<string, unknown>
    assert.deepEqual(parsed, { status: "failed", code: testCase.code }, testCase.name)
  }
})

test("AC-001: hire validate rejects unreadable and malformed input (#194)", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hire-cli-home-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const env = cliEnvironment(home)

  const missing = runCli(
    ["hire", "validate", path.join(home, "nope.json")],
    env,
    home,
  )
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /hire_request_file_unreadable/)

  const malformedPath = path.join(home, "malformed.json")
  await writeFile(malformedPath, "{not json", "utf8")
  const malformed = runCli(["hire", "validate", malformedPath], env, home)
  assert.equal(malformed.status, 1)
  assert.match(malformed.stderr, /hire_request_invalid_json/)

  const noFile = runCli(["hire", "validate"], env, home)
  assert.equal(noFile.status, 1)
  assert.match(noFile.stderr, /hire_validate_requires_file/)

  const unknown = runCli(["hire", "approve", "x.json"], env, home)
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown_hire_subcommand:approve/)

  const help = runCli(["hire", "--help"], env, home)
  assert.equal(help.status, 0)
  assert.match(help.stdout, /digital-employee hire validate <file> \[--json\]/)
})
