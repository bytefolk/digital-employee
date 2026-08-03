#!/usr/bin/env node

import { appendFile, readdir, writeFile } from "node:fs/promises"

const args = process.argv.slice(2)

function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const fixtureVersion = option("--fixture-version") || "0.17.1"
if (args.includes("--version")) {
  process.stdout.write(`${fixtureVersion}\n`)
  process.exit(0)
}

const mode = option("--fixture-mode") || "success"
const capture = option("--capture")
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

async function directoryEntries(value) {
  try {
    return await readdir(value)
  } catch {
    return null
  }
}

let stdin = ""
for await (const chunk of process.stdin) stdin += chunk.toString()

if (capture) {
  const isolatedDirectories = Object.fromEntries(
    await Promise.all(
      [
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "QWEN_HOME",
        "QWEN_RUNTIME_DIR",
        "TMPDIR",
        "TMP",
        "TEMP",
      ].map(async (name) => [name, await directoryEntries(process.env[name])]),
    ),
  )
  await writeFile(
    capture,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      workspaceEntries: await readdir(process.cwd()),
      environmentKeys: Object.keys(process.env).sort(),
      apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL,
      baseUrl: process.env.OPENAI_BASE_URL,
      home: process.env.HOME,
      xdgConfig: process.env.XDG_CONFIG_HOME,
      xdgCache: process.env.XDG_CACHE_HOME,
      xdgData: process.env.XDG_DATA_HOME,
      qwenHome: process.env.QWEN_HOME,
      qwenRuntime: process.env.QWEN_RUNTIME_DIR,
      temporaryDirectories: {
        TMPDIR: process.env.TMPDIR,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
      },
      isolatedDirectories,
      stdin,
      literalAtPath: stdin.includes("@/etc/passwd"),
    }),
  )
}

const sessionId = option("--session-id")
const model = option("--model")
const base = { session_id: sessionId }
const expectedAgents = ["general-purpose", "Explore", "statusline-setup"]
const init = {
  type: "system",
  subtype: "init",
  uuid: sessionId,
  ...base,
  cwd: process.cwd(),
  tools: mode === "tools-mismatch" ? ["read_file"] : [],
  mcp_servers: mode === "mcp-mismatch" ? [{ name: "fixture" }] : [],
  model: mode === "model-mismatch" ? "different-model" : model,
  permission_mode:
    mode === "permission-mismatch" ? "yolo" : option("--approval-mode"),
  slash_commands: mode === "commands-mismatch" ? ["help"] : [],
  qwen_code_version:
    mode === "version-mismatch" ? "0.17.2" : fixtureVersion,
  agents:
    mode === "agents-mismatch"
      ? [...expectedAgents, "local-extension"]
      : expectedAgents,
}

if (mode === "malformed") {
  process.stdout.write("not-json\n")
  await new Promise(() => {})
}

if (mode !== "missing-init") emit(init)
if (mode === "duplicate-init") emit(init)

if (
  mode === "hang" ||
  [
    "tools-mismatch",
    "mcp-mismatch",
    "commands-mismatch",
    "agents-mismatch",
    "permission-mismatch",
    "version-mismatch",
    "model-mismatch",
    "duplicate-init",
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
    type: "stream_event",
    uuid: "tool-partial",
    ...base,
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tool-1",
        name: "read_file",
        input: {},
      },
    },
  })
  await new Promise(() => {})
}

if (mode === "tool-progress") {
  emit({
    type: "stream_event",
    uuid: "tool-progress",
    ...base,
    parent_tool_use_id: null,
    event: { type: "tool_progress", tool_use_id: "tool-1", content: "busy" },
  })
  await new Promise(() => {})
}

if (mode === "subagent") {
  emit({
    type: "stream_event",
    uuid: "subagent-partial",
    ...base,
    parent_tool_use_id: "tool-1",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "subagent text" },
    },
  })
  await new Promise(() => {})
}

const eventSession = mode === "session-mismatch" ? "different-session" : sessionId
const answer =
  mode === "secret-output"
    ? `credential=${process.env.OPENAI_API_KEY}`
    : "fixture answer"
const structuredOutput =
  mode === "secret-key-output"
    ? { [process.env.OPENAI_API_KEY]: "hidden" }
    : mode === "invalid-output"
    ? { answer: 42 }
    : {
        answer,
        status: "answered",
        citations: [{ label: "Approved", uri: "knowledge/README.md" }],
      }

emit({
  type: "stream_event",
  uuid: "message-start",
  session_id: eventSession,
  parent_tool_use_id: null,
  event: {
    type: "message_start",
    message: {
      id: "assistant-message",
      role: "assistant",
      model,
      content: [],
    },
  },
})
emit({
  type: "stream_event",
  uuid: "block-start",
  session_id: eventSession,
  parent_tool_use_id: null,
  event: {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
})
emit({
  type: "stream_event",
  uuid: "text-delta",
  session_id: eventSession,
  parent_tool_use_id: null,
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: answer },
  },
})
emit({
  type: "stream_event",
  uuid: "block-stop",
  session_id: eventSession,
  parent_tool_use_id: null,
  event: { type: "content_block_stop", index: 0 },
})
emit({
  type: "assistant",
  uuid: "assistant-message",
  session_id: eventSession,
  parent_tool_use_id: null,
  message: {
    id: "assistant-message",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: answer }],
    stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  },
})
emit({
  type: "stream_event",
  uuid: "message-stop",
  session_id: eventSession,
  parent_tool_use_id: null,
  event: { type: "message_stop" },
})

if (mode === "missing-result") process.exit(0)

const result = {
  type: "result",
  subtype: mode === "result-error" ? "error_during_execution" : "success",
  uuid: "result-message",
  session_id: eventSession,
  is_error: mode === "result-error",
  duration_ms: 20,
  duration_api_ms: 10,
  num_turns: 1,
  result:
    mode === "invalid-json"
      ? `\`\`\`json\n${JSON.stringify(structuredOutput)}\n\`\`\``
      : JSON.stringify(structuredOutput),
  usage:
    mode === "invalid-usage"
      ? { input_tokens: -1, output_tokens: 5, total_tokens: 4 }
      : { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  permission_denials:
    mode === "permission-denial"
      ? [{ tool_name: "read_file", tool_use_id: "tool-1", tool_input: {} }]
      : [],
}

emit(result)
if (mode === "duplicate-result") emit(result)
if (mode === "event-after-result") {
  emit({
    type: "stream_event",
    uuid: "late-event",
    ...base,
    parent_tool_use_id: null,
    event: { type: "message_stop" },
  })
}
process.exit(mode === "nonzero" ? 2 : 0)
