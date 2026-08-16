import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const driver = path.join(root, "tests", "apps", "fixtures", "prompt-driver.mjs")

function runPrompt(type: string, input: string, extra: string[] = []) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", driver, type, ...extra],
    { cwd: root, encoding: "utf8", input, timeout: 20_000 },
  )
}

test("textPrompt returns the typed value", () => {
  const result = runPrompt("text", "my-bot\n")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RESULT:"my-bot"/)
})

test("textPrompt falls back to the default on empty input", () => {
  const result = runPrompt("text", "\n", ["default-bot"])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RESULT:"default-bot"/)
})

test("textPrompt returns empty string with no default", () => {
  const result = runPrompt("text", "\n")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RESULT:""/)
})

test("selectPrompt returns the chosen option value", () => {
  const result = runPrompt("select", "2\n")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RESULT:"2"/)
})

test("selectPrompt defaults to the first option on out-of-range input", () => {
  const result = runPrompt("select", "99\n")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RESULT:"1"/)
})

test("selectPrompt defaults to the first option on garbage input", () => {
  const result = runPrompt("select", "abc\n")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RESULT:"1"/)
})

test("confirmPrompt accepts y", () => {
  const result = runPrompt("confirm", "y\n")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RESULT:true/)
})

test("confirmPrompt accepts the yes label first letter", () => {
  const result = runPrompt("confirm", "Y\n")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RESULT:true/)
})

test("confirmPrompt accepts the full yes label", () => {
  const result = runPrompt("confirm", "Y\n")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RESULT:true/)
})

test("confirmPrompt accepts the Chinese yes word", () => {
  const result = runPrompt("confirm", "是\n")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RESULT:true/)
})

test("confirmPrompt rejects anything else", () => {
  for (const input of ["n\n", "no\n", "\n", "maybe\n"]) {
    const result = runPrompt("confirm", input)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /RESULT:false/)
  }
})

test("secretPrompt masks input and returns the value", () => {
  const result = runPrompt("secret", "s3cret-value\n")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RESULT:"s3cret-value"/)
  assert.match(result.stdout, /\*{12}/)
  // The secret text appears only in the RESULT line, never echoed back
  assert.equal(result.stdout.split("s3cret-value").length - 1, 1)
})

test("textPrompt rejects input that exceeds the total input byte limit", () => {
  const result = runPrompt("text", "x".repeat(70 * 1024))
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout, /RESULT:ERROR:deploy_prompt_input_limit_exceeded/)
})

test("textPrompt rejects a single line that exceeds the answer byte limit", () => {
  const result = runPrompt("text", `${"x".repeat(5 * 1024)}\n`)
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout, /RESULT:ERROR:deploy_prompt_input_limit_exceeded/)
})

test("textPrompt accepts a trailing partial line at EOF", () => {
  const result = runPrompt("text", "partial-line")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RESULT:"partial-line"/)
})

test("textPrompt rejects EOF with no queued answer", () => {
  const result = runPrompt("text", "")
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout, /RESULT:ERROR:deploy_prompt_input_closed/)
})

test("secretPrompt handles backspace by removing the last character", () => {
  const result = runPrompt("secret-backspace", "ab\x7fc\n")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RESULT:"ac"/)
})
