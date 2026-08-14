import assert from "node:assert/strict"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { loadConfigSnapshotFromPath } from "../../apps/cli/deploy/config.js"

test("persisted deploy timestamps require canonical UTC ISO milliseconds", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deploy-config-date-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await chmod(directory, 0o700)
  const configPath = path.join(directory, "config.json")
  const base = {
    schemaVersion: "deploy-state.v1",
    locale: "en",
    channel: "console",
    botName: "Date Test",
    engine: "qoder",
    runtime: "agent-native",
    package: {
      name: "date-test",
      version: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`,
      localReference: path.join(directory, "date-test"),
    },
    outcome: "pending_external_action",
  }
  await mkdir(base.package.localReference)
  for (const invalid of [
    "August 13, 2026 12:00:00 UTC",
    "2026-08-13T12:00:00Z",
    "2026-08-13T20:00:00.000+08:00",
    "2026-8-13T12:00:00.000Z",
  ]) {
    await writeFile(
      configPath,
      JSON.stringify({ ...base, updatedAt: invalid }),
      { mode: 0o600 },
    )
    await assert.rejects(
      () => loadConfigSnapshotFromPath(configPath),
      /deploy_config_invalid_field:updatedAt/,
    )
  }
  const valid = "2026-08-13T12:00:00.000Z"
  await writeFile(
    configPath,
    JSON.stringify({ ...base, updatedAt: valid }),
    { mode: 0o600 },
  )
  assert.equal(
    (await loadConfigSnapshotFromPath(configPath)).config.updatedAt,
    valid,
  )
})

test("persisted DingTalk identities require an opaque provider scope", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deploy-config-scope-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await chmod(directory, 0o700)
  const configPath = path.join(directory, "config.json")
  const scope = {
    kind: "dingtalk-provider-scope.v1",
    digest: `sha256:${"a".repeat(64)}`,
  }
  const base = {
    schemaVersion: "deploy-state.v1",
    locale: "en",
    channel: "dingtalk",
    botName: "Scope Test",
    engine: "qoder",
    runtime: "agent-native",
    package: {
      name: "scope-test",
      version: "1.0.0",
      digest: `sha256:${"b".repeat(64)}`,
      localReference: path.join(directory, "scope-test"),
    },
    outcome: "pending_external_action",
    updatedAt: "2026-08-13T12:00:00.000Z",
  }
  await mkdir(base.package.localReference)
  for (const remote of [
    { provider: { kind: "dingtalk-app", resourceId: "app-1", scope } },
    {
      providerOperation: {
        kind: "dingtalk-app-create",
        operationId: "c".repeat(32),
        name: base.botName,
        attemptedAt: "2026-08-13T11:59:00.000Z",
        scope,
      },
    },
  ]) {
    await writeFile(configPath, JSON.stringify({ ...base, ...remote }), {
      mode: 0o600,
    })
    const loaded = await loadConfigSnapshotFromPath(configPath)
    assert.deepEqual(
      loaded.config.provider?.scope ?? loaded.config.providerOperation?.scope,
      scope,
    )
  }

  for (const remote of [
    { provider: { kind: "dingtalk-app", resourceId: "app-1" } },
    {
      providerOperation: {
        kind: "dingtalk-app-create",
        operationId: "c".repeat(32),
        name: base.botName,
        attemptedAt: "2026-08-13T11:59:00.000Z",
      },
    },
    {
      provider: {
        kind: "dingtalk-app",
        resourceId: "app-1",
        scope: { ...scope, kind: "dingtalk-provider-scope.v2" },
      },
    },
    {
      provider: {
        kind: "dingtalk-app",
        resourceId: "app-1",
        scope: { ...scope, digest: `sha256:${"A".repeat(64)}` },
      },
    },
    {
      provider: {
        kind: "dingtalk-app",
        resourceId: "app-1",
        scope: { ...scope, corpId: "raw-identity-must-not-persist" },
      },
    },
  ]) {
    await writeFile(configPath, JSON.stringify({ ...base, ...remote }), {
      mode: 0o600,
    })
    const beforeBytes = await readFile(configPath)
    const before = await lstat(configPath)
    await assert.rejects(
      () => loadConfigSnapshotFromPath(configPath),
      /deploy_config_(?:provider_scope_missing|invalid_field|unknown_field)/,
    )
    const after = await lstat(configPath)
    assert.equal(after.dev, before.dev)
    assert.equal(after.ino, before.ino)
    assert.deepEqual(await readFile(configPath), beforeBytes)
  }
})
