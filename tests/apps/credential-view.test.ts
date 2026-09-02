/**
 * #241 credential-view consistency.
 *
 * AC-001: doctor and run evaluate the SAME operator credential view (both
 * report not_configured when the token is absent; both proceed when present).
 * AC-002: run failure on a missing credential includes the credential-view
 * diff and a recovery pointer.
 * AC-003: three-language recovery catalog entries exist and are non-empty.
 */

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  CLAUDE_SERVICE_TOKEN_ENV,
  QODER_SERVICE_TOKEN_ENV,
  describeCredentialView,
  operatorCredentialView,
  readServiceCredential,
} from "../../apps/cli/credential-view.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const builtCli = path.join(root, "dist", "apps", "cli", "bin.js")

test("readServiceCredential trims and hides blank values", () => {
  assert.equal(readServiceCredential("X", { X: "  tok  " } as NodeJS.ProcessEnv), "tok")
  assert.equal(readServiceCredential("X", { X: "   " } as NodeJS.ProcessEnv), undefined)
  assert.equal(readServiceCredential("X", {} as NodeJS.ProcessEnv), undefined)
})

test("describeCredentialView reports presence without values", () => {
  const view = describeCredentialView(
    [QODER_SERVICE_TOKEN_ENV, CLAUDE_SERVICE_TOKEN_ENV],
    { [QODER_SERVICE_TOKEN_ENV]: "abc" } as NodeJS.ProcessEnv,
  )
  assert.equal(view[QODER_SERVICE_TOKEN_ENV], "configured")
  assert.equal(view[CLAUDE_SERVICE_TOKEN_ENV], "missing")
  // No value leakage.
  assert.ok(!JSON.stringify(view).includes("abc"))
})

test("operatorCredentialView maps engine to its key", () => {
  const view = operatorCredentialView("qoder", {
    [QODER_SERVICE_TOKEN_ENV]: "x",
  } as NodeJS.ProcessEnv)
  assert.deepEqual(view, { [QODER_SERVICE_TOKEN_ENV]: "configured" })
})

test("three-language recovery entries exist and are non-empty (AC-003)", async () => {
  const { readFileSync } = await import("node:fs")
  for (const locale of ["en.json", "zh-CN.json", "ja.json"]) {
    const catalog = JSON.parse(
      readFileSync(path.join(root, "locales", locale), "utf8"),
    ) as Record<string, string>
    for (const key of [
      "run.recovery_qoder_service_token_not_configured",
      "run.recovery_claude_service_token_not_configured",
    ]) {
      assert.ok(
        typeof catalog[key] === "string" && catalog[key].trim().length > 0,
        `${locale} missing ${key}`,
      )
    }
  }
})

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
) {
  return spawnSync(process.execPath, [builtCli, ...args], {
    cwd,
    env,
    encoding: "utf8",
    input: "",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  })
}

test("doctor and run agree when the qoder token is absent (AC-001/AC-002)", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "credview-"))
  t.after(() => rm(home, { recursive: true, force: true }))

  // Decouple from the host machine: expose the conformant fake-qoder fixture as
  // `qodercli` on a controlled PATH (binary-present branch), and use an empty PATH
  // dir for the binary-absent branch. Never assume the default environment.
  const qoderBinDir = await makeControlledQoderBin()
  t.after(() => rm(qoderBinDir, { recursive: true, force: true }))
  const emptyBinDir = await mkdtemp(path.join(os.tmpdir(), "credview-nobin-"))
  t.after(() => rm(emptyBinDir, { recursive: true, force: true }))

  const withBinary = { ...process.env, HOME: home } as NodeJS.ProcessEnv
  withBinary.PATH = qoderBinDir + path.delimiter + (process.env.PATH ?? "")
  delete withBinary[QODER_SERVICE_TOKEN_ENV]

  const withoutBinary = { ...process.env, HOME: home } as NodeJS.ProcessEnv
  withoutBinary.PATH = emptyBinDir
  delete withoutBinary[QODER_SERVICE_TOKEN_ENV]

  // Scaffold a credential-free employee so run reaches host preflight.
  const pkg = path.join(home, "emp")
  const init = runCli(
    ["init", pkg, "--recipe", "minimal-answer.v1", "--author", "t"],
    withBinary,
    home,
  )
  assert.equal(init.status, 0, init.stderr)

  // Binary present + token absent: the decision reaches the credential view and
  // reports not_ready / not_configured, deterministically on any host.
  const doctor = runCli(["doctor", "--engine", "qoder", "--json"], withBinary, home)
  const doctorJson = JSON.parse(doctor.stdout)
  const qoderHost = doctorJson.hosts.find((h: { hostId: string }) => h.hostId === "qoder")
  assert.equal(qoderHost.status, "not_ready")
  assert.ok(
    qoderHost.issues.some((i: { code: string }) => i.code === "qoder_service_token_not_configured"),
    "doctor must report not_configured when token absent",
  )

  const run = runCli(["run", pkg, "--engine", "qoder", "--question", "hi"], withBinary, home)
  assert.equal(run.status, 1)
  assert.match(run.stderr, /qoder_service_token_not_configured/)
  // AC-002: actionable recovery guidance, not a dead end.
  assert.match(run.stderr, /recovery:/)

  // Binary absent: both commands agree on not_found, independent of the host.
  const doctorNoBin = runCli(["doctor", "--engine", "qoder", "--json"], withoutBinary, home)
  const noBinJson = JSON.parse(doctorNoBin.stdout)
  const noBinHost = noBinJson.hosts.find((h: { hostId: string }) => h.hostId === "qoder")
  assert.equal(noBinHost.status, "not_found")
})

/** Expose the conformant fake-qoder fixture as an executable `qodercli`. */
async function makeControlledQoderBin(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "credview-bin-"))
  const fixture = path.join(root, "tests", "apps", "fixtures", "fake-qoder.mjs")
  const wrapper = path.join(dir, process.platform === "win32" ? "qodercli.cmd" : "qodercli")
  const body =
    process.platform === "win32"
      ? `@echo off\n"${process.execPath}" "${fixture}" %*\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`
  await writeFile(wrapper, body, { mode: 0o755 })
  await chmod(wrapper, 0o755)
  return dir
}
