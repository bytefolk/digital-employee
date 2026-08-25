/**
 * `digital-employee hire` command surface (#194, R4 freeze). Subcommand:
 *
 *   hire validate <file> [--json]
 *
 * The hire channel is a static contract surface: it validates a
 * hire-request.v1alpha1 reference envelope and stops. No spawn, no engine,
 * no paid calls, no provider. Violations fail closed before any effect:
 * exit 1 plus a stable diagnostic code (one stderr line, or
 * `{ "status": "failed", "code": ... }` under `--json`).
 */

import { readFile } from "node:fs/promises"

import {
  HireRequestError,
  validateHireRequest,
} from "../../packages/core/src/hire-request.js"

export interface HireOptions {
  subcommand?: string
  args: string[]
  json?: boolean
  help?: boolean
}

/** Bounded input: a hire request is a thin reference envelope. */
const HIRE_REQUEST_MAX_BYTES = 256 * 1024

function hireUsage(): string {
  return `digital-employee hire validate <file> [--json]

Static validation of a hire-request.v1alpha1 reference envelope (#194).
No spawn, no engine, no model/provider calls. Exit 0 = valid; exit 1 =
fail-closed diagnostic (stderr line, or { "status": "failed", "code" } under --json).
`
}

function fail(code: string, json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ status: "failed", code }, null, 2)}\n`,
    )
  } else {
    process.stderr.write(`digital-employee: ${code}\n`)
  }
  process.exitCode = 1
}

export async function hire(options: HireOptions): Promise<void> {
  if (options.help) {
    process.stdout.write(hireUsage())
    return
  }
  if (options.subcommand !== "validate") {
    throw new TypeError(
      `unknown_hire_subcommand:${options.subcommand || "missing"}`,
    )
  }
  const file = options.args[0]
  if (!file) throw new TypeError("hire_validate_requires_file")
  if (options.args.length > 1) {
    throw new TypeError("hire_validate_accepts_one_file")
  }

  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch {
    return fail("hire_request_file_unreadable", Boolean(options.json))
  }
  if (Buffer.byteLength(text, "utf8") > HIRE_REQUEST_MAX_BYTES) {
    return fail("hire_request_too_large", Boolean(options.json))
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail("hire_request_invalid_json", Boolean(options.json))
  }

  try {
    const request = validateHireRequest(raw)
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ status: "valid", hire: request }, null, 2)}\n`,
      )
    } else {
      process.stdout.write(
        `hire request valid: ${request.packageRef.name}@${request.packageRef.version}\n`,
      )
    }
  } catch (error) {
    if (error instanceof HireRequestError) {
      return fail(error.code, Boolean(options.json))
    }
    throw error
  }
}
