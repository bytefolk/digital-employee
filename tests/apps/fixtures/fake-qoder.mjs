#!/usr/bin/env node

import { appendFile, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"

const args = process.argv.slice(2)

function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

if (args.includes("--version")) {
  process.stdout.write("1.1.12\n")
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
const cwd = option("--cwd")
const permissionMode = option("--permission-mode")
const tools = (option("--tools") || "").split(",").filter(Boolean)
const sessionId = "fixture-session"
const inputLines = []

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function writeCapture() {
  if (!capture) return
  const projected = cwd ? path.join(cwd, "knowledge", "README.md") : ""
  const authPayloadPath = process.env.QODER_SDK_AUTH_PAYLOAD_FILE
  let projectedText
  let projectedMode
  let authPayloadMetadata = null
  try {
    projectedText = await readFile(projected, "utf8")
    projectedMode = (await stat(projected)).mode & 0o777
  } catch {
    projectedText = null
    projectedMode = null
  }
  try {
    const payload = JSON.parse(await readFile(authPayloadPath, "utf8"))
    authPayloadMetadata = {
      mode: (await stat(authPayloadPath)).mode & 0o777,
      type: payload.type,
      hasAccessToken:
        typeof payload.accessToken === "string" && payload.accessToken.length > 0,
    }
  } catch {
    authPayloadMetadata = null
  }
  await writeFile(
    capture,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      environmentKeys: Object.keys(process.env).sort(),
      projectedText,
      projectedMode,
      sdkEntrypoint: process.env.QODER_AGENT_SDK_ENTRYPOINT,
      sdkVersion: process.env.QODER_AGENT_SDK_VERSION,
      authPayloadMetadata,
      inputLines,
    }),
  )
}

const init = {
  type: "system",
  subtype: "init",
  session_id: sessionId,
  qodercli_version: "1.1.12",
  ...(mode === "protocol-missing"
    ? {}
    : {
        protocol_version:
          mode === "protocol-major-mismatch" ? "2.0.0" : "1.1.0",
      }),
  cwd,
  permissionMode,
  tools: mode === "policy-mismatch" ? [...tools, "Bash"] : tools,
  mcp_servers: [],
  ...(mode === "plugins-missing" ? {} : { plugins: [] }),
  ...(mode === "skills-missing" ? {} : { skills: [] }),
}

async function executeRun() {
  await writeCapture()
  if (mode === "hang") {
    await new Promise(() => {})
  } else if (mode === "stderr-oversize") {
    process.stderr.write("x".repeat(300 * 1024))
    await new Promise(() => {})
  } else if (mode === "stdout-oversize") {
    process.stdout.write("x".repeat(5 * 1024 * 1024))
    await new Promise(() => {})
  } else if (mode === "missing-result") {
    process.exit(0)
  } else if (mode === "assistant-partial-invalid") {
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-valid-before-invalid",
            name: "Read",
            input: { file_path: "knowledge/README.md" },
          },
          {
            type: "tool_use",
            id: "tool-invalid",
            name: "Bash",
            input: { command: "should-not-run" },
          },
        ],
      },
    })
    await new Promise(() => {})
  }

  emit({
    type: "assistant",
    session_id: sessionId,
    message: {
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "Read",
          input: { file_path: "knowledge/README.md" },
        },
      ],
    },
  })
  emit({
    type: "user",
    session_id: sessionId,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          is_error: false,
          content: "approved knowledge",
        },
      ],
    },
  })
  if (mode === "assistant-snapshot-redaction") {
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "text", text: "api_key=fixture-secret" }],
      },
    })
  } else {
    emit({
      type: "stream_event",
      session_id: sessionId,
      event: {
        delta: {
          type: "text_delta",
          text:
            mode === "stream-redaction"
              ? "Bearer fixture-secret"
              : "fixture answer",
        },
      },
    })
  }
  const output = JSON.stringify({
    status: "answered",
    answer: "fixture answer",
    citations: [{ label: "Approved", uri: "knowledge/README.md" }],
  })
  const result = {
    type: "result",
    session_id: sessionId,
    subtype: mode === "result-error" ? "error_during_execution" : "success",
    is_error: mode === "result-error",
    result: mode === "invalid-output" ? `\`\`\`json\n${output}\n\`\`\`` : output,
  }
  emit(result)
  if (mode === "duplicate-result") emit(result)
  process.exit(mode === "nonzero" ? 2 : 0)
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let initialized = false
for await (const line of lines) {
  if (!line.trim()) continue
  inputLines.push(line)
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.exit(2)
  }

  if (!initialized) {
    if (
      message.type !== "control_request" ||
      message.request?.type !== "initialize" ||
      typeof message.request_id !== "string"
    ) {
      process.exit(2)
    }
    if (mode === "malformed") {
      process.stdout.write("not-json\n")
      await new Promise(() => {})
    }
    if (mode === "protocol-buffered") {
      emit(init)
      emit({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "wrong-initialize-request",
          response: {},
        },
      })
      emit({
        type: "stream_event",
        session_id: sessionId,
        event: { delta: { type: "text_delta", text: "must-not-escape" } },
      })
      emit({
        type: "result",
        session_id: sessionId,
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          status: "answered",
          answer: "must-not-complete",
          citations: [],
        }),
      })
      await new Promise(() => {})
    }
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          commands: [],
          agents: [],
          skills: [],
          output_style: "default",
          available_output_styles: [],
          models: [],
          account: {},
        },
      },
    })
    emit(init)
    initialized = true
    if (
      [
        "policy-mismatch",
        "protocol-missing",
        "protocol-major-mismatch",
        "plugins-missing",
        "skills-missing",
      ].includes(mode)
    ) {
      await new Promise(() => {})
    }
    continue
  }

  if (message.type !== "user") process.exit(2)
  await executeRun()
}
