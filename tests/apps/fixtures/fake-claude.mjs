#!/usr/bin/env node

import { spawn } from "node:child_process"
import {
  appendFile,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises"

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
// A pending promise alone does not keep Node alive. Give the deadline fixture
// a real event-loop handle so it cannot race a natural exit with the adapter.
if (mode === "hang") setInterval(() => {}, 1_000)
const capture = option("--capture")
const orphanPidFile = option("--orphan-pid-file")
const launchLog = option("--launch-log")
if (launchLog) {
  await appendFile(
    launchLog,
    `${JSON.stringify({ pid: process.pid, cwd: process.cwd() })}\n`,
  )
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function readMetadata(file, parseJson = false) {
  if (!file) return null
  try {
    const text = await readFile(file, "utf8")
    return {
      mode: (await stat(file)).mode & 0o777,
      text,
      ...(parseJson ? { json: JSON.parse(text) } : {}),
    }
  } catch {
    return null
  }
}

let stdin = ""
for await (const chunk of process.stdin) stdin += chunk.toString()

if (mode === "orphan-child" && orphanPidFile) {
  const orphan = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  )
  await writeFile(orphanPidFile, String(orphan.pid))
  orphan.unref()
}

const settingsPath = option("--settings")
const mcpPath = option("--mcp-config")
const systemPromptPath = option("--system-prompt-file")
if (capture) {
  await writeFile(
    capture,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      workspaceEntries: await readdir(process.cwd()),
      environmentKeys: Object.keys(process.env).sort(),
      environmentContainsSchemaMarker: Object.values(process.env).some(
        (value) => value?.includes("SCHEMA_ARGV_MARKER"),
      ),
      apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      home: process.env.HOME,
      configDirectory: process.env.CLAUDE_CONFIG_DIR,
      temporaryDirectories: {
        TMPDIR: process.env.TMPDIR,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
      },
      temporaryEntries: await readdir(process.env.TMPDIR),
      stdin,
      settings: await readMetadata(settingsPath, true),
      mcp: await readMetadata(mcpPath, true),
      systemPrompt: await readMetadata(systemPromptPath),
    }),
  )
}

const sessionId = "fixture-session"
const base = { session_id: sessionId }
const init = {
  type: "system",
  subtype: "init",
  ...base,
  apiKeySource:
    mode === "api-key-source-mismatch" ? "oauth_token" : "ANTHROPIC_API_KEY",
  claude_code_version:
    mode === "version-announcement-mismatch" ? "2.1.215" : fixtureVersion,
  cwd: process.cwd(),
  tools: mode === "policy-mismatch" ? ["Read"] : [],
  mcp_servers: mode === "mcp-mismatch" ? [{ name: "fixture" }] : [],
  plugins: mode === "plugins-mismatch" ? [{ name: "fixture" }] : [],
  skills: mode === "skills-mismatch" ? ["fixture"] : [],
  slash_commands: mode === "commands-mismatch" ? ["help"] : [],
  permissionMode:
    mode === "permission-mismatch" ? "bypassPermissions" : option("--permission-mode"),
  capabilities: [],
  model: "fixture-model",
}

if (mode === "malformed") {
  process.stdout.write("not-json\n")
  await new Promise(() => {})
}

if (mode !== "missing-init") emit(init)

if (
  mode === "hang" ||
  [
    "policy-mismatch",
    "mcp-mismatch",
    "plugins-mismatch",
    "skills-mismatch",
    "commands-mismatch",
    "permission-mismatch",
    "version-announcement-mismatch",
    "api-key-source-mismatch",
  ].includes(mode)
) {
  await new Promise(() => {})
}
if (mode === "stderr-oversize") {
  process.stderr.write("x".repeat(300 * 1024))
  await new Promise(() => {})
}
if (mode === "stdout-oversize") {
  process.stdout.write("x".repeat(5 * 1024 * 1024))
  await new Promise(() => {})
}
if (mode === "tool-use") {
  emit({
    type: "assistant",
    ...base,
    parent_tool_use_id: null,
    uuid: "tool-message",
    message: {
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "Read",
          input: { file_path: "/etc/passwd" },
        },
      ],
    },
  })
  await new Promise(() => {})
}
if (mode === "unknown-block-start") {
  emit({
    type: "stream_event",
    ...base,
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      content_block: { type: "computer_use", id: "computer-1" },
    },
  })
  await new Promise(() => {})
}
if (mode === "unsafe-message-start") {
  emit({
    type: "stream_event",
    ...base,
    parent_tool_use_id: null,
    event: {
      type: "message_start",
      message: {
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", name: "Read" }],
      },
    },
  })
  await new Promise(() => {})
}

const answer =
  mode === "secret-output"
    ? `credential=${process.env.ANTHROPIC_API_KEY}`
    : mode === "generic-redaction-output"
    ? "token=fixture-public-nonsecret"
    : "fixture answer"
const structuredOutput =
  mode === "secret-key-output"
    ? { [process.env.ANTHROPIC_API_KEY]: "hidden" }
    : mode === "invalid-output"
    ? { answer: 42 }
    : {
        answer,
        status: "answered",
        citations: [{ label: "Approved", uri: "knowledge/README.md" }],
      }
emit({
  type: "stream_event",
  ...base,
  parent_tool_use_id: null,
  event: {
    type: "content_block_delta",
    delta: { type: "text_delta", text: answer },
  },
})
emit({
  type: "assistant",
  ...base,
  parent_tool_use_id: null,
  uuid: "assistant-message",
  message: { content: [{ type: "text", text: answer }] },
})

if (mode === "missing-result") process.exit(0)

const result = {
  type: "result",
  ...base,
  subtype: mode === "result-error" ? "error_during_execution" : "success",
  is_error: mode === "result-error",
  result:
    mode === "invalid-json"
      ? `\`\`\`json\n${JSON.stringify(structuredOutput)}\n\`\`\``
      : JSON.stringify(structuredOutput),
  ...(mode === "missing-structured"
    ? {}
    : { structured_output: structuredOutput }),
  usage:
    mode === "invalid-usage"
      ? { input_tokens: -1, output_tokens: 5 }
      : { input_tokens: 10, output_tokens: 5 },
  total_cost_usd: 0.0125,
}

if (mode === "session-mismatch") result.session_id = "different-session"
emit(result)
if (mode === "duplicate-result") emit(result)
if (mode === "event-after-result") {
  emit({
    type: "stream_event",
    ...base,
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "late" },
    },
  })
}
process.exit(mode === "nonzero" ? 2 : 0)
