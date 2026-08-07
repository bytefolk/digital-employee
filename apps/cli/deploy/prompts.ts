/**
 * Interactive terminal prompts using Node's built-in readline.
 * No external dependencies (inquirer/prompts not needed).
 */

import { createInterface } from "node:readline"

const rl = () =>
  createInterface({ input: process.stdin, output: process.stdout })

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
  const iface = rl()
  return new Promise<string>((resolve) => {
    iface.question(prompt, (answer) => {
      iface.close()
      resolve(answer)
    })
  })
}
