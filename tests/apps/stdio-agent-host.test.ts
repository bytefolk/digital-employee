import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createBuiltInAgentHostRegistry } from "../../apps/cli/agent-host-registry.js"
import { REFERENCE_STDIO_HOST_ID } from "../../apps/cli/reference-stdio-host.js"
import {
  ExternalStdioAgentHostAdapter,
  createExternalStdioHostRegistration,
} from "../../apps/cli/stdio-agent-host.js"
import type { AgentHostRunRequest } from "../../packages/core/src/agent-host.js"
import { runQualificationSuite } from "../../packages/core/src/adapter-qualification.js"
import type {
  QualificationProcessTreeFixture,
  QualificationProcessTreeScenario,
} from "../../packages/core/src/adapter-qualification.js"
import {
  AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION,
  validateStdioAdapterConfig,
} from "../../packages/core/src/agent-host-stdio-config.js"
import type { StdioAdapterConfig } from "../../packages/core/src/agent-host-stdio-config.js"

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
)
const referenceHostScript = path.join(
  packageRoot,
  "apps",
  "cli",
  "reference-stdio-host.ts",
)

const ENV_FLAGS = [
  "REFERENCE_STDIO_HANG",
  "REFERENCE_STDIO_SPAWN_CHILD",
  "REFERENCE_STDIO_UNKNOWN_FIELD",
  "REFERENCE_STDIO_DUP_TERMINAL",
  "REFERENCE_STDIO_AFTER_TERMINAL",
  "REFERENCE_STDIO_MISSING_CAPABILITY",
  "REFERENCE_STDIO_DISALLOWED_TOOL",
  "REFERENCE_STDIO_REFUSE_CANCEL",
  "REFERENCE_STDIO_HOSTILE_WRITE_OK",
  "REFERENCE_STDIO_PROBE_ONLY",
  "REFERENCE_STDIO_NOT_READY",
  "REFERENCE_STDIO_QUALIFICATION_MODE",
]

function referenceConfig(overrides: {
  digest?: string
  timeoutMs?: number
} = {}): StdioAdapterConfig {
  const digest =
    overrides.digest ??
    createHash("sha256").update(readFileSync(process.execPath)).digest("hex")
  return validateStdioAdapterConfig({
    schema: AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION,
    hostId: REFERENCE_STDIO_HOST_ID,
    displayName: "Reference Stdio Host",
    // Running through the tsx CLI adds a launcher between the pinned Adapter
    // owner and the test host. Load tsx in the pinned Node process so process
    // lineage evidence names the actual owner that directly spawns the child.
    executable: process.execPath,
    args: ["--import", "tsx", referenceHostScript],
    digest: { algorithm: "sha256", hex: digest },
    envAllowlist: ["PATH", ...ENV_FLAGS],
    workingDirectoryPolicy: "request",
    timeoutMs: overrides.timeoutMs ?? 30_000,
    maxStderrBytes: 16_384,
  })
}

function readOnlyRequest(runId: string): AgentHostRunRequest {
  return {
    runId,
    employeeId: "test-employee",
    workingDirectory: process.cwd(),
    prompt: "answer the question",
    policy: {
      tools: { default: "deny", allow: [{ name: "noop", mode: "read" }] },
      filesystem: { read: ["."], write: [] },
      network: { mode: "deny" },
      approval: { mode: "never" },
      maxTurns: 4,
    },
  }
}

function code(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as { code: unknown }).code)
    : ""
}

async function withFlags(
  flags: readonly string[],
  body: () => Promise<void>,
): Promise<void> {
  for (const flag of flags) process.env[flag] = "1"
  try {
    await body()
  } finally {
    for (const flag of flags) delete process.env[flag]
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function referenceProcessTreeFixture(
  adapter: ExternalStdioAgentHostAdapter,
  observed: Array<{ childPid: number; grandchildPid: number }>,
): QualificationProcessTreeFixture {
  return {
    async create(scenario: QualificationProcessTreeScenario) {
      let reported: { childPid: number; grandchildPid: number } | undefined
      const readReported = () => {
        const matches = [
          ...adapter.diagnosticsTail().matchAll(
            new RegExp(
              `qualification process_tree ${scenario} child pid (\\d+) grandchild pid (\\d+)`,
              "g",
            ),
          ),
        ]
        const match = matches.at(-1)
        return match
          ? { childPid: Number(match[1]), grandchildPid: Number(match[2]) }
          : undefined
      }
      return {
        adapter,
        async descendants() {
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            reported = readReported()
            if (reported) {
              observed.push(reported)
              return reported
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
          }
          throw new Error("reference process-tree fixture did not report descendants")
        },
        async dispose() {
          reported ??= readReported()
          if (!reported) return
          for (const signal of ["SIGTERM", "SIGKILL"] as const) {
            for (const pid of [reported.grandchildPid, reported.childPid]) {
              if (!processExists(pid)) continue
              try {
                process.kill(pid, signal)
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
              }
            }
            const deadline = Date.now() + 1_000
            while (
              [reported.childPid, reported.grandchildPid].some(processExists) &&
              Date.now() < deadline
            ) {
              await new Promise<void>((resolve) => setTimeout(resolve, 20))
            }
            if (![reported.childPid, reported.grandchildPid].some(processExists)) {
              return
            }
          }
        },
      }
    },
  }
}

test("an explicit external adapter completes the full lifecycle through the registry", async () => {
  await withFlags([], async () => {
    const registration = createExternalStdioHostRegistration(referenceConfig())
    const registry = createBuiltInAgentHostRegistry().register(registration)
    assert.equal(registry.hasAdapter(REFERENCE_STDIO_HOST_ID), true)

    const probe = await registry.probe(REFERENCE_STDIO_HOST_ID)
    assert.equal(probe.status, "ready")
    assert.equal(probe.adapterStatus, "runnable")

    const adapter = (await registry.create(
      REFERENCE_STDIO_HOST_ID,
    )) as ExternalStdioAgentHostAdapter
    try {
      const preflight = await adapter.preflight(readOnlyRequest("preflight-1"))
      assert.equal(preflight.hostId, REFERENCE_STDIO_HOST_ID)
      const formerlyMagicPreflight = await adapter.preflight(
        readOnlyRequest("qualification-network_deny"),
      )
      assert.equal(formerlyMagicPreflight.hostId, REFERENCE_STDIO_HOST_ID)

      await assert.rejects(
        () =>
          adapter.preflight({
            ...readOnlyRequest("preflight-2"),
            policy: {
              ...readOnlyRequest("preflight-2").policy,
              filesystem: { read: ["."], write: ["/etc"] },
            },
          }),
        (error: unknown) => code(error) === "agent_host_stdio_host_error",
      )

      const events = []
      for await (const event of adapter.run(readOnlyRequest("run-1"))) {
        events.push(event)
      }
      assert.deepEqual(
        events.map((event) => event.type),
        ["run.started", "run.completed"],
      )

      const formerlyMagicRun = []
      for await (const event of adapter.run(
        readOnlyRequest("qualification-cancel"),
      )) {
        formerlyMagicRun.push(event)
      }
      assert.deepEqual(
        formerlyMagicRun.map((event) => event.type),
        ["run.started", "run.completed"],
      )

      await adapter.cancel("run-cancel")
      const cancelled = []
      for await (const event of adapter.run(readOnlyRequest("run-cancel"))) {
        cancelled.push(event)
      }
      const terminal = cancelled[cancelled.length - 1]
      assert.equal(terminal.type, "run.failed")
      assert.equal(
        terminal.type === "run.failed" && terminal.error.code,
        "agent_host_cancelled",
      )
    } finally {
      await adapter.dispose()
    }
  })
})

test("violation fixtures fail closed with stable error codes", async () => {
  const probeFixture = async (flags: string[], expected: string) => {
    await withFlags(flags, async () => {
      const adapter = new ExternalStdioAgentHostAdapter(referenceConfig())
      try {
        await assert.rejects(
          () => adapter.probe(),
          (error: unknown) => code(error) === expected,
        )
      } finally {
        await adapter.dispose()
      }
    })
  }
  await probeFixture(["REFERENCE_STDIO_UNKNOWN_FIELD"], "AGENT_HOST_PROBE_INVALID")
  await probeFixture(
    ["REFERENCE_STDIO_MISSING_CAPABILITY"],
    "AGENT_HOST_PROBE_INVALID",
  )

  await withFlags(["REFERENCE_STDIO_DUP_TERMINAL"], async () => {
    const adapter = new ExternalStdioAgentHostAdapter(referenceConfig())
    try {
      const events = []
      await assert.rejects(async () => {
        for await (const event of adapter.run(readOnlyRequest("dup-1"))) {
          events.push(event)
        }
      }, (error: unknown) =>
        code(error) === "agent_host_terminal_contract_violated")
    } finally {
      await adapter.dispose()
    }
  })

  await withFlags(["REFERENCE_STDIO_AFTER_TERMINAL"], async () => {
    const adapter = new ExternalStdioAgentHostAdapter(referenceConfig())
    try {
      await assert.rejects(async () => {
        for await (const _event of adapter.run(readOnlyRequest("after-1"))) {
          // draining; the fixture must fail closed
        }
      }, (error: unknown) =>
        code(error) === "agent_host_terminal_contract_violated")
    } finally {
      await adapter.dispose()
    }
  })

  const poisoned = new ExternalStdioAgentHostAdapter(
    referenceConfig({ digest: "b".repeat(64) }),
  )
  await assert.rejects(
    () => poisoned.probe(),
    (error: unknown) => code(error) === "agent_host_stdio_digest_mismatch",
  )
  await poisoned.dispose()

  await withFlags(["REFERENCE_STDIO_HANG"], async () => {
    const adapter = new ExternalStdioAgentHostAdapter(
      referenceConfig({ timeoutMs: 1_000 }),
    )
    try {
      await assert.rejects(async () => {
        for await (const _event of adapter.run(readOnlyRequest("hang-1"))) {
          // draining; the fixture must time out
        }
      }, (error: unknown) => code(error) === "agent_host_stdio_timeout")
    } finally {
      await adapter.dispose()
    }
  })
})

test("dispose cleans a real detached child and grandchild completely", async () => {
  await withFlags(["REFERENCE_STDIO_SPAWN_CHILD"], async () => {
    const adapter = new ExternalStdioAgentHostAdapter(referenceConfig())
    let descendants: { childPid: number; grandchildPid: number } | undefined
    try {
      await adapter.probe()
      const deadline = Date.now() + 5_000
      while (!descendants && Date.now() < deadline) {
        const match = adapter
          .diagnosticsTail()
          .match(/spawned child pid (\d+) grandchild pid (\d+)/)
        if (match) {
          descendants = {
            childPid: Number(match[1]),
            grandchildPid: Number(match[2]),
          }
          break
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
      }
      assert.ok(descendants, "expected the fixture to report both descendant pids")
      assert.deepEqual(
        [descendants.childPid, descendants.grandchildPid].map(processExists),
        [true, true],
      )
    } finally {
      await adapter.dispose()
    }
    assert.ok(descendants)
    assert.deepEqual(
      [descendants.childPid, descendants.grandchildPid].map(processExists),
      [false, false],
    )
  })
})

test("the qualification kit issues a fixture-conformant record for the reference adapter", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stdio-qualification-"))
  await withFlags(["REFERENCE_STDIO_QUALIFICATION_MODE"], async () => {
    const adapter = new ExternalStdioAgentHostAdapter(referenceConfig())
    const observed: Array<{ childPid: number; grandchildPid: number }> = []
    try {
      const record = await runQualificationSuite(adapter, {
        workingDirectory: directory,
        generatedAt: "2026-08-06T04:00:00Z",
        caseTimeoutMs: 10_000,
        processTreeFixture: referenceProcessTreeFixture(adapter, observed),
      })
      assert.equal(record.schema, "adapter-qualification-record.v1")
      assert.equal(record.hostId, REFERENCE_STDIO_HOST_ID)
      assert.deepEqual(
        record.cases.filter((entry) => !entry.passed),
        [],
      )
      assert.deepEqual(record.axes, {
        implemented: true,
        fixtureConformant: true,
        liveQualified: false,
      })
      assert.equal(record.liveEvidence, undefined)
      assert.equal(record.cases.length, 13)
      assert.ok(record.cases.every((entry) => entry.passed))
      assert.equal(observed.length, 3)
      assert.ok(
        observed.every(
          ({ childPid, grandchildPid }) =>
            !processExists(childPid) && !processExists(grandchildPid),
        ),
      )
    } finally {
      await adapter.dispose()
    }
  })
})
