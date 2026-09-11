/**
 * Shared Qoder executable selection rules for the built-in Agent Host and the
 * turn-run model port.
 *
 * The environment override is intentionally an executable reference, not a
 * shell command. Bare names are limited to the supported international and
 * China-region entrypoints; path-like values are passed to spawn with shell
 * disabled after rejecting shell/control characters. No directory discovery
 * happens here.
 */

export const DIGITAL_EMPLOYEE_QODER_COMMAND =
  "DIGITAL_EMPLOYEE_QODER_COMMAND" as const

/** Priority order is part of the local compatibility contract. */
export const QODER_COMMAND_CANDIDATES = [
  "qodercli",
  "qoder",
  "qoderclicn",
  "qodercn",
  "qoder-cn",
] as const

export type QoderCommandCandidate = (typeof QODER_COMMAND_CANDIDATES)[number]

const QODER_COMMAND_SET = new Set<string>(QODER_COMMAND_CANDIDATES)
const CONTROL_OR_SHELL_CHARACTER = /[\u0000-\u001f\u007f"'\x60$;&|<>]/
const PATH_SEPARATOR = /[\\/]/

export class QoderCommandError extends Error {
  constructor(readonly code = "qoder_command_override_invalid") {
    super(code)
    this.name = "QoderCommandError"
  }
}

/**
 * Validates one explicit environment override without echoing its value.
 * Paths remain supported for version managers and controlled test fixtures;
 * spawn still receives the path as one command with shell disabled.
 */
export function validateQoderCommandOverride(value: unknown): string {
  if (typeof value !== "string") throw new QoderCommandError()
  const command = value.trim()
  if (
    command.length === 0 ||
    CONTROL_OR_SHELL_CHARACTER.test(command) ||
    (!QODER_COMMAND_SET.has(command) && !PATH_SEPARATOR.test(command))
  ) {
    throw new QoderCommandError()
  }
  return command
}

/**
 * Returns one explicit override or the fixed fallback list. An explicitly
 * present empty/invalid value fails closed instead of silently falling back.
 */
export function qoderCommandCandidates(
  environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  if (Object.prototype.hasOwnProperty.call(environment, DIGITAL_EMPLOYEE_QODER_COMMAND)) {
    return [
      validateQoderCommandOverride(
        environment[DIGITAL_EMPLOYEE_QODER_COMMAND],
      ),
    ]
  }
  return QODER_COMMAND_CANDIDATES
}

export function qoderCommandDisplay(command: string): string {
  return QODER_COMMAND_SET.has(command) ? command : "custom executable"
}

export interface QoderCommandSelection<T> {
  command: string
  result: T
  attemptedCommands: readonly string[]
  source: "override" | "fallback"
}

/** Selects the first candidate whose bounded probe reports an installed CLI. */
export function selectQoderCommandSync<T>(
  environment: NodeJS.ProcessEnv,
  probe: (command: string) => T,
  isInstalled: (result: T) => boolean,
): QoderCommandSelection<T> {
  const candidates = qoderCommandCandidates(environment)
  let lastResult: T | undefined
  for (const command of candidates) {
    const result = probe(command)
    lastResult = result
    if (isInstalled(result)) {
      return {
        command,
        result,
        attemptedCommands: candidates,
        source:
          Object.prototype.hasOwnProperty.call(
            environment,
            DIGITAL_EMPLOYEE_QODER_COMMAND,
          )
            ? "override"
            : "fallback",
      }
    }
  }
  if (lastResult === undefined) throw new QoderCommandError()
  return {
    command: candidates[0]!,
    result: lastResult,
    attemptedCommands: candidates,
    source:
      Object.prototype.hasOwnProperty.call(
        environment,
        DIGITAL_EMPLOYEE_QODER_COMMAND,
      )
        ? "override"
        : "fallback",
  }
}

export async function selectQoderCommand<T>(
  environment: NodeJS.ProcessEnv,
  probe: (command: string) => Promise<T>,
  isInstalled: (result: T) => boolean,
): Promise<QoderCommandSelection<T>> {
  const candidates = qoderCommandCandidates(environment)
  let lastResult: T | undefined
  for (const command of candidates) {
    const result = await probe(command)
    lastResult = result
    if (isInstalled(result)) {
      return {
        command,
        result,
        attemptedCommands: candidates,
        source:
          Object.prototype.hasOwnProperty.call(
            environment,
            DIGITAL_EMPLOYEE_QODER_COMMAND,
          )
            ? "override"
            : "fallback",
      }
    }
  }
  if (lastResult === undefined) throw new QoderCommandError()
  return {
    command: candidates[0]!,
    result: lastResult,
    attemptedCommands: candidates,
    source:
      Object.prototype.hasOwnProperty.call(
        environment,
        DIGITAL_EMPLOYEE_QODER_COMMAND,
      )
        ? "override"
        : "fallback",
  }
}
