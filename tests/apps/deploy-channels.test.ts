import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  buildHttpRuntimeEnvironment,
  deployConsole,
  deployDingTalk,
  deployHttp,
  deployLark,
  deployWeCom,
  endpointUrl,
  inspectHttpDeployment,
} from "../../apps/cli/deploy/channels.js"
import type {
  DeployConfig,
  DeployEndpoint,
  DeployProcessState,
  DeployProviderScope,
} from "../../apps/cli/deploy/config.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const fakeDwsFixture = path.join(root, "tests", "apps", "fixtures", "fake-dws.mjs")
const HTTP_TOKEN_ENV = "DIGITAL_EMPLOYEE_HTTP_TOKEN"

const HTTP_ENDPOINT: DeployEndpoint = {
  protocol: "http",
  host: "127.0.0.1",
  port: 8899,
  askPath: "/v1/ask",
  healthPath: "/health",
}

function httpConfig(): DeployConfig {
  return {
    schemaVersion: "deploy-state.v1",
    locale: "en",
    channel: "http",
    botName: "http-bot",
    engine: "qoder",
    runtime: "agent-native",
    package: {
      name: "demo-bot",
      version: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`,
      localReference: "/tmp/demo-bot",
    },
    outcome: "pending_external_action",
    endpoint: HTTP_ENDPOINT,
    secretReferences: { httpTokenEnv: HTTP_TOKEN_ENV },
    updatedAt: "2026-08-16T00:00:00.000Z",
  }
}

function validLease() {
  return {
    fileDescriptor: 0,
    nonce: "a".repeat(32),
    device: 0,
    inode: 0,
    ownerPid: process.pid,
  }
}

function processState(
  pid: number,
  activationState: "prepared" | "authorized" = "authorized",
): DeployProcessState {
  return {
    pid,
    startedAt: "2026-08-16T00:00:00.000Z",
    launchId: "a".repeat(32),
    activationFence: "b".repeat(32),
    activationState,
  }
}

function dingtalkScope(): DeployProviderScope {
  const canonical = JSON.stringify({
    schema: "dingtalk-provider-scope.v1",
    corpId: "corp-a",
    userId: "user-a",
    profileClientId: "profile-client-a",
    envClientId: null,
  })
  return {
    kind: "dingtalk-provider-scope.v1",
    digest: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
  }
}

async function withEnvVar(
  t: test.TestContext,
  key: string,
  value: string,
): Promise<void> {
  const original = process.env[key]
  process.env[key] = value
  t.after(() => {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  })
}

async function withoutEnvVar(
  t: test.TestContext,
  key: string,
): Promise<void> {
  const original = process.env[key]
  delete process.env[key]
  t.after(() => {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  })
}

/** Prepends a fake `dws` executable to PATH and returns the bin directory. */
async function fakeDwsOnPath(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deploy-fake-dws-"))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const fixture = path.join(directory, "fake-dws.mjs")
  await cp(fakeDwsFixture, fixture)
  const executable = path.join(directory, "dws")
  await writeFile(
    executable,
    "#!/bin/sh\n" +
      "fixture_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd -P) || exit 1\n" +
      "exec node \"$fixture_dir/fake-dws.mjs\" \"$@\"\n",
    { mode: 0o755 },
  )
  await chmod(executable, 0o755)
  const original = process.env.PATH
  process.env.PATH = `${directory}:${original ?? ""}`
  t.after(() => {
    process.env.PATH = original
  })
  return directory
}

async function deadPid(): Promise<number> {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"])
  assert.equal(result.status, 0)
  return result.pid
}

test("deployLark reports unsupported", async () => {
  const result = await deployLark({})
  assert.equal(result.outcome, "unsupported")
  assert.equal(result.code, "lark_live_deploy_unsupported")
})

test("deployWeCom reports unsupported", async () => {
  const result = await deployWeCom({})
  assert.equal(result.outcome, "unsupported")
  assert.equal(result.code, "wecom_live_deploy_unsupported")
})

test("deployConsole reports pending external action", async () => {
  const result = await deployConsole({})
  assert.equal(result.outcome, "pending_external_action")
  assert.equal(result.code, "console_foreground_start_required")
})

test("deployDingTalk fails when botName is missing", async () => {
  const result = await deployDingTalk({})
  assert.equal(result.outcome, "failed")
  assert.equal(result.code, "dingtalk_provider_state_invalid")
})

test("deployDingTalk verifies an existing app", async (t) => {
  await fakeDwsOnPath(t)
  const scope = dingtalkScope()
  const provider = { kind: "dingtalk-app" as const, resourceId: "app-1", scope }
  const result = await deployDingTalk({ botName: "test-bot", provider })
  assert.equal(result.outcome, "pending_external_action")
  assert.equal(result.code, "dingtalk_app_verified_pending_setup")
  assert.deepEqual(result.provider, provider)
})

test("deployDingTalk creates an app when none exists", async (t) => {
  await fakeDwsOnPath(t)
  const result = await deployDingTalk(
    { botName: "test-bot" },
    {
      allowProviderWrite: true,
      onProviderOperation: () => {},
      onProviderVerified: () => {},
    },
  )
  assert.equal(result.outcome, "pending_external_action")
  assert.equal(result.code, "dingtalk_app_verified_pending_setup")
  assert.equal(result.provider?.resourceId, "app-created-1")
  assert.deepEqual(result.provider?.scope, dingtalkScope())
})

test("deployDingTalk requires provider write confirmation", async (t) => {
  await fakeDwsOnPath(t)
  const result = await deployDingTalk(
    { botName: "test-bot" },
    { confirmProviderWrite: () => false },
  )
  assert.equal(result.outcome, "pending_external_action")
  assert.equal(result.code, "dingtalk_provider_confirmation_required")
})

test("deployDingTalk preserves state on provider scope mismatch", async (t) => {
  await fakeDwsOnPath(t)
  const wrongScope: DeployProviderScope = {
    kind: "dingtalk-provider-scope.v1",
    digest: `sha256:${"b".repeat(64)}`,
  }
  const result = await deployDingTalk({
    botName: "test-bot",
    provider: { kind: "dingtalk-app", resourceId: "app-1", scope: wrongScope },
  })
  assert.equal(result.outcome, "pending_external_action")
  assert.equal(result.code, "dingtalk_provider_scope_mismatch")
  assert.equal(result.preserveState, true)
})

test("deployDingTalk fails closed when dws is unavailable", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deploy-empty-path-"))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const original = process.env.PATH
  process.env.PATH = directory
  t.after(() => {
    process.env.PATH = original
  })
  const result = await deployDingTalk({ botName: "test-bot" })
  assert.equal(result.outcome, "failed")
  assert.equal(result.code, "dingtalk_provider_scope_unavailable")
})

test("deployHttp fails when required state is missing", async () => {
  const result = await deployHttp({})
  assert.equal(result.outcome, "failed")
  assert.equal(result.code, "http_deploy_state_invalid")
})

test("deployHttp rejects the standalone runtime", async () => {
  const result = await deployHttp({
    ...httpConfig(),
    runtime: "standalone-v1",
  })
  assert.equal(result.outcome, "unsupported")
  assert.equal(result.code, "http_standalone_runtime_not_available")
})

test("deployHttp requires the http token", async (t) => {
  await withoutEnvVar(t, HTTP_TOKEN_ENV)
  const result = await deployHttp(httpConfig())
  assert.equal(result.outcome, "failed")
  assert.equal(result.code, "http_token_required")
})

test("deployHttp rejects an already-aborted signal", async (t) => {
  await withEnvVar(t, HTTP_TOKEN_ENV, "test-token")
  const controller = new AbortController()
  controller.abort()
  const result = await deployHttp(httpConfig(), { signal: controller.signal })
  assert.equal(result.outcome, "failed")
  assert.equal(result.code, "deploy_interrupted")
})

test("deployHttp rejects an invalid activation lease", async (t) => {
  await withEnvVar(t, HTTP_TOKEN_ENV, "test-token")
  const result = await deployHttp(httpConfig(), {
    activationLease: { ...validLease(), fileDescriptor: -1 },
  })
  assert.equal(result.outcome, "failed")
  assert.equal(result.code, "deploy_lock_lease_invalid")
})

test("deployHttp fails when lock ownership is lost", async (t) => {
  await withEnvVar(t, HTTP_TOKEN_ENV, "test-token")
  const result = await deployHttp(httpConfig(), {
    activationLease: validLease(),
    assertLockOwned: async () => {
      throw new Error("deploy_lock_not_owned")
    },
  })
  assert.equal(result.outcome, "failed")
  assert.equal(result.code, "deploy_lock_not_owned")
})

test("buildHttpRuntimeEnvironment forwards engine and token variables", async (t) => {
  await withEnvVar(t, "QODER_PERSONAL_ACCESS_TOKEN", "token-value")
  await withEnvVar(t, HTTP_TOKEN_ENV, "http-token-value")
  await withEnvVar(t, "UNRELATED_TEST_VAR", "must-not-leak")
  const environment = buildHttpRuntimeEnvironment({
    engine: "qoder",
    secretReferences: { httpTokenEnv: HTTP_TOKEN_ENV },
  })
  assert.equal(environment.QODER_PERSONAL_ACCESS_TOKEN, "token-value")
  assert.equal(environment[HTTP_TOKEN_ENV], "http-token-value")
  assert.equal(environment.PATH, process.env.PATH)
  assert.equal(environment.UNRELATED_TEST_VAR, undefined)
})

test("buildHttpRuntimeEnvironment forwards claude-code engine variables", async (t) => {
  await withEnvVar(t, "ANTHROPIC_API_KEY", "key-value")
  await withEnvVar(t, "ANTHROPIC_BASE_URL", "https://model.example.test/v1")
  await withEnvVar(t, "UNRELATED_TEST_VAR", "must-not-leak")
  const environment = buildHttpRuntimeEnvironment({
    engine: "claude-code",
    secretReferences: { httpTokenEnv: HTTP_TOKEN_ENV },
  })
  assert.equal(environment.ANTHROPIC_API_KEY, "key-value")
  assert.equal(environment.ANTHROPIC_BASE_URL, "https://model.example.test/v1")
  assert.equal(environment.UNRELATED_TEST_VAR, undefined)
})

test("buildHttpRuntimeEnvironment rejects unknown engines", () => {
  assert.throws(
    () => buildHttpRuntimeEnvironment({ engine: "bogus" }),
    /http_runtime_engine_invalid/,
  )
})

test("endpointUrl renders the ask endpoint", () => {
  assert.equal(endpointUrl(HTTP_ENDPOINT), "http://127.0.0.1:8899/v1/ask")
})

test("inspectHttpDeployment reports absent without endpoint or process", async () => {
  assert.equal(await inspectHttpDeployment({}), "absent")
})

test("inspectHttpDeployment reports unverified for a live process without endpoint", async () => {
  const config: DeployConfig = { process: processState(process.pid) }
  assert.equal(await inspectHttpDeployment(config), "unverified")
})

test("inspectHttpDeployment reports absent for a dead process", async () => {
  const config: DeployConfig = { process: processState(await deadPid()) }
  assert.equal(await inspectHttpDeployment(config), "absent")
})

test("inspectHttpDeployment reports unverified before authorization", async () => {
  const config: DeployConfig = {
    endpoint: HTTP_ENDPOINT,
    process: processState(process.pid, "prepared"),
  }
  assert.equal(await inspectHttpDeployment(config), "unverified")
})

test("inspectHttpDeployment reports unverified when the tracked argv mismatches", async () => {
  const config: DeployConfig = {
    endpoint: HTTP_ENDPOINT,
    process: processState(process.pid, "authorized"),
  }
  assert.equal(await inspectHttpDeployment(config), "unverified")
})
