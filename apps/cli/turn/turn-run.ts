/**
 * `turn run` spawn surface (#173 REQ-001/REQ-003/REQ-004/REQ-005, OQ-1).
 *
 * Projects the merged engine core onto a stable CLI wire surface for
 * cross-product clients: sealed turn-envelope.v1 in, NDJSON engine.v1
 * events out, exactly one trusted terminal, unambiguous exit codes.
 * Engine-internal contracts are consumed, never changed.
 *
 * Exit-code semantics (#102 crash discipline):
 *   0 = exactly one trusted terminal reached (completed, or a modeled
 *       run.failed such as budget-exceeded/doom-loop: a governance
 *       verdict, not a crash)
 *   1 = spawn/process-level failure — no terminal emitted (malformed or
 *       digest-mismatched envelope, missing model credentials, internal
 *       crash). Clients treat exit 1 as indeterminate: no automatic retry;
 *       an explicit retry is a new attempt.
 */

import { randomUUID } from "node:crypto"
import { lstat } from "node:fs/promises"
import path from "node:path"

import {
  createInMemoryBudgetLedger,
  createInMemoryEscalationSink,
  createInMemoryEvidenceSink,
} from "../../../packages/engine/src/index.js"
import {
  createDeterministicModelPort,
  type ModelPort,
} from "../../../packages/engine/src/model-port.js"
import type { EngineTurnRequest } from "../../../packages/engine/src/contracts.js"
import { createClaudeLocalModelPort, probeLocalClaude } from "./claude-local-model-port.js"
import { executeTurn } from "../../../packages/engine/src/turn-executor.js"
import { loadOrgModel } from "../org/model.js"
import {
  parseTurnEnvelope,
  TurnEnvelopeError,
  TURN_ENGINE_CLAUDE_COMMAND_ENV,
  TURN_ENGINE_MODEL_ENV,
  TURN_ENGINE_MODEL_SCRIPT_ENV,
  type TurnEnvelope,
} from "./envelope.js"

const MAX_STDERR_DIAGNOSTIC_BYTES = 8 * 1024

export interface TurnRunOptions {
  workspace: string
  positionId: string
  /** Raw envelope JSON text read from --stdin or --input-file. */
  envelopeText: string
  writeEvent?: (line: string) => void
  writeDiagnostic?: (line: string) => void
  /** Test seams. */
  env?: NodeJS.ProcessEnv
  model?: ModelPort
  now?: () => Date
  newId?: () => string
}

export interface TurnRunResult {
  exitCode: 0 | 1
  /** True when exactly one trusted terminal event was emitted. */
  terminalEmitted: boolean
}

class TurnSpawnError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "TurnSpawnError"
  }
}

function resolveModelPort(env: NodeJS.ProcessEnv): ModelPort {
  const engine = env[TURN_ENGINE_MODEL_ENV]
  if (engine === undefined || engine.trim().length === 0) {
    throw new TurnSpawnError(
      "engine.model_unavailable",
      `no model port configured: set ${TURN_ENGINE_MODEL_ENV} via the environment allowlist`,
    )
  }
  if (engine === "deterministic") {
    // Zero-credential reference port: replays a scripted JSON string array
    // for fixtures and acceptance. Never pretends to be an online model.
    const scriptRaw = env[TURN_ENGINE_MODEL_SCRIPT_ENV]
    if (!scriptRaw) {
      throw new TurnSpawnError(
        "engine.model_unavailable",
        `deterministic model port requires ${TURN_ENGINE_MODEL_SCRIPT_ENV} (JSON string array)`,
      )
    }
    let script: unknown
    try {
      script = JSON.parse(scriptRaw)
    } catch {
      throw new TurnSpawnError(
        "engine.model_unavailable",
        `${TURN_ENGINE_MODEL_SCRIPT_ENV} must be a JSON string array`,
      )
    }
    if (
      !Array.isArray(script) ||
      script.some((entry) => typeof entry !== "string")
    ) {
      throw new TurnSpawnError(
        "engine.model_unavailable",
        `${TURN_ENGINE_MODEL_SCRIPT_ENV} must be a JSON string array`,
      )
    }
    return createDeterministicModelPort(script as string[])
  }
  if (engine === "claude-local") {
    // Local-operator port (#182): drives the operator's already-authenticated
    // Claude Code install, so no service credential is read or required. Local
    // interactive use only — see claude-local-model-port.ts for the boundary.
    const command = env[TURN_ENGINE_CLAUDE_COMMAND_ENV]?.trim() || "claude"
    // A missing or out-of-window binary is an environment fault: surface it
    // here so it maps to exit 1, instead of letting the engine model it as a
    // failed turn and report exit 0.
    const unusable = probeLocalClaude(command)
    if (unusable !== undefined) {
      throw new TurnSpawnError(
        "engine.model_unavailable",
        `${unusable}: the local Claude Code binary (${command}) is missing or outside the supported version window`,
      )
    }
    return createClaudeLocalModelPort({ command, environment: env })
  }
  throw new TurnSpawnError(
    "engine.model_unavailable",
    `unknown engine model port: ${engine}`,
  )
}

async function assertWorkspaceRef(
  workspace: string,
  envelope: TurnEnvelope,
): Promise<void> {
  let stat
  try {
    stat = await lstat(workspace)
  } catch {
    throw new TurnSpawnError(
      "engine.workspace_invalid",
      `workspace directory not found: ${workspace}`,
    )
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TurnSpawnError(
      "engine.workspace_invalid",
      `workspace must be a real directory: ${workspace}`,
    )
  }
  // The workspace must carry the organization model marker; a spawn turn
  // against an uninitialized workspace fails closed.
  try {
    await loadOrgModel(workspace)
  } catch (error) {
    const code =
      error instanceof TypeError ? error.message : "engine.workspace_invalid"
    throw new TurnSpawnError(
      code.startsWith("workspace_org_") ? code : "engine.workspace_invalid",
      `workspace organization model unavailable: ${code}`,
    )
  }
  if (path.resolve(envelope.workspaceRef) !== path.resolve(workspace)) {
    throw new TurnSpawnError(
      "engine.input_invalid",
      "envelope workspaceRef does not match the workspace argument",
    )
  }
}

function boundedDiagnostic(line: string): string {
  const buffer = Buffer.from(line, "utf8")
  if (buffer.byteLength <= MAX_STDERR_DIAGNOSTIC_BYTES) return line
  return `${buffer.subarray(0, MAX_STDERR_DIAGNOSTIC_BYTES).toString("utf8")}…`
}

/**
 * Execute the spawn surface. Emits one NDJSON `engine.v1` event per stdout
 * line; diagnostics are bounded and go to stderr only.
 */
export async function runTurn(options: TurnRunOptions): Promise<TurnRunResult> {
  const env = options.env ?? process.env
  const writeEvent =
    options.writeEvent ?? ((line: string) => process.stdout.write(`${line}\n`))
  const writeDiagnostic =
    options.writeDiagnostic ??
    ((line: string) =>
      process.stderr.write(`${boundedDiagnostic(line)}\n`))

  const failSpawn = (code: string, message: string): TurnRunResult => {
    writeDiagnostic(`digital-employee: ${code}: ${message}`)
    return { exitCode: 1, terminalEmitted: false }
  }

  let envelope: TurnEnvelope
  try {
    envelope = parseTurnEnvelope(JSON.parse(options.envelopeText))
  } catch (error) {
    if (error instanceof TurnEnvelopeError) {
      return failSpawn(error.code, error.message)
    }
    return failSpawn("engine.envelope_invalid", "envelope is not valid JSON")
  }

  if (envelope.positionId !== options.positionId) {
    return failSpawn(
      "engine.input_invalid",
      "envelope positionId does not match the --position argument",
    )
  }

  try {
    await assertWorkspaceRef(options.workspace, envelope)
  } catch (error) {
    if (error instanceof TurnSpawnError) {
      return failSpawn(error.code, error.message)
    }
    throw error
  }

  let model: ModelPort
  try {
    model = options.model ?? resolveModelPort(env)
  } catch (error) {
    if (error instanceof TurnSpawnError) {
      return failSpawn(error.code, error.message)
    }
    throw error
  }

  const request: EngineTurnRequest = {
    workspaceRef: envelope.workspaceRef,
    positionId: envelope.positionId,
    turnId: envelope.turnId,
    runId: randomUUID(),
    input: envelope.input,
    budget: envelope.budget ?? { maxIterations: 1 },
    ...(envelope.positionBudget !== undefined
      ? {
          positionBudget: envelope.positionBudget,
          taskId: envelope.taskId,
          dayKey: envelope.dayKey,
        }
      : {}),
    ...(envelope.deadline !== undefined
      ? { deadline: envelope.deadline }
      : {}),
  }

  const escalationSink = createInMemoryEscalationSink()
  const evidenceSink = createInMemoryEvidenceSink()

  let terminalEmitted = false
  try {
    for await (const event of executeTurn(request, {
      model,
      budgetLedger: createInMemoryBudgetLedger(),
      escalationSink,
      evidenceSink,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.newId !== undefined ? { newId: options.newId } : {}),
    })) {
      writeEvent(JSON.stringify(event))
      if (event.type === "run.completed" || event.type === "run.failed") {
        terminalEmitted = true
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "engine crash"
    return failSpawn("engine.internal_error", message)
  }

  if (!terminalEmitted) {
    return failSpawn(
      "engine.internal_error",
      "turn ended without a terminal event",
    )
  }
  return { exitCode: 0, terminalEmitted: true }
}
