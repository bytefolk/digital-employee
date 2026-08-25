/**
 * Local-operator Claude Code model port tests (#182 AC-002..AC-005).
 *
 * Every case drives a fixture binary, so no login and no credential is
 * required. AC-001 (a real turn against a genuinely authenticated Claude
 * Code) is a manual local check and is explicitly not covered here.
 */

import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import {
  createClaudeLocalModelPort,
  isSupportedLocalClaudeVersion,
  localRunEnvironment,
} from "../../apps/cli/turn/claude-local-model-port.js"
import type { ModelTurnInput } from "../../packages/engine/src/model-port.js"

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-claude-local.mjs",
)

function input(text = "answer the question"): ModelTurnInput {
  return {
    blocks: [{ slot: "turn_input", text, byteLength: Buffer.byteLength(text), truncatedBytes: 0 }],
    priorViolations: [],
  }
}

/** Assert on the stable error code rather than the human-facing message. */
function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code)
    return true
  })
}

function port(mode: string, extra: string[] = []) {
  return createClaudeLocalModelPort({
    command: process.execPath,
    commandPrefixArgs: [fixture, "--fixture-mode", mode, ...extra],
    environment: { ...process.env },
    timeoutMs: 20_000,
    now: () => "2026-01-01T00:00:00.000Z",
    newRunId: () => "run-fixture",
  })
}

test("returns model text and token usage without any credential", async () => {
  const result = await port("success").complete(input())
  assert.equal(result.text, "fixture answer")
  assert.equal(result.inputTokens, 11)
  assert.equal(result.outputTokens, 7)
})

test("the operator HOME is preserved and ANTHROPIC_API_KEY is stripped (AC-003)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claude-local-env-"))
  const capture = path.join(dir, "env.json")
  await createClaudeLocalModelPort({
    command: process.execPath,
    commandPrefixArgs: [fixture, "--fixture-mode", "success", "--capture-env", capture],
    // A service credential in the inherited environment must not reach the child.
    environment: { ...process.env, ANTHROPIC_API_KEY: "fixture-must-not-propagate" },
    timeoutMs: 20_000,
  }).complete(input())

  const seen = JSON.parse(await readFile(capture, "utf8")) as Record<string, string | null>
  assert.equal(seen.ANTHROPIC_API_KEY, null, "the service credential must be stripped")
  assert.equal(seen.HOME, process.env.HOME ?? null, "the operator HOME must be preserved")
  assert.equal(seen.CLAUDE_CONFIG_DIR, null, "CLAUDE_CONFIG_DIR must stay unset")
  assert.equal(seen.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1", "project-memory hardening stays on")
})

test("localRunEnvironment never carries a service credential", () => {
  const result = localRunEnvironment({
    ANTHROPIC_API_KEY: "fixture-anthropic-sentinel",
    HOME: "/home/op",
  })
  assert.equal(result.ANTHROPIC_API_KEY, undefined)
  assert.equal(result.HOME, "/home/op")
})

test("the prompt carries assembled slots and prior violations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claude-local-prompt-"))
  const capture = path.join(dir, "prompt.txt")
  await createClaudeLocalModelPort({
    command: process.execPath,
    commandPrefixArgs: [fixture, "--fixture-mode", "success", "--capture-prompt", capture],
    environment: { ...process.env },
    timeoutMs: 20_000,
  }).complete({
    blocks: [{ slot: "turn_input", text: "do the thing", byteLength: 12, truncatedBytes: 0 }],
    priorViolations: [{ attempt: 1, summary: "missing field" }],
  })

  const prompt = await readFile(capture, "utf8")
  assert.match(prompt, /## turn_input\ndo the thing/)
  assert.match(prompt, /## output_violations\n- attempt 1: missing field/)
})

test("an ANTHROPIC_API_KEY-sourced init is rejected (this port is operator-auth only)", async () => {
  await rejectsWithCode(
    port("api-key-source-mismatch").complete(input()),
    "claude_runtime_policy_mismatch",
  )
})

test("a not-logged-in install reports an actionable failure, not a policy mismatch", async () => {
  // Verified against Claude Code 2.1.223: an install without an operator login
  // announces apiKeySource "none" and answers "Not logged in · Please run
  // /login". Accepting it would let an unauthenticated run past the gate.
  await rejectsWithCode(port("not-logged-in").complete(input()), "claude_local_not_logged_in")
})

test("invalid usage fails closed rather than reporting unmeasured tokens (AC-002)", async () => {
  await rejectsWithCode(port("invalid-usage").complete(input()), "claude_usage_invalid")
})

test("a missing cost field fails closed", async () => {
  await rejectsWithCode(port("missing-cost").complete(input()), "claude_usage_invalid")
})

test("an engine-reported result error fails closed", async () => {
  await assert.rejects(port("result-error").complete(input()))
})

test("a non-zero exit fails closed", async () => {
  await rejectsWithCode(port("exit-nonzero").complete(input()), "claude_local_process_failed")
})

test("an aborted signal rejects before spawning", async () => {
  const controller = new AbortController()
  controller.abort()
  await rejectsWithCode(
    port("success").complete(input(), controller.signal),
    "claude_local_aborted",
  )
})

test("the version window matches the isolated adapter (AC-005)", () => {
  assert.equal(isSupportedLocalClaudeVersion("2.1.214"), true)
  assert.equal(isSupportedLocalClaudeVersion("2.1.223 (Claude Code)"), true)
  assert.equal(isSupportedLocalClaudeVersion("2.1.213"), false)
  assert.equal(isSupportedLocalClaudeVersion("2.2.0"), false)
  assert.equal(isSupportedLocalClaudeVersion(undefined), false)
  assert.equal(isSupportedLocalClaudeVersion("not-a-version"), false)
})
