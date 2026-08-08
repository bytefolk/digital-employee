#!/usr/bin/env node

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

function variadicOption(name) {
  const index = args.indexOf(name)
  if (index < 0) return []
  const values = []
  for (let cursor = index + 1; cursor < args.length; cursor += 1) {
    if (args[cursor].startsWith("-")) break
    values.push(args[cursor])
  }
  return values
}

const fixtureVersion = option("--fixture-version") || "2.106.4"
if (args.includes("--version")) {
  process.stdout.write(`${fixtureVersion}\n`)
  process.exit(0)
}

const mode = option("--fixture-mode") || "success"
// A pending promise alone does not keep Node alive. Give the deadline fixture
// a real event-loop handle so it cannot race a natural exit with the adapter.
if (mode === "hang") setInterval(() => {}, 1_000)
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

async function entries(directory) {
  try {
    return await readdir(directory)
  } catch {
    return null
  }
}

async function metadata(file, parseJson = false) {
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

if (capture) {
  await writeFile(
    capture,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      workspaceEntries: await entries(process.cwd()),
      home: process.env.HOME,
      homeEntries: await entries(process.env.HOME),
      configDirectory: process.env.CODEBUDDY_CONFIG_DIR,
      configEntries: await entries(process.env.CODEBUDDY_CONFIG_DIR),
      workbuddyConfigDirectory: process.env.WORKBUDDY_CONFIG_DIR,
      temporaryDirectories: {
        TMPDIR: process.env.TMPDIR,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
      },
      temporaryEntries: await entries(process.env.TMPDIR),
      xdg: {
        config: process.env.XDG_CONFIG_HOME,
        configEntries: await entries(process.env.XDG_CONFIG_HOME),
        data: process.env.XDG_DATA_HOME,
        dataEntries: await entries(process.env.XDG_DATA_HOME),
        cache: process.env.XDG_CACHE_HOME,
        cacheEntries: await entries(process.env.XDG_CACHE_HOME),
        state: process.env.XDG_STATE_HOME,
        stateEntries: await entries(process.env.XDG_STATE_HOME),
        runtime: process.env.XDG_RUNTIME_DIR,
        runtimeEntries: await entries(process.env.XDG_RUNTIME_DIR),
      },
      environmentKeys: Object.keys(process.env).sort(),
      apiKeyConfigured: Boolean(process.env.CODEBUDDY_API_KEY),
      modelEnvironment: process.env.CODEBUDDY_MODEL,
      baseUrl: process.env.CODEBUDDY_BASE_URL,
      internetEnvironment: process.env.CODEBUDDY_INTERNET_ENVIRONMENT,
      isolationEnvironment: Object.fromEntries(
        [
          "CODEBUDDY_BASH_AUTO_BACKGROUND_DISABLED",
          "CODEBUDDY_CODE_DONT_INHERIT_ENV",
          "CODEBUDDY_DISABLE_AUTO_MEMORY",
          "CODEBUDDY_DISABLE_HOT_RELOAD",
          "CODEBUDDY_DISABLE_IDE",
          "CODEBUDDY_DISABLE_INPROCESS_TEAMMATES",
          "CODEBUDDY_DISABLE_MEMORY_CLEANUP",
          "CODEBUDDY_DISABLE_SHELL_SNAPSHOT",
          "CODEBUDDY_DISABLE_WEB_FETCH_REMOTE_API",
          "CODEBUDDY_GIT_REPO_SCAN_DISABLED",
          "CODEBUDDY_MEMORY_EXTRACTION_DISABLED",
          "CODEBUDDY_MEMORY_RELEVANCE_DISABLED",
          "CODEBUDDY_PROMPT_SUGGESTION_DISABLED",
          "CODEBUDDY_REMOTE_CONFIG_DISABLED",
          "CODEBUDDY_SKIP_BUILTIN_MARKETPLACE",
          "DISABLE_AUTOUPDATER",
          "DISABLE_GALILEO",
          "DISABLE_MEMORY_MANAGEMENT",
          "DISABLE_TELEMETRY",
        ].map((key) => [key, process.env[key]]),
      ),
      stdin,
      toolsValue: option("--tools"),
      disallowedTools: variadicOption("--disallowedTools"),
      settings: await metadata(option("--settings"), true),
      mcp: await metadata(option("--mcp-config"), true),
    }),
  )
}

const requestedSessionId = option("--session-id")
const sessionId =
  mode === "session-init-mismatch" ? "different-session" : requestedSessionId
const base = { session_id: sessionId }
const init = {
  type: "system",
  subtype: "init",
  uuid: "fixture-init",
  ...base,
  apiKeySource: "copilot.tencent.com",
  cwd: process.cwd(),
  tools: mode === "tool-mismatch" ? ["Read"] : [],
  mcp_servers: mode === "mcp-mismatch" ? [{ name: "fixture" }] : [],
  model: mode === "model-mismatch" ? "different-model" : option("--model"),
  permissionMode:
    mode === "permission-mismatch" ? "bypassPermissions" : option("--permission-mode"),
  slash_commands: ["help", "status"],
  output_style: "default",
}

if (mode === "malformed") {
  process.stdout.write("not-json\n")
  await new Promise(() => {})
}
if (mode !== "missing-init") emit(init)
if (
  [
    "tool-mismatch",
    "mcp-mismatch",
    "model-mismatch",
    "permission-mismatch",
    "session-init-mismatch",
  ].includes(mode)
) {
  await new Promise(() => {})
}

emit({
  type: "system",
  subtype: "status",
  status: mode === "unsafe-status" ? "busy" : null,
  uuid: "fixture-status",
  ...base,
})
emit({
  type: "file-history-snapshot",
  id: "fixture-snapshot",
  timestamp: Date.now(),
  isSnapshotUpdate: false,
  snapshot: {
    messageId: "fixture-message",
    trackedFileBackups:
      mode === "unsafe-snapshot" ? { "/tmp/file": "backup" } : {},
  },
})

if (mode === "hang") await new Promise(() => {})
if (mode === "stderr-oversize") {
  process.stderr.write("x".repeat(300 * 1024))
  await new Promise(() => {})
}
if (mode === "stdout-oversize") {
  process.stdout.write("x".repeat(5 * 1024 * 1024))
  await new Promise(() => {})
}
if (mode === "tool-event") {
  emit({
    type: "assistant",
    uuid: "fixture-tool-message",
    ...base,
    parent_tool_use_id: null,
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
if (mode === "unsafe-message-start") {
  emit({
    type: "stream_event",
    ...base,
    parent_tool_use_id: null,
    event: {
      type: "message_start",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Read" }],
      },
    },
  })
  await new Promise(() => {})
}
if (mode === "unknown-event") {
  emit({ type: "mystery", ...base })
  await new Promise(() => {})
}

const answer =
  mode === "secret-output"
    ? `credential=${process.env.CODEBUDDY_API_KEY}`
    : "fixture answer"
const structuredOutput =
  mode === "secret-key-output"
    ? { [process.env.CODEBUDDY_API_KEY]: "hidden" }
    : mode === "invalid-output"
    ? { answer: 42 }
    : {
        status: "answered",
        answer,
        citations: [{ label: "Approved", uri: "knowledge/README.md" }],
      }
const deltaTexts =
  mode === "secret-output"
    ? [answer.slice(0, Math.floor(answer.length / 2)), answer.slice(Math.floor(answer.length / 2))]
    : [answer]
for (const text of deltaTexts) {
  emit({
    type: "stream_event",
    ...base,
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text },
    },
  })
}
emit({
  type: "assistant",
  uuid: "fixture-assistant-message",
  ...base,
  parent_tool_use_id: null,
  message: { content: [{ type: "text", text: answer }] },
})

if (mode === "missing-result") process.exit(0)

const result = {
  type: "result",
  uuid: "fixture-result",
  ...base,
  subtype: mode === "result-error" ? "error_during_execution" : "success",
  is_error: mode === "result-error",
  result:
    mode === "invalid-json"
      ? `\`\`\`json\n${JSON.stringify(structuredOutput)}\n\`\`\``
      : JSON.stringify(structuredOutput),
  usage:
    mode === "invalid-usage"
      ? { input_tokens: -1, output_tokens: 7 }
      : { input_tokens: 11, output_tokens: 7 },
  total_cost_usd: 0.021,
}
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
