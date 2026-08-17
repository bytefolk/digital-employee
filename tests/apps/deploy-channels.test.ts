import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  deployConsole,
  deployDingTalk,
  deployHttp,
  deployLark,
  deployWeCom,
} from "../../apps/cli/deploy/channels.js"
import { setLocale } from "../../apps/cli/deploy/i18n.js"

setLocale("en")

/**
 * Channel deployers execFile external CLIs (dws / lark-cli / wecom-cli).
 * Instead of mocking, we prepend a temp dir of fake executables to PATH so
 * the real execFile path is exercised. Exit codes are steered via env vars.
 */
const FAKE_SCRIPT = `#!/bin/sh
case "$1" in
  auth) exit "${'${FAKE_AUTH_EXIT:-0}'}" ;;
  app) exit "${'${FAKE_APP_EXIT:-0}'}" ;;
  *) exit 1 ;;
esac
`

async function installFakeBinaries(
  t: test.TestContext,
  names = ["dws", "lark-cli", "wecom-cli"],
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deploy-channels-bin-"))
  for (const name of names) {
    await writeFile(path.join(dir, name), FAKE_SCRIPT, { mode: 0o755 })
  }
  const previousPath = process.env.PATH
  process.env.PATH = `${dir}:${previousPath}`
  t.after(() => {
    process.env.PATH = previousPath
    void rm(dir, { recursive: true, force: true })
  })
  return dir
}

function fakeAuthResult(t: test.TestContext, exit: number): void {
  process.env.FAKE_AUTH_EXIT = String(exit)
  t.after(() => {
    delete process.env.FAKE_AUTH_EXIT
  })
}

function fakeAppResult(t: test.TestContext, exit: number): void {
  process.env.FAKE_APP_EXIT = String(exit)
  t.after(() => {
    delete process.env.FAKE_APP_EXIT
  })
}

test("deployConsole reports config generation steps", async () => {
  const result = await deployConsole({})
  assert.equal(result.success, true)
  assert.ok(result.steps.length >= 2)
})

test("deployHttp uses the default port 3000", async () => {
  const result = await deployHttp({})
  assert.equal(result.success, true)
  assert.ok(result.steps.some((step) => step.includes("3000")))
})

test("deployHttp honors a custom port", async () => {
  const result = await deployHttp({ port: 8080 })
  assert.equal(result.success, true)
  assert.ok(result.steps.some((step) => step.includes("8080")))
})

test("deployDingTalk fails cleanly when dws is missing", async (t) => {
  // Isolate PATH entirely so neither dws nor which resolves; this host has a
  // real, already-authorized dws CLI that would otherwise complete the flow.
  const dir = await mkdtemp(path.join(os.tmpdir(), "deploy-channels-bin-"))
  const previousPath = process.env.PATH
  process.env.PATH = dir
  t.after(() => {
    process.env.PATH = previousPath
    void rm(dir, { recursive: true, force: true })
  })
  const result = await deployDingTalk({})
  assert.equal(result.success, false)
  assert.ok(result.error)
})

test("deployDingTalk fails when auth is rejected", async (t) => {
  await installFakeBinaries(t)
  fakeAuthResult(t, 1)
  const result = await deployDingTalk({ botName: "bot" })
  assert.equal(result.success, false)
  assert.ok(result.error)
})

test("deployDingTalk tolerates app-create failure and completes", async (t) => {
  await installFakeBinaries(t)
  fakeAppResult(t, 1)
  const result = await deployDingTalk({ botName: "bot" })
  assert.equal(result.success, true)
  assert.ok(result.steps.length >= 4)
})

test("deployDingTalk completes all steps on success", async (t) => {
  await installFakeBinaries(t)
  const result = await deployDingTalk({ botName: "bot" })
  assert.equal(result.success, true)
  assert.ok(result.steps.length >= 4)
})

test("deployLark fails when lark-cli auth is rejected", async (t) => {
  await installFakeBinaries(t)
  fakeAuthResult(t, 1)
  const result = await deployLark({})
  assert.equal(result.success, false)
  assert.ok(result.error)
})

test("deployLark completes on success", async (t) => {
  await installFakeBinaries(t)
  const result = await deployLark({ botName: "bot" })
  assert.equal(result.success, true)
  assert.ok(result.steps.length >= 4)
})

test("deployWeCom fails when wecom-cli auth is rejected", async (t) => {
  await installFakeBinaries(t)
  fakeAuthResult(t, 1)
  const result = await deployWeCom({})
  assert.equal(result.success, false)
  assert.ok(result.error)
})

test("deployWeCom completes on success", async (t) => {
  await installFakeBinaries(t)
  const result = await deployWeCom({ botName: "bot" })
  assert.equal(result.success, true)
  assert.ok(result.steps.length >= 3)
})
