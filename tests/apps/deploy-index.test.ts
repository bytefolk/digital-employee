import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { deploy } from "../../apps/cli/deploy/index.js"
import { loadConfig, saveConfig } from "../../apps/cli/deploy/config.js"
import { setLocale, t as translate } from "../../apps/cli/deploy/i18n.js"

setLocale("en")

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const DRIVER = path.join(ROOT, "tests", "apps", "fixtures", "deploy-index-driver.mjs")

/** Point config persistence at a temp dir for the duration of the test. */
async function useTempConfigDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deploy-index-config-"))
  const previous = process.env.DIGITAL_EMPLOYEE_CONFIG_DIR
  process.env.DIGITAL_EMPLOYEE_CONFIG_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.DIGITAL_EMPLOYEE_CONFIG_DIR
    else process.env.DIGITAL_EMPLOYEE_CONFIG_DIR = previous
    void rm(dir, { recursive: true, force: true })
  })
  return dir
}

/** Capture stdout/stderr writes made by the code under test. */
function captureStdio(t: test.TestContext): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  t.after(() => {
    process.stdout.write = origOut
    process.stderr.write = origErr
  })
  return { out, err }
}

test("deploy --help prints help and does not touch config", async (t) => {
  const configDir = await useTempConfigDir(t)
  const { out } = captureStdio(t)
  await deploy({ help: true, locale: "en" })
  assert.ok(out.join("").includes(translate("deploy.help")))
  assert.deepEqual(loadConfig(), {})
  assert.equal(process.exitCode, undefined)
})

test("non-interactive console deploy succeeds and persists config", async (t) => {
  const configDir = await useTempConfigDir(t)
  const { out } = captureStdio(t)
  await deploy({
    channel: "console",
    engine: "qoder",
    name: "mybot",
    locale: "en",
    yes: true,
  })
  assert.ok(out.join("").includes(translate("deploy.done_console")))
  const saved = loadConfig()
  assert.equal(saved.channel, "console")
  assert.equal(saved.engine, "qoder")
  assert.equal(saved.botName, "mybot")
  assert.equal(saved.locale, "en")
  assert.equal(saved.port, 3000)
  assert.ok(saved.deployedAt, "deployedAt should be set")
})

test("openai-key engine without a key in auto mode fails", async (t) => {
  const configDir = await useTempConfigDir(t)
  const { err } = captureStdio(t)
  const previousExitCode = process.exitCode
  process.exitCode = 0
  t.after(() => {
    process.exitCode = previousExitCode
  })
  await deploy({
    channel: "console",
    engine: "openai-key",
    locale: "en",
    yes: true,
  })
  assert.equal(process.exitCode, 1)
  assert.ok(err.join("").includes(translate("deploy.error_no_engine")))
  assert.deepEqual(loadConfig(), {}, "no config should be persisted on failure")
})

test("channel deploy failure surfaces error and sets exit code", async (t) => {
  const configDir = await useTempConfigDir(t)
  // Isolate PATH so dws is unreachable → deployDingTalk fails cleanly.
  const emptyBin = await mkdtemp(path.join(os.tmpdir(), "deploy-index-bin-"))
  const previousPath = process.env.PATH
  process.env.PATH = emptyBin
  t.after(() => {
    process.env.PATH = previousPath
    void rm(emptyBin, { recursive: true, force: true })
  })
  const { err } = captureStdio(t)
  const previousExitCode = process.exitCode
  process.exitCode = 0
  t.after(() => {
    process.exitCode = previousExitCode
  })
  await deploy({
    channel: "dingtalk",
    engine: "qoder",
    name: "x",
    locale: "en",
    yes: true,
  })
  assert.equal(process.exitCode, 1)
  // error_deploy_failed is emitted with the actual reason interpolated
  const expectedPrefix = translate("deploy.error_deploy_failed").split("{")[0]
  assert.ok(err.join("").includes(expectedPrefix), err.join(""))
  assert.deepEqual(loadConfig(), {})
})

test("existing deployment is auto-confirmed with yes and re-saved", async (t) => {
  const configDir = await useTempConfigDir(t)
  saveConfig({ deployedAt: "2026-01-01T00:00:00.000Z", channel: "console" })
  const { out } = captureStdio(t)
  await deploy({
    channel: "console",
    engine: "qoder",
    name: "newbot",
    locale: "en",
    yes: true,
  })
  const saved = loadConfig()
  assert.equal(saved.botName, "newbot")
  assert.notEqual(saved.deployedAt, "2026-01-01T00:00:00.000Z")
})

test("invalid channel falls back to interactive selection in a subprocess", (t) => {
  const result = runDriver(
    { channel: "bogus", engine: "qoder", name: "x", locale: "en", yes: true },
    "4\n", // pick option 4 (console)
    useSpawnConfigDir(t),
  )
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(translate("deploy.done_console")), result.stdout)
})

test("missing locale falls back to interactive language selection", (t) => {
  const result = runDriver(
    { channel: "bogus", engine: "qoder", name: "x", yes: true },
    "1\n4\n", // locale option 1 (en), then channel option 4 (console)
    useSpawnConfigDir(t),
  )
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(translate("deploy.done_console")), result.stdout)
})

test("a saved deployment is consumed by a later process without re-prompting", (t) => {
  const configDir = useSpawnConfigDir(t)
  // First process: interactive only for the openai key, everything else explicit.
  const first = runDriver(
    {
      channel: "console",
      engine: "openai-key",
      name: "persisted-bot",
      locale: "en",
    },
    "sk-test-123\n",
    configDir,
  )
  assert.equal(first.status, 0, first.stderr)
  assert.ok(first.stdout.includes(translate("deploy.done_console")), first.stdout)

  // Second process: no channel/name/engine options at all. The persisted
  // config.json must be consumed across processes, so no prompt may appear
  // and the same values must be re-saved.
  const second = runDriver({ locale: "en", yes: true }, "", configDir)
  assert.equal(second.status, 0, second.stderr)
  assert.ok(second.stdout.includes(translate("deploy.done_console")), second.stdout)
  for (const promptKey of [
    "deploy.channel_prompt",
    "deploy.name_prompt",
    "deploy.engine_prompt",
  ]) {
    assert.ok(
      !second.stdout.includes(translate(promptKey)),
      `${promptKey} must not be asked again`,
    )
  }
  const persisted = JSON.parse(
    readFileSync(path.join(configDir, "config.json"), "utf8"),
  ) as Record<string, unknown>
  assert.equal(persisted.channel, "console")
  assert.equal(persisted.botName, "persisted-bot")
  assert.equal(persisted.engine, "openai-key")
  assert.equal(persisted.openaiKey, "sk-test-123")
  assert.ok(persisted.deployedAt, "second deploy must re-persist deployedAt")
})

test("a persisted engine is still verified for availability", (t) => {
  const configDir = useSpawnConfigDir(t)
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      deployedAt: "2026-01-01T00:00:00.000Z",
      channel: "console",
      engine: "qoder",
      botName: "b",
      locale: "en",
    }),
  )
  // Empty PATH hides every engine CLI. The persisted engine must be rejected
  // rather than trusted blindly; the "y" only answers the overwrite confirm,
  // so any engine prompt appearing would hang the run (status null).
  const emptyBin = mkdtempSync(path.join(os.tmpdir(), "deploy-index-bin-"))
  t.after(() => {
    void rm(emptyBin, { recursive: true, force: true })
  })
  const result = runDriver({ locale: "en" }, "y\n", configDir, {
    PATH: emptyBin,
  })
  assert.equal(result.status, 1, result.stderr)
  assert.ok(
    result.stderr.includes(translate("deploy.error_no_engine")),
    result.stderr,
  )
  const persisted = JSON.parse(
    readFileSync(path.join(configDir, "config.json"), "utf8"),
  ) as Record<string, unknown>
  assert.equal(
    persisted.deployedAt,
    "2026-01-01T00:00:00.000Z",
    "failed redeploy must not rewrite config",
  )
})

function runDriver(
  options: Record<string, unknown>,
  input: string,
  configDir: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", DRIVER, JSON.stringify(options)],
    {
      cwd: ROOT,
      encoding: "utf8",
      input,
      timeout: 30_000,
      env: {
        ...process.env,
        DIGITAL_EMPLOYEE_CONFIG_DIR: configDir,
        ...extraEnv,
      },
    },
  )
}

function useSpawnConfigDir(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-index-spawn-"))
  t.after(() => {
    void rm(dir, { recursive: true, force: true })
  })
  return dir
}
