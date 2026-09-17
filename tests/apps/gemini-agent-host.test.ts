import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createGeminiAgentHostAdapter } from "../../apps/cli/gemini-agent-host.js"
import { createEmployeePackage, inspectEmployeePackage } from "../../apps/cli/employee-package.js"
import { deriveEffectiveAgentHostPolicy } from "../../packages/core/index.js"
import type { AgentHostEvent, AgentHostRunRequest, SafeValue } from "../../packages/core/index.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const fixture = path.join(root, "tests", "apps", "fixtures", "fake-gemini.mjs")

async function request(parent: string): Promise<AgentHostRunRequest> {
  const directory = path.join(parent, "employee")
  await createEmployeePackage(directory)
  const employee = await inspectEmployeePackage(directory)
  return {
    runId: "run-gemini", employeeId: employee.manifest.name, workingDirectory: employee.directory,
    workspaceFiles: employee.manifest.assets, prompt: "Answer the fixture task", instructions: employee.artifacts.skill,
    session: { mode: "new" }, outputSchema: employee.artifacts.outputSchema as SafeValue,
    policy: deriveEffectiveAgentHostPolicy(employee.manifest),
  }
}

function adapter(parent: string, mode = "success", capture?: string) {
  return createGeminiAgentHostAdapter({
    command: process.execPath,
    commandPrefixArgs: [fixture, "--fixture-mode", mode, ...(capture ? ["--capture", capture] : [])],
    environment: { PATH: process.env.PATH, GEMINI_API_KEY: "fixture-gemini-key", SECRET_SHOULD_NOT_PASS: "secret" },
    versionExecutor: async () => ({ status: "installed", output: "gemini 0.fixture" }),
    temporaryRoot: parent,
    timeoutMs: 100,
  })
}

async function events(iterable: AsyncIterable<AgentHostEvent>): Promise<AgentHostEvent[]> {
  const result: AgentHostEvent[] = []
  for await (const event of iterable) result.push(event)
  return result
}

test("Gemini CLI adapter runs with an isolated global-deny policy", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "gemini-adapter-"))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const capture = path.join(parent, "capture.json")
  const result = await events(adapter(parent, "success", capture).run(await request(parent)))
  assert.deepEqual(result.map((event) => event.type), ["run.completed"])
  assert.deepEqual((result[0] as Extract<AgentHostEvent, { type: "run.completed" }>).output, { status: "answered", answer: "fixture answer", citations: [] })
  const launched = JSON.parse(await readFile(capture, "utf8"))
  assert.equal(launched.apiKey, "fixture-gemini-key")
  assert.equal(launched.secretPresent, false)
  assert.equal(launched.args.includes("--output-format"), true)
  assert.equal(launched.args.includes("--admin-policy"), true)
  assert.match(launched.policy, /toolName = "\*"/)
  assert.match(launched.policy, /decision = "deny"/)
})

test("Gemini CLI adapter fails closed on malformed or schema-invalid responses", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "gemini-adapter-invalid-"))
  t.after(() => rm(parent, { recursive: true, force: true }))
  for (const [mode, code] of [["invalid-json", "gemini_response_invalid"], ["bad-schema", "gemini_output_not_json"], ["error", "gemini_response_invalid"]] as const) {
    const fixtureParent = path.join(parent, mode)
    await mkdir(fixtureParent)
    const result = await events(adapter(parent, mode).run(await request(fixtureParent)))
    assert.equal(result[0]?.type, "run.failed")
    assert.equal((result[0] as Extract<AgentHostEvent, { type: "run.failed" }>).error.code, code)
  }
})

test("Gemini CLI adapter is unavailable without an API key", async () => {
  const probe = await createGeminiAgentHostAdapter({
    environment: { PATH: process.env.PATH }, versionExecutor: async () => ({ status: "installed", output: "gemini 0.fixture" }),
  }).probe()
  assert.equal(probe.status, "not_ready")
  assert.equal(probe.issues.some((entry) => entry.code === "gemini_api_key_not_configured"), true)
})
