#!/usr/bin/env node

import { appendFile, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"

const args = process.argv.slice(2)
const fixtureVersion = "1.1.12"

function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

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
      environmentContainsSchemaMarker: Object.values(process.env).some(
        (value) => value?.includes("SCHEMA_ARGV_MARKER"),
      ),
      inputLines,
    }),
  )
}

async function readCredential() {
  const authPayloadPath = process.env.QODER_SDK_AUTH_PAYLOAD_FILE
  const payload = JSON.parse(await readFile(authPayloadPath, "utf8"))
  if (typeof payload.accessToken !== "string" || !payload.accessToken) {
    throw new Error("fixture credential missing")
  }
  return payload.accessToken
}

const init = {
  type: "system",
  subtype: "init",
  session_id: sessionId,
  qodercli_version: fixtureVersion,
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
  if (mode === "hang" || mode === "buffered-hang") {
    if (mode === "buffered-hang") {
      emit({
        type: "stream_event",
        session_id: sessionId,
        event: {
          delta: { type: "text_delta", text: "buffered-output-must-not-flush" },
        },
      })
      emit({
        type: "assistant",
        session_id: sessionId,
        message: {
          content: [
            {
              type: "tool_use",
              id: "buffer-observed-before-cancel",
              name: "Read",
              input: { file_path: "knowledge/README.md" },
            },
          ],
        },
      })
    }
    // An unresolved top-level await does not keep Node alive by itself. Hold a
    // referenced timer so only the Adapter's deadline/cancel path ends it.
    await new Promise(() => {
      setInterval(() => {}, 1_000)
    })
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

  const credential = mode.includes("credential")
    ? await readCredential()
    : undefined
  const toolUseId = mode === "tool-id-credential" ? credential : "tool-1"
  const toolInput =
    mode === "tool-input-credential"
      ? { note: credential }
      : mode === "tool-key-credential"
        ? { [`${"x".repeat(250)}${credential}`]: "unsafe" }
        : { file_path: "knowledge/README.md" }

  emit({
    type: "assistant",
    session_id: sessionId,
    message: {
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Read",
          input: toolInput,
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
          tool_use_id: toolUseId,
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
  } else if (mode === "snapshot-split-credential") {
    emit({
      type: "assistant",
      session_id: sessionId,
      message: { content: [{ type: "text", text: "api_key=" }] },
    })
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "text", text: `api_key=${credential}` }],
      },
    })
  } else if (
    mode === "stream-split-credential" ||
    mode === "stream-credential-result-error"
  ) {
    for (const text of ["Bearer ", credential]) {
      emit({
        type: "stream_event",
        session_id: sessionId,
        event: { delta: { type: "text_delta", text } },
      })
    }
  } else if (mode === "stream-bare-credential") {
    emit({
      type: "stream_event",
      session_id: sessionId,
      event: { delta: { type: "text_delta", text: credential } },
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
  const outputValue = {
    status: "answered",
    answer:
      mode === "output-value-credential"
        ? credential
        : mode === "schema-mismatch"
          ? 42
          : "fixture answer",
    citations: [{ label: "Approved", uri: "knowledge/README.md" }],
    ...(mode === "schema-extra-field" ? { unexpected: true } : {}),
    ...(mode === "output-key-credential" ? { [credential]: "unsafe" } : {}),
  }
  const output = JSON.stringify(outputValue)
  const resultError =
    mode === "result-error" || mode === "stream-credential-result-error"
  const result = {
    type: "result",
    session_id: sessionId,
    subtype: resultError ? "error_during_execution" : "success",
    is_error: resultError,
    result:
      mode === "invalid-output"
        ? `\`\`\`json\n${output}\n\`\`\``
        : mode === "prose-output"
          ? `Result: ${output}`
          : mode === "truncated-output"
            ? output.slice(0, -1)
            : mode === "malformed-output"
              ? "{not-json}"
              : mode === "unstructured-prose"
                ? "plain fixture answer"
                : output,
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
