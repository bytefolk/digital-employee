import { createHash } from "node:crypto"

import {
  AGENT_HOST_CAPABILITIES,
  AGENT_HOST_PROTOCOL_VERSION,
} from "./agent-host.js"
import type {
  AgentHostAdapter,
  AgentHostEvent,
  AgentHostPolicy,
  AgentHostProbeResult,
  AgentHostRunRequest,
} from "./agent-host.js"
import { CoreError } from "./contracts.js"
import type { SafeValue } from "./contracts.js"

export const ADAPTER_QUALIFICATION_SCHEMA_ID =
  "adapter-qualification-record.v1" as const

export const ADAPTER_QUALIFICATION_KIT_VERSION = "1.0.0" as const

export const QUALIFICATION_DOMAINS = [
  "capability_negotiation",
  "native_event_validation",
  "single_terminal_outcome",
  "deadline_cancel",
  "process_tree_cleanup",
  "credential_boundaries",
  "filesystem_network_enforcement",
  "tool_mcp_enforcement",
  "output_schema",
] as const

export type QualificationDomain = (typeof QUALIFICATION_DOMAINS)[number]

export interface QualificationCaseResult {
  domain: QualificationDomain
  id: string
  passed: boolean
  /** Lowercase ASCII machine code describing the outcome. */
  code: string
}

export interface QualificationAxes {
  implemented: boolean
  fixtureConformant: boolean
  liveQualified: boolean
}

export interface QualificationLiveEvidence {
  environment: string
  evidenceDigest: string
}

export interface AdapterQualificationRecord {
  schema: typeof ADAPTER_QUALIFICATION_SCHEMA_ID
  hostId: string
  hostVersion: string
  policyDigest: string
  kitVersion: typeof ADAPTER_QUALIFICATION_KIT_VERSION
  generatedAt: string
  axes: QualificationAxes
  domains: Record<QualificationDomain, { passed: number; failed: number }>
  cases: QualificationCaseResult[]
  liveEvidence?: QualificationLiveEvidence
}

export interface QualificationOptions {
  workingDirectory: string
  generatedAt: string
  requiredCapabilities?: readonly string[]
  /**
   * Explicit opt-in live evidence. Without it the live axis stays false and
   * no provider call is ever made by the kit.
   */
  liveEvidence?: QualificationLiveEvidence
}

const HOST_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/
const HEX_64_PATTERN = /^[0-9a-f]{64}$/
const CASE_ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const ENVIRONMENT_ID_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

function qualificationError(
  code: string,
  message: string,
  details?: unknown,
): CoreError {
  return new CoreError(code, message, {
    status: 400,
    retryable: false,
    details,
  })
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")
    return `{${body}}`
  }
  return JSON.stringify(value)
}

export function canonicalPolicyDigest(policy: AgentHostPolicy): string {
  return createHash("sha256").update(canonicalJson(policy)).digest("hex")
}

function defaultQualificationPolicy(): AgentHostPolicy {
  return {
    tools: { default: "deny", allow: [{ name: "noop", mode: "read" }] },
    filesystem: { read: ["."], write: [] },
    network: { mode: "deny" },
    approval: { mode: "never" },
    maxTurns: 4,
  }
}

function qualificationRequest(
  caseId: string,
  workingDirectory: string,
  policy: AgentHostPolicy,
  outputSchema?: SafeValue,
): AgentHostRunRequest {
  return {
    runId: `qualification-${caseId}`,
    employeeId: "qualification-employee",
    workingDirectory,
    prompt: `qualification case ${caseId}`,
    policy,
    ...(outputSchema ? { outputSchema } : {}),
  }
}

async function collectEvents(
  adapter: AgentHostAdapter,
  request: AgentHostRunRequest,
): Promise<AgentHostEvent[]> {
  const events: AgentHostEvent[] = []
  for await (const event of adapter.run(request)) {
    events.push(event)
    if (events.length > 256) {
      throw qualificationError(
        "qualification_event_overflow",
        "adapter emitted more than 256 events for one qualification case",
      )
    }
  }
  return events
}

const KNOWN_EVENT_TYPES = new Set([
  "run.started",
  "assistant.delta",
  "tool.started",
  "tool.completed",
  "approval.required",
  "usage",
  "run.completed",
  "run.failed",
])

function isTerminal(event: AgentHostEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed"
}

function caseResult(
  domain: QualificationDomain,
  id: string,
  passed: boolean,
  code: string,
): QualificationCaseResult {
  return { domain, id, passed, code }
}

async function runCapabilityCase(
  adapter: AgentHostAdapter,
): Promise<QualificationCaseResult> {
  let probe: AgentHostProbeResult
  try {
    probe = await adapter.probe()
  } catch {
    return caseResult(
      "capability_negotiation",
      "probe_contract",
      false,
      "probe_unavailable",
    )
  }
  const complete = AGENT_HOST_CAPABILITIES.every(
    (capability) => probe.capabilities[capability] !== undefined,
  )
  const passed =
    probe.protocolVersion === AGENT_HOST_PROTOCOL_VERSION &&
    probe.status === "ready" &&
    probe.available &&
    probe.adapterStatus === "runnable" &&
    (probe.capabilitySource === "conformance_test" ||
      probe.capabilitySource === "adapter_declaration") &&
    complete
  return caseResult(
    "capability_negotiation",
    "probe_contract",
    passed,
    passed ? "probe_contract_ok" : "probe_contract_violation",
  )
}

async function runEventCases(
  adapter: AgentHostAdapter,
  workingDirectory: string,
  policy: AgentHostPolicy,
): Promise<QualificationCaseResult[]> {
  const results: QualificationCaseResult[] = []
  const request = qualificationRequest(
    "event_stream",
    workingDirectory,
    policy,
  )
  let events: AgentHostEvent[]
  try {
    events = await collectEvents(adapter, request)
  } catch {
    return [
      caseResult(
        "native_event_validation",
        "events_well_formed",
        false,
        "event_stream_unavailable",
      ),
      caseResult(
        "single_terminal_outcome",
        "exactly_one_terminal",
        false,
        "event_stream_unavailable",
      ),
    ]
  }

  const wellFormed = events.every(
    (event) =>
      event.runId === request.runId &&
      typeof event.timestamp === "string" &&
      ISO_PATTERN.test(event.timestamp) &&
      KNOWN_EVENT_TYPES.has(event.type),
  )
  results.push(
    caseResult(
      "native_event_validation",
      "events_well_formed",
      wellFormed,
      wellFormed ? "events_well_formed_ok" : "malformed_native_event",
    ),
  )

  const terminals = events.filter(isTerminal)
  const terminalLast =
    terminals.length > 0 && isTerminal(events[events.length - 1])
  const passed = terminals.length === 1 && terminalLast
  results.push(
    caseResult(
      "single_terminal_outcome",
      "exactly_one_terminal",
      passed,
      passed
        ? "single_terminal_ok"
        : terminals.length === 0
          ? "missing_terminal_event"
          : terminals.length > 1
            ? "duplicate_terminal_event"
            : "event_after_terminal",
    ),
  )
  return results
}

async function runCancelCase(
  adapter: AgentHostAdapter,
  workingDirectory: string,
  policy: AgentHostPolicy,
): Promise<QualificationCaseResult> {
  const request = qualificationRequest("cancel", workingDirectory, policy)
  let events: AgentHostEvent[]
  try {
    if (typeof adapter.cancel === "function") {
      void Promise.resolve(adapter.cancel(request.runId)).catch(() => {})
    }
    events = await collectEvents(adapter, request)
  } catch {
    return caseResult(
      "deadline_cancel",
      "cancel_stops_run",
      false,
      "cancel_path_unavailable",
    )
  }
  const terminals = events.filter(isTerminal)
  const passed =
    terminals.length === 1 && isTerminal(events[events.length - 1])
  return caseResult(
    "deadline_cancel",
    "cancel_stops_run",
    passed,
    passed ? "cancel_stops_run_ok" : "cancel_leaves_stream_open",
  )
}

async function runCleanupCase(
  adapter: AgentHostAdapter,
  workingDirectory: string,
  policy: AgentHostPolicy,
): Promise<QualificationCaseResult> {
  const request = qualificationRequest("cleanup", workingDirectory, policy)
  try {
    const events = await collectEvents(adapter, request)
    if (events.length === 0 || !isTerminal(events[events.length - 1])) {
      return caseResult(
        "process_tree_cleanup",
        "stream_terminates",
        false,
        "stream_not_terminated",
      )
    }
    if (typeof adapter.cancel === "function") {
      await adapter.cancel(request.runId)
      await adapter.cancel(request.runId)
    }
    return caseResult(
      "process_tree_cleanup",
      "stream_terminates",
      true,
      "stream_terminates_ok",
    )
  } catch {
    return caseResult(
      "process_tree_cleanup",
      "stream_terminates",
      false,
      "cleanup_path_threw",
    )
  }
}

const QUALIFICATION_SENTINEL = "qualification-sentinel-do-not-leak"

async function runCredentialCase(
  adapter: AgentHostAdapter,
  workingDirectory: string,
  policy: AgentHostPolicy,
): Promise<QualificationCaseResult> {
  const request: AgentHostRunRequest = {
    ...qualificationRequest("credential", workingDirectory, policy),
    metadata: { qualificationSentinel: QUALIFICATION_SENTINEL },
  }
  try {
    const events = await collectEvents(adapter, request)
    const leaked = events.some((event) =>
      JSON.stringify(event).includes(QUALIFICATION_SENTINEL),
    )
    return caseResult(
      "credential_boundaries",
      "no_metadata_echo",
      !leaked,
      leaked ? "metadata_secret_echoed" : "no_metadata_echo_ok",
    )
  } catch {
    return caseResult(
      "credential_boundaries",
      "no_metadata_echo",
      false,
      "credential_case_unavailable",
    )
  }
}

async function runEnforcementCases(
  adapter: AgentHostAdapter,
  workingDirectory: string,
  policy: AgentHostPolicy,
): Promise<QualificationCaseResult[]> {
  const results: QualificationCaseResult[] = []

  const hostileFsRequest = qualificationRequest(
    "filesystem_enforcement",
    workingDirectory,
    {
      ...policy,
      filesystem: { read: ["."], write: ["/etc"] },
      network: { mode: "deny" },
    },
  )
  let fsRefused = false
  try {
    await adapter.preflight(hostileFsRequest)
  } catch {
    fsRefused = true
  }
  results.push(
    caseResult(
      "filesystem_network_enforcement",
      "hostile_write_refused",
      fsRefused,
      fsRefused ? "hostile_write_refused_ok" : "hostile_write_accepted",
    ),
  )

  const toolRequest = qualificationRequest(
    "tool_enforcement",
    workingDirectory,
    policy,
  )
  try {
    const events = await collectEvents(adapter, toolRequest)
    const allowed = new Set(policy.tools.allow.map((entry) => entry.name))
    const violation = events.some(
      (event) =>
        (event.type === "tool.started" || event.type === "tool.completed") &&
        !allowed.has(event.toolName),
    )
    results.push(
      caseResult(
        "tool_mcp_enforcement",
        "tool_allowlist_respected",
        !violation,
        violation ? "disallowed_tool_event" : "tool_allowlist_respected_ok",
      ),
    )
  } catch {
    results.push(
      caseResult(
        "tool_mcp_enforcement",
        "tool_allowlist_respected",
        false,
        "tool_case_unavailable",
      ),
    )
  }
  return results
}

async function runOutputSchemaCase(
  adapter: AgentHostAdapter,
  workingDirectory: string,
  policy: AgentHostPolicy,
): Promise<QualificationCaseResult> {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  }
  const request = qualificationRequest(
    "output_schema",
    workingDirectory,
    policy,
    schema,
  )
  try {
    const events = await collectEvents(adapter, request)
    const terminal = events.filter(isTerminal)
    if (terminal.length !== 1 || terminal[0].type !== "run.completed") {
      return caseResult(
        "output_schema",
        "terminal_output_matches_schema",
        false,
        "no_completed_terminal",
      )
    }
    const output = terminal[0].output as Record<string, unknown>
    const keys =
      output && typeof output === "object" && !Array.isArray(output)
        ? Object.keys(output)
        : []
    const matches =
      keys.length === 1 &&
      keys[0] === "answer" &&
      typeof output.answer === "string"
    return caseResult(
      "output_schema",
      "terminal_output_matches_schema",
      matches,
      matches ? "output_schema_ok" : "output_schema_violation",
    )
  } catch {
    return caseResult(
      "output_schema",
      "terminal_output_matches_schema",
      false,
      "output_schema_case_unavailable",
    )
  }
}

export async function runQualificationSuite(
  adapter: AgentHostAdapter,
  options: QualificationOptions,
): Promise<AdapterQualificationRecord> {
  if (!HOST_ID_PATTERN.test(adapter.hostId)) {
    throw qualificationError(
      "INVALID_QUALIFICATION_HOST_ID",
      "adapter hostId must be a lowercase ASCII identifier",
    )
  }
  if (!ISO_PATTERN.test(options.generatedAt)) {
    throw qualificationError(
      "INVALID_QUALIFICATION_TIMESTAMP",
      "generatedAt must be an ISO-8601 UTC timestamp",
    )
  }

  const policy = defaultQualificationPolicy()
  const cases: QualificationCaseResult[] = []
  cases.push(await runCapabilityCase(adapter))
  cases.push(
    ...(await runEventCases(adapter, options.workingDirectory, policy)),
  )
  cases.push(
    await runCancelCase(adapter, options.workingDirectory, policy),
  )
  cases.push(
    await runCleanupCase(adapter, options.workingDirectory, policy),
  )
  cases.push(
    await runCredentialCase(adapter, options.workingDirectory, policy),
  )
  cases.push(
    ...(await runEnforcementCases(
      adapter,
      options.workingDirectory,
      policy,
    )),
  )
  cases.push(
    await runOutputSchemaCase(adapter, options.workingDirectory, policy),
  )

  let probe: AgentHostProbeResult | undefined
  try {
    probe = await adapter.probe()
  } catch {
    probe = undefined
  }
  const implemented =
    probe !== undefined &&
    probe.protocolVersion === AGENT_HOST_PROTOCOL_VERSION &&
    probe.status === "ready" &&
    probe.available &&
    probe.adapterStatus === "runnable" &&
    AGENT_HOST_CAPABILITIES.every(
      (capability) => probe!.capabilities[capability] !== undefined,
    )

  const fixtureConformant =
    implemented && cases.every((result) => result.passed)
  // Project to the frozen two-field shape so callers cannot smuggle extra
  // keys (credentials, paths) into the published record.
  const liveEvidence =
    options.liveEvidence === undefined
      ? undefined
      : {
          environment: options.liveEvidence.environment,
          evidenceDigest: options.liveEvidence.evidenceDigest,
        }
  const liveQualified = liveEvidence !== undefined
  if (liveQualified) {
    if (
      !ENVIRONMENT_ID_PATTERN.test(liveEvidence.environment) ||
      !HEX_64_PATTERN.test(liveEvidence.evidenceDigest)
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_LIVE_EVIDENCE",
        "live evidence requires an environment id and a sha256 digest",
      )
    }
  }

  const domains = {} as Record<
    QualificationDomain,
    { passed: number; failed: number }
  >
  for (const domain of QUALIFICATION_DOMAINS) {
    const domainCases = cases.filter((result) => result.domain === domain)
    domains[domain] = {
      passed: domainCases.filter((result) => result.passed).length,
      failed: domainCases.filter((result) => !result.passed).length,
    }
  }

  const record: AdapterQualificationRecord = {
    schema: ADAPTER_QUALIFICATION_SCHEMA_ID,
    hostId: adapter.hostId,
    hostVersion: probe?.version ?? "unknown",
    policyDigest: canonicalPolicyDigest(policy),
    kitVersion: ADAPTER_QUALIFICATION_KIT_VERSION,
    generatedAt: options.generatedAt,
    axes: { implemented, fixtureConformant, liveQualified },
    domains,
    cases,
    ...(liveEvidence !== undefined ? { liveEvidence } : {}),
  }
  validateAdapterQualificationRecord(record)
  return record
}

export function validateAdapterQualificationRecord(
  value: unknown,
): AdapterQualificationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "qualification record must be an object",
    )
  }
  const record = value as Record<string, unknown>
  const allowed = new Set([
    "schema",
    "hostId",
    "hostVersion",
    "policyDigest",
    "kitVersion",
    "generatedAt",
    "axes",
    "domains",
    "cases",
    "liveEvidence",
  ])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        `unknown qualification record field: ${key}`,
      )
    }
  }
  if (record.schema !== ADAPTER_QUALIFICATION_SCHEMA_ID) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      `schema must be ${ADAPTER_QUALIFICATION_SCHEMA_ID}`,
    )
  }
  if (
    typeof record.hostId !== "string" ||
    !HOST_ID_PATTERN.test(record.hostId)
  ) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "hostId must be a lowercase ASCII identifier",
    )
  }
  if (typeof record.hostVersion !== "string" || record.hostVersion === "") {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "hostVersion is required",
    )
  }
  if (
    typeof record.policyDigest !== "string" ||
    !HEX_64_PATTERN.test(record.policyDigest)
  ) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "policyDigest must be a sha256 hex digest",
    )
  }
  if (record.kitVersion !== ADAPTER_QUALIFICATION_KIT_VERSION) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      `kitVersion must be ${ADAPTER_QUALIFICATION_KIT_VERSION}`,
    )
  }
  if (
    typeof record.generatedAt !== "string" ||
    !ISO_PATTERN.test(record.generatedAt)
  ) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "generatedAt must be an ISO-8601 UTC timestamp",
    )
  }

  const axes = record.axes as Record<string, unknown> | undefined
  if (
    !axes ||
    typeof axes !== "object" ||
    Array.isArray(axes) ||
    Object.keys(axes).some(
      (key) =>
        key !== "implemented" &&
        key !== "fixtureConformant" &&
        key !== "liveQualified",
    ) ||
    typeof axes.implemented !== "boolean" ||
    typeof axes.fixtureConformant !== "boolean" ||
    typeof axes.liveQualified !== "boolean"
  ) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "axes must carry three booleans",
    )
  }
  if (axes.fixtureConformant && !axes.implemented) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "fixtureConformant requires implemented",
    )
  }
  if (axes.liveQualified && record.liveEvidence === undefined) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "liveQualified requires explicit liveEvidence",
    )
  }
  if (record.liveEvidence !== undefined) {
    const evidence = record.liveEvidence as Record<string, unknown> | null
    if (
      !evidence ||
      typeof evidence !== "object" ||
      Array.isArray(evidence) ||
      Object.keys(evidence).some(
        (key) => key !== "environment" && key !== "evidenceDigest",
      ) ||
      typeof evidence.environment !== "string" ||
      !ENVIRONMENT_ID_PATTERN.test(evidence.environment) ||
      typeof evidence.evidenceDigest !== "string" ||
      !HEX_64_PATTERN.test(evidence.evidenceDigest)
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        "liveEvidence requires an environment id and a sha256 digest",
      )
    }
  }

  const domains = record.domains as
    | Record<string, unknown>
    | undefined
  if (!domains || typeof domains !== "object" || Array.isArray(domains)) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "domains is required",
    )
  }
  for (const key of Object.keys(domains)) {
    if (!(QUALIFICATION_DOMAINS as readonly string[]).includes(key)) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        `unknown qualification domain: ${key}`,
      )
    }
  }
  for (const domain of QUALIFICATION_DOMAINS) {
    const entry = domains[domain] as Record<string, unknown> | undefined
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some((key) => key !== "passed" && key !== "failed") ||
      typeof entry.passed !== "number" ||
      !Number.isInteger(entry.passed) ||
      entry.passed < 0 ||
      typeof entry.failed !== "number" ||
      !Number.isInteger(entry.failed) ||
      entry.failed < 0
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        `domain ${domain} must report passed/failed counts`,
      )
    }
  }

  if (!Array.isArray(record.cases) || record.cases.length === 0) {
    throw qualificationError(
      "INVALID_QUALIFICATION_RECORD",
      "cases must be a non-empty array",
    )
  }
  const seenDomains = new Set<string>()
  for (const entry of record.cases as Array<Record<string, unknown>>) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).some(
        (key) =>
          key !== "domain" &&
          key !== "id" &&
          key !== "passed" &&
          key !== "code",
      )
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        "unknown qualification case field",
      )
    }
    if (
      typeof entry.domain !== "string" ||
      !(QUALIFICATION_DOMAINS as readonly string[]).includes(entry.domain)
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        "every case must declare a known domain",
      )
    }
    if (
      typeof entry.id !== "string" ||
      !CASE_ID_PATTERN.test(entry.id)
    ) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        "case ids must be lowercase snake_case",
      )
    }
    if (typeof entry.passed !== "boolean") {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        "every case must report a boolean result",
      )
    }
    if (typeof entry.code !== "string" || entry.code === "") {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        "every case must report a machine code",
      )
    }
    seenDomains.add(entry.domain)
  }
  for (const domain of QUALIFICATION_DOMAINS) {
    if (!seenDomains.has(domain)) {
      throw qualificationError(
        "INVALID_QUALIFICATION_RECORD",
        `cases must cover domain ${domain}`,
      )
    }
  }
  return value as AdapterQualificationRecord
}
