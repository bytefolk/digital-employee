/**
 * `digital-employee turn` command surface (#173 REQ-001). Subcommand:
 *
 *   turn run [workspace] --position <id> (--stdin | --input-file <path>)
 *
 * The spawn surface carries exactly one input source — the sealed
 * turn-envelope.v1 JSON — and one output discipline: NDJSON engine.v1
 * events on stdout, bounded diagnostics on stderr. `--json` is rejected
 * because the NDJSON stream IS the machine surface; a second formatting
 * mode would fork the contract.
 */

import { createReadStream } from "node:fs"

import { runTurn } from "./turn-run.js"

export interface TurnOptions {
  subcommand?: string
  args: string[]
  position?: string
  stdin?: boolean
  inputFile?: string
  json?: boolean
  help?: boolean
}

const TURN_INPUT_LIMIT_BYTES = 1024 * 1024

function turnUsage(): string {
  return `digital-employee turn run [workspace] --position <id> (--stdin | --input-file <path>)

Spawn surface for the built-in engine: consumes a sealed turn-envelope.v1
request and streams NDJSON engine.v1 events. Exit 0 = exactly one trusted
terminal; exit 1 = spawn-level failure (no terminal, indeterminate).
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
  const inputModes = [Boolean(options.stdin), Boolean(options.inputFile)].filter(
    Boolean,
  ).length
  if (inputModes !== 1) {
    throw new TypeError("turn_run_accepts_one_input_source")
  }

  const envelopeText = options.inputFile
    ? await readBoundedEnvelope(createReadStream(options.inputFile))
    : await readBoundedEnvelope(process.stdin)

  const result = await runTurn({
    workspace: options.args[0] || process.cwd(),
    positionId: options.position,
    envelopeText,
  })
  process.exitCode = result.exitCode
}
