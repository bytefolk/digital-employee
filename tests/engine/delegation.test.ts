/**
 * S3-P0 explicit single-hop delegation fixtures.
 *
 * Canonical requirements:
 * - https://github.com/fullstack-ai-infra/digital-employee/issues/158 (R3)
 * - https://github.com/fullstack-ai-infra/digital-employee/issues/165 (R4, S3-P0)
 */

import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { SafeValue } from "../../packages/core/src/contracts.js"
import { buildDelegationEnvelopeSchema } from "../../apps/cli/task/envelope-schema.js"
import {
  DELEGATION_ENVELOPE_VERSION,
  DelegationContractError,
  computeCanonicalDigest,
  computeDelegationEnvelopeDigest,
  createRequestedTaskRecord,
  deriveEffectiveDelegationScope,
  executeDelegation,
  parseDelegationEnvelope,
  validateDelegationAdmission,
  type DelegationChildExecutorPort,
  type DelegationEnvelope,
  type DelegationEvent,
  type DelegationOrganization,
  type DelegationPermissions,
} from "../../packages/engine/src/delegation.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

test("published delegation envelope schema matches its code-side builder", async () => {
  const published = await readFile(
    path.join(root, "configs", "delegation-envelope.schema.json"),
    "utf8",
  )
  assert.equal(
    published,
    `${JSON.stringify(buildDelegationEnvelopeSchema(), null, 2)}\n`,
  )
})

const organization: DelegationOrganization = {
  schemaVersion: "workspace-org.v1",
  owner: "repo-owner",
  roles: [
    { id: "repo-owner", reportTo: null },
    { id: "issue-researcher", reportTo: "repo-owner" },
    { id: "release-engineer", reportTo: "repo-owner" },
    { id: "research-assistant", reportTo: "issue-researcher" },
  ],
}

const permissions: DelegationPermissions = {
  schemaVersion: "org-permissions.v1",
  owner: "repo-owner",
  positions: {
    "repo-owner": {
      contextScope: { read: ["./", "./context/private/"] },
      authorityScope: {
        writes: "deny",
        tools: { allow: ["Read", "Grep"], deny: ["Secret"] },
        delegation: {
          allow: true,
          targets: ["issue-researcher", "release-engineer"],
          escalateTo: null,
        },
      },
    },
    "issue-researcher": {
      contextScope: {
        read: ["./positions/repo-owner/issue-researcher/", "./context/"],
      },
      authorityScope: {
        writes: "deny",
        tools: { allow: ["Read", "Glob"], deny: ["Grep"] },
        delegation: {
          allow: false,
          targets: [],
          escalateTo: "repo-owner",
        },
      },
    },
    "release-engineer": {
      contextScope: { read: ["./positions/repo-owner/release-engineer/"] },
      authorityScope: {
        writes: "deny",
        tools: { allow: ["Read"], deny: [] },
        delegation: {
          allow: false,
          targets: [],
          escalateTo: "repo-owner",
        },
      },
    },
    "research-assistant": {
      contextScope: {
        read: [
          "./positions/repo-owner/issue-researcher/research-assistant/",
        ],
      },
      authorityScope: {
        writes: "deny",
        tools: { allow: ["Read"], deny: [] },
        delegation: {
          allow: false,
          targets: [],
          escalateTo: "issue-researcher",
        },
      },
    },
  },
}

function sealed(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const body = {
    schemaVersion: DELEGATION_ENVELOPE_VERSION,
    taskId: "task-1",
    parentTurnId: "turn-parent",
    childTurnId: "turn-child",
    delegatedBy: "repo-owner",
    routedTo: "issue-researcher",
    trigger: "user_explicit",
    delegationDepth: 1,
    attempt: 1,
    retryOfTaskId: null,
    engine: "qoder",
    instruction: "Research issue 158 and return bounded evidence.",
    organizationDigest: computeCanonicalDigest(organization),
    permissionsDigest: computeCanonicalDigest(permissions),
    deadline: "2026-08-24T12:00:00.000Z",
    ...overrides,
  }
  return {
    ...body,
    envelopeDigest: computeDelegationEnvelopeDigest(body),
  }
}

function executor(
  result:
    | { status: "completed"; output: SafeValue }
    | {
        status: "failed" | "cancelled"
        error: { code: string; message: string; retryable: boolean }
      } = { status: "completed", output: { answer: "evidence" } },
): DelegationChildExecutorPort {
  return {
    async run(request) {
      request.onStarted()
      request.onUsage?.({ inputTokens: 2, outputTokens: 3, totalTokens: 5 })
      return result
    },
  }
}

test("AC-005: sealed owner to direct-report envelope emits one ordered terminal", async () => {
  const envelope = parseDelegationEnvelope(sealed())
  const events: DelegationEvent[] = []
  for await (const event of executeDelegation(envelope, {
    organization,
    permissions,
    childExecutor: executor(),
    now: () => new Date("2026-08-24T10:00:00.000Z"),
    newId: (() => {
      let id = 0
      return () => `event-${++id}`
    })(),
    runId: () => "run-child",
  })) {
    events.push(event)
  }
  assert.deepEqual(
    events.map((event) => event.type),
    ["delegation.started", "delegation.usage", "delegation.completed"],
  )
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3])
  assert.equal(events.filter((event) => event.type === "delegation.completed").length, 1)
  assert.ok(
    (events.at(-1)!.payload as { outputDigest: string }).outputDigest.startsWith(
      "sha256:",
    ),
  )
})

test("AC-006: effective scope is intersection-only and parent permissions are immutable", () => {
  const before = JSON.stringify(permissions.positions["repo-owner"])
  assert.deepEqual(
    deriveEffectiveDelegationScope(
      permissions.positions["repo-owner"]!,
      permissions.positions["issue-researcher"]!,
    ),
    {
      contextRead: [
        "./context/",
        "./positions/repo-owner/issue-researcher/",
      ],
      toolAllow: ["Read"],
      toolDeny: ["Grep", "Secret"],
      writes: "deny",
      delegation: "deny",
    },
  )
  assert.equal(JSON.stringify(permissions.positions["repo-owner"]), before)
})

test("REQ-003: task.v1 initializer carries stable responsibility and digest fields", () => {
  const envelope = parseDelegationEnvelope(sealed())
  const effectiveScope = deriveEffectiveDelegationScope(
    permissions.positions["repo-owner"]!,
    permissions.positions["issue-researcher"]!,
  )
  const task = createRequestedTaskRecord(envelope, {
    parentConversationId: "conversation-parent",
    childConversationId: "conversation-child",
    effectiveScope,
    createdAt: "2026-08-24T10:00:00.000Z",
  })
  assert.equal(task.schemaVersion, "task.v1")
  assert.equal(task.status, "requested")
  assert.equal(task.delegatedBy, "repo-owner")
  assert.equal(task.routedTo, "issue-researcher")
  assert.equal(task.scopeDigest, computeCanonicalDigest(effectiveScope))
  assert.equal(task.startedAt, null)
  assert.deepEqual(task.events, [])
})

test("AC-007: invalid routes and widened shapes fail before child execution", async () => {
  const invalid = [
    sealed({ routedTo: "repo-owner" }),
    sealed({ routedTo: "unknown-worker" }),
    sealed({ routedTo: "research-assistant" }),
    sealed({ delegatedBy: "issue-researcher", routedTo: "release-engineer" }),
    sealed({ delegationDepth: 2 }),
    sealed({ routedTo: ["issue-researcher", "release-engineer"] }),
    sealed({ engine: "codex" }),
  ]
  for (const raw of invalid) {
    let calls = 0
    const childExecutor: DelegationChildExecutorPort = {
      async run() {
        calls += 1
        return { status: "completed", output: null }
      },
    }
    await assert.rejects(async () => {
      const envelope = parseDelegationEnvelope(raw)
      for await (const _event of executeDelegation(envelope, {
        organization,
        permissions,
        childExecutor,
      })) {
        // consume
      }
    }, DelegationContractError)
    assert.equal(calls, 0)
  }
})

test("AC-007: tamper, unknown fields, duplicate task and second child fail closed", () => {
  const tampered = sealed()
  tampered.instruction = "changed after sealing"
  assert.throws(() => parseDelegationEnvelope(tampered), DelegationContractError)
  assert.throws(
    () => parseDelegationEnvelope(sealed({ unexpected: true })),
    DelegationContractError,
  )

  const first = parseDelegationEnvelope(sealed())
  assert.throws(
    () =>
      validateDelegationAdmission(first, [
        {
          taskId: "task-1",
          parentTurnId: "turn-parent",
          childTurnId: "turn-child",
          attempt: 1,
          retryOfTaskId: null,
        },
      ]),
    DelegationContractError,
  )
  assert.throws(
    () =>
      validateDelegationAdmission(
        parseDelegationEnvelope(
          sealed({ taskId: "task-2", childTurnId: "turn-child-2" }),
        ),
        [
          {
            taskId: "task-1",
            parentTurnId: "turn-parent",
            childTurnId: "turn-child",
            attempt: 1,
            retryOfTaskId: null,
          },
        ],
      ),
    DelegationContractError,
  )
})

test("AC-008: explicit retry uses new identities and increments attempt", () => {
  const retry = parseDelegationEnvelope(
    sealed({
      taskId: "task-2",
      childTurnId: "turn-child-2",
      attempt: 2,
      retryOfTaskId: "task-1",
    }),
  )
  assert.doesNotThrow(() =>
    validateDelegationAdmission(retry, [
      {
        taskId: "task-1",
        parentTurnId: "turn-parent",
        childTurnId: "turn-child",
        attempt: 1,
        retryOfTaskId: null,
      },
    ]),
  )
})

test("AC-007/AC-008: retry history must be one contiguous linear chain", () => {
  const retry = parseDelegationEnvelope(
    sealed({
      taskId: "task-3",
      childTurnId: "turn-child-3",
      attempt: 3,
      retryOfTaskId: "task-2",
    }),
  )
  const first = {
    taskId: "task-1",
    parentTurnId: "turn-parent",
    childTurnId: "turn-child",
    attempt: 1,
    retryOfTaskId: null,
  }
  const second = {
    taskId: "task-2",
    parentTurnId: "turn-parent",
    childTurnId: "turn-child-2",
    attempt: 2,
    retryOfTaskId: "task-1",
  }
  assert.doesNotThrow(() => validateDelegationAdmission(retry, [first, second]))
  for (const invalid of [
    [
      first,
      second,
      {
        taskId: "task-2-branch",
        parentTurnId: "turn-parent",
        childTurnId: "turn-child-2-branch",
        attempt: 2,
        retryOfTaskId: "task-1",
      },
    ],
    [
      first,
      {
        taskId: "task-3-old",
        parentTurnId: "turn-parent",
        childTurnId: "turn-child-3-old",
        attempt: 3,
        retryOfTaskId: "task-1",
      },
    ],
    [first, { ...second, taskId: "task-1" }],
  ]) {
    assert.throws(
      () => validateDelegationAdmission(retry, invalid),
      DelegationContractError,
    )
  }
})

test("R3 transition: no started event exists until the child confirms run.started", async () => {
  const events: DelegationEvent[] = []
  await assert.rejects(async () => {
    for await (const event of executeDelegation(parseDelegationEnvelope(sealed()), {
      organization,
      permissions,
      childExecutor: {
        async run() {
          throw new Error("preflight failed before run.started")
        },
      },
    })) {
      events.push(event)
    }
  })
  assert.deepEqual(events, [])
})

test("AC-008: modeled failure and cancellation emit distinct trusted terminals", async () => {
  for (const status of ["failed", "cancelled"] as const) {
    const events = []
    for await (const event of executeDelegation(
      parseDelegationEnvelope(sealed()),
      {
        organization,
        permissions,
        childExecutor: executor({
          status,
          error: {
            code: status === "failed" ? "model.refused" : "host.cancelled",
            message: status,
            retryable: false,
          },
        }),
      },
    )) {
      events.push(event)
    }
    assert.equal(events.at(-1)!.type, `delegation.${status}`)
    assert.equal(events.filter((event) => event.type.startsWith("delegation.") && ["delegation.completed", "delegation.failed", "delegation.cancelled"].includes(event.type)).length, 1)
  }
})
