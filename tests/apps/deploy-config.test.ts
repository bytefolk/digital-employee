import assert from "node:assert/strict"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  acquireDeploymentLock,
  getConfigDir,
  getConfigPath,
  hasExistingDeployment,
  loadConfig,
  saveConfig,
} from "../../apps/cli/deploy/config.js"
import type { DeployConfig } from "../../apps/cli/deploy/config.js"

const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`

const READY_HTTP_CONFIG: DeployConfig = {
  schemaVersion: "deploy-state.v1",
  locale: "en",
  channel: "http",
  botName: "http-bot",
  engine: "qoder",
  runtime: "agent-native",
  package: {
    name: "demo-bot",
    version: "1.0.0",
    digest: PACKAGE_DIGEST,
    localReference: "/tmp/demo-bot",
  },
  outcome: "ready",
  endpoint: {
    protocol: "http",
    host: "127.0.0.1",
    port: 8899,
    askPath: "/v1/ask",
    healthPath: "/health",
  },
  process: {
    pid: 4242,
    startedAt: "2026-08-16T00:00:00.000Z",
    launchId: "a".repeat(32),
    activationFence: "b".repeat(32),
    activationState: "authorized",
  },
  deployedAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
}

function pendingConsoleConfig(): DeployConfig {
  return {
    schemaVersion: "deploy-state.v1",
    locale: "en",
    channel: "console",
    botName: "console-bot",
    engine: "qoder",
    runtime: "agent-native",
    package: {
      name: "demo-bot",
      version: "1.0.0",
      digest: PACKAGE_DIGEST,
      localReference: "/tmp/demo-bot",
    },
    outcome: "pending_external_action",
    updatedAt: "2026-08-16T00:00:00.000Z",
  }
}

async function isolatedHome(t: test.TestContext): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "deploy-config-home-"))
  const original = process.env.HOME
  process.env.HOME = home
  t.after(async () => {
    if (original === undefined) delete process.env.HOME
    else process.env.HOME = original
    await rm(home, { recursive: true, force: true })
  })
  return home
}

async function privateConfigDirectory(home: string): Promise<string> {
  const directory = path.join(home, ".digital-employee")
  await mkdir(directory, { mode: 0o700 })
  return directory
}

test("config directory resolves under HOME", async (t) => {
  const home = await isolatedHome(t)
  assert.equal(getConfigDir(), path.join(home, ".digital-employee"))
  assert.equal(getConfigPath(), path.join(home, ".digital-employee", "config.json"))
})

test("config directory falls back to home when HOME is unset", async (t) => {
  await isolatedHome(t)
  delete process.env.HOME
  assert.equal(getConfigDir(), path.join(os.homedir(), ".digital-employee"))
})

test("save then load round-trips a full config", async (t) => {
  const home = await isolatedHome(t)
  const lock = await acquireDeploymentLock()
  t.after(() => lock.release())
  const fingerprint = await saveConfig(READY_HTTP_CONFIG, {
    expected: { kind: "missing" },
    lock,
  })
  assert.equal(fingerprint.kind, "present")
  assert.deepEqual(await loadConfig(), READY_HTTP_CONFIG)
  const fileStat = await lstat(path.join(home, ".digital-employee", "config.json"))
  assert.equal(fileStat.mode & 0o777, 0o600)
  const raw = JSON.parse(
    await readFile(path.join(home, ".digital-employee", "config.json"), "utf8"),
  )
  assert.deepEqual(raw, READY_HTTP_CONFIG)
})

test("saveConfig persists an empty config", async (t) => {
  const home = await isolatedHome(t)
  const lock = await acquireDeploymentLock()
  t.after(() => lock.release())
  await saveConfig({}, { expected: { kind: "missing" }, lock })
  assert.deepEqual(await loadConfig(), {})
})

test("loadConfig returns {} when no config exists", async (t) => {
  await isolatedHome(t)
  assert.deepEqual(await loadConfig(), {})
})

test("loadConfig rejects malformed JSON", async (t) => {
  const home = await isolatedHome(t)
  await privateConfigDirectory(home)
  await writeFile(path.join(home, ".digital-employee", "config.json"), "{not json", {
    mode: 0o600,
  })
  await assert.rejects(loadConfig(), /deploy_config_malformed_json/)
})

test("loadConfig rejects a symlinked config", async (t) => {
  const home = await isolatedHome(t)
  await privateConfigDirectory(home)
  const target = path.join(home, "real-config.json")
  await writeFile(target, "{}", { mode: 0o600 })
  await symlink(target, path.join(home, ".digital-employee", "config.json"))
  await assert.rejects(loadConfig(), /deploy_config_symlink_not_allowed/)
})

test("loadConfig rejects an unsafe config directory", async (t) => {
  const home = await isolatedHome(t)
  await mkdir(path.join(home, ".digital-employee"), { mode: 0o755 })
  await writeFile(path.join(home, ".digital-employee", "config.json"), "{}", {
    mode: 0o600,
  })
  await assert.rejects(loadConfig(), /deploy_config_directory_permissions_unsafe/)
})

test("loadConfig rejects an unsafe config file mode", async (t) => {
  const home = await isolatedHome(t)
  await privateConfigDirectory(home)
  await writeFile(path.join(home, ".digital-employee", "config.json"), "{}", {
    mode: 0o644,
  })
  await assert.rejects(loadConfig(), /deploy_config_permissions_unsafe/)
})

test("saveConfig rejects when the config generation changed", async (t) => {
  const home = await isolatedHome(t)
  const lock = await acquireDeploymentLock()
  t.after(() => lock.release())
  const original = await saveConfig(READY_HTTP_CONFIG, {
    expected: { kind: "missing" },
    lock,
  })
  const updated = {
    ...READY_HTTP_CONFIG,
    updatedAt: "2026-08-17T00:00:00.000Z",
  }
  await writeFile(path.join(home, ".digital-employee", "config.json"), `${JSON.stringify(updated, null, 2)}\n`, {
    mode: 0o600,
  })
  await assert.rejects(
    saveConfig(updated, { expected: original, lock }),
    /deploy_config_generation_changed/,
  )
  const leftovers = (await readdir(path.join(home, ".digital-employee"))).filter(
    (entry) => entry.startsWith(".config."),
  )
  assert.deepEqual(leftovers, [])
})

test("saveConfig rejects when the lock is not owned", async (t) => {
  await isolatedHome(t)
  const lock = await acquireDeploymentLock()
  await lock.release()
  await assert.rejects(
    saveConfig(READY_HTTP_CONFIG, { expected: { kind: "missing" }, lock }),
    /deploy_lock_not_owned/,
  )
})

test("hasExistingDeployment keys off outcome", async (t) => {
  const home = await isolatedHome(t)
  const lock = await acquireDeploymentLock()
  t.after(() => lock.release())
  assert.equal(await hasExistingDeployment(), false)
  const empty = await saveConfig({}, { expected: { kind: "missing" }, lock })
  assert.equal(await hasExistingDeployment(), false)
  await saveConfig(pendingConsoleConfig(), { expected: empty, lock })
  assert.equal(await hasExistingDeployment(), true)
})
