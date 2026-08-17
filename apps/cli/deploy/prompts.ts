/**
 * Interactive terminal prompts. No external dependencies.
 *
 * Uses a single shared stdin reader that works both with a TTY
 * (canonical-mode line editing) and with piped input: readline's
 * per-question interfaces drop already-buffered lines, which makes
 * multi-prompt flows hang on non-TTY stdin, so we read directly.
 */

let lineQueue: string[] = []
let lineWaiters: ((line: string) => void)[] = []
let chunk = ""
let secretActive = false
let secretBytes: number[] = []
let secretResolve: ((value: string) => void) | null = null
let stdinAttached = false

function onInput(data: Buffer): void {
  if (secretActive) {
    handleSecretBytes(data)
    return
  }
  chunk += data.toString("utf8")
  let nl: number
  while ((nl = chunk.indexOf("\n")) !== -1) {
    const line = chunk.slice(0, nl)
    chunk = chunk.slice(nl + 1)
    const waiter = lineWaiters.shift()
    if (waiter) waiter(line)
    else lineQueue.push(line)
  }
}

function onEnd(): void {
  // Deliver a trailing partial line when piped input lacks a final newline.
  if (chunk !== "") {
    const line = chunk
    chunk = ""
    const waiter = lineWaiters.shift()
    if (waiter) waiter(line)
    else lineQueue.push(line)
  }
}

function ensureStdinListener(): void {
  if (stdinAttached) return
  stdinAttached = true
  process.stdin.on("data", onInput)
  process.stdin.on("end", onEnd)
}

/**
 * Release stdin so an interactive process can exit naturally after the
 * last prompt. Prompts still work afterwards — the listener re-attaches
 * on the next use.
 */
export function closePrompts(): void {
  if (!stdinAttached) return
  stdinAttached = false
  process.stdin.removeListener("data", onInput)
  process.stdin.removeListener("end", onEnd)
  lineQueue = []
  lineWaiters = []
  secretBytes = []
  secretResolve = null
  secretActive = false
}

function handleSecretBytes(data: Buffer): void {
  for (const byte of data) {
    if (byte === 13 || byte === 10) {
      // Enter
      const value = Buffer.from(secretBytes).toString("utf8").trim()
      secretBytes = []
      process.stdout.write("\n")
      const resolve = secretResolve
      secretActive = false
      secretResolve = null
      resolve?.(value)
    } else if (byte === 127 || byte === 8) {
      // Backspace
      secretBytes.pop()
    } else {
      secretBytes.push(byte)
      process.stdout.write("*")
    }
  }
}

/**
 * Ask user to select from a list of options (arrow-key style).
 * Falls back to numeric selection for portability.
 */
export async function selectPrompt(
  message: string,
  options: { label: string; value: string; hint?: string }[],
): Promise<string> {
  process.stdout.write(`${message}\n`)
  for (let i = 0; i < options.length; i++) {
    const hint = options[i].hint ? ` (${options[i].hint})` : ""
    process.stdout.write(`  ${i + 1}) ${options[i].label}${hint}\n`)
  }
  const answer = await question(`  Choice [1-${options.length}]: `)
  const index = parseInt(answer.trim(), 10) - 1
  if (index >= 0 && index < options.length) {
    return options[index].value
  }
  // Default to first option
  return options[0].value
}

/**
 * Ask user for text input.
 */
export async function textPrompt(
  message: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : ""
  const answer = await question(`${message}${suffix} `)
  return answer.trim() || defaultValue || ""
}

/**
 * Ask user a yes/no confirmation.
 */
export async function confirmPrompt(
  message: string,
  options: { yes: string; no: string },
): Promise<boolean> {
  const answer = await question(`${message} [${options.yes}/${options.no}] `)
  const lower = answer.trim().toLowerCase()
  // Accept "y", "yes", first letter of yes label, or the full yes label
  return (
    lower === "y" ||
    lower === "yes" ||
    lower === "是" ||
    lower === options.yes.toLowerCase() ||
    lower === options.yes[0].toLowerCase()
  )
}

/**
 * Display a secret input prompt (masks input).
 */
export async function secretPrompt(message: string): Promise<string> {
  ensureStdinListener()
  process.stdout.write(message + " ")
  const stdin = process.stdin
  const wasRaw = stdin.isRaw
  if (stdin.isTTY) stdin.setRawMode(true)
  secretActive = true
  return new Promise<string>((resolve) => {
    secretResolve = (value) => {
      if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw)
      resolve(value)
    }
  })
}

function question(prompt: string): Promise<string> {
  ensureStdinListener()
  process.stdout.write(prompt)
  const queued = lineQueue.shift()
  if (queued !== undefined) return Promise.resolve(queued)
  return new Promise((resolve) => {
    lineWaiters.push(resolve)
  })
}
