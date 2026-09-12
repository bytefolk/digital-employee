/**
 * Port-level tests for the turn-run qoder model port (#185 AC-002/AC-003/
 * AC-005): zero-tool completion through the conformance fixture, credential
 * discipline (token never in argv, auth-payload file 0600), honest absence of
 * token usage, and fail-closed mapping of adapter failures.
 */

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  createQoderModelPort,
  probeQoderModelPort,
  resolveQoderModelPortCommand,
  QoderModelPortError,
} from "../../apps/cli/turn/qoder-model-port.js"
import type { ModelTurnInput } from "../../packages/engine/src/model-port.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const fixture = path.join(root, "tests", "apps", "fixtures", "fake-qoder.mjs")
const TOKEN = "fixture-service-token"

function turnInput(): ModelTurnInput {
  return {
    blocks: [
      {
        slot: "turn_input",
        text: "Answer the fixture question.",
        byteLength: Buffer.byteLength("Answer the fixture question.", "utf8"),
        truncatedBytes: 0,
      },
    ],
    priorViolations: [],
  }
}

function portEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    QODER_PERSONAL_ACCESS_TOKEN: TOKEN,
  }
}

async function installVersionCommand(
  directory: string,
  name: string,
  version: string,
): Promise<void> {
  await writeFile(
    path.join(directory, name),
    "#!/bin/sh\n" +
      "printf '%s\\n' " +
      JSON.stringify(version) +
      "\n",
    { mode: 0o755 },
  )
}

test("#185 AC-002: zero-tool completion returns the fixture answer without usage", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-port-"))
  const capture = path.join(parent, "capture.json")
  const port = createQoderModelPort({
    command: process.execPath,
    commandPrefixArgs: [
      fixture,
      "--fixture-mode",
      "zero-tool",
      "--capture",
      capture,
    ],
    environment: portEnvironment(),
  })
  const result = await port.complete(turnInput())
  assert.equal(result.text, "fixture qoder answer")
  // Usage honesty (AC-005): no token counts may be invented.
  assert.equal(result.inputTokens, undefined)
  assert.equal(result.outputTokens, undefined)

  // Credential discipline (REQ-003): the token travels via the auth-payload
  // file, never argv or inherited environment.
  const captured = JSON.parse(await readFile(capture, "utf8"))
  assert.ok(!captured.args.includes(TOKEN), "token must never appear in argv")
  assert.ok(
    !captured.environmentKeys.includes("QODER_PERSONAL_ACCESS_TOKEN"),
    "token must not be inherited into the child environment",
  )
  assert.equal(captured.authPayloadMetadata?.hasAccessToken, true)
  assert.equal(captured.authPayloadMetadata?.mode, 0o600)
})

test("#185 AC-003: an adapter-level auth failure maps to its machine code", async () => {
  const port = createQoderModelPort({
    command: process.execPath,
    commandPrefixArgs: [fixture, "--fixture-mode", "auth-invalid"],
    environment: portEnvironment(),
  })
  await assert.rejects(
    port.complete(turnInput()),
    (error: unknown) =>
      error instanceof QoderModelPortError &&
      error.code === "qoder_access_token_invalid",
  )
})

test("#185 REQ-004: the probe fails closed per fault class", async () => {
  assert.equal(
    probeQoderModelPort("/nonexistent/qodercli-for-this-test"),
    "qoder_binary_unavailable",
  )
  const parent = await mkdtemp(path.join(os.tmpdir(), "qoder-port-probe-"))
  const stub = path.join(parent, "qodercli-version-stub")
  await writeFile(stub, `#!${process.execPath}\nprocess.stdout.write("1.2.3\\n")\n`, {
    mode: 0o755,
  })
  assert.equal(probeQoderModelPort(stub), "qoder_version_not_conformance_verified")
  const good = path.join(parent, "qodercli-good-stub")
  await writeFile(good, `#!${process.execPath}\nprocess.stdout.write("1.1.12\\n")\n`, {
    mode: 0o755,
  })
  assert.equal(probeQoderModelPort(good), undefined)
})

test("#253: Qoder command override accepts the China-region entrypoint", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qoder-command-cn-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await installVersionCommand(directory, "qoderclicn", "qoderclicn 1.1.12")

  const resolution = resolveQoderModelPortCommand({
    PATH: directory,
    DIGITAL_EMPLOYEE_QODER_COMMAND: "qoderclicn",
  })
  assert.deepEqual(resolution, {
    command: "qoderclicn",
    displayCommand: "qoderclicn",
    source: "override",
  })
})

test("#253: fallback probes qodercli first and then China-region names", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qoder-command-fallback-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await installVersionCommand(directory, "qoderclicn", "qoderclicn 1.1.12")

  const fallback = resolveQoderModelPortCommand({ PATH: directory })
  assert.equal(fallback.command, "qoderclicn")
  assert.equal(fallback.source, "fallback")

  await installVersionCommand(directory, "qodercli", "qodercli 1.1.13")
  const priority = resolveQoderModelPortCommand({ PATH: directory })
  assert.equal(priority.command, "qodercli")
  assert.equal(priority.displayCommand, "qodercli")
})

test("#253: invalid explicit command fails closed without echoing the override", () => {
  const resolution = resolveQoderModelPortCommand({
    PATH: process.env.PATH,
    DIGITAL_EMPLOYEE_QODER_COMMAND: "qodercli --version",
  })
  assert.equal(resolution.error, "qoder_command_override_invalid")
  assert.equal(resolution.command, undefined)
  assert.equal(resolution.displayCommand, "configured override")
  assert.equal(JSON.stringify(resolution).includes("qodercli --version"), false)
})
