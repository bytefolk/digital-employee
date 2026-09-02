import assert from "node:assert/strict"
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  createQoderAgentHostAdapter,
} from "../../apps/cli/qoder-agent-host.js"
import type {
  QoderAgentHostAdapterOptions,
} from "../../apps/cli/qoder-agent-host.js"
import {
  createEmployeePackage,
  inspectEmployeePackage,
} from "../../apps/cli/employee-package.js"
import { deriveEffectiveAgentHostPolicy } from "../../packages/core/index.js"
import type {
  AgentHostEvent,
  AgentHostRunRequest,
  SafeValue,
} from "../../packages/core/index.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const fixture = path.join(root, "tests", "apps", "fixtures", "fake-qoder.mjs")

async function employeeRequest(
  parent: string,
  runId = "run-fixture",
): Promise<AgentHostRunRequest> {
  const employeeDirectory = path.join(parent, "team-answer")
  await createEmployeePackage(employeeDirectory)
  const inspection = await inspectEmployeePackage(employeeDirectory)
  return {
    runId,
    employeeId: inspection.manifest.name,
    workingDirectory: inspection.directory,
    workspaceFiles: inspection.manifest.assets,
    prompt: "Complete the task: fixture question",
    instructions: inspection.artifacts.skill,
    session: { mode: "new" },
    outputSchema: inspection.artifacts.outputSchema as SafeValue,
    policy: deriveEffectiveAgentHostPolicy(inspection.manifest),
  }
}

function adapter(
  parent: string,
  mode = "success",
  capture?: string,
  timeoutMs = 30_000,
  options: QoderAgentHostAdapterOptions & { fixtureArgs?: string[] } = {},
) {
  const { fixtureArgs = [], ...adapterOptions } = options
  return createQoderAgentHostAdapter({
    command: process.execPath,
    commandPrefixArgs: [
      fixture,
      "--fixture-mode",
      mode,
      ...(capture ? ["--capture", capture] : []),
      ...fixtureArgs,
    ],
    environment: {
      PATH: process.env.PATH,
      QODER_PERSONAL_ACCESS_TOKEN: "fixture-service-token",
      SECRET_SHOULD_NOT_PASS: "private-value",
      NODE_OPTIONS: "--trace-warnings",
    },
    temporaryRoot: parent,
    timeoutMs,
    versionExecutor: async () => ({ status: "installed", output: "1.1.12" }),
    ...adapterOptions,
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function collect(
  iterable: AsyncIterable<AgentHostEvent>,
): Promise<AgentHostEvent[]> {
  const events: AgentHostEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

function terminalEvents(events: AgentHostEvent[]) {
  return events.filter(
    (event) => event.type === "run.completed" || event.type === "run.failed",
  )
}

test("Qoder probe reports only the fixture-verified stateless capabilities", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-probe-"))
  const versionCalls: Array<{ command: string; args: string[] }> = []
  const probe = await adapter(parent, "success", undefined, 30_000, {
    versionExecutor: async (command, args) => {
      versionCalls.push({ command, args })
      return { status: "installed", output: "1.1.12" }
    },
  }).probe()

  assert.deepEqual(versionCalls, [
    {
      command: process.execPath,
      args: [fixture, "--fixture-mode", "success", "--version"],
    },
  ])
  assert.equal(probe.status, "ready")
  assert.equal(probe.version, "1.1.12")
  assert.equal(probe.adapterStatus, "runnable")
  assert.equal(probe.capabilitySource, "conformance_test")
  assert.equal(probe.capabilities.tool_allowlist, "supported")
  assert.equal(probe.capabilities.filesystem_scope, "supported")
  assert.equal(probe.capabilities.network_policy, "supported")
  assert.equal(probe.capabilities.structured_output, "supported")
  assert.equal(probe.capabilities.mcp, "unsupported")
  assert.equal(probe.capabilities.usage_events, "unknown")
  const disclosure = probe.issues.find(
    (entry) => entry.code === "qoder_handshake_verified_by_conformance_only",
  )
  assert.equal(typeof disclosure?.message, "string")
  assert.equal(disclosure?.blocking, false)
})

test("Qoder probe accepts only stable three-segment 1.1.x versions", async () => {
  for (const [version, accepted] of [
    ["1.1.0", true],
    ["1.1.12", true],
    ["Qoder CLI version 1.1.999 (stable)\n", true],
    ["Qoder CLI [1.1.12]", true],
    ["1.1.12-beta.1", false],
    ["1.1.12+build.1", false],
    ["1.1.12.1", false],
    ["1.1.12rc1", false],
    ["v1.1.12", false],
    ["1.1.012", false],
    ["1.2.0", false],
    ["2.1.0", false],
  ] as const) {
    const host = createQoderAgentHostAdapter({
      command: process.execPath,
      environment: {
        PATH: process.env.PATH,
        QODER_PERSONAL_ACCESS_TOKEN: "fixture-service-token",
      },
      versionExecutor: async () => ({ status: "installed", output: version }),
    })
    const probe = await host.probe()
    const versionRejected = probe.issues.some(
      (entry) => entry.code === "qoder_version_not_conformance_verified",
    )

    assert.equal(versionRejected, !accepted, version)
    if (!accepted) assert.equal(probe.status, "not_ready", version)
  }
})

test("Qoder run uses an isolated projection, filtered environment, and normalized events", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-success-"))
  const capture = path.join(parent, "capture.json")
  const sentinel = path.join(parent, "must-not-exist")
  const request = await employeeRequest(parent)
  request.prompt = `--yolo; touch ${sentinel}; $(touch ${sentinel})`
  const schemaMarker = "SCHEMA_ARGV_MARKER"
  assert.equal(
    typeof request.outputSchema === "object" && request.outputSchema !== null,
    true,
  )
  request.outputSchema = {
    ...(request.outputSchema as Record<string, SafeValue>),
    $comment: schemaMarker,
  }

  const events = await collect(adapter(parent, "success", capture).run(request))
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.started",
      "tool.started",
      "tool.completed",
      "assistant.delta",
      "run.completed",
    ],
  )
  assert.equal(terminalEvents(events).length, 1)
  assert.equal(events.at(-1)?.type, "run.completed")
  const terminal = events.at(-1)
  assert.equal(
    terminal?.type === "run.completed" &&
      typeof terminal.output === "object" &&
      terminal.output !== null &&
      !Array.isArray(terminal.output) &&
      terminal.output.answer,
    "fixture answer",
  )

  const captured = JSON.parse(await readFile(capture, "utf8"))
  assert.notEqual(captured.cwd, request.workingDirectory)
  assert.match(captured.cwd, /digital-employee-qoder-/)
  assert.match(captured.projectedText, /Approved knowledge/)
  assert.equal(captured.projectedMode, 0o400)
  assert.equal(captured.environmentKeys.includes("QODER_PERSONAL_ACCESS_TOKEN"), false)
  assert.equal(captured.sdkEntrypoint, "sdk-ts")
  assert.equal(captured.sdkVersion, "1.0.16")
  assert.deepEqual(captured.authPayloadMetadata, {
    mode: 0o600,
    type: "accessToken",
    hasAccessToken: true,
  })
  assert.equal(captured.environmentKeys.includes("SECRET_SHOULD_NOT_PASS"), false)
  assert.equal(captured.environmentKeys.includes("NODE_OPTIONS"), false)
  assert.equal(captured.environmentContainsSchemaMarker, false)
  assert.equal(
    captured.args.some((value: string) => value.includes(schemaMarker)),
    false,
  )
  assert.equal(JSON.stringify(events).includes(schemaMarker), false)
  assert.equal(captured.args.includes("--dangerously-skip-permissions"), false)
  assert.equal(captured.args.includes("--yolo"), false)
  assert.equal(captured.args.includes("dont_ask"), true)
  assert.equal(captured.args.includes("stream-json"), true)
  assert.equal(captured.args.includes("--disable-builtin-skills"), true)
  assert.equal(captured.args.includes("--allowed-tools"), false)
  assert.equal(captured.args.includes("--input-format"), true)
  assert.equal(captured.args.includes("--append-system-prompt"), false)
  assert.equal(
    captured.args.some((value: string) => value.includes("--yolo; touch")),
    false,
  )
  assert.equal(captured.inputLines.length, 2)
  const initialize = JSON.parse(captured.inputLines[0])
  assert.equal(initialize.request.type, "initialize")
  assert.match(initialize.request.appendSystemPrompt, /# team-answer/)
  const user = JSON.parse(captured.inputLines[1])
  assert.equal(user.type, "user")
  assert.match(user.message.content[0].text, /--yolo; touch/)
  assert.match(user.message.content[0].text, /SCHEMA_ARGV_MARKER/)
  await assert.rejects(access(sentinel))
  assert.equal(
    (await readdir(parent)).some((entry) =>
      entry.startsWith("digital-employee-qoder-"),
    ),
    false,
  )
})

test("Qoder maps native tools directly and rejects decoupled file policy", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-tool-allowlist-"))
  const capture = path.join(parent, "capture.json")
  const request = await employeeRequest(parent, "run-tool-allowlist")
  request.policy.tools.allow = [
    { name: "filesystem.read", mode: "read" },
  ]

  const events = await collect(adapter(parent, "success", capture).run(request))
  assert.equal(events.at(-1)?.type, "run.completed")

  const captured = JSON.parse(await readFile(capture, "utf8"))
  const toolsIndex = captured.args.indexOf("--tools")
  assert.notEqual(toolsIndex, -1)
  assert.equal(captured.args[toolsIndex + 1], "Read")

  for (const mismatch of ["grant-only", "tool-only"] as const) {
    const mismatchParent = await mkdtemp(
      path.join(os.tmpdir(), `qoder-tool-${mismatch}-`),
    )
    const mismatchRequest = await employeeRequest(
      mismatchParent,
      `run-tool-${mismatch}`,
    )
    if (mismatch === "grant-only") {
      mismatchRequest.policy.tools.allow = []
    } else {
      mismatchRequest.policy.filesystem.read = []
    }
    const preflight = await adapter(mismatchParent).preflight(mismatchRequest)
    assert.equal(preflight.status, "not_ready")
    assert.equal(
      preflight.issues.some(
        (issue) => issue.code === "qoder_filesystem_tool_policy_mismatch",
      ),
      true,
    )
  }
})

test("Qoder redacts both native stream and assistant snapshot deltas", async () => {
  for (const [mode, expected] of [
    ["stream-redaction", "Bearer [REDACTED]"],
    ["assistant-snapshot-redaction", "api_key=[REDACTED]"],
  ] as const) {
    const parent = await mkdtemp(path.join(os.tmpdir(), `qoder-${mode}-`))
    const request = await employeeRequest(parent, `run-${mode}`)
    const events = await collect(adapter(parent, mode).run(request))
    const deltas = events.filter(
      (event): event is Extract<AgentHostEvent, { type: "assistant.delta" }> =>
        event.type === "assistant.delta",
    )

    assert.equal(events.at(-1)?.type, "run.completed")
    assert.deepEqual(deltas.map((event) => event.text), [expected])
    assert.equal(JSON.stringify(events).includes("fixture-secret"), false)
  }
})

test("Qoder buffers and scrubs the actual credential across stream boundaries", async () => {
  for (const [mode, expected] of [
    ["stream-split-credential", "Bearer [REDACTED]"],
    ["snapshot-split-credential", "api_key=[REDACTED]"],
    ["stream-bare-credential", "[REDACTED]"],
  ] as const) {
    const parent = await mkdtemp(path.join(os.tmpdir(), `qoder-${mode}-`))
    const request = await employeeRequest(parent, `run-${mode}`)
    const events = await collect(adapter(parent, mode).run(request))
    const deltas = events.filter(
      (event): event is Extract<AgentHostEvent, { type: "assistant.delta" }> =>
        event.type === "assistant.delta",
    )

    assert.equal(events.at(-1)?.type, "run.completed")
    assert.deepEqual(deltas.map((event) => event.text), [expected])
    assert.equal(JSON.stringify(events).includes("fixture-service-token"), false)
  }
})

test("Qoder scrubs credentials from tool input and rejects sensitive keys and ids", async () => {
  const inputParent = await mkdtemp(
    path.join(os.tmpdir(), "qoder-tool-input-credential-"),
  )
  const inputRequest = await employeeRequest(
    inputParent,
    "run-tool-input-credential",
  )
  const inputEvents = await collect(
    adapter(inputParent, "tool-input-credential").run(inputRequest),
  )
  const toolStarted = inputEvents.find((event) => event.type === "tool.started")

  assert.equal(inputEvents.at(-1)?.type, "run.completed")
  assert.deepEqual(
    toolStarted?.type === "tool.started" && toolStarted.input,
    { note: "[REDACTED]" },
  )
  assert.equal(
    JSON.stringify(inputEvents).includes("fixture-service-token"),
    false,
  )

  const idParent = await mkdtemp(
    path.join(os.tmpdir(), "qoder-tool-id-credential-"),
  )
  const idRequest = await employeeRequest(idParent, "run-tool-id-credential")
  const idEvents = await collect(
    adapter(idParent, "tool-id-credential").run(idRequest),
  )
  const idTerminal = idEvents.at(-1)

  assert.equal(idTerminal?.type, "run.failed")
  assert.equal(
    idTerminal?.type === "run.failed" && idTerminal.error.code,
    "qoder_sensitive_tool_call_id_denied",
  )
  assert.equal(JSON.stringify(idEvents).includes("fixture-service-token"), false)

  const keyParent = await mkdtemp(
    path.join(os.tmpdir(), "qoder-tool-key-credential-"),
  )
  const keyRequest = await employeeRequest(keyParent, "run-tool-key-credential")
  const keyEvents = await collect(
    adapter(keyParent, "tool-key-credential").run(keyRequest),
  )
  const keyTerminal = keyEvents.at(-1)

  assert.equal(keyTerminal?.type, "run.failed")
  assert.equal(
    keyTerminal?.type === "run.failed" && keyTerminal.error.code,
    "qoder_tool_input_sensitive_key_denied",
  )
  assert.equal(JSON.stringify(keyEvents).includes("fixture-service-token"), false)
})

test("Qoder scrubs complete host values before applying event size bounds", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "qoder-long-tool-input-credential-"),
  )
  const request = await employeeRequest(
    parent,
    "run-long-tool-input-credential",
  )
  const credential = `qoder-${"x".repeat(5_000)}-tail`
  const events = await collect(
    adapter(parent, "tool-input-credential", undefined, 30_000, {
      environment: {
        PATH: process.env.PATH,
        QODER_PERSONAL_ACCESS_TOKEN: credential,
      },
    }).run(request),
  )
  const toolStarted = events.find((event) => event.type === "tool.started")
  const serialized = JSON.stringify(events)

  assert.equal(events.at(-1)?.type, "run.completed")
  assert.deepEqual(
    toolStarted?.type === "tool.started" && toolStarted.input,
    { note: "[REDACTED]" },
  )
  assert.equal(serialized.includes(credential), false)
  assert.equal(serialized.includes(credential.slice(0, 4_096)), false)
})

test("Qoder does not confuse the actual credential with its redaction marker", async () => {
  const credential = "[REDACTED]"
  for (const [mode, expectedTerminal, expectedCode] of [
    ["stream-bare-credential", "run.completed", undefined],
    [
      "output-value-credential",
      "run.failed",
      "qoder_output_sensitive_value_denied",
    ],
  ] as const) {
    const parent = await mkdtemp(path.join(os.tmpdir(), `qoder-marker-${mode}-`))
    const request = await employeeRequest(parent, `run-marker-${mode}`)
    const events = await collect(
      adapter(parent, mode, undefined, 30_000, {
        environment: {
          PATH: process.env.PATH,
          QODER_PERSONAL_ACCESS_TOKEN: credential,
        },
      }).run(request),
    )
    const terminal = events.at(-1)

    assert.equal(terminal?.type, expectedTerminal)
    if (expectedCode) {
      assert.equal(
        terminal?.type === "run.failed" && terminal.error.code,
        expectedCode,
      )
    }
    assert.equal(JSON.stringify(events).includes(credential), false)
  }
})

test("Qoder fails closed when structured output contains its credential", async () => {
  for (const [mode, expectedCode] of [
    ["output-value-credential", "qoder_output_sensitive_value_denied"],
    ["output-key-credential", "qoder_output_sensitive_key_denied"],
  ] as const) {
    const parent = await mkdtemp(path.join(os.tmpdir(), `qoder-${mode}-`))
    const request = await employeeRequest(parent, `run-${mode}`)
    if (mode === "output-key-credential") {
      request.outputSchema = {
        type: "object",
        additionalProperties: true,
      }
    }
    const events = await collect(adapter(parent, mode).run(request))
    const terminal = events.at(-1)

    assert.equal(terminal?.type, "run.failed")
    assert.equal(
      terminal?.type === "run.failed" && terminal.error.code,
      expectedCode,
    )
    assert.equal(JSON.stringify(events).includes("fixture-service-token"), false)
  }

  const parent = await mkdtemp(
    path.join(os.tmpdir(), "qoder-unstructured-output-credential-"),
  )
  const request = await employeeRequest(
    parent,
    "run-unstructured-output-credential",
  )
  request.outputSchema = undefined
  const events = await collect(
    adapter(parent, "output-value-credential").run(request),
  )
  const terminal = events.at(-1)

  assert.equal(terminal?.type, "run.completed")
  assert.match(
    terminal?.type === "run.completed" && typeof terminal.output === "string"
      ? terminal.output
      : "",
    /\[REDACTED\]/,
  )
  assert.equal(JSON.stringify(events).includes("fixture-service-token"), false)
})

test("Qoder never flushes buffered credentials after a failed run", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "qoder-stream-credential-result-error-"),
  )
  const request = await employeeRequest(
    parent,
    "run-stream-credential-result-error",
  )
  const events = await collect(
    adapter(parent, "stream-credential-result-error").run(request),
  )
  const terminal = events.at(-1)

  assert.equal(events.some((event) => event.type === "assistant.delta"), false)
  assert.equal(terminal?.type, "run.failed")
  assert.equal(
    terminal?.type === "run.failed" && terminal.error.code,
    "qoder_execution_failed",
  )
  assert.equal(JSON.stringify(events).includes("fixture-service-token"), false)
})

for (const [mode, expectedCode] of [
  ["malformed", "qoder_stream_invalid_json"],
  ["policy-mismatch", "qoder_runtime_policy_mismatch"],
  ["protocol-missing", "qoder_runtime_policy_mismatch"],
  ["protocol-major-mismatch", "qoder_runtime_policy_mismatch"],
  ["plugins-missing", "qoder_runtime_policy_mismatch"],
  ["skills-missing", "qoder_runtime_policy_mismatch"],
  ["missing-result", "qoder_result_missing"],
  ["duplicate-result", "qoder_duplicate_result"],
  ["nonzero", "qoder_process_failed"],
  ["result-error", "qoder_execution_failed"],
  ["invalid-output", "qoder_output_not_json"],
  ["prose-output", "qoder_output_not_json"],
  ["truncated-output", "qoder_output_not_json"],
  ["malformed-output", "qoder_output_not_json"],
  ["schema-mismatch", "qoder_output_schema_mismatch"],
  ["schema-extra-field", "qoder_output_schema_mismatch"],
  ["stdout-oversize", "qoder_stdout_limit_exceeded"],
  ["stderr-oversize", "qoder_stderr_limit_exceeded"],
  ["duplicate-init-divergent", "qoder_duplicate_init"],
  ["auth-invalid", "qoder_access_token_invalid"],
  ["auth-payload-missing", "qoder_auth_payload_missing"],
  ["silent-exit", "qoder_no_response"],
] as const) {
  test(`Qoder ${mode} fixture fails closed with one terminal event`, async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), `qoder-${mode}-`))
    const request = await employeeRequest(parent, `run-${mode}`)
    const events = await collect(adapter(parent, mode).run(request))
    const terminals = terminalEvents(events)

    assert.equal(terminals.length, 1)
    assert.equal(events.at(-1), terminals[0])
    assert.equal(terminals[0]?.type, "run.failed")
    assert.equal(
      terminals[0]?.type === "run.failed" && terminals[0].error.code,
      expectedCode,
    )
    assert.equal(
      events.some((event) => event.type === "assistant.delta"),
      false,
    )
  })
}

test("Qoder tolerates an identical re-announced system/init (#241 live conformance)", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-dup-init-identical-"))
  const request = await employeeRequest(parent, "run-dup-init-identical")
  const events = await collect(
    adapter(parent, "duplicate-init-identical").run(request),
  )
  const terminals = terminalEvents(events)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]?.type, "run.completed")
})

test("Qoder repairs unescaped quotes inside model JSON strings", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-quote-repair-"))
  const request = await employeeRequest(parent, "run-unescaped-quotes")
  const events = await collect(
    adapter(parent, "unescaped-quotes").run(request),
  )
  const terminal = events.at(-1)

  assert.equal(terminal?.type, "run.completed")
  assert.equal(
    terminal?.type === "run.completed" &&
      typeof terminal.output === "object" &&
      terminal.output !== null &&
      !Array.isArray(terminal.output) &&
      terminal.output.answer,
    'fixture "quoted" answer',
  )
})

test("Qoder treats a false JSON Schema as present and fails closed", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-false-schema-"))
  const request = await employeeRequest(parent, "run-false-schema")
  request.outputSchema = false
  const events = await collect(adapter(parent).run(request))
  const terminal = events.at(-1)

  assert.equal(terminal?.type, "run.failed")
  assert.equal(
    terminal?.type === "run.failed" && terminal.error.code,
    "qoder_output_schema_mismatch",
  )
  assert.equal(events.some((event) => event.type === "assistant.delta"), false)
})

test("Qoder leaves unstructured output unchanged without outputSchema", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-unstructured-"))
  const request = await employeeRequest(parent, "run-unstructured")
  request.outputSchema = undefined
  const events = await collect(adapter(parent, "unstructured-prose").run(request))
  const terminal = events.at(-1)

  assert.equal(terminal?.type, "run.completed")
  assert.equal(
    terminal?.type === "run.completed" && terminal.output,
    "plain fixture answer",
  )
})

for (const [mode, expectedCode] of [
  ["protocol-buffered", "qoder_initialize_response_invalid"],
  ["assistant-partial-invalid", "qoder_runtime_tool_mismatch"],
] as const) {
  test(`Qoder ${mode} never emits partially trusted native events`, async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), `qoder-${mode}-`))
    const request = await employeeRequest(parent, `run-${mode}`)
    const events = await collect(adapter(parent, mode).run(request))

    assert.deepEqual(
      events.map((event) => event.type),
      ["run.started", "run.failed"],
    )
    const failed = events.at(-1)
    assert.equal(
      failed?.type === "run.failed" && failed.error.code,
      expectedCode,
    )
  })
}

test("Qoder completes a late-init handshake after the grace window submits the prompt", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-deferred-init-"))
  const request = await employeeRequest(parent, "run-deferred-init")
  const events = await collect(
    adapter(parent, "deferred-init", undefined, 30_000, {
      handshakeGraceMs: 100,
    }).run(request),
  )

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.started",
      "tool.started",
      "tool.completed",
      "assistant.delta",
      "run.completed",
    ],
  )
  assert.equal(events.at(-1)?.type, "run.completed")
})

test("Qoder releases credentials and the run reservation before its terminal event", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-terminal-cleanup-"))
  const request = await employeeRequest(parent, "run-terminal-cleanup")
  const host = adapter(parent)
  const iterator = host.run(request)[Symbol.asyncIterator]()

  let terminal: AgentHostEvent | undefined
  while (!terminal) {
    const next = await iterator.next()
    assert.equal(next.done, false)
    if (
      next.value.type === "run.completed" ||
      next.value.type === "run.failed"
    ) {
      terminal = next.value
    }
  }

  assert.equal(terminal.type, "run.completed")
  assert.equal(
    (await readdir(parent)).some((entry) =>
      entry.startsWith("digital-employee-qoder-"),
    ),
    false,
  )
  const reused = await collect(host.run(request))
  assert.equal(reused.at(-1)?.type, "run.completed")
  assert.equal((await iterator.next()).done, true)
})

test("Qoder deadline and explicit cancellation terminate a hanging run", async () => {
  const deadlineParent = await mkdtemp(path.join(os.tmpdir(), "qoder-deadline-"))
  const deadlineRequest = await employeeRequest(deadlineParent, "run-deadline")
  const deadlineEvents = await collect(
    adapter(deadlineParent, "hang", undefined, 40).run(deadlineRequest),
  )
  const deadlineTerminal = deadlineEvents.at(-1)
  assert.equal(deadlineTerminal?.type, "run.failed")
  assert.equal(
    deadlineTerminal?.type === "run.failed" && deadlineTerminal.error.code,
    "qoder_deadline_exceeded",
  )

  const cancelParent = await mkdtemp(path.join(os.tmpdir(), "qoder-cancel-"))
  const cancelRequest = await employeeRequest(cancelParent, "run-cancel")
  const cancelAdapter = adapter(cancelParent, "hang")
  const iterator = cancelAdapter.run(cancelRequest)[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.equal(first.value?.type, "run.started")
  await cancelAdapter.cancel(cancelRequest.runId)
  const remainder: AgentHostEvent[] = []
  for (;;) {
    const next = await iterator.next()
    if (next.done) break
    remainder.push(next.value)
  }
  assert.equal(remainder.length, 1)
  assert.equal(remainder[0]?.type, "run.failed")
  assert.equal(
    remainder[0]?.type === "run.failed" && remainder[0].error.code,
    "qoder_run_cancelled",
  )
})

test("Qoder never flushes buffered output on explicit cancellation", async () => {
  const cancelParent = await mkdtemp(
    path.join(os.tmpdir(), "qoder-buffered-cancel-"),
  )
  const cancelRequest = await employeeRequest(
    cancelParent,
    "run-buffered-cancel",
  )
  const host = adapter(cancelParent, "buffered-hang")
  const iterator = host.run(cancelRequest)[Symbol.asyncIterator]()
  const events: AgentHostEvent[] = []
  const started = await iterator.next()
  assert.equal(started.value?.type, "run.started")
  if (started.value) events.push(started.value)
  const bufferedTool = await iterator.next()
  assert.equal(bufferedTool.value?.type, "tool.started")
  if (bufferedTool.value) events.push(bufferedTool.value)
  await host.cancel(cancelRequest.runId)
  for (;;) {
    const next = await iterator.next()
    if (next.done) break
    events.push(next.value)
  }
  const cancelTerminal = events.at(-1)
  assert.equal(cancelTerminal?.type, "run.failed")
  assert.equal(
    cancelTerminal?.type === "run.failed" && cancelTerminal.error.code,
    "qoder_run_cancelled",
  )
  assert.equal(events.some((event) => event.type === "assistant.delta"), false)
  assert.equal(terminalEvents(events).length, 1)
})

test("Qoder preflight rejects write and missing service-token policies without a model run", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-preflight-"))
  const request = await employeeRequest(parent)
  request.policy.filesystem.write = ["./knowledge/out.md"]
  request.policy.tools.allow.push({ name: "filesystem.write", mode: "write" })
  const noToken = createQoderAgentHostAdapter({
    command: process.execPath,
    commandPrefixArgs: [fixture],
    environment: { PATH: process.env.PATH },
    temporaryRoot: parent,
  })
  const probe = await noToken.preflight(request)
  assert.equal(probe.status, "not_ready")
  assert.equal(
    probe.issues.some(
      (entry) => entry.code === "qoder_service_token_not_configured",
    ),
    true,
  )

  assert.equal(
    probe.issues.some(
      (entry) => entry.code === "qoder_tool_policy_unsupported",
    ),
    true,
  )
})

test("Qoder rejects invalid, oversized, and async Schema before any Qoder process", async () => {
  for (const [name, schema, expectedCode] of [
    [
      "invalid",
      { type: "definitely-not-a-json-schema-type" },
      "qoder_output_schema_invalid",
    ],
    [
      "oversized",
      { type: "object", $comment: "x".repeat(16 * 1024) },
      "qoder_output_schema_too_large",
    ],
    [
      "async",
      { $async: true, type: "object" },
      "qoder_output_schema_invalid",
    ],
  ] as const) {
    const parent = await mkdtemp(path.join(os.tmpdir(), `qoder-schema-${name}-`))
    const launchLog = path.join(parent, "launch.jsonl")
    const request = await employeeRequest(parent, `run-schema-${name}`)
    request.outputSchema = schema
    let beforeSpawnCalls = 0
    let beforeProjectionOpenCalls = 0
    let versionProbeCalls = 0
    const host = adapter(parent, "success", undefined, 10_000, {
      fixtureArgs: ["--launch-log", launchLog],
      versionExecutor: async () => {
        versionProbeCalls += 1
        return { status: "installed", output: "1.1.12" }
      },
      beforeSpawn: async () => {
        beforeSpawnCalls += 1
      },
      beforeProjectionOpen: async () => {
        beforeProjectionOpenCalls += 1
      },
    })

    const preflight = await host.preflight(request)
    assert.equal(preflight.status, "not_ready", name)
    assert.equal(
      preflight.issues.some((entry) => entry.code === expectedCode),
      true,
      name,
    )
    const events = await collect(host.run(request))
    const terminal = events.at(-1)
    assert.equal(terminal?.type, "run.failed", name)
    assert.equal(
      terminal?.type === "run.failed" && terminal.error.code,
      expectedCode,
      name,
    )
    assert.equal(beforeSpawnCalls, 0, name)
    assert.equal(beforeProjectionOpenCalls, 0, name)
    assert.equal(versionProbeCalls, 0, name)
    await assert.rejects(access(launchLog))
    assert.equal(
      (await readdir(parent)).some((entry) =>
        entry.startsWith("digital-employee-qoder-"),
      ),
      false,
      name,
    )
  }
})

test("Qoder reserves a run id before asynchronous preflight work", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-reservation-"))
  const request = await employeeRequest(parent, "run-reserved")
  const entered = deferred()
  const release = deferred()
  const host = adapter(parent, "hang", undefined, 10_000, {
    beforeSpawn: async () => {
      entered.resolve()
      await release.promise
    },
  })

  const firstIterator = host.run(request)[Symbol.asyncIterator]()
  const firstNext = firstIterator.next()
  await entered.promise
  const duplicate = await host.run(request)[Symbol.asyncIterator]().next()
  assert.equal(duplicate.value?.type, "run.failed")
  assert.equal(
    duplicate.value?.type === "run.failed" && duplicate.value.error.code,
    "qoder_run_already_active",
  )

  release.resolve()
  const first = await firstNext
  assert.equal(first.value?.type, "run.started")
  await host.cancel(request.runId)
  for (;;) {
    const next = await firstIterator.next()
    if (next.done) break
  }

  const reused = host.run(request)[Symbol.asyncIterator]()
  const reusedFirst = await reused.next()
  assert.equal(reusedFirst.value?.type, "run.started")
  await host.cancel(request.runId)
  for (;;) {
    const next = await reused.next()
    if (next.done) break
  }
})

test("Qoder cancellation during staging prevents process launch", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-pre-spawn-cancel-"))
  const launchLog = path.join(parent, "launch.jsonl")
  const request = await employeeRequest(parent, "run-pre-spawn-cancel")
  const entered = deferred()
  const release = deferred()
  const host = adapter(parent, "hang", undefined, 10_000, {
    fixtureArgs: ["--launch-log", launchLog],
    beforeSpawn: async () => {
      entered.resolve()
      await release.promise
    },
  })
  const iterator = host.run(request)[Symbol.asyncIterator]()
  const pending = iterator.next()
  await entered.promise
  await host.cancel(request.runId)
  release.resolve()

  const terminal = await pending
  assert.equal(terminal.value?.type, "run.failed")
  assert.equal(
    terminal.value?.type === "run.failed" && terminal.value.error.code,
    "qoder_run_cancelled",
  )
  assert.equal((await iterator.next()).done, true)
  await assert.rejects(access(launchLog))
})

test("Qoder detects inode and ctime changes before projecting package files", async (t) => {
  if (process.platform === "win32") return t.skip("inode semantics are POSIX-specific")

  for (const mutation of ["replace-inode", "rewrite-inode"] as const) {
    await t.test(mutation, async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), `qoder-${mutation}-`))
      const launchLog = path.join(parent, "launch.jsonl")
      const request = await employeeRequest(parent, `run-${mutation}`)
      const source = await realpath(
        path.join(request.workingDirectory, "knowledge", "README.md"),
      )
      const original = await readFile(source)
      let mutated = false
      const host = adapter(parent, "success", undefined, 10_000, {
        fixtureArgs: ["--launch-log", launchLog],
        beforeProjectionOpen: async (sourcePath) => {
          if (mutated || sourcePath !== source) return
          mutated = true
          if (mutation === "replace-inode") {
            await rename(source, `${source}.approved`)
            await writeFile(source, Buffer.alloc(original.byteLength, 120))
            return
          }
          const before = await lstat(source, { bigint: true })
          await writeFile(source, Buffer.alloc(original.byteLength, 121))
          const after = await lstat(source, { bigint: true })
          assert.equal(after.dev, before.dev)
          assert.equal(after.ino, before.ino)
          assert.notEqual(after.ctimeNs, before.ctimeNs)
        },
      })

      const events = await collect(host.run(request))
      const terminal = events.at(-1)
      assert.equal(terminal?.type, "run.failed")
      assert.equal(
        terminal?.type === "run.failed" && terminal.error.code,
        "qoder_projection_changed_during_copy",
      )
      await assert.rejects(access(launchLog))
      await rm(parent, { recursive: true, force: true })
    })
  }
})

test("Qoder iterator return releases the process and run reservation", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-iterator-return-"))
  const request = await employeeRequest(parent, "run-return")
  const host = adapter(parent, "hang")
  const iterator = host.run(request)[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value?.type, "run.started")
  await iterator.return?.()
  assert.equal(
    (await readdir(parent)).some((entry) =>
      entry.startsWith("digital-employee-qoder-"),
    ),
    false,
  )

  const reused = host.run(request)[Symbol.asyncIterator]()
  assert.equal((await reused.next()).value?.type, "run.started")
  await host.cancel(request.runId)
  for (;;) {
    const next = await reused.next()
    if (next.done) break
  }
})

test("Qoder cleanup failure replaces success with an explicit failed terminal", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-cleanup-failure-"))
  const request = await employeeRequest(parent, "run-cleanup-failure")
  let cleanupCalls = 0
  const host = adapter(parent, "stream-split-credential", undefined, 10_000, {
    removeRunRoot: async () => {
      cleanupCalls += 1
      throw Object.assign(new Error("fixture cleanup failure"), { code: "EACCES" })
    },
  })

  const events = await collect(host.run(request))
  assert.equal(cleanupCalls, 2)
  assert.equal(terminalEvents(events).length, 1)
  assert.equal(events.some((event) => event.type === "assistant.delta"), false)
  assert.equal(JSON.stringify(events).includes("fixture-service-token"), false)
  assert.equal(events.at(-1)?.type, "run.failed")
  const failed = events.at(-1)
  assert.equal(
    failed?.type === "run.failed" && failed.error.code,
    "qoder_cleanup_failed",
  )
  await rm(parent, { recursive: true, force: true })
})
