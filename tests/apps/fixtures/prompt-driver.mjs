/**
 * Subprocess driver for deploy prompt tests. Each invocation exercises one
 * prompt against real stdin/stdout; the result is emitted on stdout as a
 * RESULT line. Usage:
 *   node --import tsx prompt-driver.mjs <select|text|confirm|secret> [default]
 */
import {
  confirmPrompt,
  secretPrompt,
  selectPrompt,
  textPrompt,
} from "../../../apps/cli/deploy/prompts.js"

const type = process.argv[2]
const defaultValue = process.argv[3]

let result
if (type === "select") {
  result = await selectPrompt("Pick:", [
    { label: "One", value: "1" },
    { label: "Two", value: "2", hint: "hint" },
  ])
} else if (type === "text") {
  result = await textPrompt("Name:", defaultValue)
} else if (type === "confirm") {
  result = await confirmPrompt("Sure?", { yes: "Y", no: "n" })
} else if (type === "secret") {
  result = await secretPrompt("Key:")
} else {
  throw new Error(`unknown prompt type: ${type}`)
}

process.stdout.write(`RESULT:${JSON.stringify(result)}\n`)
