/**
 * Subprocess driver for deploy prompt tests. Each invocation exercises one
 * prompt against real stdin/stdout; the result is emitted on stdout as a
 * RESULT line (or RESULT:ERROR:<message> when the prompt rejects). Usage:
 *   node --import tsx prompt-driver.mjs <select|text|confirm|secret|overflow|longline|eof-partial|eof-empty|secret-backspace> [default]
 */
import {
  confirmPrompt,
  secretPrompt,
  selectPrompt,
  textPrompt,
} from "../../../apps/cli/deploy/prompts.js"

const type = process.argv[2]
const defaultValue = process.argv[3]

async function run() {
  if (type === "select") {
    return await selectPrompt("Pick:", [
      { label: "One", value: "1" },
      { label: "Two", value: "2", hint: "hint" },
    ])
  }
  if (type === "text") {
    return await textPrompt("Name:", defaultValue)
  }
  if (type === "confirm") {
    return await confirmPrompt("Sure?", { yes: "Y", no: "n" })
  }
  if (type === "secret" || type === "secret-backspace") {
    return await secretPrompt("Key:")
  }
  if (type === "overflow" || type === "longline") {
    return await textPrompt("Name:")
  }
  if (type === "eof-partial" || type === "eof-empty") {
    return await textPrompt("Name:")
  }
  throw new Error(`unknown prompt type: ${type}`)
}

try {
  const result = await run()
  process.stdout.write(`RESULT:${JSON.stringify(result)}\n`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(`RESULT:ERROR:${message}\n`)
  process.exitCode = 1
}
