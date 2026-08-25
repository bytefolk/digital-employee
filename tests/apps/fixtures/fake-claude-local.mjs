#!/usr/bin/env node

// Fixture for the local-operator Claude Code model port (#182). Emits the
// zero-tool stream-json shape an operator-authenticated Claude Code produces,
// so the port can be exercised without a real login or any credential.

import { readFile } from "node:fs/promises"

const args = process.argv.slice(2)

function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const fixtureVersion = option("--fixture-version") || "2.1.214"
if (args.includes("--version")) {
  process.stdout.write(`${fixtureVersion} (Claude Code)\n`)
  process.exit(0)
}

const mode = option("--fixture-mode") || "success"
const promptCapture = option("--capture-prompt")
const envCapture = option("--capture-env")

if (mode === "hang") setInterval(() => {}, 1_000)

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

// The port writes the prompt to stdin and closes it.
let prompt = ""
process.stdin.setEncoding("utf8")
for await (const chunk of process.stdin) prompt += chunk

if (promptCapture) {
  await (await import("node:fs/promises")).writeFile(promptCapture, prompt)
}
if (envCapture) {
  await (await import("node:fs/promises")).writeFile(
    envCapture,
    JSON.stringify({
      HOME: process.env.HOME ?? null,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS ?? null,
    }),
  )
}

const sessionId = "fixture-local-session"
const base = { session_id: sessionId }

emit({
  type: "system",
  subtype: "init",
  ...base,
  // "none" was verified against Claude Code 2.1.223 to mean *not logged in*;
  // "claude_cli_oauth" is the operator-login label. The service-credential
  // source must stay rejected by this port.
  apiKeySource:
    mode === "api-key-source-mismatch"
      ? "ANTHROPIC_API_KEY"
      : mode === "not-logged-in"
        ? "none"
        : "claude_cli_oauth",
  claude_code_version: fixtureVersion,
  cwd: process.cwd(),
  tools: [],
  mcp_servers: [],
  plugins: [],
  skills: [],
  slash_commands: [],
  permissionMode: option("--permission-mode"),
  capabilities: [],
  model: "fixture-model",
})

if (mode === "api-key-source-mismatch" || mode === "not-logged-in") {
  await new Promise(() => {})
}

const answer = mode === "empty-answer" ? "" : "fixture answer"

emit({
  type: "assistant",
  ...base,
  parent_tool_use_id: null,
  message: { role: "assistant", content: [{ type: "text", text: answer }] },
})

emit({
  type: "result",
  ...base,
  subtype: mode === "result-error" ? "error_during_execution" : "success",
  is_error: mode === "result-error",
  result: answer,
  usage:
    mode === "invalid-usage"
      ? { input_tokens: -1, output_tokens: 5 }
      : { input_tokens: 11, output_tokens: 7 },
  ...(mode === "missing-cost" ? {} : { total_cost_usd: 0 }),
})

process.exit(mode === "exit-nonzero" ? 1 : 0)
