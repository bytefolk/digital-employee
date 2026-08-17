import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

/**
 * End-to-end tests for the CLI `ask` command: a real subprocess answers
 * against the demo profile's extractive model (deterministic, no network).
 *
 * `ask` is a legacy alias (`legacy ask`), so its stderr carries the
 * deprecation warning plus an unavoidable SQLite ExperimentalWarning from the
 * runtime assembly chain; assertions therefore target stdout and exit codes.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const cli = path.join(root, "apps", "cli", "bin.ts")

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  })
}

const HIT_QUESTION = "What belongs in an incident report?"

test("ask answers from approved knowledge with human-readable output", () => {
  const result = runCli(["ask", "--question", HIT_QUESTION])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /application version/i)
  assert.match(result.stdout, /Sources:/)
  assert.match(result.stdout, /handbook\.md/)
})

test("ask --json emits machine-readable output with citations", () => {
  const result = runCli(["ask", "--question", HIT_QUESTION, "--json"])
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout) as {
    ok: boolean
    status: string
    answer: string
    citations: Array<{ uri: string }>
  }
  assert.equal(output.ok, true)
  assert.equal(output.status, "answered")
  assert.match(output.answer, /application version/i)
  assert.ok(output.citations.length >= 1)
  assert.ok(output.citations.some((citation) => citation.uri.endsWith("handbook.md")))
})

test("ask accepts positionals as the question", () => {
  const result = runCli(["ask", ...HIT_QUESTION.split(" ")])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /application version/i)
})

test("ask without a question fails with the stable error code", () => {
  const result = runCli(["ask"])
  assert.equal(result.status, 1)
  assert.ok(
    result.stderr.includes("digital-employee: ask_requires_question"),
    result.stderr,
  )
})

test("ask escalates instead of guessing when evidence is insufficient", () => {
  const result = runCli([
    "ask",
    "--question",
    "What is the meaning of life?",
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /I could not find enough approved evidence/i)
  assert.match(result.stdout, /Human review:/)
})
