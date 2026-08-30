/**
 * `digital-employee turn` command surface (#173 REQ-001). Subcommand:
 *
 *   turn run [workspace] --position <id>
 *     (--stdin | --input-file <path> | --question "<text>")
 *
 * The spawn surface carries exactly one input source — the sealed
 * turn-envelope.v1/v1alpha2 JSON — and one output discipline: NDJSON
 * engine.v1 events on stdout, bounded diagnostics on stderr. `--json` is
 * rejected because the NDJSON stream IS the machine surface; a second
 * formatting mode would fork the contract.
 *
 * `--question` is a purely additive usability sugar: when supplied, the
 * CLI auto-builds a minimal v1alpha2 envelope (absolute workspaceRef, the
 * --position value, a fresh turnId, `input.message = <question>`, and a
 * conservative iteration budget) and digest-seals it with the existing
 * `computeEnvelopeDigest`. It does not change the wire schema, add any
 * required field, or bypass the digest gate — a `--question` envelope
 * still flows through `parseTurnEnvelope` and fails closed on any
 * downstream validation problem exactly like a hand-crafted one.
 */

import { randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import path from "node:path"

import {
  computeEnvelopeDigest,
  TURN_ENVELOPE_VERSION,
} from "./envelope.js"
import { runTurn } from "./turn-run.js"

export interface TurnOptions {
  subcommand?: string
  args: string[]
  position?: string
  stdin?: boolean
  inputFile?: string
  /**
   * Usability sugar (#173 add-only): when set, the CLI auto-builds a
   * sealed v1alpha2 envelope from this free-form question and the
   * --position argument. Mutually exclusive with --stdin / --input-file.
   */
  question?: string
  json?: boolean
  help?: boolean
}

const TURN_INPUT_LIMIT_BYTES = 1024 * 1024
/**
 * Default iteration budget for a `--question` sugar envelope. Kept
 * conservative but generous enough for a small multi-step task; callers
 * who need something different still have the raw envelope path.
 */
const TURN_QUESTION_DEFAULT_MAX_ITERATIONS = 12

function turnUsage(): string {
  return `digital-employee turn run [workspace] --position <id>
    (--stdin | --input-file <path> | --question "<text>")

Spawn surface for the built-in engine: consumes a sealed
turn-envelope.v1/v1alpha2 request and streams NDJSON engine.v1 events.
Exit 0 = exactly one trusted terminal; exit 1 = spawn-level failure (no
terminal, indeterminate).

Input sources (exactly one is required):
  --stdin              Read the sealed envelope JSON from stdin.
  --input-file <path>  Read the sealed envelope JSON from a file.
  --question "<text>"  Usability sugar: auto-build and digest-seal a
                       minimal v1alpha2 envelope from a free-form
                       question. The envelope pins workspaceRef to the
                       absolute [workspace] path, positionId to
                       --position, generates a fresh turnId, and uses a
                       default budget.maxIterations of ${TURN_QUESTION_DEFAULT_MAX_ITERATIONS}. For anything
                       beyond a plain question (custom budget triples,
                       pendingApproval verdicts, conversationRef, etc.),
                       use --stdin or --input-file with a hand-crafted
                       envelope.
`
}

async function readBoundedEnvelope(
  stream: AsyncIterable<string | Buffer>,
): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > TURN_INPUT_LIMIT_BYTES) {
      throw new TypeError("turn_envelope_too_large")
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * Build a sealed v1alpha2 envelope from a `--question` sugar invocation.
 * Exported so tests can exercise the envelope-shaping logic without
 * spawning the whole `turn run` surface; the produced envelope is
 * indistinguishable from a hand-crafted one downstream.
 */
export function buildQuestionEnvelope(input: {
  workspace: string
  positionId: string
  question: string
  turnId?: string
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schemaVersion: TURN_ENVELOPE_VERSION,
    workspaceRef: path.resolve(input.workspace),
    positionId: input.positionId,
    turnId: input.turnId ?? randomUUID(),
    input: { message: input.question },
    budget: { maxIterations: TURN_QUESTION_DEFAULT_MAX_ITERATIONS },
  }
  return { ...body, envelopeDigest: computeEnvelopeDigest(body) }
}

export async function turn(options: TurnOptions): Promise<void> {
  if (options.help) {
    process.stdout.write(turnUsage())
    return
  }
  if (options.subcommand !== "run") {
    throw new TypeError(
      `unknown_turn_subcommand:${options.subcommand || "missing"}`,
    )
  }
  if (options.args.length > 1) {
    throw new TypeError("turn_run_accepts_one_workspace")
  }
  if (!options.position) {
    throw new TypeError("turn_run_requires_position")
  }
  if (options.json) {
    throw new TypeError("turn_run_emits_ndjson_not_json")
  }
  const hasQuestion =
    typeof options.question === "string" && options.question.length > 0
  const inputModes = [
    Boolean(options.stdin),
    Boolean(options.inputFile),
    hasQuestion,
  ].filter(Boolean).length
  if (inputModes === 0) {
    // Preserve the pre-existing "no input source" surface exactly.
    throw new TypeError("turn_run_accepts_one_input_source")
  }
  if (inputModes > 1) {
    // Mixing --question with --stdin / --input-file is ambiguous: the
    // sugar path builds a fresh envelope, the raw paths consume one.
    // Surface it as engine.input_invalid so cross-product clients can
    // map it onto the same input-invalid vocabulary they already know.
    throw new TypeError(
      "engine.input_invalid:turn_run_accepts_one_input_source",
    )
  }

  const workspace = options.args[0] || process.cwd()
  let envelopeText: string
  if (hasQuestion) {
    envelopeText = JSON.stringify(
      buildQuestionEnvelope({
        workspace,
        positionId: options.position,
        question: options.question as string,
      }),
    )
  } else if (options.inputFile) {
    envelopeText = await readBoundedEnvelope(createReadStream(options.inputFile))
  } else {
    envelopeText = await readBoundedEnvelope(process.stdin)
  }

  const result = await runTurn({
    workspace,
    positionId: options.position,
    envelopeText,
  })
  process.exitCode = result.exitCode
}
