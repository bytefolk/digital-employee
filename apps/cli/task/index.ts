/** `digital-employee task delegate [workspace] --stdin`. */

import { runDelegation } from "./delegation-run.js"

export interface TaskOptions {
  subcommand?: string
  args: string[]
  stdin?: boolean
  json?: boolean
  help?: boolean
}

const INPUT_LIMIT_BYTES = 1024 * 1024

function usage(): string {
  return `digital-employee task delegate [workspace] --stdin

Consumes one sealed delegation-envelope.v1 and streams delegation-event.v1
NDJSON. Exit 0 = exactly one trusted terminal; exit 1 = indeterminate.
`
}

async function readBounded(
  stream: AsyncIterable<string | Buffer>,
): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.byteLength
    if (bytes > INPUT_LIMIT_BYTES) throw new TypeError("delegation_envelope_too_large")
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export async function task(options: TaskOptions): Promise<void> {
  if (options.help) {
    process.stdout.write(usage())
    return
  }
  if (options.subcommand !== "delegate") {
    throw new TypeError(`unknown_task_subcommand:${options.subcommand || "missing"}`)
  }
  if (options.args.length > 1) throw new TypeError("task_delegate_accepts_one_workspace")
  if (!options.stdin) throw new TypeError("task_delegate_requires_stdin")
  if (options.json) throw new TypeError("task_delegate_emits_ndjson_not_json")
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once("SIGINT", abort)
  process.once("SIGTERM", abort)
  let result
  try {
    result = await runDelegation({
      workspace: options.args[0] || process.cwd(),
      envelopeText: await readBounded(process.stdin),
      signal: controller.signal,
    })
  } finally {
    process.removeListener("SIGINT", abort)
    process.removeListener("SIGTERM", abort)
  }
  process.exitCode = result.exitCode
}
