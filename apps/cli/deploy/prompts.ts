/**
 * Interactive terminal prompts using Node's built-in readline.
 * No external dependencies (inquirer/prompts not needed).
 */

import { createInterface } from "node:readline"
import { StringDecoder } from "node:string_decoder"

const queuedAnswers: string[] = []
const MAX_PROMPT_INPUT_BYTES = 64 * 1024
const MAX_PROMPT_ANSWER_BYTES = 4 * 1024
const MAX_QUEUED_ANSWERS = 64
const answerWaiters: Array<{
  resolve: (answer: string) => void
  reject: (error: Error) => void
}> = []
let inputRemainder = ""
let inputListening = false
let inputEnded = false
let inputBytes = 0
let inputFailure: Error | undefined
let inputDecoder = new StringDecoder("utf8")

function drainAnswers(): void {
  while (queuedAnswers.length > 0 && answerWaiters.length > 0) {
    answerWaiters.shift()!.resolve(queuedAnswers.shift()!)
  }
}

function collectInput(chunk: Buffer | string): void {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  inputBytes += buffer.length
  if (inputBytes > MAX_PROMPT_INPUT_BYTES) {
    failPromptInput(new TypeError("deploy_prompt_input_limit_exceeded"))
    return
  }
  inputRemainder += inputDecoder.write(buffer)
  const lines = inputRemainder.split(/\r?\n/)
  inputRemainder = lines.pop() ?? ""
  if (
    Buffer.byteLength(inputRemainder) > MAX_PROMPT_ANSWER_BYTES ||
    lines.some((line) => Buffer.byteLength(line) > MAX_PROMPT_ANSWER_BYTES) ||
    queuedAnswers.length + lines.length > MAX_QUEUED_ANSWERS
  ) {
    failPromptInput(new TypeError("deploy_prompt_input_limit_exceeded"))
    return
  }
  queuedAnswers.push(...lines)
  drainAnswers()
}

function failPromptInput(error: Error): void {
  inputFailure ??= error
  process.stdin.removeListener("data", collectInput)
  process.stdin.removeListener("end", finishInput)
  if (inputListening) process.stdin.pause()
  inputListening = false
  inputEnded = true
  inputRemainder = ""
  inputDecoder = new StringDecoder("utf8")
  queuedAnswers.length = 0
  while (answerWaiters.length > 0) answerWaiters.shift()!.reject(inputFailure)
}

function finishInput(): void {
  inputRemainder += inputDecoder.end()
  inputDecoder = new StringDecoder("utf8")
  if (inputRemainder) {
    if (
      Buffer.byteLength(inputRemainder) > MAX_PROMPT_ANSWER_BYTES ||
      queuedAnswers.length >= MAX_QUEUED_ANSWERS
    ) {
      failPromptInput(new TypeError("deploy_prompt_input_limit_exceeded"))
      return
    }
    queuedAnswers.push(inputRemainder)
  }
  inputRemainder = ""
  inputDecoder = new StringDecoder("utf8")
  inputEnded = true
  drainAnswers()
  while (answerWaiters.length > 0) {
    answerWaiters.shift()!.reject(new TypeError("deploy_prompt_input_closed"))
  }
  inputListening = false
}

function listenForAnswers(): void {
  if (inputListening) return
  inputListening = true
  process.stdin.on("data", collectInput)
  process.stdin.once("end", finishInput)
}

export function closePromptInput(
  errorCode = "deploy_prompt_input_closed",
): void {
  process.stdin.removeListener("data", collectInput)
  process.stdin.removeListener("end", finishInput)
  if (inputListening) process.stdin.pause()
  inputListening = false
  inputBytes = 0
  inputFailure = undefined
  inputEnded = process.stdin.readableEnded
  inputRemainder = ""
  inputDecoder = new StringDecoder("utf8")
  queuedAnswers.length = 0
  while (answerWaiters.length > 0) {
    answerWaiters.shift()!.reject(new TypeError(errorCode))
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
  const iface = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  // Mute output for secret
  return new Promise<string>((resolve) => {
    process.stdout.write(message + " ")
    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    if (stdin.isTTY) stdin.setRawMode(true)
    const chunks: Buffer[] = []
    const onData = (data: Buffer) => {
      for (const byte of data) {
        if (byte === 13 || byte === 10) {
          // Enter
          stdin.removeListener("data", onData)
          if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw)
          process.stdout.write("\n")
          iface.close()
          resolve(Buffer.concat(chunks).toString("utf8").trim())
          return
        }
        if (byte === 127 || byte === 8) {
          // Backspace
          chunks.pop()
        } else {
          chunks.push(Buffer.from([byte]))
          process.stdout.write("*")
        }
      }
    }
    stdin.on("data", onData)
  })
}

function question(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  if (inputFailure) return Promise.reject(inputFailure)
  if (queuedAnswers.length > 0) {
    return Promise.resolve(queuedAnswers.shift()!)
  }
  if (inputEnded || process.stdin.readableEnded) {
    return Promise.reject(new TypeError("deploy_prompt_input_closed"))
  }
  return new Promise<string>((resolve, reject) => {
    answerWaiters.push({ resolve, reject })
    listenForAnswers()
  })
}
