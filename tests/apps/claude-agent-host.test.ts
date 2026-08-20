import assert from "node:assert/strict"
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  createClaudeAgentHostAdapter,
  isSupportedClaudeVersion,
} from "../../apps/cli/claude-agent-host.js"
import type { ClaudeAgentHostAdapterOptions } from "../../apps/cli/claude-agent-host.js"
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
const fixture = path.join(root, "tests", "apps", "fixtures", "fake-claude.mjs")
const fixtureApiKey = "fixture-anthropic-api-key"
const fixtureVersion = "2.1.214 (Claude Code)"

async function fixtureVersionExecutor() {
  return { status: "installed" as const, output: fixtureVersion }
}

async function employeeRequest(
  parent: string,
  runId = "run-fixture",
): Promise<AgentHostRunRequest> {
  const employeeDirectory = path.join(parent, `employee-${runId}`)
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
  options: ClaudeAgentHostAdapterOptions & { fixtureArgs?: string[] } = {},
) {
  const { fixtureArgs = [], ...adapterOptions } = options
  return createClaudeAgentHostAdapter({
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
      ANTHROPIC_API_KEY: fixtureApiKey,
      SECRET_SHOULD_NOT_PASS: "private-value",
      NODE_OPTIONS: "--trace-warnings",
    },
    versionExecutor: fixtureVersionExecutor,
    temporaryRoot: parent,
    timeoutMs,
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

test("Claude version gate is exactly >=2.1.214 and <2.2.0", () => {
  assert.equal(isSupportedClaudeVersion("2.1.213 (Claude Code)"), false)
  assert.equal(isSupportedClaudeVersion("2.1.214 (Claude Code)"), true)
  assert.equal(isSupportedClaudeVersion("claude 2.1.999"), true)
  assert.equal(isSupportedClaudeVersion("Claude Code v2.1.214"), true)
  assert.equal(isSupportedClaudeVersion("2.1.214-beta.1"), false)
  assert.equal(isSupportedClaudeVersion("2.1.214+build.7"), false)
  assert.equal(isSupportedClaudeVersion("2.1.214.1"), false)
  assert.equal(isSupportedClaudeVersion("release.2.1.214"), false)
  assert.equal(isSupportedClaudeVersion("02.1.214"), false)
  assert.equal(isSupportedClaudeVersion("2.2.0 (Claude Code)"), false)
  assert.equal(isSupportedClaudeVersion("3.0.0"), false)
  assert.equal(isSupportedClaudeVersion("unknown"), false)
})

test("Claude probe reports only the conformance-tested zero-tool capabilities", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-probe-"))
  const versionCalls: Array<{ command: string; args: string[] }> = []
  const probe = await adapter(parent, "success", undefined, 30_000, {
    versionExecutor: async (command, args) => {
      versionCalls.push({ command, args })
      return fixtureVersionExecutor()
    },
  }).probe()

  assert.deepEqual(versionCalls, [
    {
      command: process.execPath,
      args: [fixture, "--fixture-mode", "success", "--version"],
    },
  ])
  assert.equal(probe.status, "ready")
  assert.equal(probe.version, fixtureVersion)
  assert.equal(probe.adapterStatus, "runnable")
  assert.equal(probe.capabilitySource, "conformance_test")
  assert.equal(probe.capabilities.structured_output, "supported")
  assert.equal(probe.capabilities.tool_allowlist, "supported")
  assert.equal(probe.capabilities.filesystem_scope, "supported")
  assert.equal(probe.capabilities.network_policy, "supported")
  assert.equal(probe.capabilities.usage_events, "supported")
  assert.equal(probe.capabilities.mcp, "unsupported")
  assert.equal(probe.capabilities.session_resume, "unsupported")
})

test("Claude run uses an empty host workspace and an inline bounded value projection", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-success-"))
  const capture = path.join(parent, "capture.json")
  const sentinel = path.join(parent, "must-not-exist")
  const request = await employeeRequest(parent)
  request.prompt =
    `--dangerously-skip-permissions; touch ${sentinel}; inspect @/etc/passwd`
  request.instructions = `${request.instructions}\n\nINSTRUCTION_ARGV_MARKER`
  assert.equal(typeof request.outputSchema, "object")
  Object.defineProperty(request.outputSchema as object, "$comment", {
    value: "SCHEMA_ARGV_MARKER",
    enumerable: true,
    configurable: true,
    writable: true,
  })

  const events = await collect(adapter(parent, "success", capture).run(request))
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.started", "assistant.delta", "usage", "run.completed"],
  )
  assert.equal(terminalEvents(events).length, 1)
  const completed = events.at(-1)
  assert.equal(completed?.type, "run.completed")
  assert.equal(
    completed?.type === "run.completed" &&
      typeof completed.output === "object" &&
      completed.output !== null &&
      !Array.isArray(completed.output) &&
      completed.output.answer,
    "fixture answer",
  )
  const usage = events.find((event) => event.type === "usage")
  assert.deepEqual(
    usage?.type === "usage"
      ? {
          input: usage.inputTokens,
          output: usage.outputTokens,
          total: usage.totalTokens,
          cost: usage.reportedCost,
          currency: usage.currency,
        }
      : undefined,
    { input: 10, output: 5, total: 15, cost: 0.0125, currency: "USD" },
  )

  const captured = JSON.parse(await readFile(capture, "utf8"))
  assert.notEqual(captured.cwd, request.workingDirectory)
  assert.match(captured.cwd, /digital-employee-claude-/)
  assert.deepEqual(captured.workspaceEntries, [])
  assert.equal(captured.apiKeyConfigured, true)
  assert.equal(captured.environmentKeys.includes("ANTHROPIC_API_KEY"), true)
  assert.equal(captured.environmentKeys.includes("SECRET_SHOULD_NOT_PASS"), false)
  assert.equal(captured.environmentKeys.includes("NODE_OPTIONS"), false)
  assert.match(captured.home, /digital-employee-claude-.*\/home$/)
  assert.match(captured.configDirectory, /digital-employee-claude-.*\/config$/)
  assert.deepEqual(captured.temporaryEntries, [])
  assert.equal(
    new Set(Object.values(captured.temporaryDirectories)).size,
    1,
  )
  assert.match(captured.temporaryDirectories.TMPDIR, /digital-employee-claude-.*\/tmp$/)
  assert.equal(captured.settings.mode, 0o600)
  assert.equal(captured.mcp.mode, 0o600)
  assert.equal(captured.systemPrompt.mode, 0o600)
  assert.equal(captured.settings.json.permissions.defaultMode, "dontAsk")
  assert.equal(captured.settings.json.permissions.deny.includes("Read"), true)
  assert.deepEqual(captured.mcp.json, { mcpServers: {} })
  assert.match(captured.systemPrompt.text, /# employee-/)
  assert.match(captured.systemPrompt.text, /zero-tool host/)

  for (const flag of [
    "--bare",
    "--print",
    "--include-partial-messages",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
  ]) {
    assert.equal(captured.args.includes(flag), true, flag)
  }
  assert.equal(captured.args.includes("--allowedTools"), false)
  assert.equal(captured.args.includes("--json-schema"), false)
  assert.equal(captured.args.includes("--dangerously-skip-permissions"), false)
  const toolsIndex = captured.args.indexOf("--tools")
  assert.notEqual(toolsIndex, -1)
  assert.equal(captured.args[toolsIndex + 1], "")
  assert.equal(
    captured.args.some((value: string) => value.includes(request.prompt)),
    false,
  )
  assert.equal(captured.stdin.includes("@/etc/passwd"), false)
  assert.equal(
    captured.args.some((value: string) => value.includes("Approved knowledge")),
    false,
  )
  assert.equal(
    captured.args.some((value: string) =>
      /INSTRUCTION_ARGV_MARKER|SCHEMA_ARGV_MARKER/.test(value),
    ),
    false,
  )
  assert.equal(captured.environmentContainsSchemaMarker, false)
  assert.equal(JSON.stringify(events).includes("SCHEMA_ARGV_MARKER"), false)

  const envelope = JSON.parse(captured.stdin.slice(captured.stdin.indexOf("\n") + 1))
  assert.equal(envelope.schemaVersion, "digital-employee-context.v1")
  assert.equal(envelope.task, request.prompt)
  assert.equal(envelope.outputSchema.$comment, "SCHEMA_ARGV_MARKER")
  assert.equal(envelope.assets.length > 0, true)
  assert.equal(envelope.assets[0].path.startsWith("./"), true)
  assert.equal(
    envelope.assets.some((asset: { content: string }) =>
      asset.content.includes("Approved knowledge"),
    ),
    true,
  )
  await assert.rejects(access(sentinel))
  assert.equal(
    (await readdir(parent)).some((entry) =>
      entry.startsWith("digital-employee-claude-"),
    ),
    false,
  )
})

for (const [mode, expectedCode] of [
  ["malformed", "claude_stream_invalid_json"],
  ["policy-mismatch", "claude_runtime_policy_mismatch"],
  ["mcp-mismatch", "claude_runtime_policy_mismatch"],
  ["plugins-mismatch", "claude_runtime_policy_mismatch"],
  ["skills-mismatch", "claude_runtime_policy_mismatch"],
  ["commands-mismatch", "claude_runtime_policy_mismatch"],
  ["permission-mismatch", "claude_runtime_policy_mismatch"],
  ["version-announcement-mismatch", "claude_runtime_policy_mismatch"],
  ["api-key-source-mismatch", "claude_runtime_policy_mismatch"],
  ["missing-init", "claude_init_required"],
  ["missing-result", "claude_result_missing"],
  ["duplicate-result", "claude_duplicate_result"],
  ["event-after-result", "claude_event_after_result"],
  ["session-mismatch", "claude_session_id_mismatch"],
  ["tool-use", "claude_runtime_tool_mismatch"],
  ["unknown-block-start", "claude_stream_unknown_block"],
  ["unsafe-message-start", "claude_stream_invalid_message_start"],
  ["nonzero", "claude_process_failed"],
  ["result-error", "claude_execution_failed"],
  ["invalid-output", "claude_output_schema_mismatch"],
  ["invalid-json", "claude_output_not_json"],
  ["invalid-usage", "claude_usage_invalid"],
  ["stdout-oversize", "claude_stdout_limit_exceeded"],
  ["stderr-oversize", "claude_stderr_limit_exceeded"],
] as const) {
  test(`Claude ${mode} fixture fails closed with one terminal event`, async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), `claude-${mode}-`))
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
  })
}

test("Claude fails closed without emitting the API key from hostile output", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-secret-"))
  const request = await employeeRequest(parent, "run-secret")
  const events = await collect(adapter(parent, "secret-output").run(request))
  const serialized = JSON.stringify(events)

  assert.equal(serialized.includes(fixtureApiKey), false)
  const terminal = events.at(-1)
  assert.equal(terminal?.type, "run.failed")
  assert.equal(
    terminal?.type === "run.failed" && terminal.error.code,
    "claude_output_sensitive_value_denied",
  )
})

test("Claude validates structured output before redaction can manufacture conformance", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-redaction-order-"))
  const request = await employeeRequest(parent, "run-redaction-order")
  request.outputSchema = {
    type: "object",
    required: ["answer"],
    properties: { answer: { const: "token=[REDACTED]" } },
    additionalProperties: true,
  }
  const events = await collect(
    adapter(parent, "generic-redaction-output").run(request),
  )
  const terminal = events.at(-1)

  assert.equal(terminal?.type, "run.failed")
  assert.equal(
    terminal?.type === "run.failed" && terminal.error.code,
    "claude_output_schema_mismatch",
  )
  assert.equal(events.some((event) => event.type === "run.completed"), false)
  assert.equal(JSON.stringify(events).includes("fixture-public-nonsecret"), false)
})

test("Claude fails closed when a hostile result uses the API key as an object key", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-secret-key-"))
  const request = await employeeRequest(parent, "run-secret-key")
  request.outputSchema = { type: "object" }
  const events = await collect(adapter(parent, "secret-key-output").run(request))
  const serialized = JSON.stringify(events)

  assert.equal(serialized.includes(fixtureApiKey), false)
  const terminal = events.at(-1)
  assert.equal(terminal?.type, "run.failed")
  assert.equal(
    terminal?.type === "run.failed" && terminal.error.code,
    "claude_output_sensitive_key_denied",
  )
})

test("Claude validates result text locally without trusting native structured_output", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-local-schema-"))
  const request = await employeeRequest(parent, "run-local-schema")
  const events = await collect(adapter(parent, "missing-structured").run(request))
  const completed = events.at(-1)

  assert.equal(completed?.type, "run.completed")
  assert.equal(
    completed?.type === "run.completed" &&
      typeof completed.output === "object" &&
      completed.output !== null &&
      !Array.isArray(completed.output) &&
      completed.output.answer,
    "fixture answer",
  )
})

test("Claude rejects unsupported versions, missing API keys and write policies before launch", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-preflight-"))
  const launchLog = path.join(parent, "launch.jsonl")
  const request = await employeeRequest(parent, "run-preflight")
  request.policy.filesystem.write = ["./knowledge/out.md"]

  const noKey = createClaudeAgentHostAdapter({
    command: process.execPath,
    commandPrefixArgs: [fixture, "--launch-log", launchLog],
    environment: { PATH: process.env.PATH },
    versionExecutor: fixtureVersionExecutor,
    temporaryRoot: parent,
  })
  const preflight = await noKey.preflight(request)
  assert.equal(preflight.status, "not_ready")
  assert.equal(
    preflight.issues.some((entry) => entry.code === "claude_api_key_not_configured"),
    true,
  )
  assert.equal(
    preflight.issues.some((entry) => entry.code === "claude_write_policy_unsupported"),
    true,
  )

  const oldVersion = createClaudeAgentHostAdapter({
    environment: { ANTHROPIC_API_KEY: fixtureApiKey },
    versionExecutor: async () => ({
      status: "installed",
      output: "2.1.213 (Claude Code)",
    }),
  })
  assert.equal((await oldVersion.probe()).status, "not_ready")
  await assert.rejects(access(launchLog))
})

test("Claude validates synchronous JSON Schema locally before launching", async () => {
  for (const [name, outputSchema] of [
    ["invalid", { type: "definitely-not-a-json-schema-type" }],
    ["async", { $async: true, type: "object" }],
  ] as const) {
    const parent = await mkdtemp(path.join(os.tmpdir(), `claude-schema-${name}-`))
    const launchLog = path.join(parent, "launch.jsonl")
    const request = await employeeRequest(parent, `run-schema-${name}`)
    request.outputSchema = outputSchema as SafeValue
    const host = adapter(parent, "success", undefined, 10_000, {
      fixtureArgs: ["--launch-log", launchLog],
    })

    const events = await collect(host.run(request))
    const failed = events.at(-1)
    assert.equal(failed?.type, "run.failed")
    assert.equal(
      failed?.type === "run.failed" && failed.error.code,
      "claude_output_schema_invalid",
    )
    await assert.rejects(access(launchLog))
  }
})

test("Claude preflight rejects invalid, $async and oversized Schemas before any probe or spawn", async () => {
  for (const [name, outputSchema, code] of [
    [
      "invalid",
      { type: "definitely-not-a-json-schema-type" },
      "claude_output_schema_invalid",
    ],
    [
      "async",
      { $async: true, type: "object" },
      "claude_output_schema_invalid",
    ],
    [
      "oversized",
      {
        type: "object",
        properties: { filler: { description: "x".repeat(20_000) } },
      },
      "claude_output_schema_too_large",
    ],
  ] as const) {
    const parent = await mkdtemp(path.join(os.tmpdir(), `claude-guard-${name}-`))
    const launchLog = path.join(parent, "launch.jsonl")
    const request = await employeeRequest(parent, `run-guard-${name}`)
    request.outputSchema = outputSchema as SafeValue
    const versionCalls: Array<{ command: string; args: string[] }> = []
    const host = adapter(parent, "success", undefined, 10_000, {
      fixtureArgs: ["--launch-log", launchLog],
      versionExecutor: async (command, args) => {
        versionCalls.push({ command, args })
        return fixtureVersionExecutor()
      },
    })

    const preflight = await host.preflight(request)
    assert.equal(preflight.status, "not_ready")
    assert.equal(preflight.available, false)
    assert.deepEqual(
      preflight.issues.map((entry) => entry.code),
      [code],
    )
    assert.deepEqual(versionCalls, [])
    await assert.rejects(access(launchLog))
  }
})

test("Claude keeps the prepared Schema when the request mutates before spawn", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-late-schema-"))
  const request = await employeeRequest(parent, "run-late-schema")
  const host = adapter(parent, "success", undefined, 10_000, {
    beforeSpawn: async () => {
      request.outputSchema = { $async: true, type: "object" }
    },
  })

  const events = await collect(host.run(request))
  const completed = events.at(-1)
  assert.equal(completed?.type, "run.completed")
  assert.equal(
    completed?.type === "run.completed" &&
      (completed.output as { answer?: string }).answer,
    "fixture answer",
  )
})

test("Claude deadline and explicit cancellation terminate a hanging run", async () => {
  const deadlineParent = await mkdtemp(path.join(os.tmpdir(), "claude-deadline-"))
  const deadlineRequest = await employeeRequest(deadlineParent, "run-deadline")
  const deadlineEvents = await collect(
    adapter(deadlineParent, "hang", undefined, 40).run(deadlineRequest),
  )
  const deadlineTerminal = deadlineEvents.at(-1)
  assert.equal(deadlineTerminal?.type, "run.failed")
  assert.equal(
    deadlineTerminal?.type === "run.failed" && deadlineTerminal.error.code,
    "claude_deadline_exceeded",
  )

  const cancelParent = await mkdtemp(path.join(os.tmpdir(), "claude-cancel-"))
  const cancelRequest = await employeeRequest(cancelParent, "run-cancel")
  const host = adapter(cancelParent, "hang")
  const iterator = host.run(cancelRequest)[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value?.type, "run.started")
  await host.cancel(cancelRequest.runId)
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
    "claude_run_cancelled",
  )
})

test("Claude reserves run ids before staging and cancellation prevents launch", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-reservation-"))
  const launchLog = path.join(parent, "launch.jsonl")
  const request = await employeeRequest(parent, "run-reserved")
  const entered = deferred()
  const release = deferred()
  const host = adapter(parent, "hang", undefined, 10_000, {
    fixtureArgs: ["--launch-log", launchLog],
    beforeSpawn: async () => {
      entered.resolve()
      await release.promise
    },
  })

  const first = host.run(request)[Symbol.asyncIterator]()
  const pending = first.next()
  await entered.promise
  const duplicate = await host.run(request)[Symbol.asyncIterator]().next()
  assert.equal(duplicate.value?.type, "run.failed")
  assert.equal(
    duplicate.value?.type === "run.failed" && duplicate.value.error.code,
    "claude_run_already_active",
  )
  await host.cancel(request.runId)
  release.resolve()
  const cancelled = await pending
  assert.equal(cancelled.value?.type, "run.failed")
  assert.equal(
    cancelled.value?.type === "run.failed" && cancelled.value.error.code,
    "claude_run_cancelled",
  )
  assert.equal((await first.next()).done, true)
  await assert.rejects(access(launchLog))
})

test("Claude observes cancellation immediately after the version probe", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-probe-cancel-"))
  const launchLog = path.join(parent, "launch.jsonl")
  const request = await employeeRequest(parent, "run-probe-cancel")
  const controller = new AbortController()
  request.signal = controller.signal
  const host = adapter(parent, "success", undefined, 10_000, {
    fixtureArgs: ["--launch-log", launchLog],
    versionExecutor: async () => {
      controller.abort()
      return { status: "installed", output: "2.1.214 (Claude Code)" }
    },
  })

  const events = await collect(host.run(request))
  const failed = events.at(-1)
  assert.equal(failed?.type, "run.failed")
  assert.equal(
    failed?.type === "run.failed" && failed.error.code,
    "claude_run_cancelled",
  )
  await assert.rejects(access(launchLog))
})

test("Claude iterator return cleans the process and releases its reservation", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-return-"))
  const request = await employeeRequest(parent, "run-return")
  const host = adapter(parent, "hang")
  const iterator = host.run(request)[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value?.type, "run.started")
  await iterator.return?.()
  assert.equal(
    (await readdir(parent)).some((entry) =>
      entry.startsWith("digital-employee-claude-"),
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

test("Claude cleanup failure replaces success with one explicit failed terminal", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-cleanup-"))
  const request = await employeeRequest(parent, "run-cleanup")
  let cleanupCalls = 0
  const host = adapter(parent, "success", undefined, 10_000, {
    removeRunRoot: async () => {
      cleanupCalls += 1
      throw Object.assign(new Error("fixture cleanup failure"), { code: "EACCES" })
    },
  })

  const events = await collect(host.run(request))
  assert.equal(cleanupCalls, 2)
  assert.equal(terminalEvents(events).length, 1)
  const failed = events.at(-1)
  assert.equal(failed?.type, "run.failed")
  assert.equal(
    failed?.type === "run.failed" && failed.error.code,
    "claude_cleanup_failed",
  )
  assert.equal(events.some((event) => event.type === "usage"), false)
  await rm(parent, { recursive: true, force: true })
})

test("Claude removes inherited process-group descendants before publishing success", async (t) => {
  if (process.platform === "win32") {
    return t.skip("POSIX process-group behavior")
  }
  const parent = await mkdtemp(path.join(os.tmpdir(), "claude-orphan-"))
  const orphanPidFile = path.join(parent, "orphan.pid")
  const request = await employeeRequest(parent, "run-orphan")
  const events = await collect(
    adapter(parent, "orphan-child", undefined, 10_000, {
      fixtureArgs: ["--orphan-pid-file", orphanPidFile],
    }).run(request),
  )

  assert.equal(events.at(-1)?.type, "run.completed")
  const orphanPid = Number(await readFile(orphanPidFile, "utf8"))
  assert.throws(
    () => process.kill(orphanPid, 0),
    (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ESRCH",
  )
})
