import assert from "node:assert/strict"
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  createCodeBuddyAgentHostAdapter,
} from "../../apps/cli/codebuddy-agent-host.js"
import type {
  CodeBuddyAgentHostAdapterOptions,
} from "../../apps/cli/codebuddy-agent-host.js"
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
const fixture = path.join(root, "tests", "apps", "fixtures", "fake-codebuddy.mjs")
const fixtureApiKey = "fixture-codebuddy-api-key"
const fixtureModel = "fixture-model"
const fixtureVersion = "2.106.4"

async function fixtureVersionExecutor() {
  return { status: "installed" as const, output: fixtureVersion }
}

const exactDeniedTools = [
  "Agent",
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "PowerShell",
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
  "WebFetch",
  "WebSearch",
  "TaskStop",
  "TaskOutput",
  "Skill",
  "AskUserQuestion",
  "StructuredOutput",
  "ToolSearch",
  "DeferExecuteTool",
  "SendMessage",
  "TeamCreate",
  "TeamDelete",
  "WeChatReply",
  "WeComReply",
  "ImageGen",
  "VideoGen",
  "SkillManage",
  "ListMcpResources",
  "ReadMcpResource",
]

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
  options: CodeBuddyAgentHostAdapterOptions & { fixtureArgs?: string[] } = {},
) {
  const { fixtureArgs = [], ...adapterOptions } = options
  return createCodeBuddyAgentHostAdapter({
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
      CODEBUDDY_API_KEY: fixtureApiKey,
      CODEBUDDY_MODEL: fixtureModel,
      CODEBUDDY_BASE_URL: "https://codebuddy.example.test/api",
      CODEBUDDY_INTERNET_ENVIRONMENT: "internal",
      CODEBUDDY_AUTH_TOKEN: "personal-token-must-not-pass",
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

test("CodeBuddy requires the exact conformance-tested 2.106.4 release", async () => {
  for (const [version, expected] of [
    ["2.106.3", "not_ready"],
    ["2.106.4", "ready"],
    ["CodeBuddy Code 2.106.4", "ready"],
    ["2.106.4-beta.1", "not_ready"],
    ["2.106.4.1", "not_ready"],
    ["2.106.5", "not_ready"],
    ["3.0.0", "not_ready"],
  ] as const) {
    const host = createCodeBuddyAgentHostAdapter({
      command: process.execPath,
      environment: {
        PATH: process.env.PATH,
        CODEBUDDY_API_KEY: fixtureApiKey,
        CODEBUDDY_MODEL: fixtureModel,
      },
      versionExecutor: async () => ({ status: "installed", output: version }),
    })
    assert.equal((await host.probe()).status, expected, version)
  }
})

test("CodeBuddy probe declares only the conformance-tested stateless surface", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codebuddy-probe-"))
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

test("CodeBuddy run is zero-tool, fully isolated, and value-projected over stdin", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codebuddy-success-"))
  const capture = path.join(parent, "capture.json")
  const sentinel = path.join(parent, "must-not-exist")
  const request = await employeeRequest(parent)
  request.prompt = `Answer @../../etc/passwd; touch ${sentinel}`
  request.instructions = `${request.instructions}\n\nINSTRUCTION@ARGV_MARKER`
  assert.equal(typeof request.outputSchema, "object")
  Object.defineProperty(request.outputSchema as object, "$comment", {
    value: "SCHEMA@ARGV_MARKER",
    enumerable: true,
    configurable: true,
    writable: true,
  })
  await writeFile(
    path.join(request.workingDirectory, "knowledge", "README.md"),
    "Approved knowledge @../../private-file\n",
  )

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
    { input: 11, output: 7, total: 18, cost: 0.021, currency: "USD" },
  )

  const captured = JSON.parse(await readFile(capture, "utf8"))
  assert.notEqual(captured.cwd, request.workingDirectory)
  assert.match(captured.cwd, /digital-employee-codebuddy-/)
  assert.deepEqual(captured.workspaceEntries, [])
  assert.deepEqual(captured.homeEntries, [])
  assert.deepEqual(captured.configEntries, [])
  assert.equal(captured.workbuddyConfigDirectory, captured.configDirectory)
  assert.deepEqual(captured.temporaryEntries, [])
  assert.equal(
    new Set(Object.values(captured.temporaryDirectories)).size,
    1,
  )
  assert.match(
    captured.temporaryDirectories.TMPDIR,
    /digital-employee-codebuddy-.*\/tmp$/,
  )
  for (const entries of [
    captured.xdg.configEntries,
    captured.xdg.dataEntries,
    captured.xdg.cacheEntries,
    captured.xdg.stateEntries,
    captured.xdg.runtimeEntries,
  ]) {
    assert.deepEqual(entries, [])
  }
  assert.equal(captured.apiKeyConfigured, true)
  assert.equal(captured.modelEnvironment, fixtureModel)
  assert.equal(captured.baseUrl, "https://codebuddy.example.test/api")
  assert.equal(captured.internetEnvironment, "internal")
  assert.equal(captured.environmentKeys.includes("CODEBUDDY_API_KEY"), true)
  assert.equal(captured.environmentKeys.includes("CODEBUDDY_AUTH_TOKEN"), false)
  assert.equal(captured.environmentKeys.includes("SECRET_SHOULD_NOT_PASS"), false)
  assert.equal(captured.environmentKeys.includes("NODE_OPTIONS"), false)
  assert.equal(
    Object.values(captured.isolationEnvironment).every((value) => value === "1"),
    true,
  )
  assert.equal(captured.settings.mode, 0o600)
  assert.equal(captured.mcp.mode, 0o600)
  assert.equal(captured.settings.json.permissions.defaultMode, "default")
  assert.deepEqual(captured.settings.json.permissions.deny, exactDeniedTools)
  assert.deepEqual(captured.mcp.json, { mcpServers: {} })

  assert.equal(captured.args.includes("-p"), true)
  assert.equal(captured.args.includes("--include-partial-messages"), true)
  assert.equal(captured.args.includes("--strict-mcp-config"), true)
  assert.equal(captured.args.includes("--allowedTools"), false)
  assert.equal(captured.args.includes("--dangerously-skip-permissions"), false)
  assert.equal(captured.args.includes("--json-schema"), false)
  assert.equal(captured.args.includes("--system-prompt"), false)
  assert.equal(captured.args.includes("--system-prompt-file"), false)
  assert.equal(captured.toolsValue, "")
  assert.deepEqual(captured.disallowedTools, exactDeniedTools)
  assert.equal(
    captured.args[captured.args.indexOf("--setting-sources") + 1],
    "none",
  )
  assert.equal(
    captured.args[captured.args.indexOf("--permission-mode") + 1],
    "default",
  )
  assert.equal(
    captured.args[captured.args.indexOf("--model") + 1],
    fixtureModel,
  )
  assert.match(
    captured.args[captured.args.indexOf("--session-id") + 1],
    /^[0-9a-f-]{36}$/,
  )
  assert.equal(
    captured.args.some((value: string) =>
      /Answer @|INSTRUCTION@ARGV_MARKER|SCHEMA@ARGV_MARKER|Approved knowledge/.test(
        value,
      ),
    ),
    false,
  )

  assert.equal(captured.stdin.includes("@"), false)
  assert.equal(captured.stdin.includes("\\u0040"), true)
  const envelope = JSON.parse(captured.stdin.slice(captured.stdin.indexOf("\n") + 1))
  assert.equal(envelope.task, request.prompt)
  assert.match(envelope.employeeInstructions, /INSTRUCTION@ARGV_MARKER/)
  assert.equal(envelope.outputSchema.$comment, "SCHEMA@ARGV_MARKER")
  assert.equal(
    envelope.assets.some((asset: { content: string }) =>
      asset.content.includes("Approved knowledge @../../private-file"),
    ),
    true,
  )
  await assert.rejects(access(sentinel))
  assert.equal(
    (await readdir(parent)).some((entry) =>
      entry.startsWith("digital-employee-codebuddy-"),
    ),
    false,
  )
})

for (const [mode, expectedCode] of [
  ["tool-mismatch", "codebuddy_runtime_policy_mismatch"],
  ["mcp-mismatch", "codebuddy_runtime_policy_mismatch"],
  ["model-mismatch", "codebuddy_runtime_policy_mismatch"],
  ["permission-mismatch", "codebuddy_runtime_policy_mismatch"],
  ["session-init-mismatch", "codebuddy_runtime_policy_mismatch"],
  ["unsafe-status", "codebuddy_status_event_invalid"],
  ["unsafe-snapshot", "codebuddy_file_history_event_invalid"],
  ["tool-event", "codebuddy_runtime_tool_mismatch"],
  ["unsafe-message-start", "codebuddy_stream_invalid_message_start"],
  ["unknown-event", "codebuddy_stream_unknown_event"],
  ["malformed", "codebuddy_stream_invalid_json"],
  ["missing-init", "codebuddy_init_required"],
  ["missing-result", "codebuddy_result_missing"],
  ["duplicate-result", "codebuddy_duplicate_result"],
  ["event-after-result", "codebuddy_event_after_result"],
  ["nonzero", "codebuddy_process_failed"],
  ["result-error", "codebuddy_execution_failed"],
  ["invalid-output", "codebuddy_output_schema_mismatch"],
  ["invalid-json", "codebuddy_output_not_json"],
  ["invalid-usage", "codebuddy_usage_invalid"],
  ["stdout-oversize", "codebuddy_stdout_limit_exceeded"],
  ["stderr-oversize", "codebuddy_stderr_limit_exceeded"],
] as const) {
  test(`CodeBuddy ${mode} fixture fails closed with one terminal event`, async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), `codebuddy-${mode}-`))
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

test("CodeBuddy fails closed without emitting CODEBUDDY_API_KEY from hostile output", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codebuddy-secret-"))
  const request = await employeeRequest(parent, "run-secret")
  const events = await collect(adapter(parent, "secret-output").run(request))
  const serialized = JSON.stringify(events)

  assert.equal(serialized.includes(fixtureApiKey), false)
  const terminal = events.at(-1)
  assert.equal(terminal?.type, "run.failed")
  assert.equal(
    terminal?.type === "run.failed" && terminal.error.code,
    "codebuddy_output_sensitive_value_denied",
  )
})

test("CodeBuddy fails closed when hostile output uses the API key as an object key", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codebuddy-secret-key-"))
  const request = await employeeRequest(parent, "run-secret-key")
  request.outputSchema = { type: "object" }
  const events = await collect(adapter(parent, "secret-key-output").run(request))
  const serialized = JSON.stringify(events)

  assert.equal(serialized.includes(fixtureApiKey), false)
  const terminal = events.at(-1)
  assert.equal(terminal?.type, "run.failed")
  assert.equal(
    terminal?.type === "run.failed" && terminal.error.code,
    "codebuddy_output_sensitive_key_denied",
  )
})

test("CodeBuddy preflight requires key/model and rejects writes without launch", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codebuddy-preflight-"))
  const launchLog = path.join(parent, "launch.jsonl")
  const request = await employeeRequest(parent, "run-preflight")
  request.policy.filesystem.write = ["./knowledge/out.md"]
  const host = createCodeBuddyAgentHostAdapter({
    command: process.execPath,
    commandPrefixArgs: [fixture, "--launch-log", launchLog],
    environment: { PATH: process.env.PATH },
    temporaryRoot: parent,
  })

  const preflight = await host.preflight(request)
  assert.equal(preflight.status, "not_ready")
  for (const code of [
    "codebuddy_api_key_not_configured",
    "codebuddy_model_not_configured",
    "codebuddy_write_policy_unsupported",
  ]) {
    assert.equal(preflight.issues.some((entry) => entry.code === code), true)
  }
  const events = await collect(host.run(request))
  assert.equal(events.at(-1)?.type, "run.failed")
  await assert.rejects(access(launchLog))
})

test("CodeBuddy validates optional endpoint and environment settings", async () => {
  for (const [environment, expectedCode] of [
    [
      {
        CODEBUDDY_API_KEY: fixtureApiKey,
        CODEBUDDY_MODEL: fixtureModel,
        CODEBUDDY_BASE_URL: "file:///etc/passwd",
      },
      "codebuddy_base_url_invalid",
    ],
    [
      {
        CODEBUDDY_API_KEY: fixtureApiKey,
        CODEBUDDY_MODEL: fixtureModel,
        CODEBUDDY_BASE_URL: "http://codebuddy.example.test/api",
      },
      "codebuddy_base_url_invalid",
    ],
    [
      {
        CODEBUDDY_API_KEY: fixtureApiKey,
        CODEBUDDY_MODEL: fixtureModel,
        CODEBUDDY_INTERNET_ENVIRONMENT: "surprise",
      },
      "codebuddy_internet_environment_invalid",
    ],
  ] as const) {
    const host = createCodeBuddyAgentHostAdapter({
      command: process.execPath,
      environment,
      versionExecutor: async () => ({ status: "installed", output: "2.106.4" }),
    })
    const probe = await host.probe()
    assert.equal(probe.status, "not_ready")
    assert.equal(probe.issues.some((entry) => entry.code === expectedCode), true)
  }
})

test("CodeBuddy validates JSON Schema locally before launching", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codebuddy-schema-"))
  const launchLog = path.join(parent, "launch.jsonl")
  const request = await employeeRequest(parent, "run-schema")
  request.outputSchema = { type: "definitely-not-a-json-schema-type" }
  const host = adapter(parent, "success", undefined, 10_000, {
    fixtureArgs: ["--launch-log", launchLog],
  })

  const events = await collect(host.run(request))
  const failed = events.at(-1)
  assert.equal(failed?.type, "run.failed")
  assert.equal(
    failed?.type === "run.failed" && failed.error.code,
    "codebuddy_output_schema_invalid",
  )
  await assert.rejects(access(launchLog))
})

test("CodeBuddy deadline and explicit cancellation terminate a hanging run", async () => {
  const deadlineParent = await mkdtemp(path.join(os.tmpdir(), "codebuddy-deadline-"))
  const deadlineRequest = await employeeRequest(deadlineParent, "run-deadline")
  const deadlineEvents = await collect(
    adapter(deadlineParent, "hang", undefined, 40).run(deadlineRequest),
  )
  const deadlineTerminal = deadlineEvents.at(-1)
  assert.equal(deadlineTerminal?.type, "run.failed")
  assert.equal(
    deadlineTerminal?.type === "run.failed" && deadlineTerminal.error.code,
    "codebuddy_deadline_exceeded",
  )

  const cancelParent = await mkdtemp(path.join(os.tmpdir(), "codebuddy-cancel-"))
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
    "codebuddy_run_cancelled",
  )
})

test("CodeBuddy reserves run ids and cancellation before spawn prevents launch", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codebuddy-reserved-"))
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
    "codebuddy_run_already_active",
  )
  await host.cancel(request.runId)
  release.resolve()
  const cancelled = await pending
  assert.equal(cancelled.value?.type, "run.failed")
  assert.equal(
    cancelled.value?.type === "run.failed" && cancelled.value.error.code,
    "codebuddy_run_cancelled",
  )
  assert.equal((await first.next()).done, true)
  await assert.rejects(access(launchLog))
})

test("CodeBuddy iterator return cleans the process and releases reservation", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codebuddy-return-"))
  const request = await employeeRequest(parent, "run-return")
  const host = adapter(parent, "hang")
  const iterator = host.run(request)[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value?.type, "run.started")
  await iterator.return?.()
  assert.equal(
    (await readdir(parent)).some((entry) =>
      entry.startsWith("digital-employee-codebuddy-"),
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

test("CodeBuddy cleanup failure replaces success with one failed terminal", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codebuddy-cleanup-"))
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
    "codebuddy_cleanup_failed",
  )
  assert.equal(events.some((event) => event.type === "usage"), false)
  await rm(parent, { recursive: true, force: true })
})
