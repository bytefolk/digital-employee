import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  getConfigDir,
  getConfigPath,
  hasExistingDeployment,
  loadConfig,
  saveConfig,
} from "../../apps/cli/deploy/config.js"

const CONFIG_DIR_ENV = "DIGITAL_EMPLOYEE_CONFIG_DIR"

async function isolatedConfigDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deploy-config-"))
  process.env[CONFIG_DIR_ENV] = dir
  t.after(() => {
    delete process.env[CONFIG_DIR_ENV]
    void rm(dir, { recursive: true, force: true })
  })
  return dir
}

test("config directory honors DIGITAL_EMPLOYEE_CONFIG_DIR override", async (t) => {
  const dir = await isolatedConfigDir(t)
  assert.equal(getConfigDir(), dir)
  assert.equal(getConfigPath(), path.join(dir, "config.json"))
})

test("config directory falls back to home when env is empty", async (t) => {
  await isolatedConfigDir(t)
  delete process.env[CONFIG_DIR_ENV]
  assert.equal(getConfigDir(), path.join(os.homedir(), ".digital-employee"))
})

test("save then load round-trips a config", async (t) => {
  const dir = await isolatedConfigDir(t)
  const config = {
    locale: "zh-CN",
    channel: "console",
    botName: "bot",
    engine: "openai-key",
    port: 3000,
    deployedAt: "2026-08-16T00:00:00.000Z",
  }
  saveConfig(config)
  assert.deepEqual(loadConfig(), config)
  const raw = JSON.parse(await readFile(path.join(dir, "config.json"), "utf8"))
  assert.deepEqual(raw, config)
})

test("loadConfig returns {} when no file exists", async (t) => {
  await isolatedConfigDir(t)
  assert.deepEqual(loadConfig(), {})
})

test("loadConfig returns {} on corrupted JSON instead of throwing", async (t) => {
  const dir = await isolatedConfigDir(t)
  await writeFile(path.join(dir, "config.json"), "{not json", "utf8")
  assert.deepEqual(loadConfig(), {})
})

test("hasExistingDeployment keys off deployedAt", async (t) => {
  await isolatedConfigDir(t)
  assert.equal(hasExistingDeployment(), false)
  saveConfig({ botName: "bot" })
  assert.equal(hasExistingDeployment(), false)
  saveConfig({ deployedAt: "2026-08-16T00:00:00.000Z" })
  assert.equal(hasExistingDeployment(), true)
})
