import assert from "node:assert/strict"
import test from "node:test"

import {
  DIGITAL_EMPLOYEE_QODER_COMMAND,
  QODER_COMMAND_CANDIDATES,
  QoderCommandError,
  qoderCommandCandidates,
  qoderCommandDisplay,
  selectQoderCommandSync,
  validateQoderCommandOverride,
} from "../../apps/cli/qoder-command.js"

test("validateQoderCommandOverride accepts each known candidate", () => {
  for (const candidate of QODER_COMMAND_CANDIDATES) {
    assert.equal(validateQoderCommandOverride(candidate), candidate)
  }
})

test("validateQoderCommandOverride accepts path-like values", () => {
  assert.equal(validateQoderCommandOverride("/usr/local/bin/qodercli"), "/usr/local/bin/qodercli")
  assert.equal(validateQoderCommandOverride("./qoder"), "./qoder")
  assert.equal(validateQoderCommandOverride("C:\\tools\\qoder.exe"), "C:\\tools\\qoder.exe")
})

test("validateQoderCommandOverride trims whitespace", () => {
  assert.equal(validateQoderCommandOverride("  qodercli  "), "qodercli")
})

test("validateQoderCommandOverride rejects non-string input", () => {
  for (const value of [undefined, null, 42, true, {}, []]) {
    assert.throws(() => validateQoderCommandOverride(value), (error: unknown) =>
      error instanceof QoderCommandError && error.code === "qoder_command_override_invalid",
    )
  }
})

test("validateQoderCommandOverride rejects empty and whitespace-only strings", () => {
  for (const value of ["", "   ", "\t"]) {
    assert.throws(() => validateQoderCommandOverride(value), (error: unknown) =>
      error instanceof QoderCommandError,
    )
  }
})

test("validateQoderCommandOverride rejects control characters", () => {
  const payloads = [
    "qoder\x00cli",
    "qoder\ncli",
    "qoder\rcli",
    "qoder\x1fcli",
    "qoder\x7fcli",
  ]
  for (const value of payloads) {
    assert.throws(() => validateQoderCommandOverride(value), (error: unknown) =>
      error instanceof QoderCommandError,
      `expected rejection for control char in: ${JSON.stringify(value)}`,
    )
  }
})

test("validateQoderCommandOverride rejects shell metacharacters", () => {
  const payloads = [
    "qoder;rm -rf /",
    "qoder|cat /etc/passwd",
    "qoder&background",
    "qoder$HOME",
    "qoder`whoami`",
    "qoder'inject",
    'qoder"inject',
    "qoder>output",
    "qoder<input",
  ]
  for (const value of payloads) {
    assert.throws(() => validateQoderCommandOverride(value), (error: unknown) =>
      error instanceof QoderCommandError,
      `expected rejection for shell metachar in: ${JSON.stringify(value)}`,
    )
  }
})

test("validateQoderCommandOverride rejects unknown bare names", () => {
  for (const value of ["malware", "notqoder", "qodercli-extra"]) {
    assert.throws(() => validateQoderCommandOverride(value), (error: unknown) =>
      error instanceof QoderCommandError,
    )
  }
})

test("qoderCommandCandidates returns defaults without env override", () => {
  const result = qoderCommandCandidates({})
  assert.deepEqual([...result], [...QODER_COMMAND_CANDIDATES])
})

test("qoderCommandCandidates returns override when env var is set", () => {
  const result = qoderCommandCandidates({ [DIGITAL_EMPLOYEE_QODER_COMMAND]: "/opt/qoder" })
  assert.deepEqual([...result], ["/opt/qoder"])
})

test("qoderCommandCandidates fails closed on invalid override", () => {
  assert.throws(
    () => qoderCommandCandidates({ [DIGITAL_EMPLOYEE_QODER_COMMAND]: "qoder;inject" }),
    (error: unknown) => error instanceof QoderCommandError,
  )
})

test("qoderCommandDisplay shows name for known candidates, opaque label otherwise", () => {
  assert.equal(qoderCommandDisplay("qodercli"), "qodercli")
  assert.equal(qoderCommandDisplay("qoder-cn"), "qoder-cn")
  assert.equal(qoderCommandDisplay("/opt/qoder"), "custom executable")
})

test("selectQoderCommandSync returns first matching candidate in fallback mode", () => {
  const probe = (command: string) => ({ installed: command === "qoder" })
  const result = selectQoderCommandSync({}, probe, (r) => r.installed)
  assert.equal(result.command, "qoder")
  assert.equal(result.source, "fallback")
  assert.deepEqual([...result.attemptedCommands], [...QODER_COMMAND_CANDIDATES])
})

test("selectQoderCommandSync uses override when env var is set", () => {
  const probe = (command: string) => ({ installed: command === "/opt/qoder" })
  const result = selectQoderCommandSync(
    { [DIGITAL_EMPLOYEE_QODER_COMMAND]: "/opt/qoder" },
    probe,
    (r) => r.installed,
  )
  assert.equal(result.command, "/opt/qoder")
  assert.equal(result.source, "override")
})

test("selectQoderCommandSync returns first candidate when no probe matches", () => {
  const probe = () => ({ installed: false })
  const result = selectQoderCommandSync({}, probe, (r) => r.installed)
  assert.equal(result.command, QODER_COMMAND_CANDIDATES[0])
  assert.equal(result.source, "fallback")
})