/**
 * `task delegate` spawn boundary for #158 R3 / #165 R4 S3-P0.
 *
 * The Workbench owns task persistence and orchestration. This module owns the
 * portable envelope/event contract, applied-state revalidation, effective
 * scope derivation and one child Host run. Any protocol/process uncertainty
 * exits without a trusted terminal so the Workbench can record indeterminate.
 */

import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"

import type { AgentHostRegistryPort } from "../../../packages/core/src/agent-host-registry.js"
import type {
  AgentHostEvent,
  AgentHostPolicy,
} from "../../../packages/core/src/agent-host.js"
import {
  DelegationContractError,
  executeDelegation,
  parseDelegationEnvelope,
  parseExistingDelegationHistory,
  type DelegationChildExecutorPort,
  type DelegationOrganization,
  type DelegationPermissions,
  type ExistingDelegationRef,
} from "../../../packages/engine/src/delegation.js"
import { runEmployeePackage } from "../agent-run.js"
import {
  ORG_MODEL_FILE,
  ORG_PERMISSIONS_FILE,
  ORG_STATE_DIR,
} from "../org/model.js"
import { validateOrganizationDocument } from "../org/budget.js"
import { deriveOrganizationPermissions } from "../org/permissions.js"

const MAX_STDERR_DIAGNOSTIC_BYTES = 8 * 1024
const MAX_APPLIED_STATE_BYTES = 4 * 1024 * 1024
const MAX_HISTORY_BYTES = 4 * 1024 * 1024

export interface DelegationRunOptions {
  workspace: string
  envelopeText: string
  /** Trusted Workbench-owned snapshot; CLI supplies it from --history-file. */
  historyText?: string
  writeEvent?: (line: string) => void
  writeDiagnostic?: (line: string) => void
  /** Deterministic E3 seam. Production calls omit this. */
  childExecutor?: DelegationChildExecutorPort
  hostRegistry?: AgentHostRegistryPort
  now?: () => Date
  newId?: () => string
  runId?: () => string
  signal?: AbortSignal
}

export interface DelegationRunResult {
  exitCode: 0 | 1
  terminalEmitted: boolean
}

function boundedDiagnostic(line: string): string {
  const bytes = Buffer.from(line, "utf8")
  if (bytes.byteLength <= MAX_STDERR_DIAGNOSTIC_BYTES) return line
  return `${bytes.subarray(0, MAX_STDERR_DIAGNOSTIC_BYTES).toString("utf8")}…`
}

async function readPrivateJson(file: string, code: string): Promise<unknown> {
  let stat
  try {
    stat = await lstat(file)
  } catch {
    throw new DelegationContractError(code, "applied state file is unavailable")
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_APPLIED_STATE_BYTES
  ) {
    throw new DelegationContractError(code, "applied state must be a real file")
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown
  } catch {
    throw new DelegationContractError(code, "applied state is not valid JSON")
  }
}

async function loadAppliedState(workspace: string): Promise<{
  organization: DelegationOrganization
  permissions: DelegationPermissions
}> {
  const resolved = path.resolve(workspace)
  let workspaceStat
  try {
    workspaceStat = await lstat(resolved)
  } catch {
    throw new DelegationContractError(
      "delegation.workspace_invalid",
      "workspace is unavailable",
    )
  }
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new DelegationContractError(
      "delegation.workspace_invalid",
      "workspace must be a real directory",
    )
  }
  const state = path.join(resolved, ORG_STATE_DIR)
  let stateStat
  try {
    stateStat = await lstat(state)
  } catch {
    throw new DelegationContractError(
      "delegation.organization_unapplied",
      "applied state directory is unavailable",
    )
  }
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    throw new DelegationContractError(
      "delegation.organization_invalid",
      "applied state directory must be a real directory",
    )
  }
  const rawOrganization = await readPrivateJson(
    path.join(state, ORG_MODEL_FILE),
    "delegation.organization_unapplied",
  )
  const rawPermissions = await readPrivateJson(
    path.join(state, ORG_PERMISSIONS_FILE),
    "delegation.permissions_unapplied",
  )
  let validated
  try {
    validated = validateOrganizationDocument(rawOrganization)
  } catch {
    throw new DelegationContractError(
      "delegation.organization_invalid",
      "applied organization failed validation",
    )
  }
  const expectedPermissions = deriveOrganizationPermissions(validated)
  if (JSON.stringify(rawPermissions) !== JSON.stringify(expectedPermissions)) {
    throw new DelegationContractError(
      "delegation.permissions_invalid",
      "applied permissions do not match the organization",
    )
  }
  return {
    organization: rawOrganization as DelegationOrganization,
    permissions: rawPermissions as DelegationPermissions,
  }
}

function isInfrastructureUncertainty(code: string): boolean {
  return (
    code.startsWith("agent_host_") ||
    code === "employee_package_digest_mismatch" ||
    code === "employee_input_schema_invalid" ||
    code === "employee_input_schema_mismatch" ||
    code === "employee_input_not_json" ||
    code === "employee_output_schema_invalid"
  )
}

async function assertPackageInsideWorkspace(
  workspace: string,
  packageDirectory: string,
): Promise<{ workspaceReal: string; workspaceAssetPrefix: string }> {
  let packageStat
  try {
    packageStat = await lstat(packageDirectory)
  } catch {
    throw new DelegationContractError(
      "delegation.worker_package_invalid",
      "worker package is unavailable",
    )
  }
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
    throw new DelegationContractError(
      "delegation.worker_package_invalid",
      "worker package must be a real directory",
    )
  }
  let workspaceReal: string
  let packageReal: string
  try {
    ;[workspaceReal, packageReal] = await Promise.all([
      realpath(workspace),
      realpath(packageDirectory),
    ])
  } catch {
    throw new DelegationContractError(
      "delegation.worker_package_invalid",
      "worker package is unavailable",
    )
  }
  const relative = path.relative(workspaceReal, packageReal)
  if (
    relative.length === 0 ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new DelegationContractError(
      "delegation.worker_package_invalid",
      "worker package must remain inside the workspace",
    )
  }
  return {
    workspaceReal,
    workspaceAssetPrefix: `./${relative.split(path.sep).join("/")}`,
  }
}

function projectEffectiveHostPolicy(
  contextRead: readonly string[],
  toolAllow: readonly string[],
): AgentHostPolicy {
  const known = new Set(["Read", "Grep", "Glob"])
  if (toolAllow.some((tool) => !known.has(tool))) {
    throw new DelegationContractError(
      "delegation.authority_unexpressible",
      "effective authority contains a tool outside the Host projection",
    )
  }
  const allow: AgentHostPolicy["tools"]["allow"] = []
  if (toolAllow.includes("Read")) {
    allow.push({ name: "filesystem.read", mode: "read" })
  }
  if (toolAllow.includes("Grep") || toolAllow.includes("Glob")) {
    allow.push({ name: "filesystem.search", mode: "read" })
  }
  const filesystemRead =
    allow.length === 0
      ? []
      : contextRead.map((scope) =>
          scope === "./" ? "./**" : `${scope.replace(/\/$/, "")}/**`,
        )
  return {
    tools: { default: "deny", allow },
    filesystem: { read: filesystemRead, write: [] },
    network: { mode: "deny" },
    approval: { mode: "never" },
  }
}

function createHostChildExecutor(options: {
  workspace: string
  organization: DelegationOrganization
  hostRegistry?: AgentHostRegistryPort
}): DelegationChildExecutorPort {
  return {
    async run(request) {
      const role = options.organization.roles.find(
        (entry) => entry.id === request.positionId,
      ) as
        | {
            package?: { localReference?: unknown; digest?: unknown }
          }
        | undefined
      if (
        !role ||
        typeof role.package?.localReference !== "string" ||
        typeof role.package.digest !== "string"
      ) {
        throw new DelegationContractError(
          "delegation.worker_package_invalid",
          "worker package binding is missing",
        )
      }
      const projection = await assertPackageInsideWorkspace(
        options.workspace,
        role.package.localReference,
      )
      const policy = projectEffectiveHostPolicy(
        request.effectiveScope.contextRead,
        request.effectiveScope.toolAllow,
      )
      let started = false
      const result = await runEmployeePackage({
        directory: role.package.localReference,
        engine: request.engine,
        ...(options.hostRegistry ? { hostRegistry: options.hostRegistry } : {}),
        input: { message: request.instruction },
        runId: request.runId,
        expectedPackageDigest: role.package.digest,
        deadline: request.deadline,
        hostRequestProjection: {
          workingDirectory: projection.workspaceReal,
          workspaceAssetPrefix: projection.workspaceAssetPrefix,
          policy,
          mcp: "deny",
        },
        ...(request.signal ? { signal: request.signal } : {}),
        onEvent(event: AgentHostEvent) {
          if (event.type === "run.started") {
            if (started) {
              throw new DelegationContractError(
                "delegation.child_protocol_invalid",
                "child Host emitted duplicate run.started events",
              )
            }
            started = true
            request.onStarted()
            return
          }
          if (event.type === "usage") {
            if (!started) {
              throw new DelegationContractError(
                "delegation.child_protocol_invalid",
                "child Host emitted usage before run.started",
              )
            }
            request.onUsage?.({
              ...(event.inputTokens !== undefined
                ? { inputTokens: event.inputTokens }
                : {}),
              ...(event.outputTokens !== undefined
                ? { outputTokens: event.outputTokens }
                : {}),
              ...(event.totalTokens !== undefined
                ? { totalTokens: event.totalTokens }
                : {}),
            })
          }
        },
      })
      if (!started) {
        throw new DelegationContractError(
          "delegation.child_indeterminate",
          "child Host settled without run.started",
        )
      }
      if (result.status === "completed") {
        return { status: "completed", output: result.output }
      }
      if (result.error.code === "agent_host_cancelled") {
        return { status: "cancelled", error: result.error }
      }
      if (isInfrastructureUncertainty(result.error.code)) {
        throw new DelegationContractError(
          "delegation.child_indeterminate",
          "child Host did not produce a trusted terminal",
        )
      }
      return { status: "failed", error: result.error }
    },
  }
}

export async function runDelegation(
  options: DelegationRunOptions,
): Promise<DelegationRunResult> {
  const writeEvent =
    options.writeEvent ?? ((line: string) => process.stdout.write(`${line}\n`))
  const writeDiagnostic =
    options.writeDiagnostic ??
    ((line: string) => process.stderr.write(`${boundedDiagnostic(line)}\n`))
  let terminalEmitted = false
  try {
    let raw: unknown
    try {
      raw = JSON.parse(options.envelopeText) as unknown
    } catch {
      throw new DelegationContractError(
        "delegation.envelope_invalid",
        "delegation envelope is not valid JSON",
      )
    }
    const envelope = parseDelegationEnvelope(raw)
    let existingDelegations: ExistingDelegationRef[]
    if (options.historyText === undefined) {
      existingDelegations = []
    } else {
      if (Buffer.byteLength(options.historyText, "utf8") > MAX_HISTORY_BYTES) {
        throw new DelegationContractError(
          "delegation.history_invalid",
          "delegation history exceeds the bounded byte limit",
        )
      }
      let rawHistory: unknown
      try {
        rawHistory = JSON.parse(options.historyText) as unknown
      } catch {
        throw new DelegationContractError(
          "delegation.history_invalid",
          "delegation history is not valid JSON",
        )
      }
      existingDelegations = parseExistingDelegationHistory(rawHistory)
    }
    const { organization, permissions } = await loadAppliedState(
      options.workspace,
    )
    const childExecutor =
      options.childExecutor ??
      createHostChildExecutor({
        workspace: path.resolve(options.workspace),
        organization,
        ...(options.hostRegistry ? { hostRegistry: options.hostRegistry } : {}),
      })
    for await (const event of executeDelegation(envelope, {
      organization,
      permissions,
      childExecutor,
      existingDelegations,
      ...(options.now ? { now: options.now } : {}),
      ...(options.newId ? { newId: options.newId } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      writeEvent(JSON.stringify(event))
      if (
        event.type === "delegation.completed" ||
        event.type === "delegation.failed" ||
        event.type === "delegation.cancelled"
      ) {
        terminalEmitted = true
      }
    }
  } catch (error) {
    const code =
      error instanceof DelegationContractError
        ? error.code
        : "delegation.child_indeterminate"
    writeDiagnostic(`digital-employee: ${code}`)
    return { exitCode: 1, terminalEmitted: false }
  }
  if (!terminalEmitted) {
    writeDiagnostic("digital-employee: delegation.child_indeterminate")
    return { exitCode: 1, terminalEmitted: false }
  }
  return { exitCode: 0, terminalEmitted: true }
}
