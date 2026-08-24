import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer, request as httpRequest } from "node:http"
import { createConnection } from "node:net"
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import {
  computeEmployeePackageDirectoryDigest,
  createEmployeePackage,
} from "../../apps/cli/employee-package.js"
import { reconcileDingTalkApplication } from "../../apps/cli/deploy/dingtalk-provider.js"
import {
  buildHttpRuntimeEnvironment,
  deployDingTalk,
} from "../../apps/cli/deploy/channels.js"
import {
  loadConfigSnapshotFromPath,
  saveConfig,
} from "../../apps/cli/deploy/config.js"
import type {
  DeployConfig,
  DeployProviderOperation,
} from "../../apps/cli/deploy/config.js"
import { getAvailableLocales } from "../../apps/cli/deploy/i18n.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const builtCli = path.join(root, "dist", "apps", "cli", "bin.js")
const qoderFixture = path.join(
  root,
  "tests",
  "apps",
  "fixtures",
  "fake-qoder.mjs",
)

const DEFAULT_DWS_IDENTITY = {
  profile: "corp-a:user-a",
  corpId: "corp-a",
  userId: "user-a",
  clientId: "profile-client-a",
}

function testProviderScope(
  identity = DEFAULT_DWS_IDENTITY,
  envClientId: string | null = null,
) {
  const digest = createHash("sha256").update(JSON.stringify({
    schema: "dingtalk-provider-scope.v1",
    corpId: identity.corpId,
    userId: identity.userId,
    profileClientId: identity.clientId,
    envClientId,
  })).digest("hex")
  return {
    kind: "dingtalk-provider-scope.v1" as const,
    digest: `sha256:${digest}` as const,
  }
}

const PROVIDER_SCOPE_GOLDEN =
  "sha256:6888cea3020c442749851d9c40ed9d0d7d2123ebe40d9381750d24cb172f2205"

async function readDwsRawCalls(logPath: string): Promise<string[][]> {
  try {
    const raw = (await readFile(`${logPath}.raw`, "utf8")).trim()
    return raw ? raw.split("\n").map((line) => JSON.parse(line) as string[]) : []
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return []
    }
    throw error
  }
}

function assertPinnedDevappCalls(
  calls: string[][],
  expectedProfile: string,
): void {
  for (const call of calls.filter((entry) => entry.includes("devapp"))) {
    assert.deepEqual(call.slice(0, 3), ["--profile", expectedProfile, "devapp"])
  }
}

test("DingTalk provider scope has a stable persisted digest vector", () => {
  assert.equal(
    testProviderScope(DEFAULT_DWS_IDENTITY, "env-client-a").digest,
    PROVIDER_SCOPE_GOLDEN,
  )
})

test("HTTP runtime environment contains only the selected engine credentials", () => {
  const source = {
    PATH: "/fixture/bin",
    ANTHROPIC_API_KEY: "anthropic-sentinel",
    QODER_PERSONAL_ACCESS_TOKEN: "qoder-sentinel",
    OPENAI_API_KEY: "openai-sentinel",
    OPENAI_MODEL: "openai-model",
    OPENAI_BASE_URL: "https://openai.example.test",
    CODEBUDDY_API_KEY: "codebuddy-sentinel",
    CODEBUDDY_MODEL: "codebuddy-model",
    CODEBUDDY_BASE_URL: "https://codebuddy.example.test",
    CODEBUDDY_INTERNET_ENVIRONMENT: "internal",
    DIGITAL_EMPLOYEE_HTTP_TOKEN: "http-token-sentinel",
    AWS_SECRET_ACCESS_KEY: "unrelated-sentinel",
  }
  const expected: Record<string, string[]> = {
    "claude-code": ["ANTHROPIC_API_KEY"],
    qoder: ["QODER_PERSONAL_ACCESS_TOKEN"],
    "qwen-code": ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"],
    codebuddy: [
      "CODEBUDDY_API_KEY",
      "CODEBUDDY_MODEL",
      "CODEBUDDY_BASE_URL",
      "CODEBUDDY_INTERNET_ENVIRONMENT",
    ],
  }
  for (const [engine, engineKeys] of Object.entries(expected)) {
    const environment = buildHttpRuntimeEnvironment({
      schemaVersion: "deploy-state.v1",
      locale: "en",
      channel: "http",
      botName: "Environment Test",
      engine,
      runtime: "agent-native",
      outcome: "pending_external_action",
      secretReferences: { httpTokenEnv: "DIGITAL_EMPLOYEE_HTTP_TOKEN" },
      updatedAt: "2026-08-13T00:00:00.000Z",
    }, source)
    assert.deepEqual(
      Object.keys(environment).sort(),
      ["PATH", "DIGITAL_EMPLOYEE_HTTP_TOKEN", ...engineKeys].sort(),
    )
  }
  const withoutTokenReference = buildHttpRuntimeEnvironment({
    schemaVersion: "deploy-state.v1",
    locale: "en",
    channel: "http",
    botName: "Environment Test",
    engine: "qoder",
    runtime: "agent-native",
    outcome: "pending_external_action",
    updatedAt: "2026-08-13T00:00:00.000Z",
  }, source)
  assert.equal(withoutTokenReference.DIGITAL_EMPLOYEE_HTTP_TOKEN, undefined)
  assert.equal(withoutTokenReference.AWS_SECRET_ACCESS_KEY, undefined)
})

interface CliEnvironment {
  home: string
  bin?: string
  extra?: NodeJS.ProcessEnv
}

const TEST_HTTP_TOKEN = "deploy-http-test-token-sentinel"

function httpAuthorization(token = TEST_HTTP_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

function cliEnvironment({ home, bin, extra = {} }: CliEnvironment): NodeJS.ProcessEnv {
  return {
    // Pin the child's locale so prompt-language assertions are deterministic
    // on non-English developer machines; tests use --locale for localization.
    LC_ALL: "en_US.UTF-8",
    ...process.env,
    LANG: "en_US.UTF-8",
    HOME: home,
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
      .filter(Boolean)
      .join(path.delimiter),
    ...extra,
  }
}

function httpCliEnvironment(options: CliEnvironment): NodeJS.ProcessEnv {
  return cliEnvironment({
    ...options,
    extra: {
      ...options.extra,
      DIGITAL_EMPLOYEE_HTTP_TOKEN:
        options.extra?.DIGITAL_EMPLOYEE_HTTP_TOKEN ?? TEST_HTTP_TOKEN,
    },
  })
}

function runBuiltCli(
  args: string[],
  {
    cwd = root,
    environment,
    input = "",
    entry = builtCli,
    timeoutMs = 20_000,
  }: {
    cwd?: string
    environment: NodeJS.ProcessEnv
    input?: string
    entry?: string
    timeoutMs?: number
  },
) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    input,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  })
}

function startBuiltCli(
  args: string[],
  {
    cwd = root,
    environment,
    pipeInput = false,
    entry = builtCli,
  }: {
    cwd?: string
    environment: NodeJS.ProcessEnv
    pipeInput?: boolean
    entry?: string
  },
) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: environment,
    stdio: [pipeInput ? "pipe" : "ignore", "pipe", "pipe"],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  if (!child.stdout || !child.stderr) {
    throw new Error("built_cli_output_pipe_unavailable")
  }
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
  const completion = new Promise<{
    status: number | null
    stdout: string
    stderr: string
  }>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    })
  })
  return {
    child,
    completion,
    stdoutText: () => Buffer.concat(stdout).toString("utf8"),
    stderrText: () => Buffer.concat(stderr).toString("utf8"),
  }
}

async function runBuiltCliAsync(
  args: string[],
  {
    cwd = root,
    environment,
  }: { cwd?: string; environment: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return startBuiltCli(args, { cwd, environment }).completion
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(20)
  }
  throw new Error("condition_not_reached_before_timeout")
}

async function ownedProcessEnvironment(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    return (await readFile(`/proc/${pid}/environ`)).toString("utf8")
  }
  if (process.platform === "darwin") {
    const result = spawnSync(
      "/bin/ps",
      ["eww", "-p", String(pid), "-o", "command="],
      { encoding: "utf8" },
    )
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  return undefined
}

function deploymentPids(configPath: string): number[] {
  const result = spawnSync("ps", ["-ax", "-o", "pid=,command="], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
    .split("\n")
    .filter(
      (line) =>
        line.includes("deploy/http-runtime") &&
        line.includes(`--state=${configPath}`),
    )
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
}

async function isolatedRoot(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  return directory
}

async function installFakeQoder(directory: string): Promise<void> {
  await mkdir(directory)
  const executable = path.join(directory, "qodercli")
  const fixture = path.join(directory, "fake-qoder.mjs")
  await cp(qoderFixture, fixture)
  await writeFile(
    executable,
    "#!/bin/sh\n" +
      "if [ \"$1\" = \"--version\" ]; then printf '1.1.12\\n'; exit 0; fi\n" +
      "fixture_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd -P) || exit 1\n" +
      "exec node \"$fixture_dir/fake-qoder.mjs\" \"$@\"\n",
    { mode: 0o755 },
  )
  await chmod(executable, 0o755)
}

async function addValidFinalGateAssets(directory: string): Promise<void> {
  const manifestPath = path.join(directory, "employee.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    assets: string[]
  }
  const padding = "x".repeat(3_500_000)
  for (let index = 0; index < 3; index += 1) {
    const relative = `./knowledge/final-gate-${index}.txt`
    manifest.assets.push(relative)
    await writeFile(path.join(directory, relative), `${padding}\n`)
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function installObservableProbe(
  directory: string,
  marker: string,
): Promise<void> {
  await mkdir(directory)
  const executable = path.join(directory, "qodercli")
  await writeFile(
    executable,
    `#!/usr/bin/env node\n` +
      `const { appendFileSync } = require("node:fs")\n` +
      `appendFileSync(${JSON.stringify(marker)}, "called\\n")\n` +
      `if (process.argv.includes("--version")) process.stdout.write("1.1.12\\n")\n`,
    { mode: 0o755 },
  )
  await chmod(executable, 0o755)
  assert.equal(marker.length > 0, true)
}

async function installVersionProbeWithRuntimeMarker(
  directory: string,
  marker: string,
): Promise<void> {
  await mkdir(directory)
  const executable = path.join(directory, "qodercli")
  await writeFile(
    executable,
    `#!/usr/bin/env node\n` +
      `const { appendFileSync } = require("node:fs")\n` +
      `if (process.argv.includes("--version")) { process.stdout.write("1.1.12\\n"); process.exit(0) }\n` +
      `appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + "\\n")\n` +
      `process.exitCode = 9\n`,
    { mode: 0o755 },
  )
  await chmod(executable, 0o755)
}

async function installObservableDws(
  directory: string,
  marker: string,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  const executable = path.join(directory, "dws")
  await writeFile(
    executable,
    "#!/usr/bin/env node\n" +
      "const { appendFileSync } = require('node:fs')\n" +
      `appendFileSync(${JSON.stringify(marker)}, 'called\\n')\n` +
      "process.stdout.write('{}\\n')\n",
    { mode: 0o755 },
  )
  await chmod(executable, 0o755)
  assert.equal(marker.length > 0, true)
}

async function installFakeDws(
  directory: string,
  mode:
    | "success"
    | "conflict"
    | "arbitrary"
    | "ambiguous"
    | "malformed"
    | "create-invalid"
    | "create-get-malformed"
    | "create-stderr-conflict"
    | "create-stderr-malformed-code"
    | "create-stderr-malformed"
    | "create-stderr-oversized"
    | "list-one-get-malformed"
    | "list-one-get-conflict"
    | "split-multibyte"
    | "success-orphan"
    | "slow-success",
  logPath: string,
  statePath: string,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  const executable = path.join(directory, "dws")
const source = `#!/usr/bin/env node
(async () => {
const fs = await import("node:fs")
const { spawn } = await import("node:child_process")
const args = process.argv.slice(2)
const mode = ${JSON.stringify(mode)}
const logPath = ${JSON.stringify(logPath)}
const statePath = ${JSON.stringify(statePath)}
const identityPath = statePath + ".identity.json"
const rawLogPath = logPath + ".raw"
const defaultIdentity = ${JSON.stringify(DEFAULT_DWS_IDENTITY)}
const emitAndExit = async (payload, code = 0) => {
  await new Promise((resolve) => process.stdout.write(JSON.stringify(payload) + "\\n", resolve))
  process.exit(code)
}
fs.appendFileSync(rawLogPath, JSON.stringify(args) + "\\n")
const identityDocument = () => {
  try { return JSON.parse(fs.readFileSync(identityPath, "utf8")) } catch { return { current: defaultIdentity } }
}
const writeIdentityDocument = (document) => fs.writeFileSync(identityPath, JSON.stringify(document))
const currentIdentity = () => identityDocument().current || defaultIdentity
const profileResponse = () => {
  const document = identityDocument()
  if (document.profileResponse) return document.profileResponse
  const identity = currentIdentity()
  return {
    success: true,
    currentProfile: identity.profile,
    profiles: [{
      profile: identity.profile,
      corpId: identity.corpId,
      corpName: "Fixture Corp",
      userId: identity.userId,
      userName: "Fixture User",
      clientId: identity.clientId,
      status: "active",
      isPrimary: true,
      isCurrent: true,
      isOrgCurrent: true,
    }],
  }
}
const switchIdentity = (field) => {
  const document = identityDocument()
  if (document[field] && document.next) {
    writeIdentityDocument({ ...document, current: document.next, [field]: false })
  }
}
if (args[0] === "profile" && args[1] === "list") {
  if (identityDocument().profileUnavailable) {
    await emitAndExit({ error: { code: "provider_unavailable" } }, 7)
  }
  await emitAndExit(profileResponse())
}
if (args[0] === "--profile" && args[2] === "auth" && args[3] === "status") {
  const document = identityDocument()
  const identity = [document.current, document.next, defaultIdentity]
    .find((candidate) => candidate && candidate.profile === args[1]) || currentIdentity()
  const response = document.authResponse || {
    success: true,
    authenticated: true,
    token_valid: true,
    refresh_token_valid: true,
    corp_id: identity.corpId,
    user_id: identity.userId,
  }
  switchIdentity("switchAfterAuth")
  await emitAndExit(response)
}
const document = identityDocument()
const allowedProfiles = [document.current, document.next, defaultIdentity]
  .filter(Boolean)
  .map((candidate) => candidate.profile)
if (args[0] !== "--profile" || !allowedProfiles.includes(args[1]) || args[2] !== "devapp") {
  await emitAndExit({ error: { code: "profile_required" } }, 9)
}
const command = args[3]
fs.appendFileSync(logPath, JSON.stringify(["devapp", ...args.slice(3), "--profile", args[1]]) + "\\n")
const value = (flag) => args[args.indexOf(flag) + 1]
const name = value("--name") || "Ding Bot"
let storedName
try { storedName = JSON.parse(fs.readFileSync(statePath, "utf8")).name } catch {}
const app = { unifiedAppId: "app-verified-1", name: mode === "split-multibyte" ? "钉钉机器人" : storedName || "Ding Bot" }
const writeSplitMultibyte = async (payload) => {
  const encoded = Buffer.from(JSON.stringify(payload) + "\\n")
  const splitAt = encoded.indexOf(Buffer.from("钉")) + 1
  process.stdout.write(encoded.subarray(0, splitAt))
  await new Promise((resolve) => setTimeout(resolve, 100))
  process.stdout.write(encoded.subarray(splitAt))
}
if (command === "+list") {
  if (mode === "malformed") process.stdout.write("not-json\\n")
  else if (mode === "split-multibyte") await writeSplitMultibyte({ apps: [app], count: 1, hasMore: false })
  else if (mode === "ambiguous") process.stdout.write(JSON.stringify({ apps: [app, { ...app, unifiedAppId: "app-verified-2" }], hasMore: false }) + "\\n")
  else if (mode === "list-one-get-malformed" || mode === "list-one-get-conflict") process.stdout.write(JSON.stringify({ apps: [app], count: 1, hasMore: false }) + "\\n")
  else if (mode === "conflict" && fs.existsSync(statePath)) process.stdout.write(JSON.stringify({ apps: [app], count: 1, hasMore: false }) + "\\n")
  else process.stdout.write(JSON.stringify({ apps: [], count: 0, hasMore: false }) + "\\n")
  switchIdentity("switchAfterList")
} else if (command === "+create") {
  if (mode === "create-invalid") {
    fs.writeFileSync(statePath, "remote-outcome-unknown")
    process.stdout.write("not-json\\n")
  } else if (mode === "create-stderr-conflict") {
    process.stderr.write(JSON.stringify({ error: { code: 7, category: "api", server_error_code: "already_exists", message: JSON.stringify({ success: false, errorCode: "permission_denied", errorMsg: "conflicting codes" }) } }) + "\\n")
    process.exitCode = 7
  } else if (mode === "create-stderr-malformed-code") {
    process.stderr.write(JSON.stringify({ error: { code: 7, category: "api", server_error_code: "malformed code", message: JSON.stringify({ success: false, errorCode: "already_exists", errorMsg: "malformed competing code" }) } }) + "\\n")
    process.exitCode = 7
  } else if (mode === "create-stderr-malformed") {
    process.stderr.write("not-json\\n")
    process.exitCode = 7
  } else if (mode === "create-stderr-oversized") {
    process.stderr.write("x".repeat(1024 * 1024 + 1))
    process.exitCode = 7
  } else if (mode === "success-orphan") {
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});if(process.send){process.send({pid:process.pid});process.disconnect()}setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("orphan_ready_timeout")), 5000)
      descendant.once("message", (message) => {
        clearTimeout(timer)
        fs.writeFileSync(statePath + ".orphan.json", JSON.stringify(message))
        descendant.unref()
        resolve()
      })
      descendant.once("error", reject)
    })
    fs.writeFileSync(statePath, JSON.stringify({ created: true, name }))
    process.stdout.write(JSON.stringify({ result: { unifiedAppId: app.unifiedAppId }, name }) + "\\n")
  } else if (mode === "slow-success") {
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});if(process.send)process.send('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("descendant_ready_timeout")), 5000)
      descendant.once("message", () => { clearTimeout(timer); resolve() })
      descendant.once("error", reject)
    })
    fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, descendantPid: descendant.pid, phase: "parseable-response-before-settlement" }))
    process.stdout.write(JSON.stringify({ result: { unifiedAppId: app.unifiedAppId } }) + "\\n")
    process.once("SIGTERM", () => process.exit(143))
    setTimeout(() => {}, 60_000)
  } else if (mode === "conflict") {
    fs.writeFileSync(statePath, "conflict")
    process.stderr.write(JSON.stringify({ error: { code: 7, category: "api", message: JSON.stringify({ success: false, errorCode: "already_exists", errorMsg: "application exists" }) } }) + "\\n")
    process.exitCode = 7
  } else if (mode === "arbitrary") {
    process.stderr.write(JSON.stringify({ error: { code: 7, category: "api", message: JSON.stringify({ success: false, errorCode: "permission_denied", errorMsg: "provider-secret-sentinel" }) } }) + "\\n")
    process.exitCode = 7
  } else {
    fs.writeFileSync(statePath, JSON.stringify({ created: true, name }))
    process.stdout.write(JSON.stringify({ result: { unifiedAppId: app.unifiedAppId }, debug: "provider-secret-sentinel", name }) + "\\n")
  }
  switchIdentity("switchAfterCreate")
} else if (command === "+get") {
  if (mode === "create-get-malformed" || mode === "list-one-get-malformed") process.stdout.write("not-json\\n")
  else if (mode === "list-one-get-conflict") process.stdout.write(JSON.stringify({ app, data: { app: { ...app, unifiedAppId: "app-conflicting" } } }) + "\\n")
  else if (mode === "split-multibyte") await writeSplitMultibyte({ app })
  else process.stdout.write(JSON.stringify({ app, debug: "provider-secret-sentinel" }) + "\\n")
} else {
  process.stdout.write(JSON.stringify({ error: { code: "unexpected_command" } }) + "\\n")
  process.exitCode = 9
}
})().catch((error) => {
  process.stderr.write(String(error && error.stack || error) + "\\n")
  process.exitCode = 1
})
`
  await writeFile(executable, source, { mode: 0o755 })
  await chmod(executable, 0o755)
}

async function installPaginatedDws(
  directory: string,
  scenario:
    | "page-two"
    | "none"
    | "ambiguous"
    | "loop"
    | "limit"
    | "missing-has-more"
    | "typed-has-more"
    | "typed-cursor"
    | "conflicting-has-more"
    | "conflicting-cursor"
    | "missing-cursor"
    | "empty-cursor"
    | "unexpected-cursor"
    | "cycle"
    | "oversized-cursor"
    | "oversized-page"
    | "malformed-page-one"
    | "malformed-page-two"
    | "unavailable-page-one"
    | "unavailable-page-two",
  logPath: string,
): Promise<void> {
  await mkdir(directory, { recursive: true })
  const executable = path.join(directory, "dws")
  const source = `#!/usr/bin/env node
const fs = await import("node:fs")
const args = process.argv.slice(2)
const scenario = ${JSON.stringify(scenario)}
const logPath = ${JSON.stringify(logPath)}
const identity = ${JSON.stringify(DEFAULT_DWS_IDENTITY)}
const emitAndExit = async (payload, code = 0) => {
  await new Promise((resolve) => process.stdout.write(JSON.stringify(payload) + "\\n", resolve))
  process.exit(code)
}
fs.appendFileSync(logPath + ".raw", JSON.stringify(args) + "\\n")
if (args[0] === "profile" && args[1] === "list") {
  await emitAndExit({
    success: true,
    currentProfile: identity.profile,
    profiles: [{ ...identity, corpName: "Fixture Corp", userName: "Fixture User", isPrimary: true, isCurrent: true, isOrgCurrent: true }],
  })
}
if (args[0] === "--profile" && args[1] === identity.profile && args[2] === "auth" && args[3] === "status") {
  await emitAndExit({ success: true, authenticated: true, token_valid: true, corp_id: identity.corpId, user_id: identity.userId })
}
if (args[0] !== "--profile" || args[1] !== identity.profile || args[2] !== "devapp") {
  await emitAndExit({ error: { code: "profile_required" } }, 9)
}
fs.appendFileSync(logPath, JSON.stringify(["devapp", ...args.slice(3), "--profile", args[1]]) + "\\n")
const command = args[3]
const value = (flag) => {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}
const cursor = value("--cursor")
const first = { unifiedAppId: "app-page-1", name: "Ding Bot" }
const second = { unifiedAppId: "app-page-2", name: "Ding Bot" }
if (command === "+list") {
  if (scenario === "missing-has-more") {
    process.stdout.write(JSON.stringify({ apps: [] }) + "\\n")
  } else if (scenario === "typed-has-more") {
    process.stdout.write(JSON.stringify({ apps: [], hasMore: "true", nextCursor: "cursor-1" }) + "\\n")
  } else if (scenario === "typed-cursor") {
    process.stdout.write(JSON.stringify({ apps: [], hasMore: true, nextCursor: 1 }) + "\\n")
  } else if (scenario === "conflicting-has-more") {
    process.stdout.write(JSON.stringify({ result: { apps: [], hasMore: true, nextCursor: "cursor-1" }, hasMore: false }) + "\\n")
  } else if (scenario === "conflicting-cursor") {
    process.stdout.write(JSON.stringify({ result: { apps: [], hasMore: true, nextCursor: "cursor-nested" }, hasMore: true, nextCursor: "cursor-top" }) + "\\n")
  } else if (scenario === "empty-cursor") {
    process.stdout.write(JSON.stringify({ apps: [], hasMore: true, nextCursor: "" }) + "\\n")
  } else if (scenario === "oversized-cursor") {
    process.stdout.write(JSON.stringify({ apps: [], hasMore: true, nextCursor: "x".repeat(4097) }) + "\\n")
  } else if (scenario === "oversized-page") {
    process.stdout.write(JSON.stringify({ apps: Array.from({ length: 21 }, (_, index) => ({ unifiedAppId: "other-" + String(index), name: "Other Bot" })), hasMore: false }) + "\\n")
  } else if (scenario === "malformed-page-one") {
    process.stdout.write("not-json\\n")
  } else if (scenario === "unavailable-page-one") {
    process.stdout.write(JSON.stringify({ error: { code: "provider_unavailable" } }) + "\\n")
    process.exitCode = 7
  } else if (scenario === "page-two") {
    process.stdout.write(JSON.stringify(cursor
      ? { apps: [second], count: 1, hasMore: false }
      : { apps: [], count: 0, hasMore: true, nextCursor: "cursor-1" }) + "\\n")
  } else if (scenario === "none") {
    process.stdout.write(JSON.stringify(cursor
      ? { apps: [], count: 0, hasMore: false }
      : { apps: [], count: 0, hasMore: true, nextCursor: "cursor-1" }) + "\\n")
  } else if (scenario === "ambiguous") {
    process.stdout.write(JSON.stringify(cursor
      ? { apps: [second], count: 1, hasMore: false }
      : { apps: [first], count: 1, hasMore: true, nextCursor: "cursor-1" }) + "\\n")
  } else if (scenario === "loop") {
    process.stdout.write(JSON.stringify({ apps: [], count: 0, hasMore: true, nextCursor: "cursor-loop" }) + "\\n")
  } else if (scenario === "cycle") {
    const nextCursor = !cursor ? "cursor-a" : cursor === "cursor-a" ? "cursor-b" : "cursor-a"
    process.stdout.write(JSON.stringify({ apps: [], count: 0, hasMore: true, nextCursor }) + "\\n")
  } else if (scenario === "missing-cursor") {
    process.stdout.write(JSON.stringify({ apps: [], count: 0, hasMore: true }) + "\\n")
  } else if (scenario === "unexpected-cursor") {
    process.stdout.write(JSON.stringify({ apps: [], count: 0, hasMore: false, nextCursor: "cursor-unexpected" }) + "\\n")
  } else if (scenario === "malformed-page-two") {
    process.stdout.write(cursor
      ? "not-json\\n"
      : JSON.stringify({ apps: [], count: 0, hasMore: true, nextCursor: "cursor-1" }) + "\\n")
  } else if (scenario === "unavailable-page-two") {
    if (cursor) {
      process.stdout.write(JSON.stringify({ error: { code: "provider_unavailable" } }) + "\\n")
      process.exitCode = 7
    } else {
      process.stdout.write(JSON.stringify({ apps: [], count: 0, hasMore: true, nextCursor: "cursor-1" }) + "\\n")
    }
  } else {
    const page = cursor ? Number(cursor.slice("cursor-".length)) : 0
    process.stdout.write(JSON.stringify({ apps: [], count: 0, hasMore: true, nextCursor: "cursor-" + String(page + 1) }) + "\\n")
  }
} else if (command === "+get") {
  process.stdout.write(JSON.stringify({ app: second }) + "\\n")
} else {
  process.stdout.write(JSON.stringify({ error: { code: "unexpected_effect" } }) + "\\n")
  process.exitCode = 9
}
`
  await writeFile(executable, source, { mode: 0o755 })
  await chmod(executable, 0o755)
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function httpJson({
  port,
  path: requestPath,
  method = "GET",
  body,
  headers = {},
  timeoutMs = 2_000,
}: {
  port: number
  path: string
  method?: "GET" | "POST"
  body?: string
  headers?: Record<string, string>
  timeoutMs?: number
}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method,
        timeout: timeoutMs,
        headers: {
          ...headers,
          ...(body ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
                string,
                unknown
              >,
            })
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    request.once("timeout", () => request.destroy(new Error("http_timeout")))
    request.once("error", reject)
    if (body) request.write(body)
    request.end()
  })
}

async function noConfig(home: string): Promise<boolean> {
  try {
    await access(path.join(home, ".digital-employee", "config.json"))
    return false
  } catch {
    return true
  }
}

async function markerMissing(marker: string): Promise<boolean> {
  try {
    await access(marker)
    return false
  } catch {
    return true
  }
}

interface DeploymentLockUtility {
  command: string
  args: string[]
}

interface DeploymentLockActorEvent {
  attempt: number
  decisionDeadline: number
  fileDescriptor: number
  observedAt: number
  pid?: number
  previousPid?: number
  previousPidAlive?: boolean
  remainingMs: number
  watchdogMs: number
}

interface DeploymentLockActorReport {
  cleanup?: {
    abortListeners: number
    candidateFdClosed: boolean
    childCloseListeners: number[]
    childErrorListeners: number[]
    childExitCodes: Array<number | null>
    childSignalCodes: Array<NodeJS.Signals | null>
    directChildrenAlive: boolean[]
    immediates: number
    lifecycleBarrierHeld: boolean
    settlementCount: number
    timeouts: number
  }
  contended?: boolean
  device?: number
  error?: string
  events: DeploymentLockActorEvent[]
  fileDescriptor?: number
  inode?: number
  phase: "acquired" | "released" | "error"
  settledAt?: number
}

const deploymentLockActorSource = String.raw`
const { acquireDeploymentLock } = await import(process.argv[1])
const { ChildProcess } = await import("node:child_process")
const { getEventListeners } = await import("node:events")
const { existsSync, fstatSync, readFileSync, writeFileSync } = await import("node:fs")
const options = JSON.parse(process.argv[2])
const controller = new AbortController()
const events = []
const supervisedChildren = []
let invocationCount = 0
let previousPid
let originalGetuid
let deferredKillChild
let harnessRestored = false
let acquisitionSettled = false
let settlementCount = 0

const drainMode = ["delayed-close-timeout", "delayed-close-abort"].includes(
  options.mode,
)
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
const originalSetImmediate = globalThis.setImmediate
const originalClearImmediate = globalThis.clearImmediate
const activeTimeouts = new Set()
const activeImmediates = new Set()
globalThis.setTimeout = (callback, timeout, ...args) => {
  let handle
  handle = originalSetTimeout((...callbackArgs) => {
    activeTimeouts.delete(handle)
    callback(...callbackArgs)
  }, timeout, ...args)
  activeTimeouts.add(handle)
  return handle
}
globalThis.clearTimeout = (handle) => {
  activeTimeouts.delete(handle)
  return originalClearTimeout(handle)
}
globalThis.setImmediate = (callback, ...args) => {
  let handle
  handle = originalSetImmediate((...callbackArgs) => {
    activeImmediates.delete(handle)
    callback(...callbackArgs)
  }, ...args)
  activeImmediates.add(handle)
  return handle
}
globalThis.clearImmediate = (handle) => {
  activeImmediates.delete(handle)
  return originalClearImmediate(handle)
}

function appendHarnessEvent(event) {
  writeFileSync(
    options.wrapperEventsPath,
    JSON.stringify({ ...event, at: performance.now() }) + "\n",
    { flag: "a" },
  )
}

const originalChildOnce = ChildProcess.prototype.once
const originalChildKill = ChildProcess.prototype.kill
ChildProcess.prototype.once = function(event, listener) {
  if (event === "close" && !supervisedChildren.includes(this)) {
    supervisedChildren.push(this)
  }
  return originalChildOnce.call(this, event, listener)
}
ChildProcess.prototype.kill = function(signal) {
  const normalizedSignal = signal ?? "SIGTERM"
  appendHarnessEvent({
    type: "signal",
    signal: normalizedSignal,
    pid: this.pid,
  })
  if (
    drainMode &&
    normalizedSignal === "SIGKILL" &&
    deferredKillChild === undefined
  ) {
    deferredKillChild = this
    appendHarnessEvent({
      type: "lifecycle-barrier-held",
      pid: this.pid,
      decisionDeadline: events[0]?.decisionDeadline,
      abortListeners: getEventListeners(controller.signal, "abort").length,
      childCloseListeners: this.listenerCount("close"),
      childErrorListeners: this.listenerCount("error"),
      timeouts: activeTimeouts.size,
      immediates: activeImmediates.size,
    })
    // Deterministically model a successful kill request whose direct-child
    // close proof has not arrived. The fixture releases the real KILL later.
    return true
  }
  return originalChildKill.call(this, signal)
}

function abortAcquisition() {
  controller.abort()
}

function releaseLifecycleBarrier() {
  if (!deferredKillChild) return
  const child = deferredKillChild
  deferredKillChild = undefined
  appendHarnessEvent({ type: "lifecycle-barrier-released", pid: child.pid })
  originalChildKill.call(child, "SIGKILL")
}

if (drainMode) {
  process.on("SIGUSR1", abortAcquisition)
  process.on("SIGUSR2", releaseLifecycleBarrier)
}

function candidateFdClosed() {
  const fileDescriptor = events[0]?.fileDescriptor
  if (!Number.isInteger(fileDescriptor)) return false
  try {
    fstatSync(fileDescriptor)
    return false
  } catch (error) {
    return error?.code === "EBADF"
  }
}

function cleanupSnapshot() {
  return {
    abortListeners: getEventListeners(controller.signal, "abort").length,
    candidateFdClosed: candidateFdClosed(),
    childCloseListeners: supervisedChildren.map((child) =>
      child.listenerCount("close")
    ),
    childErrorListeners: supervisedChildren.map((child) =>
      child.listenerCount("error")
    ),
    childExitCodes: supervisedChildren.map((child) => child.exitCode),
    childSignalCodes: supervisedChildren.map((child) => child.signalCode),
    directChildrenAlive: supervisedChildren.map((child) => pidAlive(child.pid)),
    immediates: activeImmediates.size,
    lifecycleBarrierHeld: deferredKillChild !== undefined,
    settlementCount,
    timeouts: activeTimeouts.size,
  }
}

function restoreHarness() {
  if (harnessRestored) return
  harnessRestored = true
  process.removeListener("SIGUSR1", abortAcquisition)
  process.removeListener("SIGUSR2", releaseLifecycleBarrier)
  ChildProcess.prototype.once = originalChildOnce
  ChildProcess.prototype.kill = originalChildKill
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
  globalThis.setImmediate = originalSetImmediate
  globalThis.clearImmediate = originalClearImmediate
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function delayedTerminalStatus(mode) {
  const match = /^delayed-(0|1|75)$/.exec(mode)
  return match ? Number(match[1]) : undefined
}

function wrapperInvocation(mode) {
  return {
    command: process.execPath,
    args: [
      options.wrapperPath,
      options.utility.command,
      JSON.stringify(options.utility.args),
      mode,
      options.wrapperEventsPath,
      options.lockPath,
      String(invocationCount),
    ],
  }
}

const hooks = {
  ...(options.probeWatchdogTimeoutMs === undefined
    ? {}
    : { probeWatchdogTimeoutMs: options.probeWatchdogTimeoutMs }),
  lockUtilityInvocation() {
    invocationCount += 1
    if (
      options.mode === "double-watchdog-then-success" &&
      invocationCount <= 3
    ) {
      return wrapperInvocation(invocationCount < 3 ? "term-0" : "pass")
    }
    if (options.mode === "late-code-0-after-deadline") {
      return wrapperInvocation("pass")
    }
    if (
      ["direct-watchdog", "direct-timeout"].includes(options.mode) &&
      invocationCount === 1
    ) {
      return options.blockingUtility
    }
    if (options.mode === "recoverable" && invocationCount === 1) {
      return wrapperInvocation("hang")
    }
    if (
      options.mode.startsWith("watchdog-exit-") &&
      invocationCount === 1
    ) {
      return wrapperInvocation(
        "term-" + options.mode.slice("watchdog-exit-".length),
      )
    }
    if (
      [
        "hung-timeout",
        "abort-hung",
        "delayed-close-timeout",
        "delayed-close-abort",
      ].includes(options.mode)
    ) {
      return wrapperInvocation("hang")
    }
    if (options.mode === "inode-replaced" && invocationCount === 1) {
      return wrapperInvocation("replace")
    }
    if (options.mode === "enoent") {
      return { command: options.missingCommand, args: [] }
    }
    if (options.mode === "exit-9") {
      return { command: process.execPath, args: ["-e", "process.exit(9)"] }
    }
    if (
      options.mode === "owner-changed" &&
      invocationCount === 1 &&
      typeof process.getuid === "function"
    ) {
      originalGetuid = process.getuid
      process.getuid = () => originalGetuid() + 1
    }
    const delayedStatus = delayedTerminalStatus(options.mode)
    if (delayedStatus !== undefined && invocationCount === 1) {
      return {
        command: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'terminal\\n');" +
            "process.exit(" + String(delayedStatus) + ")",
          options.terminalMarker,
        ],
      }
    }
    return options.utility
  },
  onLockUtilitySpawn(context) {
    const observedAt = performance.now()
    events.push({
      ...context,
      observedAt,
      ...(previousPid === undefined
        ? {}
        : {
            previousPid,
            previousPidAlive: pidAlive(previousPid),
          }),
    })
    previousPid = context.pid
    appendHarnessEvent({ type: "spawn", ...context, observedAt })
    if (
      options.mode === "direct-watchdog" &&
      context.attempt === 2 &&
      options.ownerPid
    ) {
      process.kill(options.ownerPid, "SIGUSR1")
    }
    const waitsForDelegatedWrapper =
      (
        context.attempt === 1 &&
        (
          options.mode.startsWith("watchdog-exit-") ||
          [
            "recoverable",
            "hung-timeout",
            "abort-hung",
            "delayed-close-timeout",
            "delayed-close-abort",
            "inode-replaced",
          ].includes(options.mode)
        )
      ) ||
      (
        options.mode === "double-watchdog-then-success" &&
        context.attempt <= 3
      ) ||
      (
        options.mode === "late-code-0-after-deadline" &&
        context.attempt === 1
      )
    if (waitsForDelegatedWrapper) {
      const wrapperReadyType =
        (
          options.mode === "double-watchdog-then-success" &&
          context.attempt === 3
        ) || options.mode === "late-code-0-after-deadline"
          ? "exit-intent"
          : "delegated"
      const delegatedNeedle =
        '"type":"' + wrapperReadyType + '","attempt":' +
        String(context.attempt)
      const wrapperReadyDeadline = Date.now() + 2_000
      while (Date.now() < wrapperReadyDeadline) {
        if (
          existsSync(options.wrapperEventsPath) &&
          readFileSync(options.wrapperEventsPath, "utf8").includes(delegatedNeedle)
        ) {
          break
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
      if (
        !existsSync(options.wrapperEventsPath) ||
        !readFileSync(options.wrapperEventsPath, "utf8").includes(delegatedNeedle)
      ) {
        throw new Error("wrapper_delegated_not_observed")
      }
    }
    if (
      options.mode === "double-watchdog-then-success" &&
      context.attempt === 3
    ) {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        options.eventLoopDelayMs,
      )
    }
    if (
      options.mode === "late-code-0-after-deadline" &&
      context.attempt === 1
    ) {
      appendHarnessEvent({
        type: "deadline-close-held",
        pid: context.pid,
        decisionDeadline: context.decisionDeadline,
      })
      const closeHoldUntil =
        context.decisionDeadline + options.eventLoopDelayMs
      const closeHoldBuffer = new Int32Array(new SharedArrayBuffer(4))
      while (performance.now() < closeHoldUntil) {
        Atomics.wait(
          closeHoldBuffer,
          0,
          0,
          Math.min(5, Math.max(1, closeHoldUntil - performance.now())),
        )
      }
    }
    if (options.mode === "abort-hung" && context.attempt === 1) {
      setTimeout(() => controller.abort(), options.abortAfterMs)
    }
    if (
      delayedTerminalStatus(options.mode) !== undefined &&
      context.attempt === 1
    ) {
      const terminalDeadline = Date.now() + 2_000
      while (
        !existsSync(options.terminalMarker) &&
        Date.now() < terminalDeadline
      ) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
      if (!existsSync(options.terminalMarker)) {
        throw new Error("terminal_marker_not_observed")
      }
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        options.eventLoopDelayMs,
      )
    }
  },
  afterKernelAcquire() {
    if (options.mode === "late-code-0-after-deadline") {
      appendHarnessEvent({ type: "after-kernel-acquire" })
    }
    if (options.mode === "fence-corrupt") {
      writeFileSync(options.lockPath, "foreign-fence-record\n")
    }
  },
}

function emit(report) {
  process.stdout.write(JSON.stringify({ ...report, events }) + "\n")
}

try {
  const request = { signal: controller.signal, hooks }
  if (options.timeoutMs !== undefined) request.timeoutMs = options.timeoutMs
  const lock = await acquireDeploymentLock(request)
  acquisitionSettled = true
  settlementCount += 1
  await lock.assertOwned()
  const releaseSignal = options.holdAfterAcquire
    ? new Promise((resolve) => process.once("SIGUSR1", resolve))
    : undefined
  const cleanup = cleanupSnapshot()
  restoreHarness()
  emit({
    phase: "acquired",
    cleanup,
    contended: lock.contended,
    fileDescriptor: lock.fileDescriptor,
    device: lock.device,
    inode: lock.inode,
  })
  if (options.holdAfterAcquire) {
    const holdInterval = setInterval(() => {}, 1_000)
    await releaseSignal
    clearInterval(holdInterval)
    await lock.assertOwned()
  }
  await lock.release()
  if (options.holdAfterAcquire) emit({ phase: "released" })
} catch (error) {
  if (!acquisitionSettled) {
    acquisitionSettled = true
    settlementCount += 1
  }
  const cleanup = cleanupSnapshot()
  restoreHarness()
  const exitSignal = options.holdAfterError
    ? new Promise((resolve) => process.once("SIGUSR1", resolve))
    : undefined
  const holdInterval = options.holdAfterError
    ? setInterval(() => {}, 1_000)
    : undefined
  emit({
    phase: "error",
    cleanup,
    error: error instanceof Error ? error.message : "unknown",
    settledAt: performance.now(),
  })
  if (exitSignal) {
    await exitSignal
    clearInterval(holdInterval)
  }
} finally {
  restoreHarness()
  if (originalGetuid) process.getuid = originalGetuid
}
`

const deploymentLockWrapperSource = String.raw`
import { appendFileSync, fstatSync, renameSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

const [command, argsJson, mode, eventsPath, lockPath, attemptText] =
  process.argv.slice(2)
const attempt = Number(attemptText)
const append = (event) => appendFileSync(
  eventsPath,
  JSON.stringify({ ...event, at: performance.now(), pid: process.pid }) + "\n",
)
const descriptor = fstatSync(3)
process.on("SIGTERM", () => {
  const status = mode.startsWith("term-")
    ? Number(mode.slice("term-".length))
    : undefined
  append({ type: "term", attempt, ...(status === undefined ? {} : { status }) })
  if (mode.startsWith("term-")) {
    process.exit(status)
  }
})
append({
  type: "start",
  attempt,
  fileDescriptor: 3,
  device: descriptor.dev,
  inode: descriptor.ino,
})
const delegated = spawnSync(command, JSON.parse(argsJson), {
  stdio: ["ignore", "ignore", "ignore", 3],
})
append({
  type: "delegated",
  attempt,
  delegatedPid: delegated.pid,
  status: delegated.status,
})
if (mode === "replace") {
  renameSync(lockPath, lockPath + ".displaced")
  writeFileSync(lockPath, "replacement-generation\n", { mode: 0o600 })
  process.exit(delegated.status ?? 9)
}
if (mode === "hang" || mode.startsWith("term-")) {
  setInterval(() => {}, 1_000)
} else {
  const status = delegated.status ?? 9
  append({ type: "exit-intent", attempt, status })
  process.exit(status)
}
`

async function realDeploymentLockUtility(): Promise<DeploymentLockUtility> {
  if (process.platform === "linux") {
    let command = "/usr/bin/flock"
    try {
      await access(command)
    } catch {
      command = "/bin/flock"
    }
    return { command, args: ["-n", "3"] }
  }
  if (process.platform === "darwin") {
    return { command: "/usr/bin/lockf", args: ["-s", "-t", "0", "3"] }
  }
  throw new Error(`unsupported_lock_test_platform:${process.platform}`)
}

function blockingDeploymentLockUtility(
  utility: DeploymentLockUtility,
): DeploymentLockUtility {
  return process.platform === "linux"
    ? { command: utility.command, args: ["-w", "10", "3"] }
    : { command: utility.command, args: ["-s", "-t", "10", "3"] }
}

async function deploymentKernelLockIsFree(
  lockPath: string,
  utility: DeploymentLockUtility,
): Promise<boolean> {
  const handle = await open(lockPath, "r+")
  try {
    const result = spawnSync(utility.command, utility.args, {
      stdio: ["ignore", "ignore", "pipe", handle.fd],
      encoding: "utf8",
      timeout: 5_000,
    })
    assert.equal(result.error, undefined)
    assert.ok(
      result.status === 0 || result.status === 1 || result.status === 75,
      `unexpected lock utility status ${String(result.status)}`,
    )
    return result.status === 0
  } finally {
    await handle.close()
  }
}

function startDeploymentLockActor(
  t: test.TestContext,
  options: Record<string, unknown> & {
    home: string
    lockPath: string
    utility: DeploymentLockUtility
    wrapperEventsPath: string
    wrapperPath: string
  },
) {
  const configModule = path.join(root, "apps", "cli", "deploy", "config.ts")
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      deploymentLockActorSource,
      configModule,
      JSON.stringify(options),
    ],
    {
      cwd: root,
      env: cliEnvironment({ home: options.home }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
  const completion = new Promise<{
    status: number | null
    stdout: string
    stderr: string
  }>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }))
  })
  t.after(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill("SIGKILL")
  })
  return {
    child,
    completion,
    stdoutText: () => Buffer.concat(stdout).toString("utf8"),
    stderrText: () => Buffer.concat(stderr).toString("utf8"),
  }
}

function deploymentLockActorReports(stdout: string): DeploymentLockActorReport[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DeploymentLockActorReport)
}

async function readJsonLines(
  filePath: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return []
    }
    throw error
  }
}

function assertProcessIsReaped(pid: number | undefined): void {
  if (!pid || !Number.isSafeInteger(pid)) {
    assert.fail(`invalid supervised pid ${String(pid)}`)
  }
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH",
    ),
  )
}

async function stopVerifiedHttpProcess(
  pid: number,
  port: number,
): Promise<void> {
  const health = await httpJson({ port, path: "/health" })
  assert.equal(health.status, 200)
  assert.equal(health.body.pid, pid)
  process.kill(pid, "SIGTERM")
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await delay(50)
    } catch {
      return
    }
  }
  throw new Error("verified_deploy_process_did_not_exit")
}

test("built deploy rejects an invalid package before config, prompt, provider, or process", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-invalid-package-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const invalidPackage = path.join(temporary, "invalid")
  const marker = path.join(temporary, "provider.marker")
  await mkdir(home)
  await mkdir(invalidPackage)
  await installObservableProbe(bin, marker)

  const result = runBuiltCli(
    [
      "deploy",
      "--package",
      invalidPackage,
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--yes",
    ],
    {
      environment: httpCliEnvironment({
        home,
        bin,
        extra: {
          QODER_PERSONAL_ACCESS_TOKEN: "invalid-package-secret-sentinel",
          DEPLOY_PROVIDER_MARKER: marker,
        },
      }),
    },
  )

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Invalid employee package/)
  assert.match(
    result.stderr,
    /Run `digital-employee init <directory>` to scaffold one\./,
  )
  assert.doesNotMatch(result.stdout, /\?|Choice/)
  assert.equal(await noConfig(home), true)
  assert.equal(await markerMissing(marker), true)
})

test("built deploy help is localized, complete, dynamic, and side-effect free", async (t) => {
  const available = getAvailableLocales().join("|")
  const localizedContract: Record<string, RegExp[]> = {
    en: [
      /at most one positional path/,
      /cannot be combined with a positional package-path/,
      /package-bound standalone-v1 is unsupported/,
      /http channel only; default 3000/,
      /name=Digital Employee/,
      /available:\s+http \(ready only after authenticated readback\)/,
      /preview \/ pending:\s+console \| dingtalk/,
      /unavailable:\s+lark \| wecom/,
    ],
    "zh-CN": [
      /最多只能提供一个位置路径/,
      /不能与位置参数 package-path 同时使用/,
      /包绑定 standalone-v1 不受支持/,
      /仅 http；默认 3000/,
      /name=数字员工助手/,
      /可用：\s+http（仅通过认证读回后 ready）/,
      /预览 \/ 等待外部操作：\s+console \| dingtalk/,
      /不可用：\s+lark \| wecom/,
    ],
    ja: [
      /位置引数は最大1つ/,
      /位置引数package-pathとは併用できません/,
      /パッケージ指定standalone-v1は未対応/,
      /httpのみ、デフォルト3000/,
      /name=デジタル従業員/,
      /利用可能：\s+http（認証済みreadback後のみready）/,
      /プレビュー \/ 外部操作待ち：\s+console \| dingtalk/,
      /利用不可：\s+lark \| wecom/,
    ],
  }
  for (const locale of ["en", "zh-CN", "ja"]) {
    await t.test(locale, async (subtest) => {
      const temporary = await isolatedRoot(subtest, "deploy-help-")
      const home = path.join(temporary, "home")
      await mkdir(home)
      const result = runBuiltCli(["deploy", "--help", "--locale", locale], {
        cwd: temporary,
        environment: cliEnvironment({ home }),
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr, "")
      assert.match(result.stdout, /digital-employee deploy \[package-path\]/)
      for (const option of [
        "--package",
        "--channel",
        "--engine",
        "--runtime",
        "--name",
        "--locale",
        "--port",
        "--yes",
        "--help",
      ]) {
        assert.match(result.stdout, new RegExp(option))
      }
      assert.match(
        result.stdout,
        /claude-code \| qoder \| qwen-code \| codebuddy/,
      )
      assert.match(result.stdout, /extractive \| openai-compatible/)
      assert.match(result.stdout, /digital-employee legacy/)
      for (const marker of localizedContract[locale]!) {
        assert.match(result.stdout, marker)
      }
      assert.match(result.stdout, new RegExp(available))
      assert.match(result.stdout, /ready=.*0/)
      assert.match(result.stdout, /pending_external_action=.*2/)
      assert.doesNotMatch(result.stdout, /\?|Choice/)
      assert.equal(await noConfig(home), true)
    })
  }
})

test("built deploy rejects an explicit invalid channel before package, prompt, provider, or process", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-invalid-channel-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const marker = path.join(temporary, "provider.marker")
  await mkdir(home)
  await installObservableProbe(bin, marker)

  const result = runBuiltCli(
    [
      "deploy",
      "--package",
      path.join(temporary, "does-not-exist"),
      "--channel",
      "bogus",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--yes",
    ],
    {
      environment: cliEnvironment({
        home,
        bin,
        extra: {
          QODER_PERSONAL_ACCESS_TOKEN: "invalid-channel-secret-sentinel",
          DEPLOY_PROVIDER_MARKER: marker,
        },
      }),
    },
  )

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Invalid channel/)
  assert.match(result.stderr, /dingtalk\|lark\|wecom\|console\|http/)
  assert.doesNotMatch(result.stdout, /\?|Choice/)
  assert.equal(await noConfig(home), true)
  assert.equal(await markerMissing(marker), true)
})

test("built deploy rejects an explicit unavailable engine before config or runtime start", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-unavailable-engine-")
  const home = path.join(temporary, "home")
  const packageDirectory = path.join(temporary, "unavailable-engine")
  await mkdir(home)
  await createEmployeePackage(packageDirectory, { name: "unavailable-engine" })

  const result = runBuiltCli(
    [
      "deploy",
      packageDirectory,
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--yes",
    ],
    {
      environment: httpCliEnvironment({
        home,
        extra: { QODER_PERSONAL_ACCESS_TOKEN: "unavailable-engine-sentinel" },
      }),
    },
  )

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /selected engine is unsupported, unavailable, or incompatible/i)
  assert.match(
    result.stderr,
    /Install the qoder CLI or pass a different --engine/,
  )
  assert.doesNotMatch(result.stdout, /\?|Choice|Ready:/)
  assert.equal(await noConfig(home), true)
})

test("built deploy rejects an available Agent host that is incompatible with the package before effects", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-incompatible-engine-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "structured-action")
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, {
    name: "structured-action",
    recipe: "structured-action.v1",
  })
  // Qoder 1.1.x now advertises structured_output (host conformance #117), so
  // require an additional capability the Qoder adapter still does not support.
  const manifestPath = path.join(packageDirectory, "employee.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.host.requiredCapabilities = ["structured_output", "sandbox"]
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const result = runBuiltCli(
    [
      "deploy",
      packageDirectory,
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--yes",
    ],
    {
      environment: httpCliEnvironment({
        home,
        bin,
        extra: { QODER_PERSONAL_ACCESS_TOKEN: "incompatible-engine-sentinel" },
      }),
    },
  )

  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /selected engine is unsupported, unavailable, or incompatible/i)
  assert.doesNotMatch(result.stdout, /\?|Choice|Ready:/)
  assert.equal(await noConfig(home), true)
})

test("built complete --yes deploy binds --package and starts a verified /v1/ask runtime without stdin", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-package-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "bound-http")
  const port = await freePort()
  const secret = "http-deploy-secret-sentinel"
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "bound-http" })
  const digest = await computeEmployeePackageDirectoryDigest(packageDirectory)

  const result = runBuiltCli(
    [
      "deploy",
      "--package",
      packageDirectory,
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--name",
      "Bound HTTP",
      "--locale",
      "en",
      "--port",
      String(port),
      "--yes",
    ],
    {
      cwd: temporary,
      environment: httpCliEnvironment({
        home,
        bin,
        extra: {
          QODER_PERSONAL_ACCESS_TOKEN: secret,
          ANTHROPIC_API_KEY: "unused-anthropic-sentinel",
          OPENAI_API_KEY: "unused-openai-sentinel",
          OPENAI_MODEL: "unused-openai-model",
          CODEBUDDY_API_KEY: "unused-codebuddy-sentinel",
          CODEBUDDY_MODEL: "unused-codebuddy-model",
        },
      }),
    },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /\?|Choice/)
  assert.match(result.stdout, /bound-http@0\.1\.0/)
  assert.match(result.stdout, new RegExp(digest))
  assert.match(result.stdout, /runtime=agent-native/)
  assert.match(result.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/v1/ask`))

  const configPath = path.join(home, ".digital-employee", "config.json")
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    runtime: string
    engine: string
    package: { name: string; version: string; digest: string; localReference: string }
    process: { pid: number; launchId: string }
    endpoint: { host: string; port: number; askPath: string; healthPath: string }
  }
  t.after(async () => stopVerifiedHttpProcess(config.process.pid, port))
  assert.equal(config.outcome, "ready")
  assert.equal(config.runtime, "agent-native")
  assert.equal(config.engine, "qoder")
  assert.deepEqual(
    {
      name: config.package.name,
      version: config.package.version,
      digest: config.package.digest,
    },
    { name: "bound-http", version: "0.1.0", digest },
  )
  const localReference = await realpath(packageDirectory)
  assert.equal(config.package.localReference, localReference)
  assert.equal(config.endpoint.askPath, "/v1/ask")
  assert.equal((await stat(configPath)).mode & 0o777, 0o600)
  assert.equal((await stat(path.dirname(configPath))).mode & 0o777, 0o700)

  const health = await httpJson({ port, path: "/health" })
  assert.equal(health.status, 200)
  assert.equal(health.body.inputContract, "message.v1")
  assert.equal(health.body.pid, config.process.pid)
  assert.equal(health.body.launchId, config.process.launchId)
  assert.deepEqual(health.body.endpoint, {
    host: "127.0.0.1",
    port,
    askPath: "/v1/ask",
    healthPath: "/health",
  })
  assert.deepEqual(health.body.package, {
    name: "bound-http",
    version: "0.1.0",
    digest,
    runtime: "agent-native",
    engine: "qoder",
  })
  const command = spawnSync(
    "/bin/ps",
    ["-ww", "-p", String(config.process.pid), "-o", "command="],
    { encoding: "utf8" },
  )
  assert.equal(command.status, 0, command.stderr)
  assert.match(command.stdout, new RegExp(`--launch-id=${config.process.launchId}`))
  assert.match(command.stdout, new RegExp(`--package-digest=${digest}`))
  assert.match(command.stdout, new RegExp(`--port=${port}`))
  const runtimeEnvironment = await ownedProcessEnvironment(config.process.pid)
  if (runtimeEnvironment !== undefined) {
    assert.match(runtimeEnvironment, new RegExp(secret))
    assert.doesNotMatch(
      runtimeEnvironment,
      /unused-anthropic-sentinel|unused-openai-sentinel|unused-openai-model|unused-codebuddy-sentinel|unused-codebuddy-model/,
    )
  }

  const oldPath = await httpJson({
    port,
    path: "/answer",
    headers: httpAuthorization(),
  })
  assert.equal(oldPath.status, 404)
  const answer = await httpJson({
    port,
    path: "/v1/ask",
    method: "POST",
    body: JSON.stringify({ message: "fixture question" }),
    headers: httpAuthorization(),
    timeoutMs: 10_000,
  })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.answer, "fixture answer")

  const knowledgePath = path.join(packageDirectory, "knowledge", "README.md")
  const boundKnowledge = await readFile(knowledgePath)
  await writeFile(
    knowledgePath,
    Buffer.concat([boundKnowledge, Buffer.from("\nunbound mutation\n")]),
  )
  const changedSource = await httpJson({
    port,
    path: "/v1/ask",
    method: "POST",
    body: JSON.stringify({ message: "must not execute changed bytes" }),
    headers: httpAuthorization(),
    timeoutMs: 10_000,
  })
  assert.equal(changedSource.status, 200)
  assert.equal(changedSource.body.answer, "fixture answer")
  await writeFile(knowledgePath, boundKnowledge)
  const restoredSource = await httpJson({
    port,
    path: "/v1/ask",
    method: "POST",
    body: JSON.stringify({ message: "fixture question" }),
    headers: httpAuthorization(),
    timeoutMs: 10_000,
  })
  assert.equal(restoredSource.status, 200)
  assert.equal(restoredSource.body.answer, "fixture answer")

  const argv = spawnSync("ps", ["-p", String(config.process.pid), "-o", "command="], {
    encoding: "utf8",
  })
  const artifacts = [result.stdout, result.stderr, await readFile(configPath, "utf8"), JSON.stringify(health.body), JSON.stringify(answer.body), argv.stdout]
  for (const artifact of artifacts) assert.doesNotMatch(artifact, new RegExp(secret))
  for (const publicArtifact of [
    result.stdout,
    result.stderr,
    JSON.stringify(health.body),
    JSON.stringify(answer.body),
    argv.stdout,
  ]) {
    assert.equal(publicArtifact.includes(localReference), false)
  }
})

test("built HTTP deploy fails closed when the requested loopback port is already occupied", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-port-occupied-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "port-occupied")
  const listener = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(`${JSON.stringify({ owner: "existing-listener" })}\n`)
  })
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", resolve)
  })
  t.after(() => new Promise<void>((resolve) => listener.close(() => resolve())))
  const address = listener.address()
  assert.ok(address && typeof address === "object")
  const port = address.port
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "port-occupied" })

  const result = runBuiltCli(
    [
      "deploy",
      packageDirectory,
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--locale",
      "en",
      "--port",
      String(port),
      "--yes",
    ],
    {
      environment: httpCliEnvironment({
        home,
        bin,
        extra: { QODER_PERSONAL_ACCESS_TOKEN: "occupied-port-sentinel" },
      }),
    },
  )

  assert.equal(result.status, 1, result.stderr)
  assert.doesNotMatch(result.stdout, /Ready:/)
  assert.match(result.stderr, /Deployment failed/i)
  assert.match(
    result.stderr,
    /could not listen on the requested port; another process may already be using it\. Free that port or choose another with --port/i,
  )
  assert.doesNotMatch(
    result.stderr,
    /Private deployment state could not be written/i,
  )
  const configPath = path.join(home, ".digital-employee", "config.json")
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    process?: unknown
    deployedAt?: unknown
  }
  assert.equal(config.outcome, "failed")
  assert.equal(config.process, undefined)
  assert.equal(config.deployedAt, undefined)
  assert.deepEqual(deploymentPids(configPath), [])
  const existing = await httpJson({ port, path: "/health" })
  assert.equal(existing.status, 200)
  assert.equal(existing.body.owner, "existing-listener")
})

test("HTTP reuse binds the canonical local reference and rejects copy-delete substitution", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-local-reference-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageA = path.join(temporary, "a", "local-reference")
  const packageB = path.join(temporary, "b", "local-reference")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const port = await freePort()
  const declaredPackageByteSentinel = "declared-package-byte-sentinel-91ce"
  await mkdir(home)
  await mkdir(path.dirname(packageA), { recursive: true })
  await mkdir(path.dirname(packageB), { recursive: true })
  await installFakeQoder(bin)
  await createEmployeePackage(packageA, { name: "local-reference" })
  await writeFile(
    path.join(packageA, "knowledge", "README.md"),
    `# Local reference\n\n${declaredPackageByteSentinel}\n`,
  )
  await cp(packageA, packageB, { recursive: true })
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "local-reference-sentinel" },
  })
  const args = (packageDirectory: string) => [
    "deploy",
    packageDirectory,
    "--channel",
    "http",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Local Reference",
    "--port",
    String(port),
    "--yes",
  ]

  const first = runBuiltCli(args(packageA), { environment })
  assert.equal(first.status, 0, first.stderr)
  const firstConfig = JSON.parse(await readFile(configPath, "utf8")) as {
    package: { localReference: string; digest: string }
    process: { pid: number }
  }
  const canonicalA = await realpath(packageA)
  const canonicalB = await realpath(packageB)
  assert.equal(firstConfig.package.localReference, canonicalA)
  assert.notEqual(canonicalA, canonicalB)
  t.after(async () => {
    for (const pid of deploymentPids(configPath)) {
      try {
        await stopVerifiedHttpProcess(pid, port)
      } catch {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // The exact test-owned runtime already exited.
        }
      }
    }
  })

  const firstBytes = await readFile(configPath)
  const firstIdentity = await lstat(configPath)
  const samePath = runBuiltCli(args(packageA), { environment })
  assert.equal(samePath.status, 0, samePath.stderr)
  assert.match(samePath.stdout, /Ready:/)
  assert.deepEqual(deploymentPids(configPath), [firstConfig.process.pid])
  const afterSamePath = await lstat(configPath)
  assert.equal(afterSamePath.dev, firstIdentity.dev)
  assert.equal(afterSamePath.ino, firstIdentity.ino)
  assert.deepEqual(await readFile(configPath), firstBytes)

  await rm(packageA, { recursive: true })
  const beforeRejected = await lstat(configPath)
  const rejectedBytes = await readFile(configPath)
  const substituted = runBuiltCli(args(packageB), { environment })
  assert.equal(substituted.status, 1, substituted.stderr)
  assert.match(substituted.stderr, /cannot be replaced safely/i)
  assert.doesNotMatch(substituted.stdout, /Ready:/)
  assert.deepEqual(deploymentPids(configPath), [firstConfig.process.pid])
  const afterRejected = await lstat(configPath)
  assert.equal(afterRejected.dev, beforeRejected.dev)
  assert.equal(afterRejected.ino, beforeRejected.ino)
  assert.deepEqual(await readFile(configPath), rejectedBytes)
  for (const artifact of [
    first.stdout,
    first.stderr,
    samePath.stdout,
    samePath.stderr,
    substituted.stdout,
    substituted.stderr,
  ]) {
    assert.equal(artifact.includes(canonicalA), false)
    assert.equal(artifact.includes(canonicalB), false)
  }

  await stopVerifiedHttpProcess(firstConfig.process.pid, port)
  await waitFor(() => deploymentPids(configPath).length === 0)
  const fresh = runBuiltCli(args(packageB), { environment })
  assert.equal(fresh.status, 0, fresh.stderr)
  assert.match(fresh.stdout, /Ready:/)
  const freshConfig = JSON.parse(await readFile(configPath, "utf8")) as {
    package: { localReference: string; digest: string }
    process: { pid: number }
  }
  assert.equal(freshConfig.package.localReference, canonicalB)
  assert.equal(freshConfig.package.digest, firstConfig.package.digest)
  assert.notEqual(freshConfig.process.pid, firstConfig.process.pid)
  assert.deepEqual(deploymentPids(configPath), [freshConfig.process.pid])
  const freshHealth = await httpJson({ port, path: "/health" })
  const freshAnswer = await httpJson({
    port,
    path: "/v1/ask",
    method: "POST",
    body: JSON.stringify({ message: "fresh B privacy check" }),
    headers: httpAuthorization(),
    timeoutMs: 10_000,
  })
  assert.equal(freshHealth.status, 200)
  assert.equal(freshAnswer.status, 200)
  const freshArgv = spawnSync(
    "ps",
    ["-ww", "-p", String(freshConfig.process.pid), "-o", "command="],
    { encoding: "utf8" },
  )
  assert.equal(freshArgv.status, 0, freshArgv.stderr)
  for (const artifact of [
    fresh.stdout,
    fresh.stderr,
    JSON.stringify(freshHealth.body),
    JSON.stringify(freshAnswer.body),
    freshArgv.stdout,
  ]) {
    assert.equal(artifact.includes(canonicalA), false)
    assert.equal(artifact.includes(canonicalB), false)
    assert.equal(artifact.includes(declaredPackageByteSentinel), false)
  }
  await stopVerifiedHttpProcess(freshConfig.process.pid, port)
  await waitFor(() => deploymentPids(configPath).length === 0)
})

test("HTTP reuse requires the exact symbolic and live token binding", async (t) => {
  for (const fixture of [
    { name: "change", first: "credential-alpha", second: "credential-beta" },
    { name: "remove", first: "credential-alpha", second: undefined },
  ]) {
    await t.test(fixture.name, async (subtest) => {
      const temporary = await isolatedRoot(
        subtest,
        "deploy-http-token-binding-",
      )
      const home = path.join(temporary, "home")
      const bin = path.join(temporary, "bin")
      const packageDirectory = path.join(temporary, "token-binding")
      const configPath = path.join(home, ".digital-employee", "config.json")
      const port = await freePort()
      await mkdir(home)
      await installFakeQoder(bin)
      await createEmployeePackage(packageDirectory, { name: "token-binding" })
      const environment = (token: string | undefined) =>
        cliEnvironment({
          home,
          bin,
          extra: {
            QODER_PERSONAL_ACCESS_TOKEN: "token-binding-host-sentinel",
            ...(token ? { DIGITAL_EMPLOYEE_HTTP_TOKEN: token } : {}),
          },
        })
      const args = [
        "deploy",
        packageDirectory,
        "--channel",
        "http",
        "--engine",
        "qoder",
        "--runtime",
        "agent-native",
        "--locale",
        "en",
        "--name",
        "Token Binding",
        "--port",
        String(port),
        "--yes",
      ]
      const first = runBuiltCli(args, {
        environment: environment(fixture.first),
      })
      assert.equal(first.status, 0, first.stderr)
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        process: { pid: number }
      }
      subtest.after(async () => {
        try {
          await stopVerifiedHttpProcess(
            config.process.pid,
            port,
          )
        } catch {
          try {
            process.kill(config.process.pid, "SIGKILL")
          } catch {
            // The exact test-owned runtime already exited.
          }
        }
      })
      const beforeBytes = await readFile(configPath)
      const before = await lstat(configPath)
      const replay = runBuiltCli(args, {
        environment: environment(fixture.second),
      })
      assert.equal(replay.status, 1, replay.stderr)
      assert.match(
        replay.stderr,
        fixture.name === "remove"
          ? /http_token_required/
          : /cannot be replaced safely/i,
      )
      assert.doesNotMatch(replay.stdout, /Ready:/)
      assert.deepEqual(deploymentPids(configPath), [config.process.pid])
      const after = await lstat(configPath)
      assert.equal(after.dev, before.dev)
      assert.equal(after.ino, before.ino)
      assert.deepEqual(await readFile(configPath), beforeBytes)
      assert.doesNotMatch(
        `${replay.stdout}${replay.stderr}${await readFile(configPath, "utf8")}`,
        /credential-alpha|credential-beta|token-binding-host-sentinel/,
      )
      await stopVerifiedHttpProcess(config.process.pid, port)
      await waitFor(() => deploymentPids(configPath).length === 0)
    })
  }
})

test("built HTTP deploy enforces Bearer auth and persists only the symbolic token reference", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-auth-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "http-auth")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const port = await freePort()
  const credential = "http-auth-credential-sentinel-7f4c"
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "http-auth" })
  const result = runBuiltCli(
    [
      "deploy",
      packageDirectory,
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--locale",
      "en",
      "--name",
      "Authenticated HTTP",
      "--port",
      String(port),
      "--yes",
    ],
    {
      environment: cliEnvironment({
        home,
        bin,
        extra: {
          QODER_PERSONAL_ACCESS_TOKEN: "http-auth-host-sentinel",
          DIGITAL_EMPLOYEE_HTTP_TOKEN: credential,
        },
      }),
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const configText = await readFile(configPath, "utf8")
  const config = JSON.parse(configText) as {
    secretReferences: { httpTokenEnv: string }
    process: { pid: number }
  }
  t.after(async () => stopVerifiedHttpProcess(config.process.pid, port))
  assert.deepEqual(config.secretReferences, {
    httpTokenEnv: "DIGITAL_EMPLOYEE_HTTP_TOKEN",
  })

  const body = JSON.stringify({ message: "authenticated fixture question" })
  const missing = await httpJson({
    port,
    path: "/v1/ask",
    method: "POST",
    body,
  })
  assert.equal(missing.status, 401)
  assert.deepEqual(missing.body, { error: "unauthorized" })
  const wrong = await httpJson({
    port,
    path: "/v1/ask",
    method: "POST",
    body,
    headers: { authorization: "Bearer wrong-credential" },
  })
  assert.equal(wrong.status, 401)
  assert.deepEqual(wrong.body, { error: "unauthorized" })
  const accepted = await httpJson({
    port,
    path: "/v1/ask",
    method: "POST",
    body,
    headers: { authorization: `Bearer ${credential}` },
    timeoutMs: 10_000,
  })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.answer, "fixture answer")
  const health = await httpJson({ port, path: "/health" })
  assert.equal(health.status, 200)
  const argv = spawnSync(
    "ps",
    ["-ww", "-p", String(config.process.pid), "-o", "command="],
    { encoding: "utf8" },
  )
  assert.equal(argv.status, 0, argv.stderr)
  for (const artifact of [
    result.stdout,
    result.stderr,
    configText,
    JSON.stringify(missing.body),
    JSON.stringify(wrong.body),
    JSON.stringify(accepted.body),
    JSON.stringify(health.body),
    argv.stdout,
  ]) {
    assert.equal(artifact.includes(credential), false)
  }
})

test("HTTP runtime rejects mismatched immutable digest and port arguments before listening", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-runtime-mismatch-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "runtime-mismatch")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const runtimeEntry = path.join(root, "dist", "apps", "cli", "deploy", "http-runtime.js")
  const port = await freePort()
  let mismatchPort = await freePort()
  while (mismatchPort === port) mismatchPort = await freePort()
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "runtime-mismatch" })
  await mkdir(path.dirname(configPath), { mode: 0o700 })
  const lockPath = path.join(path.dirname(configPath), ".deploy.lock")
  const lockNonce = "9".repeat(32)
  await writeFile(lockPath, `${JSON.stringify({
    schemaVersion: "deploy-lock.v3",
    pid: process.pid,
    nonce: lockNonce,
    ownerStartedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 })
  const lockHandle = await open(lockPath, "r+")
  const lockStat = await lockHandle.stat()
  t.after(() => lockHandle.close())
  const packageDigest = await computeEmployeePackageDirectoryDigest(packageDirectory)
  const localReference = await realpath(packageDirectory)
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "runtime-mismatch-sentinel" },
  })

  async function exerciseMismatch(
    tupleDigest: string,
    tuplePort: number,
  ): Promise<void> {
    const launchId = createHash("sha256")
      .update(`launch:${tupleDigest}:${tuplePort}`)
      .digest("hex")
      .slice(0, 32)
    const activationFence = createHash("sha256")
      .update(`fence:${tupleDigest}:${tuplePort}`)
      .digest("hex")
      .slice(0, 32)
    const tuple = {
      statePath: configPath,
      launchId,
      activationFence,
      botName: "Runtime Mismatch",
      engine: "qoder",
      runtime: "agent-native",
      packageName: "runtime-mismatch",
      packageVersion: "0.1.0",
      packageDigest: tupleDigest,
      host: "127.0.0.1",
      port: tuplePort,
      askPath: "/v1/ask",
      healthPath: "/health",
      lockNonce,
      lockDevice: lockStat.dev,
      lockInode: lockStat.ino,
      lockOwnerPid: process.pid,
    }
    const child = spawn(
      process.execPath,
      [
        runtimeEntry,
        `--state=${configPath}`,
        `--launch-id=${launchId}`,
        `--package-digest=${tupleDigest}`,
        `--port=${tuplePort}`,
        "--package-name=runtime-mismatch",
        "--package-version=0.1.0",
        "--engine=qoder",
        "--runtime=agent-native",
        "--bot-name=Runtime Mismatch",
        "--host=127.0.0.1",
        "--ask-path=/v1/ask",
        "--health-path=/health",
        `--activation-fence=${activationFence}`,
      ],
      {
        env: environment,
        stdio: ["ignore", "ignore", "ignore", "ipc", lockHandle.fd],
      },
    )
    assert.ok(child.pid)
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    })
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", resolve)
    })
    const awaiting = await Promise.race([
      new Promise<Record<string, unknown>>((resolve) => {
        child.once("message", (message) => resolve(message as Record<string, unknown>))
      }),
      delay(5_000).then(() => {
        throw new Error("runtime_activation_request_timeout")
      }),
    ])
    assert.deepEqual(awaiting, {
      type: "deploy-http-runtime-awaiting-activation",
      ...tuple,
    })
    const now = new Date().toISOString()
    const state = {
      schemaVersion: "deploy-state.v1",
      locale: "en",
      channel: "http",
      botName: "Runtime Mismatch",
      engine: "qoder",
      runtime: "agent-native",
      package: {
        name: "runtime-mismatch",
        version: "0.1.0",
        digest: packageDigest,
        localReference,
      },
      outcome: "pending_external_action",
      secretReferences: {
        httpTokenEnv: "DIGITAL_EMPLOYEE_HTTP_TOKEN",
      },
      endpoint: {
        protocol: "http",
        host: "127.0.0.1",
        port,
        askPath: "/v1/ask",
        healthPath: "/health",
      },
      process: {
        pid: child.pid,
        startedAt: now,
        launchId,
        activationFence,
        activationState: "prepared",
      },
      updatedAt: now,
    }
    const serialized = `${JSON.stringify(state, null, 2)}\n`
    await writeFile(configPath, serialized, { mode: 0o600 })
    const stateDigest = createHash("sha256").update(serialized).digest("hex")
    child.send({
      type: "deploy-http-runtime-activation",
      phase: "prepare",
      stateDigest,
      ...tuple,
    })
    assert.equal(await Promise.race([
      completion,
      delay(5_000).then(() => {
        throw new Error("runtime_mismatch_did_not_exit")
      }),
    ]), 1)
    await assert.rejects(
      httpJson({ port: tuplePort, path: "/health", timeoutMs: 200 }),
    )
  }

  await exerciseMismatch(`sha256:${"0".repeat(64)}`, port)
  await exerciseMismatch(packageDigest, mismatchPort)
  await assert.rejects(
    httpJson({ port, path: "/health", timeoutMs: 200 }),
  )
})

test("HTTP activation protocol fails closed across EOF, timeout, forged tuple, generation, and lock-fence faults", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-activation-faults-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "activation-faults")
  const stateDirectory = path.join(home, ".digital-employee")
  const configPath = path.join(stateDirectory, "config.json")
  const lockPath = path.join(stateDirectory, ".deploy.lock")
  const runtimeEntry = path.join(root, "dist", "apps", "cli", "deploy", "http-runtime.js")
  const releaseFdProbe = path.join(
    root,
    "tests",
    "apps",
    "fixtures",
    "http-release-fd-probe.cjs",
  )
  const releaseFdMarker = path.join(temporary, "release-fd.marker")
  const builtConfigModule = path.join(
    root,
    "dist",
    "apps",
    "cli",
    "deploy",
    "config.js",
  )
  const builtChannelsModule = path.join(
    root,
    "dist",
    "apps",
    "cli",
    "deploy",
    "channels.js",
  )
  const freshOwnerSource = `
const { acquireDeploymentLock, loadConfigSnapshot } = await import(process.argv[1])
const { readbackHttpDeployment } = await import(process.argv[2])
const report = (message) => new Promise((resolve, reject) => {
  process.send(message, (error) => error ? reject(error) : resolve())
})
await report({ type: "fresh-owner-attempting" })
const lock = await acquireDeploymentLock({ timeoutMs: 10000 })
const evidence = async (type) => {
  await lock.assertOwned()
  const snapshot = await loadConfigSnapshot()
  const readback = await readbackHttpDeployment(snapshot.config)
  await lock.assertOwned()
  await report({
    type,
    contended: lock.contended,
    fingerprint: snapshot.fingerprint,
    readback,
  })
}
await evidence("fresh-owner-acquired")
process.on("message", async (message) => {
  if (message?.type === "recheck") await evidence("fresh-owner-rechecked")
  if (message?.type === "release") {
    await lock.release()
    process.exit(0)
  }
})
`
  await mkdir(home)
  await mkdir(stateDirectory, { mode: 0o700 })
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "activation-faults" })
  const packageDigest = await computeEmployeePackageDirectoryDigest(packageDirectory)
  const localReference = await realpath(packageDirectory)
  const lockNonce = "8".repeat(32)
  const lockRecord = `${JSON.stringify({
    schemaVersion: "deploy-lock.v3",
    pid: process.pid,
    nonce: lockNonce,
    ownerStartedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  })}\n`
  const lockUtilityCommand = process.platform === "linux"
    ? await (async () => {
        try {
          await access("/usr/bin/flock")
          return "/usr/bin/flock"
        } catch {
          return "/bin/flock"
        }
      })()
    : "/usr/bin/lockf"
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: {
      QODER_PERSONAL_ACCESS_TOKEN: "activation-fault-sentinel",
    },
  })

  type ProtocolTuple = {
    statePath: string
    launchId: string
    activationFence: string
    botName: string
    engine: string
    runtime: string
    packageName: string
    packageVersion: string
    packageDigest: string
    host: string
    port: number
    askPath: string
    healthPath: string
    lockNonce: string
    lockDevice: number
    lockInode: number
    lockOwnerPid: number
  }
  type RuntimeCase = {
    child: ReturnType<typeof spawn>
    completion: Promise<number | null>
    tuple: ProtocolTuple
    port: number
    stopProbe: () => Promise<boolean>
    leaseHandle?: FileHandle
    lockPath: string
  }

  function kernelLockStatus(fileDescriptor: number): number | null {
    const args = process.platform === "linux"
      ? ["-n", "3"]
      : ["-s", "-t", "0", "3"]
    const result = spawnSync(lockUtilityCommand, args, {
      stdio: ["ignore", "ignore", "pipe", fileDescriptor],
      encoding: "utf8",
      timeout: 5_000,
    })
    assert.equal(result.error, undefined)
    return result.status
  }

  async function probeKernelLock(probePath: string): Promise<boolean> {
    const handle = await open(probePath, "r+")
    try {
      const status = kernelLockStatus(handle.fd)
      assert.ok(
        status === 0 || status === 1 || status === 75,
        `unexpected lock utility status ${String(status)}`,
      )
      return status === 0
    } finally {
      await handle.close()
    }
  }

  function waitForMessage(
    child: ReturnType<typeof spawn>,
    timeoutMs = 5_000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (
        message?: Record<string, unknown>,
        error?: Error,
      ) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.removeListener("message", onMessage)
        child.removeListener("error", onError)
        child.removeListener("exit", onExit)
        if (error) reject(error)
        else resolve(message!)
      }
      const onMessage = (message: unknown) => {
        finish(message as Record<string, unknown>)
      }
      const onError = (error: Error) => finish(undefined, error)
      const onExit = () => finish(
        undefined,
        new Error("runtime_protocol_child_exited"),
      )
      const timer = setTimeout(() => finish(
        undefined,
        new Error("runtime_protocol_message_timeout"),
      ), timeoutMs)
      timer.unref()
      child.once("message", onMessage)
      child.once("error", onError)
      child.once("exit", onExit)
    })
  }

  function sendMessage(
    child: ReturnType<typeof spawn>,
    message: Record<string, unknown>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      child.send?.(message, (error) => error ? reject(error) : resolve())
    })
  }

  function startPortProbe(port: number): () => Promise<boolean> {
    let stopped = false
    let everAccepted = false
    const running = (async () => {
      while (!stopped) {
        const accepted = await new Promise<boolean>((resolve) => {
          const socket = createConnection({ host: "127.0.0.1", port })
          let settled = false
          const finish = (value: boolean) => {
            if (settled) return
            settled = true
            socket.destroy()
            resolve(value)
          }
          socket.once("connect", () => finish(true))
          socket.once("error", () => finish(false))
          socket.setTimeout(25, () => finish(false))
        })
        everAccepted ||= accepted
        await delay(5)
      }
    })()
    return async () => {
      stopped = true
      await running
      return everAccepted
    }
  }

  async function spawnCase(label: string): Promise<RuntimeCase> {
    const port = await freePort()
    const launchId = createHash("sha256").update(`launch:${label}`).digest("hex").slice(0, 32)
    const activationFence = createHash("sha256").update(`fence:${label}`).digest("hex").slice(0, 32)
    await writeFile(lockPath, lockRecord, { mode: 0o600 })
    const leaseHandle = await open(lockPath, "r+")
    assert.equal(kernelLockStatus(leaseHandle.fd), 0)
    const lockStat = await leaseHandle.stat()
    const tuple: ProtocolTuple = {
      statePath: configPath,
      launchId,
      activationFence,
      botName: "Activation Faults",
      engine: "qoder",
      runtime: "agent-native",
      packageName: "activation-faults",
      packageVersion: "0.1.0",
      packageDigest,
      host: "127.0.0.1",
      port,
      askPath: "/v1/ask",
      healthPath: "/health",
      lockNonce,
      lockDevice: lockStat.dev,
      lockInode: lockStat.ino,
      lockOwnerPid: process.pid,
    }
    const child = spawn(process.execPath, [
      runtimeEntry,
      `--state=${configPath}`,
      `--launch-id=${launchId}`,
      `--package-digest=${packageDigest}`,
      `--port=${port}`,
      "--package-name=activation-faults",
      "--package-version=0.1.0",
      "--engine=qoder",
      "--runtime=agent-native",
      "--bot-name=Activation Faults",
      "--host=127.0.0.1",
      "--ask-path=/v1/ask",
      "--health-path=/health",
      `--activation-fence=${activationFence}`,
    ], {
      env: label === "successful-fd4-release"
        ? {
            ...environment,
            NODE_OPTIONS: `--require=${releaseFdProbe}`,
            DEPLOY_RELEASE_FD_MARKER: releaseFdMarker,
          }
        : environment,
      stdio: ["ignore", "ignore", "ignore", "ipc", leaseHandle.fd],
    })
    assert.ok(child.pid, `runtime PID missing for ${label}`)
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    })
    t.after(() => leaseHandle.close().catch(() => {}))
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", resolve)
    })
    const stopProbe = startPortProbe(port)
    t.after(() => stopProbe())
    const awaiting = await waitForMessage(child)
    assert.deepEqual(awaiting, {
      type: "deploy-http-runtime-awaiting-activation",
      ...tuple,
    }, `activation barrier not reached for ${label}`)
    return {
      child,
      completion,
      tuple,
      port,
      stopProbe,
      leaseHandle,
      lockPath,
    }
  }

  async function persistState(
    runtimeCase: RuntimeCase,
    activationState: "prepared" | "authorized",
    outcome: "pending_external_action" | "ready" = "pending_external_action",
  ): Promise<string> {
    const now = new Date().toISOString()
    const state = {
      schemaVersion: "deploy-state.v1",
      locale: "en",
      channel: "http",
      botName: "Activation Faults",
      engine: "qoder",
      runtime: "agent-native",
      package: {
        name: "activation-faults",
        version: "0.1.0",
        digest: packageDigest,
        localReference,
      },
      outcome,
      secretReferences: {
        httpTokenEnv: "DIGITAL_EMPLOYEE_HTTP_TOKEN",
      },
      endpoint: {
        protocol: "http",
        host: "127.0.0.1",
        port: runtimeCase.port,
        askPath: "/v1/ask",
        healthPath: "/health",
      },
      process: {
        pid: runtimeCase.child.pid,
        startedAt: now,
        launchId: runtimeCase.tuple.launchId,
        activationFence: runtimeCase.tuple.activationFence,
        activationState,
      },
      ...(outcome === "ready" ? { deployedAt: now } : {}),
      updatedAt: now,
    }
    const serialized = `${JSON.stringify(state, null, 2)}\n`
    await writeFile(configPath, serialized, { mode: 0o600 })
    return createHash("sha256").update(serialized).digest("hex")
  }

  function activationMessage(
    runtimeCase: RuntimeCase,
    phase: string,
    stateDigest: string,
  ): Record<string, unknown> {
    return {
      type: "deploy-http-runtime-activation",
      phase,
      stateDigest,
      ...runtimeCase.tuple,
    }
  }

  async function closeParentLease(runtimeCase: RuntimeCase): Promise<void> {
    const handle = runtimeCase.leaseHandle
    assert.ok(handle, "parent activation lease was already closed")
    runtimeCase.leaseHandle = undefined
    await handle.close()
  }

  async function sendPhaseAndExpectAck(
    runtimeCase: RuntimeCase,
    phase: string,
    stateDigest: string,
    ackPhase: string,
  ): Promise<void> {
    const acknowledged = waitForMessage(runtimeCase.child)
    await sendMessage(
      runtimeCase.child,
      activationMessage(runtimeCase, phase, stateDigest),
    )
    assert.deepEqual(await acknowledged, {
      type: "deploy-http-runtime-activation-ack",
      phase: ackPhase,
      stateDigest,
      ...runtimeCase.tuple,
    })
  }

  async function advanceToPrepared(runtimeCase: RuntimeCase): Promise<string> {
    const digest = await persistState(runtimeCase, "prepared")
    await sendPhaseAndExpectAck(runtimeCase, "prepare", digest, "prepared")
    return digest
  }

  async function advanceToAuthorized(runtimeCase: RuntimeCase): Promise<string> {
    await advanceToPrepared(runtimeCase)
    const digest = await persistState(runtimeCase, "authorized")
    await sendPhaseAndExpectAck(runtimeCase, "commit", digest, "authorized")
    return digest
  }

  async function advanceToReadyToListen(
    runtimeCase: RuntimeCase,
  ): Promise<string> {
    const digest = await advanceToAuthorized(runtimeCase)
    await sendPhaseAndExpectAck(
      runtimeCase,
      "activate",
      digest,
      "ready-to-listen",
    )
    return digest
  }

  async function advanceToListening(runtimeCase: RuntimeCase): Promise<string> {
    const digest = await advanceToReadyToListen(runtimeCase)
    await sendPhaseAndExpectAck(runtimeCase, "listen", digest, "listening")
    return digest
  }

  async function advanceToDetached(runtimeCase: RuntimeCase): Promise<string> {
    const digest = await advanceToListening(runtimeCase)
    await sendPhaseAndExpectAck(runtimeCase, "detach", digest, "detached")
    return digest
  }

  async function expectBoundedExitWithoutListen(
    runtimeCase: RuntimeCase,
    timeoutMs = 5_000,
  ): Promise<void> {
    assert.equal(await Promise.race([
      runtimeCase.completion,
      delay(timeoutMs).then(() => {
        throw new Error("runtime_fault_did_not_exit_bounded")
      }),
    ]), 1)
    assert.equal(await runtimeCase.stopProbe(), false)
    await closeParentLease(runtimeCase)
    assert.equal(await probeKernelLock(runtimeCase.lockPath), true)
    await assert.rejects(
      httpJson({ port: runtimeCase.port, path: "/health", timeoutMs: 100 }),
    )
  }

  async function expectBoundedExitAfterPossibleListen(
    runtimeCase: RuntimeCase,
  ): Promise<void> {
    assert.equal(await Promise.race([
      runtimeCase.completion,
      delay(5_000).then(() => {
        throw new Error("runtime_lock_fault_did_not_exit_bounded")
      }),
    ]), 1)
    await runtimeCase.stopProbe()
    await closeParentLease(runtimeCase)
    assert.equal(await probeKernelLock(runtimeCase.lockPath), true)
    await assert.rejects(
      httpJson({ port: runtimeCase.port, path: "/health", timeoutMs: 100 }),
    )
  }

  async function displaceLockFence(
    runtimeCase: RuntimeCase,
    label: string,
  ): Promise<void> {
    const displaced = `${lockPath}.${label}.displaced`
    await rename(lockPath, displaced)
    runtimeCase.lockPath = displaced
    await writeFile(lockPath, lockRecord, { mode: 0o600 })
    assert.notEqual((await lstat(lockPath)).ino, runtimeCase.tuple.lockInode)
  }

  async function expectParentIpcLossReleasesLease(
    runtimeCase: RuntimeCase,
    listenerMayHaveOpened = false,
  ): Promise<void> {
    await closeParentLease(runtimeCase)
    assert.equal(
      await probeKernelLock(runtimeCase.lockPath),
      false,
      "the inherited fd4 lease did not fence a contender",
    )
    const disconnectedAt = Date.now()
    runtimeCase.child.disconnect()
    assert.equal(await Promise.race([
      runtimeCase.completion,
      delay(5_000).then(() => {
        throw new Error("runtime_parent_loss_did_not_exit_bounded")
      }),
    ]), 1)
    assert.ok(Date.now() - disconnectedAt < 5_000)
    const accepted = await runtimeCase.stopProbe()
    if (!listenerMayHaveOpened) assert.equal(accepted, false)
    await assert.rejects(
      httpJson({ port: runtimeCase.port, path: "/health", timeoutMs: 100 }),
    )
    assert.equal(
      await probeKernelLock(runtimeCase.lockPath),
      true,
      "the exited runtime retained fd4 or its kernel lock",
    )
  }

  async function assertAskCannotReachHost(
    runtimeCase: RuntimeCase,
    listenerOpen: boolean,
  ): Promise<void> {
    if (!listenerOpen) {
      await assert.rejects(
        httpJson({ port: runtimeCase.port, path: "/v1/ask", timeoutMs: 100 }),
      )
    } else {
      const response = await httpJson({
        port: runtimeCase.port,
        path: "/v1/ask",
        method: "POST",
        body: JSON.stringify({ message: "pre-release request" }),
        headers: httpAuthorization(),
      })
      assert.equal(response.status, 400)
      assert.deepEqual(response.body.error, {
        code: "http_runtime_activation_incomplete",
        retryable: true,
      })
    }
  }

  const eof = await spawnCase("parent-eof-awaiting")
  assert.equal(eof.child.connected, true)
  await expectParentIpcLossReleasesLease(eof)

  const missingPhase = await spawnCase("missing-prepare-timeout")
  const missingStartedAt = Date.now()
  await expectBoundedExitWithoutListen(missingPhase, 12_000)
  assert.ok(Date.now() - missingStartedAt >= 9_000, "protocol timeout fired too early")

  const generationMismatch = await spawnCase("generation-mismatch")
  await persistState(generationMismatch, "prepared")
  await sendMessage(
    generationMismatch.child,
    activationMessage(generationMismatch, "prepare", "0".repeat(64)),
  )
  await expectBoundedExitWithoutListen(generationMismatch)

  const forgedMutations: Array<(message: Record<string, unknown>) => void> = [
    (message) => { message.statePath = `${message.statePath as string}.forged` },
    (message) => { message.launchId = "0".repeat(32) },
    (message) => { message.activationFence = "0".repeat(32) },
    (message) => { message.botName = "Forged" },
    (message) => { message.engine = "claude-code" },
    (message) => { message.runtime = "standalone-v1" },
    (message) => { message.packageName = "forged" },
    (message) => { message.packageVersion = "9.9.9" },
    (message) => { message.packageDigest = `sha256:${"f".repeat(64)}` },
    (message) => { message.host = "0.0.0.0" },
    (message) => { message.port = Number(message.port) + 1 },
    (message) => { message.askPath = "/forged" },
    (message) => { message.healthPath = "/forged" },
    (message) => { message.lockNonce = "7".repeat(32) },
    (message) => { message.lockDevice = Number(message.lockDevice) + 1 },
    (message) => { message.lockInode = Number(message.lockInode) + 1 },
    (message) => { message.lockOwnerPid = Number(message.lockOwnerPid) + 1 },
    (message) => { message.extra = "forged" },
    (message) => { message.type = "forged" },
    (message) => { message.phase = "commit" },
  ]
  for (let index = 0; index < forgedMutations.length; index += 1) {
    const forged = await spawnCase(`forged-${index}`)
    const digest = await persistState(forged, "prepared")
    const message = activationMessage(forged, "prepare", digest)
    forgedMutations[index]!(message)
    await sendMessage(forged.child, message)
    await expectBoundedExitWithoutListen(forged)
  }

  const preparedParentLoss = await spawnCase("parent-eof-prepared")
  await advanceToPrepared(preparedParentLoss)
  await assertAskCannotReachHost(preparedParentLoss, false)
  await expectParentIpcLossReleasesLease(preparedParentLoss)

  const authorizedParentLoss = await spawnCase("parent-eof-authorized")
  await advanceToAuthorized(authorizedParentLoss)
  await assertAskCannotReachHost(authorizedParentLoss, false)
  await expectParentIpcLossReleasesLease(authorizedParentLoss)

  const readyToListenParentLoss = await spawnCase(
    "parent-eof-ready-to-listen",
  )
  await advanceToReadyToListen(readyToListenParentLoss)
  await assertAskCannotReachHost(readyToListenParentLoss, false)
  await expectParentIpcLossReleasesLease(readyToListenParentLoss)

  const listeningParentLoss = await spawnCase("parent-eof-listening")
  await advanceToListening(listeningParentLoss)
  await assertAskCannotReachHost(listeningParentLoss, true)
  await expectParentIpcLossReleasesLease(listeningParentLoss, true)

  const detachedParentLoss = await spawnCase("parent-eof-detached")
  await advanceToDetached(detachedParentLoss)
  await assertAskCannotReachHost(detachedParentLoss, true)
  await expectParentIpcLossReleasesLease(detachedParentLoss, true)

  const readyPublishedParentLoss = await spawnCase(
    "parent-eof-ready-published",
  )
  await advanceToDetached(readyPublishedParentLoss)
  await persistState(readyPublishedParentLoss, "authorized", "ready")
  await assertAskCannotReachHost(readyPublishedParentLoss, true)
  await expectParentIpcLossReleasesLease(readyPublishedParentLoss, true)
  const staleReady = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
  }
  assert.equal(staleReady.outcome, "ready")

  const released = await spawnCase("successful-fd4-release")
  await advanceToDetached(released)
  const readyDigest = await persistState(released, "authorized", "ready")
  const readyBytes = await readFile(configPath)
  assert.equal(
    await probeKernelLock(released.lockPath),
    false,
    "the child did not retain fd4 through the detached barrier",
  )
  const freshOwner = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      freshOwnerSource,
      builtConfigModule,
      builtChannelsModule,
    ],
    {
      cwd: root,
      env: environment,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  )
  assert.ok(freshOwner.pid)
  t.after(() => {
    if (freshOwner.exitCode === null && freshOwner.signalCode === null) {
      freshOwner.kill("SIGKILL")
    }
  })
  let freshOwnerStderr = ""
  freshOwner.stderr?.on("data", (chunk: Buffer | string) => {
    freshOwnerStderr += Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : chunk
  })
  const freshOwnerCompletion = new Promise<number | null>((resolve, reject) => {
    freshOwner.once("error", reject)
    freshOwner.once("exit", resolve)
  })
  const freshOwnerMessages: Record<string, unknown>[] = []
  freshOwner.on("message", (message) => {
    if (message && typeof message === "object" && !Array.isArray(message)) {
      freshOwnerMessages.push(message as Record<string, unknown>)
    }
  })
  await waitFor(() =>
    freshOwnerMessages.some((message) =>
      message.type === "fresh-owner-attempting"
    )
  )
  await delay(250)
  assert.equal(
    freshOwnerMessages.some((message) =>
      message.type === "fresh-owner-acquired"
    ),
    false,
    "a fresh owner acquired while the runtime still retained fd4",
  )
  const gatedAsk = await httpJson({
    port: released.port,
    path: "/v1/ask",
    method: "POST",
    body: JSON.stringify({ message: "must not launch before handoff" }),
    headers: httpAuthorization(),
  })
  assert.equal(gatedAsk.status, 400)
  assert.equal(gatedAsk.body.status, "rejected")
  assert.deepEqual(gatedAsk.body.error, {
    code: "http_runtime_activation_incomplete",
    retryable: true,
  })
  await sendPhaseAndExpectAck(released, "release", readyDigest, "released")
  await waitFor(async () => !await markerMissing(releaseFdMarker))
  assert.equal(
    await readFile(releaseFdMarker, "utf8"),
    `${released.child.pid}:fd4-closed-before-ack\n`,
  )
  await waitFor(() => released.child.connected === false)
  await delay(250)
  assert.equal(
    freshOwnerMessages.some((message) =>
      message.type === "fresh-owner-acquired"
    ),
    false,
    "the parent descriptor did not retain authority after child handoff",
  )
  assert.deepEqual(await readFile(configPath), readyBytes)
  const releasedHealth = await httpJson({ port: released.port, path: "/health" })
  assert.equal(releasedHealth.status, 200)
  assert.equal(releasedHealth.body.inputContract, "message.v1")
  const releasedAsk = await httpJson({
    port: released.port,
    path: "/v1/ask",
    method: "POST",
    body: JSON.stringify({ message: "released request" }),
    headers: httpAuthorization(),
  })
  assert.equal(releasedAsk.status, 200)
  assert.equal(releasedAsk.body.answer, "fixture answer")
  await closeParentLease(released)
  await waitFor(() =>
    freshOwnerMessages.some((message) =>
      message.type === "fresh-owner-acquired"
    )
  )
  const acquired = freshOwnerMessages.find((message) =>
    message.type === "fresh-owner-acquired"
  )!
  assert.equal(acquired.contended, true)
  assert.equal(acquired.readback, true)
  assert.equal(
    (acquired.fingerprint as { kind?: string }).kind,
    "present",
  )
  assert.equal(
    (acquired.fingerprint as { digest?: string }).digest,
    readyDigest,
  )
  const readyConfig = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    package: { digest: string }
    process: { pid: number; launchId: string; activationFence: string }
  }
  assert.equal(readyConfig.outcome, "ready")
  assert.equal(readyConfig.package.digest, packageDigest)
  assert.equal(
    await computeEmployeePackageDirectoryDigest(packageDirectory),
    packageDigest,
  )
  const health = await httpJson({ port: released.port, path: "/health" })
  assert.equal(health.status, 200)
  assert.equal(health.body.pid, readyConfig.process.pid)
  assert.equal(health.body.launchId, readyConfig.process.launchId)
  assert.equal(
    health.body.activationFence,
    readyConfig.process.activationFence,
  )
  await delay(100)
  assert.deepEqual(await readFile(configPath), readyBytes)
  await sendMessage(freshOwner, { type: "recheck" })
  await waitFor(() =>
    freshOwnerMessages.some((message) =>
      message.type === "fresh-owner-rechecked"
    )
  )
  const rechecked = freshOwnerMessages.find((message) =>
    message.type === "fresh-owner-rechecked"
  )!
  assert.equal(rechecked.readback, true)
  assert.deepEqual(rechecked.fingerprint, acquired.fingerprint)
  released.child.kill("SIGTERM")
  assert.equal(await Promise.race([
    released.completion,
    delay(5_000).then(() => {
      throw new Error("released_runtime_did_not_stop_bounded")
    }),
  ]), 0)
  assert.deepEqual(await readFile(configPath), readyBytes)
  await sendMessage(freshOwner, { type: "release" })
  assert.equal(
    await Promise.race([
      freshOwnerCompletion,
      delay(5_000).then(() => {
        throw new Error("fresh_lock_owner_did_not_release_bounded")
      }),
    ]),
    0,
    freshOwnerStderr,
  )
  assert.equal(await released.stopProbe(), true)
  assert.equal(await probeKernelLock(released.lockPath), true)

  const lockFenceLoss = await spawnCase("lock-fence-loss")
  const lockFenceDigest = await persistState(lockFenceLoss, "prepared")
  await displaceLockFence(lockFenceLoss, "prepare")
  await sendMessage(
    lockFenceLoss.child,
    activationMessage(lockFenceLoss, "prepare", lockFenceDigest),
  )
  await expectBoundedExitWithoutListen(lockFenceLoss)

  const listeningLockFenceLoss = await spawnCase("listening-lock-fence-loss")
  const listeningDigest = await advanceToListening(listeningLockFenceLoss)
  await assertAskCannotReachHost(listeningLockFenceLoss, true)
  await displaceLockFence(listeningLockFenceLoss, "listening")
  await sendMessage(
    listeningLockFenceLoss.child,
    activationMessage(listeningLockFenceLoss, "detach", listeningDigest),
  )
  await expectBoundedExitAfterPossibleListen(listeningLockFenceLoss)

  const detachedLockFenceLoss = await spawnCase("detached-lock-fence-loss")
  await advanceToDetached(detachedLockFenceLoss)
  const detachedReadyDigest = await persistState(
    detachedLockFenceLoss,
    "authorized",
    "ready",
  )
  await assertAskCannotReachHost(detachedLockFenceLoss, true)
  await displaceLockFence(detachedLockFenceLoss, "detached")
  await sendMessage(
    detachedLockFenceLoss.child,
    activationMessage(detachedLockFenceLoss, "release", detachedReadyDigest),
  )
  await expectBoundedExitAfterPossibleListen(detachedLockFenceLoss)
})

test("built parent never rolls back or signals after an autonomous child loses, delays, or forges the release ACK", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-release-ack-faults-")
  const sourceDist = path.join(root, "dist")
  const releaseAnchor = "        becomeAutonomous();\n        try {"
  const releasedPhase = '                phase: "released",'

  async function faultedCli(
    label: string,
    fault: "lost" | "delayed" | "forged",
  ): Promise<string> {
    const copiedDist = path.join(temporary, label, "dist")
    await mkdir(path.dirname(copiedDist), { recursive: true })
    await cp(sourceDist, copiedDist, { recursive: true })
    await symlink(
      path.join(root, "node_modules"),
      path.join(copiedDist, "node_modules"),
      "dir",
    )
    const runtimePath = path.join(
      copiedDist,
      "apps",
      "cli",
      "deploy",
      "http-runtime.js",
    )
    const source = await readFile(runtimePath, "utf8")
    let patched = source
    if (fault === "lost") {
      patched = source.replace(
        releaseAnchor,
        "        becomeAutonomous();\n" +
          "        if (process.connected) process.disconnect();\n" +
          "        try {",
      )
    } else if (fault === "delayed") {
      patched = source.replace(
        releaseAnchor,
        "        becomeAutonomous();\n" +
          "        await new Promise((resolve) => setTimeout(resolve, 11000));\n" +
          "        try {",
      )
    } else {
      patched = source.replace(
        releasedPhase,
        '                phase: "forged-released",',
      )
    }
    assert.notEqual(patched, source, `runtime fault ${fault} was not injected`)
    await writeFile(runtimePath, patched)
    return path.join(copiedDist, "apps", "cli", "bin.js")
  }

  for (const fault of ["lost", "delayed", "forged"] as const) {
    const caseRoot = path.join(temporary, fault)
    const home = path.join(caseRoot, "home")
    const bin = path.join(caseRoot, "bin")
    const packageDirectory = path.join(caseRoot, `release-ack-${fault}`)
    const configPath = path.join(home, ".digital-employee", "config.json")
    const hostEffectMarker = path.join(caseRoot, "host-effect.marker")
    const port = await freePort()
    await mkdir(home, { recursive: true })
    await mkdir(bin, { recursive: true })
    const qoder = path.join(bin, "qodercli")
    await writeFile(
      qoder,
      "#!/usr/bin/env node\n" +
        "const fs = require('node:fs')\n" +
        "if (process.argv.includes('--version')) process.stdout.write('1.1.12\\n')\n" +
        `else fs.appendFileSync(${JSON.stringify(hostEffectMarker)}, 'called\\n')\n`,
      { mode: 0o755 },
    )
    await chmod(qoder, 0o755)
    await createEmployeePackage(packageDirectory, {
      name: `release-ack-${fault}`,
    })
    const entry = await faultedCli(`runtime-${fault}`, fault)
    const environment = httpCliEnvironment({
      home,
      bin,
      extra: { QODER_PERSONAL_ACCESS_TOKEN: "release-boundary-test-sentinel" },
    })
    const args = [
      "deploy",
      packageDirectory,
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--locale",
      "en",
      "--name",
      `Release ACK ${fault}`,
      "--port",
      String(port),
      "--yes",
    ]
    const result = runBuiltCli(args, { environment, entry })
    assert.equal(result.status, 1, result.stderr)
    assert.doesNotMatch(result.stdout, /Ready:/)
    assert.match(result.stderr, /http_activation_release_ack_failed/)
    const readyBytes = await readFile(configPath)
    const config = JSON.parse(readyBytes.toString("utf8")) as {
      outcome: string
      process: { pid: number }
    }
    assert.equal(config.outcome, "ready")
    assert.deepEqual(deploymentPids(configPath), [config.process.pid])
    const health = await httpJson({ port, path: "/health" })
    assert.equal(health.status, 200)
    assert.equal(health.body.pid, config.process.pid)
    const authorizationProbe = await httpJson({
      port,
      path: "/v1/ask",
      method: "POST",
      body: JSON.stringify({ requestId: "release-ack-probe" }),
      headers: httpAuthorization(),
    })
    assert.equal(authorizationProbe.status, 400)
    assert.equal(
      authorizationProbe.body.error,
      "client_identity_fields_not_allowed",
    )
    assert.equal(await markerMissing(hostEffectMarker), true)
    assert.deepEqual(await readFile(configPath), readyBytes)

    const retry = runBuiltCli(args, { environment, entry })
    assert.equal(retry.status, 0, retry.stderr)
    assert.match(retry.stdout, /Ready:/)
    const reused = JSON.parse(await readFile(configPath, "utf8")) as {
      outcome: string
      process: { pid: number }
    }
    assert.equal(reused.outcome, "ready")
    assert.equal(reused.process.pid, config.process.pid)
    assert.equal(await markerMissing(hostEffectMarker), true)
    await stopVerifiedHttpProcess(config.process.pid, port)
  }
})

test("release-time child Ready reopen mismatch preserves the external generation without rollback or preauthorization effects", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-release-reopen-race-")
  const copiedDist = path.join(temporary, "copied-dist")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "release-reopen-race")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const releaseReceivedMarker = path.join(temporary, "release-received.marker")
  const hostEffectMarker = path.join(temporary, "host-effect.marker")
  const port = await freePort()
  await cp(path.join(root, "dist"), copiedDist, { recursive: true })
  await symlink(
    path.join(root, "node_modules"),
    path.join(copiedDist, "node_modules"),
    "dir",
  )
  const runtimePath = path.join(
    copiedDist,
    "apps",
    "cli",
    "deploy",
    "http-runtime.js",
  )
  const source = await readFile(runtimePath, "utf8")
  const readyReopen =
    '        await activatedConfig(runtimeArguments, releaseStateDigest, "authorized", "ready");'
  const patched = source.replace(
    readyReopen,
    `        await (await import("node:fs/promises")).writeFile(${JSON.stringify(releaseReceivedMarker)}, "received\\n");\n` +
      "        await new Promise((resolve) => setTimeout(resolve, 1000));\n" +
      readyReopen,
  )
  assert.notEqual(patched, source, "release reopen fault was not injected")
  await writeFile(runtimePath, patched)
  await mkdir(home, { recursive: true })
  await mkdir(bin, { recursive: true })
  const qoder = path.join(bin, "qodercli")
  await writeFile(
    qoder,
    "#!/usr/bin/env node\n" +
      "const fs = require('node:fs')\n" +
      "if (process.argv.includes('--version')) process.stdout.write('1.1.12\\n')\n" +
      `else fs.appendFileSync(${JSON.stringify(hostEffectMarker)}, 'called\\n')\n`,
    { mode: 0o755 },
  )
  await chmod(qoder, 0o755)
  await createEmployeePackage(packageDirectory, { name: "release-reopen-race" })
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "release-reopen-test-sentinel" },
  })
  const running = startBuiltCli([
    "deploy",
    packageDirectory,
    "--channel",
    "http",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Release Reopen Race",
    "--port",
    String(port),
    "--yes",
  ], {
    environment,
    entry: path.join(copiedDist, "apps", "cli", "bin.js"),
  })
  t.after(() => {
    for (const pid of deploymentPids(configPath)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // The exact test-owned runtime already exited.
      }
    }
  })
  await waitFor(async () => !await markerMissing(releaseReceivedMarker), 20_000)
  const gatedAsk = await httpJson({
    port,
    path: "/v1/ask",
    method: "POST",
    body: JSON.stringify({ message: "must remain gated" }),
    headers: httpAuthorization(),
  })
  assert.equal(gatedAsk.status, 400)
  assert.deepEqual(gatedAsk.body.error, {
    code: "http_runtime_activation_incomplete",
    retryable: true,
  })
  assert.equal(await markerMissing(hostEffectMarker), true)

  const original = JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >
  const replacement = `${JSON.stringify({
    ...original,
    botName: "External Replacement",
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`
  const replacementPath = `${configPath}.replacement`
  await writeFile(replacementPath, replacement, { mode: 0o600 })
  await rename(replacementPath, configPath)
  const replacementIdentity = await lstat(configPath)

  const result = await running.completion
  assert.equal(result.status, 1, result.stderr)
  assert.doesNotMatch(result.stdout, /Ready:/)
  assert.equal((await lstat(configPath)).ino, replacementIdentity.ino)
  assert.equal(await readFile(configPath, "utf8"), replacement)
  await waitFor(() => deploymentPids(configPath).length === 0)
  await assert.rejects(httpJson({ port, path: "/health", timeoutMs: 200 }))
  assert.equal(await markerMissing(hostEffectMarker), true)
})

test("parent crash after release send preserves the autonomous Ready child for exact fresh reuse", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-post-release-parent-crash-")
  const copiedDist = path.join(temporary, "copied-dist")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "post-release-crash")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const hostEffectMarker = path.join(temporary, "host-effect.marker")
  const autonomousMarker = path.join(temporary, "autonomous.marker")
  const port = await freePort()
  await cp(path.join(root, "dist"), copiedDist, { recursive: true })
  await symlink(
    path.join(root, "node_modules"),
    path.join(copiedDist, "node_modules"),
    "dir",
  )
  const runtimePath = path.join(
    copiedDist,
    "apps",
    "cli",
    "deploy",
    "http-runtime.js",
  )
  const source = await readFile(runtimePath, "utf8")
  const releaseAnchor = "        becomeAutonomous();\n        try {"
  const patched = source.replace(
    releaseAnchor,
    "        becomeAutonomous();\n" +
      `        await (await import("node:fs/promises")).writeFile(${JSON.stringify(autonomousMarker)}, "autonomous\\n");\n` +
      "        await new Promise((resolve) => setTimeout(resolve, 30000));\n" +
      "        try {",
  )
  assert.notEqual(patched, source, "post-release crash fault was not injected")
  await writeFile(runtimePath, patched)
  await mkdir(home, { recursive: true })
  await mkdir(bin, { recursive: true })
  const qoder = path.join(bin, "qodercli")
  await writeFile(
    qoder,
    "#!/usr/bin/env node\n" +
      "const fs = require('node:fs')\n" +
      "if (process.argv.includes('--version')) process.stdout.write('1.1.12\\n')\n" +
      `else fs.appendFileSync(${JSON.stringify(hostEffectMarker)}, 'called\\n')\n`,
    { mode: 0o755 },
  )
  await chmod(qoder, 0o755)
  await createEmployeePackage(packageDirectory, { name: "post-release-crash" })
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "post-release-crash-test-sentinel" },
  })
  const entry = path.join(copiedDist, "apps", "cli", "bin.js")
  const args = [
    "deploy",
    packageDirectory,
    "--channel",
    "http",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Post Release Crash",
    "--port",
    String(port),
    "--yes",
  ]
  const running = startBuiltCli(args, { environment, entry })
  assert.ok(running.child.pid)
  t.after(() => {
    for (const pid of deploymentPids(configPath)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // The exact test-owned runtime already exited.
      }
    }
  })

  let readyBytes: Buffer | undefined
  let runtimePid = 0
  await waitFor(async () => {
    try {
      const bytes = await readFile(configPath)
      const config = JSON.parse(bytes.toString("utf8")) as {
        outcome?: string
        process?: { pid?: number }
      }
      if (config.outcome !== "ready" || !config.process?.pid) return false
      if (await markerMissing(autonomousMarker)) return false
      readyBytes = bytes
      runtimePid = config.process.pid
      return true
    } catch {
      return false
    }
  }, 20_000)
  process.kill(running.child.pid!, "SIGKILL")
  const crashed = await running.completion
  assert.equal(crashed.status, null)
  assert.doesNotMatch(crashed.stdout, /Ready:/)
  assert.ok(readyBytes)
  assert.deepEqual(await readFile(configPath), readyBytes)
  assert.doesNotThrow(() => process.kill(runtimePid, 0))
  let health: Awaited<ReturnType<typeof httpJson>> | undefined
  await waitFor(async () => {
    try {
      health = await httpJson({ port, path: "/health", timeoutMs: 200 })
      return health.status === 200
    } catch {
      return false
    }
  }, 5_000)
  assert.ok(health)
  assert.equal(health.status, 200)
  assert.equal(health.body.pid, runtimePid)
  assert.equal(await markerMissing(hostEffectMarker), true)

  const retry = runBuiltCli(args, { environment, entry })
  assert.equal(retry.status, 0, retry.stderr)
  assert.match(retry.stdout, /Ready:/)
  const reused = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    process: { pid: number }
  }
  assert.equal(reused.outcome, "ready")
  assert.equal(reused.process.pid, runtimePid)
  assert.equal(await markerMissing(hostEffectMarker), true)
  await stopVerifiedHttpProcess(runtimePid, port)
})

test("package mutation during the post-persistence HTTP gate prevents Ready and cleans up", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-final-digest-race-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "final-digest-race")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const mutationPath = path.join(packageDirectory, "knowledge", "README.md")
  const port = await freePort()
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "final-digest-race" })
  await addValidFinalGateAssets(packageDirectory)
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "final-digest-race-sentinel" },
  })
  const running = startBuiltCli(
    [
      "deploy",
      packageDirectory,
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--locale",
      "en",
      "--name",
      "Final Digest Race",
      "--port",
      String(port),
      "--yes",
    ],
    { environment },
  )
  const watcher = spawn(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');const c=process.argv[1],p=process.argv[2];const end=Date.now()+60000;function poll(){try{const s=JSON.parse(fs.readFileSync(c,'utf8'));if(s.outcome==='pending_external_action'&&s.code==='http_final_verification_pending'){fs.appendFileSync(p,'\\nmutated-during-final-gate\\n');process.exit(0)}}catch{}if(Date.now()>end)process.exit(2);setImmediate(poll)}poll()",
      configPath,
      mutationPath,
    ],
    { stdio: "ignore" },
  )
  const watcherCompletion = new Promise<number | null>((resolve) => {
    watcher.once("close", resolve)
  })
  t.after(() => {
    for (const pid of deploymentPids(configPath)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // The exact test-owned worker already exited.
      }
    }
  })
  const result = await running.completion
  assert.equal(result.status, 1, result.stderr)
  assert.doesNotMatch(result.stdout, /Ready:/)
  assert.match(result.stderr, /Deployment failed/)
  assert.equal(await watcherCompletion, 0)
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    code: string
    process?: unknown
    deployedAt?: unknown
  }
  assert.equal(config.outcome, "failed")
  assert.equal(config.code, "http_final_readback_failed")
  assert.equal(config.process, undefined)
  assert.equal(config.deployedAt, undefined)
  await waitFor(() => deploymentPids(configPath).length === 0)
  await assert.rejects(httpJson({ port, path: "/health", timeoutMs: 200 }))
})

test("SIGTERM during the post-persistence HTTP gate exits interrupted without Ready or orphan", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-final-signal-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "final-signal")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const port = await freePort()
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "final-signal" })
  await addValidFinalGateAssets(packageDirectory)
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "final-signal-sentinel" },
  })
  const running = startBuiltCli(
    [
      "deploy",
      packageDirectory,
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--locale",
      "en",
      "--name",
      "Final Signal",
      "--port",
      String(port),
      "--yes",
    ],
    { environment },
  )
  assert.ok(running.child.pid)
  const watcher = spawn(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');const c=process.argv[1],pid=Number(process.argv[2]);const end=Date.now()+60000;function poll(){try{const s=JSON.parse(fs.readFileSync(c,'utf8'));if(s.outcome==='pending_external_action'&&s.code==='http_final_verification_pending'){process.kill(pid,'SIGTERM');process.exit(0)}}catch{}if(Date.now()>end)process.exit(2);setImmediate(poll)}poll()",
      configPath,
      String(running.child.pid),
    ],
    { stdio: "ignore" },
  )
  const watcherCompletion = new Promise<number | null>((resolve) => {
    watcher.once("close", resolve)
  })
  t.after(() => {
    for (const pid of deploymentPids(configPath)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // The exact test-owned worker already exited.
      }
    }
  })
  const result = await running.completion
  assert.equal(result.status, 1, result.stderr)
  assert.doesNotMatch(result.stdout, /Ready:/)
  assert.match(result.stderr, /interrupted/i)
  assert.equal(await watcherCompletion, 0)
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    code: string
    process?: unknown
  }
  assert.equal(config.outcome, "failed")
  assert.equal(config.code, "deploy_interrupted")
  assert.equal(config.process, undefined)
  await waitFor(() => deploymentPids(configPath).length === 0)
})

test("built deploy consumes cwd when no package path is supplied", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-cwd-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "cwd-bound")
  const port = await freePort()
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "cwd-bound" })

  const result = runBuiltCli(
    [
      "deploy",
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--port",
      String(port),
      "--yes",
    ],
    {
      cwd: packageDirectory,
      environment: httpCliEnvironment({
        home,
        bin,
        extra: { QODER_PERSONAL_ACCESS_TOKEN: "cwd-secret-sentinel" },
      }),
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(
    await readFile(path.join(home, ".digital-employee", "config.json"), "utf8"),
  ) as { package: { name: string; localReference: string }; process: { pid: number } }
  t.after(async () => stopVerifiedHttpProcess(config.process.pid, port))
  assert.equal(config.package.name, "cwd-bound")
  assert.equal(config.package.localReference, await realpath(packageDirectory))
})

test("built deploy binds each exact cwd package and rejects a cwd without a package", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-cwd-matrix-")
  const bin = path.join(temporary, "bin")
  await installFakeQoder(bin)
  const packages = [
    { directory: path.join(temporary, "cwd-alpha"), name: "cwd-alpha" },
    { directory: path.join(temporary, "cwd-beta"), name: "cwd-beta" },
  ]
  const bindings: Array<{ name: string; digest: string; localReference: string }> = []
  for (const [index, fixture] of packages.entries()) {
    await createEmployeePackage(fixture.directory, { name: fixture.name })
    await writeFile(
      path.join(fixture.directory, "knowledge", "README.md"),
      `# ${fixture.name}\n\nDistinct cwd package ${index}.\n`,
    )
    const home = path.join(temporary, `home-${index}`)
    await mkdir(home)
    const result = runBuiltCli(
      [
        "deploy",
        "--channel",
        "console",
        "--engine",
        "qoder",
        "--runtime",
        "agent-native",
        "--yes",
      ],
      {
        cwd: fixture.directory,
        environment: cliEnvironment({
          home,
          bin,
          extra: { QODER_PERSONAL_ACCESS_TOKEN: `cwd-matrix-${index}` },
        }),
      },
    )
    assert.equal(result.status, 2, result.stderr)
    const config = JSON.parse(
      await readFile(path.join(home, ".digital-employee", "config.json"), "utf8"),
    ) as { package: { name: string; digest: string; localReference: string } }
    assert.equal(config.package.name, fixture.name)
    assert.equal(
      config.package.digest,
      await computeEmployeePackageDirectoryDigest(fixture.directory),
    )
    assert.equal(config.package.localReference, await realpath(fixture.directory))
    bindings.push(config.package)
  }
  assert.notEqual(bindings[0]!.name, bindings[1]!.name)
  assert.notEqual(bindings[0]!.digest, bindings[1]!.digest)
  assert.notEqual(bindings[0]!.localReference, bindings[1]!.localReference)

  const invalidCwd = path.join(temporary, "cwd-invalid")
  const invalidHome = path.join(temporary, "home-invalid")
  await mkdir(invalidCwd)
  await mkdir(invalidHome)
  const invalid = runBuiltCli(
    [
      "deploy",
      "--channel",
      "console",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--yes",
    ],
    {
      cwd: invalidCwd,
      environment: cliEnvironment({ home: invalidHome, bin }),
    },
  )
  assert.equal(invalid.status, 1, invalid.stderr)
  assert.match(invalid.stderr, /Invalid employee package/)
  assert.equal(await noConfig(invalidHome), true)
})

test("concurrent complete HTTP deploys converge on one verified process and exact state", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-concurrent-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "concurrent-http")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const port = await freePort()
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "concurrent-http" })
  const digest = await computeEmployeePackageDirectoryDigest(packageDirectory)
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "concurrent-secret-sentinel" },
  })
  const args = [
    "deploy",
    packageDirectory,
    "--channel",
    "http",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--name",
    "Concurrent HTTP",
    "--locale",
    "en",
    "--port",
    String(port),
    "--yes",
  ]

  t.after(async () => {
    for (const pid of deploymentPids(configPath)) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // The exact test-owned worker already exited.
      }
    }
  })

  const [left, right] = await Promise.all([
    runBuiltCliAsync(args, { environment }),
    runBuiltCliAsync(args, { environment }),
  ])
  assert.equal(left.status, 0, left.stderr)
  assert.equal(right.status, 0, right.stderr)
  assert.doesNotMatch(`${left.stdout}${right.stdout}`, /\?|Choice/)

  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    package: { digest: string }
    process: { pid: number }
  }
  assert.equal(config.outcome, "ready")
  assert.equal(config.package.digest, digest)
  assert.deepEqual(deploymentPids(configPath), [config.process.pid])
  const health = await httpJson({ port, path: "/health" })
  assert.equal(health.body.pid, config.process.pid)
})

test("stale unresponsive HTTP deployments are preserved with localized fail-closed guidance", async (t) => {
  const guidance = {
    en: /cannot be replaced safely.*http_runtime_stale_unverified/i,
    "zh-CN": /无法被安全替换.*http_runtime_stale_unverified/,
    ja: /安全に置換できない.*http_runtime_stale_unverified/,
  } as const
  for (const locale of ["en", "zh-CN", "ja"] as const) {
    await t.test(locale, async (subtest) => {
      const temporary = await isolatedRoot(
        subtest,
        `deploy-http-stale-${locale}-`,
      )
      const home = path.join(temporary, "home")
      const bin = path.join(temporary, "bin")
      const packageDirectory = path.join(temporary, "stale-http")
      const configPath = path.join(home, ".digital-employee", "config.json")
      const port = await freePort()
      await mkdir(home)
      await installFakeQoder(bin)
      await createEmployeePackage(packageDirectory, { name: "stale-http" })
      const environment = httpCliEnvironment({
        home,
        bin,
        extra: { QODER_PERSONAL_ACCESS_TOKEN: `stale-${locale}-sentinel` },
      })
      const args = [
        "deploy",
        packageDirectory,
        "--channel",
        "http",
        "--engine",
        "qoder",
        "--runtime",
        "agent-native",
        "--locale",
        locale,
        "--name",
        "Stale HTTP",
        "--port",
        String(port),
        "--yes",
      ]
      const seed = runBuiltCli(args, { environment })
      assert.equal(seed.status, 0, seed.stderr)
      const stale = JSON.parse(await readFile(configPath, "utf8")) as {
        process: { pid: number; startedAt: string }
        updatedAt: string
      }
      const pid = stale.process.pid
      subtest.after(async () => {
        try {
          process.kill(pid, "SIGCONT")
        } catch {
          return
        }
        try {
          await stopVerifiedHttpProcess(pid, port)
        } catch {
          try {
            process.kill(pid, "SIGKILL")
          } catch {
            // The exact test-owned worker already exited.
          }
        }
      })
      process.kill(pid, "SIGSTOP")
      await waitFor(() => {
        const status = spawnSync("/bin/ps", [
          "-o",
          "state=",
          "-p",
          String(pid),
        ], { encoding: "utf8" })
        return status.status === 0 && status.stdout.trim().startsWith("T")
      })
      stale.process.startedAt = new Date(Date.now() - 60_000).toISOString()
      stale.updatedAt = new Date().toISOString()
      const staleBytes = Buffer.from(`${JSON.stringify(stale, null, 2)}\n`)
      await writeFile(configPath, staleBytes, { mode: 0o600 })
      const before = await lstat(configPath)

      const result = runBuiltCli(args, { environment })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, guidance[locale])
      assert.doesNotMatch(result.stdout, /Ready:/)
      const after = await lstat(configPath)
      assert.equal(after.dev, before.dev)
      assert.equal(after.ino, before.ino)
      assert.deepEqual(await readFile(configPath), staleBytes)
      assert.deepEqual(deploymentPids(configPath), [pid])
      process.kill(pid, 0)
      const status = spawnSync("/bin/ps", [
        "-o",
        "state=",
        "-p",
        String(pid),
      ], { encoding: "utf8" })
      assert.equal(status.status, 0, status.stderr)
      assert.match(status.stdout.trim(), /^T/)
    })
  }
})

test("unsafe deployment state fails closed and preserves bytes and path identity", async (t) => {
  const cases: Array<{
    name: string
    setup(configPath: string, temporary: string): Promise<void>
  }> = [
    {
      name: "malformed JSON",
      async setup(configPath) {
        await writeFile(configPath, "{malformed", { mode: 0o600 })
      },
    },
    {
      name: "oversized file",
      async setup(configPath) {
        await writeFile(configPath, Buffer.alloc(1024 * 1024 + 1, 0x61), {
          mode: 0o600,
        })
      },
    },
    {
      name: "unsupported schema",
      async setup(configPath) {
        await writeFile(
          configPath,
          `${JSON.stringify({ schemaVersion: "deploy-state.v999" })}\n`,
          { mode: 0o600 },
        )
      },
    },
    {
      name: "unsafe file permissions",
      async setup(configPath) {
        await writeFile(configPath, `${JSON.stringify({ locale: "en" })}\n`, {
          mode: 0o644,
        })
      },
    },
    {
      name: "unsafe state directory permissions",
      async setup(configPath) {
        await writeFile(configPath, `${JSON.stringify({ locale: "en" })}\n`, {
          mode: 0o600,
        })
        await chmod(path.dirname(configPath), 0o755)
      },
    },
    {
      name: "unknown secret-bearing field",
      async setup(configPath) {
        const forbiddenKey = ["api", "Key"].join("")
        const syntheticValue = ["unsafe-state", "secret-sentinel"].join("-")
        await writeFile(
          configPath,
          `${JSON.stringify({
            schemaVersion: "deploy-state.v1",
            [forbiddenKey]: syntheticValue,
          })}\n`,
          { mode: 0o600 },
        )
      },
    },
    {
      name: "symlink",
      async setup(configPath, temporary) {
        const target = path.join(temporary, "state-target.json")
        await writeFile(target, "{\"schemaVersion\":\"deploy-state.v1\"}\n", {
          mode: 0o600,
        })
        await symlink(target, configPath)
      },
    },
    {
      name: "non-regular path",
      async setup(configPath) {
        await mkdir(configPath)
      },
    },
    {
      name: "ambiguous legacy state",
      async setup(configPath) {
        await writeFile(
          configPath,
          `${JSON.stringify({ locale: "en", channel: "http" })}\n`,
          { mode: 0o600 },
        )
      },
    },
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async (subtest) => {
      const temporary = await isolatedRoot(subtest, "deploy-unsafe-state-")
      const home = path.join(temporary, "home")
      const configDirectory = path.join(home, ".digital-employee")
      const configPath = path.join(configDirectory, "config.json")
      const packageDirectory = path.join(temporary, "state-bound")
      const bin = path.join(temporary, "bin")
      const marker = path.join(temporary, "provider.marker")
      await mkdir(home)
      await mkdir(configDirectory, { mode: 0o700 })
      await createEmployeePackage(packageDirectory, { name: "state-bound" })
      await installObservableProbe(bin, marker)
      await fixture.setup(configPath, temporary)
      const before = await lstat(configPath)
      const linkTarget = before.isSymbolicLink()
        ? await readlink(configPath)
        : undefined
      const linkedBytes = linkTarget ? await readFile(linkTarget) : undefined
      const bytes = before.isFile() ? await readFile(configPath) : undefined

      const result = runBuiltCli(
        [
          "deploy",
          packageDirectory,
          "--channel",
          "http",
          "--engine",
          "qoder",
          "--runtime",
          "agent-native",
          "--locale",
          "en",
          "--yes",
        ],
        {
          environment: cliEnvironment({
            home,
            bin,
            extra: { DEPLOY_PROVIDER_MARKER: marker },
          }),
        },
      )

      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /state is invalid.*preserved/i)
      assert.doesNotMatch(result.stderr, /unsafe-state-secret-sentinel/)
      assert.doesNotMatch(result.stdout, /\?|Choice/)
      assert.equal(await markerMissing(marker), true)
      const after = await lstat(configPath)
      assert.equal(after.dev, before.dev)
      assert.equal(after.ino, before.ino)
      assert.equal(after.isSymbolicLink(), before.isSymbolicLink())
      if (bytes) assert.deepEqual(await readFile(configPath), bytes)
      if (linkTarget) {
        assert.equal(await readlink(configPath), linkTarget)
        assert.deepEqual(await readFile(linkTarget), linkedBytes)
      }
      assert.deepEqual(
        (await readdir(configDirectory)).sort(),
        ["config.json"],
      )
      assert.deepEqual(deploymentPids(configPath), [])
    })
  }
})

test("deployment state changed during read fails closed without replacing bytes or inode", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-state-read-race-")
  const home = path.join(temporary, "home")
  const configDirectory = path.join(home, ".digital-employee")
  const configPath = path.join(configDirectory, "config.json")
  const packageDirectory = path.join(temporary, "read-race-bound")
  await mkdir(home)
  await mkdir(configDirectory, { mode: 0o700 })
  await createEmployeePackage(packageDirectory, { name: "read-race-bound" })
  const original = Buffer.from(
    `${JSON.stringify({ locale: "en" })}${" ".repeat(900_000)}\n`,
  )
  await writeFile(configPath, original, { mode: 0o600 })
  const before = await lstat(configPath)
  const mutator = spawn(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');const p=process.argv[1];const end=Date.now()+5000;let n=0;while(Date.now()<end){const d=new Date(Date.now()+(n++%2));fs.utimesSync(p,d,d)}",
      configPath,
    ],
    { stdio: "ignore" },
  )
  t.after(() => {
    try {
      mutator.kill("SIGTERM")
    } catch {
      // The bounded mutator already exited.
    }
  })
  await delay(100)

  const result = runBuiltCli(
    ["deploy", packageDirectory, "--engine", "qoder", "--locale", "en"],
    { environment: cliEnvironment({ home }) },
  )
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /deploy_config_changed_during_read/)
  const after = await lstat(configPath)
  assert.equal(after.dev, before.dev)
  assert.equal(after.ino, before.ino)
  assert.deepEqual(await readFile(configPath), original)
  assert.deepEqual((await readdir(configDirectory)).sort(), ["config.json"])
})

test("config save rejects open-read path replacements without clobbering them", async (t) => {
  for (const replacement of ["regular", "symlink", "directory"] as const) {
    await t.test(replacement, async (subtest) => {
      const temporary = await isolatedRoot(
        subtest,
        `deploy-config-open-race-${replacement}-`,
      )
      const home = path.join(temporary, "home")
      const configDirectory = path.join(home, ".digital-employee")
      const configPath = path.join(configDirectory, "config.json")
      const displacedPath = path.join(configDirectory, "opened-generation.json")
      const sentinelPath = path.join(temporary, "replacement-sentinel.json")
      await mkdir(home)
      await mkdir(configDirectory, { mode: 0o700 })
      const state = (botName: string): DeployConfig => ({
        schemaVersion: "deploy-state.v1",
        locale: "en",
        channel: "console",
        botName,
        engine: "qoder",
        runtime: "agent-native",
        package: {
          name: "config-open-race",
          version: "0.1.0",
          digest: `sha256:${"7".repeat(64)}`,
          localReference: path.join(temporary, "package"),
        },
        outcome: "pending_external_action",
        updatedAt: new Date().toISOString(),
      })
      const originalBytes = Buffer.from(
        `${JSON.stringify(state("Opened Generation"), null, 2)}\n`,
      )
      const replacementBytes = Buffer.from(
        `${JSON.stringify(state("External Replacement"), null, 2)}\n`,
      )
      await writeFile(configPath, originalBytes, { mode: 0o600 })
      await writeFile(sentinelPath, replacementBytes, { mode: 0o600 })
      const expected = (await loadConfigSnapshotFromPath(configPath)).fingerprint
      let replacementIdentity: Awaited<ReturnType<typeof lstat>> | undefined
      const originalHome = process.env.HOME
      process.env.HOME = home
      try {
        await assert.rejects(
          saveConfig(state("Attempted Overwrite"), {
            expected,
            lock: { assertOwned: async () => {} },
            currentReadHooks: {
              afterHandleRead: async () => {
                await rename(configPath, displacedPath)
                if (replacement === "regular") {
                  await writeFile(configPath, replacementBytes, { mode: 0o600 })
                } else if (replacement === "symlink") {
                  await symlink(sentinelPath, configPath)
                } else {
                  await mkdir(configPath, { mode: 0o700 })
                }
                replacementIdentity = await lstat(configPath)
              },
            },
          }),
          /deploy_config_changed_during_read/,
        )
      } finally {
        if (originalHome === undefined) delete process.env.HOME
        else process.env.HOME = originalHome
      }
      assert.ok(replacementIdentity)
      const after = await lstat(configPath)
      assert.equal(after.dev, replacementIdentity.dev)
      assert.equal(after.ino, replacementIdentity.ino)
      if (replacement === "regular") {
        assert.deepEqual(await readFile(configPath), replacementBytes)
      } else if (replacement === "symlink") {
        assert.equal(await readlink(configPath), sentinelPath)
        assert.deepEqual(await readFile(sentinelPath), replacementBytes)
      } else {
        assert.equal(after.isDirectory(), true)
        assert.deepEqual(await readdir(configPath), [])
      }
      const entries = await readdir(configDirectory)
      assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false)
      assert.deepEqual(await readFile(displacedPath), originalBytes)
    })
  }
})

test("impossible deployment states fail closed without replacing the original generation", async (t) => {
  const cases: Array<{
    name: string
    mutate(config: Record<string, unknown>): Record<string, unknown>
  }> = [
    {
      name: "unknown channel",
      mutate: (config) => ({ ...config, channel: "unknown-channel" }),
    },
    {
      name: "unknown engine",
      mutate: (config) => ({ ...config, engine: "unknown-engine" }),
    },
    {
      name: "standalone runtime",
      mutate: (config) => ({ ...config, runtime: "standalone-v1" }),
    },
    {
      name: "console ready tuple",
      mutate: (config) => ({
        ...config,
        outcome: "ready",
        deployedAt: new Date().toISOString(),
        process: {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          launchId: "1".repeat(32),
        },
      }),
    },
    {
      name: "Lark pending tuple",
      mutate: (config) => ({
        ...config,
        channel: "lark",
        outcome: "pending_external_action",
      }),
    },
    {
      name: "HTTP ready without process",
      mutate: (config) => ({
        ...config,
        channel: "http",
        outcome: "ready",
        endpoint: {
          protocol: "http",
          host: "127.0.0.1",
          port: 34567,
          askPath: "/v1/ask",
          healthPath: "/health",
        },
        deployedAt: new Date().toISOString(),
      }),
    },
    {
      name: "HTTP Ready with prepared activation",
      mutate: (config) => ({
        ...config,
        channel: "http",
        outcome: "ready",
        endpoint: {
          protocol: "http",
          host: "127.0.0.1",
          port: 34567,
          askPath: "/v1/ask",
          healthPath: "/health",
        },
        process: {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          launchId: "1".repeat(32),
          activationFence: "2".repeat(32),
          activationState: "prepared",
        },
        deployedAt: new Date().toISOString(),
      }),
    },
    {
      name: "unsupported locale",
      mutate: (config) => ({ ...config, locale: "not-shipped" }),
    },
    {
      name: "unsupported legacy locale",
      mutate: () => ({ locale: "not-shipped" }),
    },
    {
      name: "oversized bot name",
      mutate: (config) => ({ ...config, botName: "n".repeat(129) }),
    },
    {
      name: "control-bearing bot name",
      mutate: (config) => ({ ...config, botName: "Bot\nName" }),
    },
    {
      name: "control-bearing local reference",
      mutate: (config) => ({
        ...config,
        package: {
          ...(config.package as Record<string, unknown>),
          localReference: `${String(
            (config.package as Record<string, unknown>).localReference,
          )}\n`,
        },
      }),
    },
    {
      name: "invalid package name",
      mutate: (config) => ({
        ...config,
        package: {
          ...(config.package as Record<string, unknown>),
          name: "Invalid_Package",
        },
      }),
    },
    {
      name: "invalid package version",
      mutate: (config) => ({
        ...config,
        package: {
          ...(config.package as Record<string, unknown>),
          version: "01.2.3",
        },
      }),
    },
    {
      name: "invalid package digest",
      mutate: (config) => ({
        ...config,
        package: {
          ...(config.package as Record<string, unknown>),
          digest: `sha256:${"G".repeat(64)}`,
        },
      }),
    },
    {
      name: "relative package local reference",
      mutate: (config) => ({
        ...config,
        package: {
          ...(config.package as Record<string, unknown>),
          localReference: "relative/package",
        },
      }),
    },
    {
      name: "control-bearing provider identity",
      mutate: (config) => ({
        ...config,
        channel: "dingtalk",
        provider: {
          kind: "dingtalk-app",
          resourceId: "app\nidentity",
          scope: testProviderScope(),
        },
      }),
    },
    {
      name: "unsafe persisted code",
      mutate: (config) => ({
        ...config,
        code: "credential-shaped raw text\nwith controls",
      }),
    },
  ]
  for (const fixture of cases) {
    await t.test(fixture.name, async (subtest) => {
      const temporary = await isolatedRoot(subtest, "deploy-impossible-state-")
      const home = path.join(temporary, "home")
      const bin = path.join(temporary, "bin")
      const packageDirectory = path.join(temporary, "impossible-state")
      const configPath = path.join(home, ".digital-employee", "config.json")
      await mkdir(home)
      await installFakeQoder(bin)
      await createEmployeePackage(packageDirectory, { name: "impossible-state" })
      const args = [
        "deploy",
        packageDirectory,
        "--channel",
        "console",
        "--engine",
        "qoder",
        "--runtime",
        "agent-native",
        "--locale",
        "en",
        "--name",
        "Impossible State",
        "--yes",
      ]
      const environment = cliEnvironment({
        home,
        bin,
        extra: { QODER_PERSONAL_ACCESS_TOKEN: "impossible-state-sentinel" },
      })
      const seed = runBuiltCli(args, { environment })
      assert.equal(seed.status, 2, seed.stderr)
      const base = JSON.parse(await readFile(configPath, "utf8")) as Record<
        string,
        unknown
      >
      const bytes = Buffer.from(
        `${JSON.stringify(fixture.mutate(base), null, 2)}\n`,
      )
      await writeFile(configPath, bytes, { mode: 0o600 })
      const before = await lstat(configPath)

      const result = runBuiltCli(args, { environment })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /state is invalid.*preserved/i)
      const after = await lstat(configPath)
      assert.equal(after.dev, before.dev)
      assert.equal(after.ino, before.ino)
      assert.deepEqual(await readFile(configPath), bytes)
      assert.deepEqual(deploymentPids(configPath), [])
    })
  }
})

test("Lark and WeCom persist only truthful unsupported terminal states", async (t) => {
  for (const channel of ["lark", "wecom"] as const) {
    await t.test(channel, async (subtest) => {
      const temporary = await isolatedRoot(subtest, `deploy-${channel}-unsupported-`)
      const home = path.join(temporary, "home")
      const bin = path.join(temporary, "bin")
      const marker = path.join(temporary, "dws.marker")
      const packageDirectory = path.join(temporary, `${channel}-unsupported`)
      const configPath = path.join(home, ".digital-employee", "config.json")
      await mkdir(home)
      await installFakeQoder(bin)
      await installObservableDws(bin, marker)
      await createEmployeePackage(packageDirectory, {
        name: `${channel}-unsupported`,
      })
      const result = runBuiltCli(
        [
          "deploy",
          packageDirectory,
          "--channel",
          channel,
          "--engine",
          "qoder",
          "--runtime",
          "agent-native",
          "--locale",
          "en",
          "--name",
          `${channel} Bot`,
          "--yes",
        ],
        {
          environment: cliEnvironment({
            home,
            bin,
            extra: { QODER_PERSONAL_ACCESS_TOKEN: `${channel}-sentinel` },
          }),
        },
      )
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /Unsupported deployment/)
      assert.equal(await markerMissing(marker), true)
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        channel: string
        outcome: string
        process?: unknown
        provider?: unknown
        deployedAt?: unknown
      }
      assert.equal(config.channel, channel)
      assert.equal(config.outcome, "unsupported")
      assert.equal(config.process, undefined)
      assert.equal(config.provider, undefined)
      assert.equal(config.deployedAt, undefined)
    })
  }
})

test("config generation CAS rejects replacement while overwrite confirmation is paused", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-generation-cas-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "generation-cas")
  const configDirectory = path.join(home, ".digital-employee")
  const configPath = path.join(configDirectory, "config.json")
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "generation-cas" })
  const args = [
    "deploy",
    packageDirectory,
    "--channel",
    "console",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Generation CAS",
  ]
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "generation-cas-sentinel" },
  })
  const seed = runBuiltCli([...args, "--yes"], { environment })
  assert.equal(seed.status, 2, seed.stderr)

  const paused = startBuiltCli(args, {
    environment,
    pipeInput: true,
  })
  assert.ok(paused.child.stdin)
  await waitFor(() => paused.stdoutText().includes("existing deployment was found"))
  const replacement = JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >
  replacement.code = "external_generation"
  replacement.updatedAt = new Date(Date.now() + 1_000).toISOString()
  const replacementBytes = Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`)
  const replacementPath = path.join(configDirectory, ".external-generation.tmp")
  await writeFile(replacementPath, replacementBytes, { mode: 0o600 })
  await rename(replacementPath, configPath)
  const before = await lstat(configPath)
  paused.child.stdin.write("y\n")
  paused.child.stdin.end()
  const result = await paused.completion
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /state could not be written/i)
  const after = await lstat(configPath)
  assert.equal(after.dev, before.dev)
  assert.equal(after.ino, before.ino)
  assert.deepEqual(await readFile(configPath), replacementBytes)
})

test("SIGTERM aborts an open overwrite prompt, preserves state, and releases the lock", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-prompt-sigterm-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "prompt-sigterm")
  const configPath = path.join(home, ".digital-employee", "config.json")
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "prompt-sigterm" })
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "prompt-sigterm-sentinel" },
  })
  const args = [
    "deploy",
    packageDirectory,
    "--channel",
    "console",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Prompt SIGTERM",
  ]
  const seed = runBuiltCli([...args, "--yes"], { environment })
  assert.equal(seed.status, 2, seed.stderr)
  const before = await lstat(configPath)
  const beforeBytes = await readFile(configPath)
  const paused = startBuiltCli(args, { environment, pipeInput: true })
  await waitFor(() => paused.stdoutText().includes("existing deployment was found"))
  assert.ok(paused.child.pid)
  process.kill(paused.child.pid, "SIGTERM")
  const result = await paused.completion
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /interrupted/i)
  const after = await lstat(configPath)
  assert.equal(after.dev, before.dev)
  assert.equal(after.ino, before.ino)
  assert.deepEqual(await readFile(configPath), beforeBytes)

  const successor = runBuiltCli([...args, "--yes"], { environment })
  assert.equal(successor.status, 2, successor.stderr)
})

test("deployment lock deadline and supervised-helper matrix uses the real platform primitive", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip(`real deployment lock matrix is unsupported on ${process.platform}`)
    return
  }
  const temporary = await isolatedRoot(t, "deploy-lock-deadline-matrix-")
  const wrapperPath = path.join(temporary, "lock-wrapper.mjs")
  const utility = await realDeploymentLockUtility()
  await writeFile(wrapperPath, deploymentLockWrapperSource, { mode: 0o700 })
  if (process.platform === "darwin") {
    assert.deepEqual(utility, {
      command: "/usr/bin/lockf",
      args: ["-s", "-t", "0", "3"],
    })
  } else {
    assert.ok(
      utility.command === "/usr/bin/flock" || utility.command === "/bin/flock",
    )
    assert.deepEqual(utility.args, ["-n", "3"])
  }

  async function caseOptions(
    label: string,
    overrides: Record<string, unknown> = {},
  ) {
    const home = path.join(temporary, label, "home")
    const lockPath = path.join(home, ".digital-employee", ".deploy.lock")
    const wrapperEventsPath = path.join(temporary, label, "wrapper-events.jsonl")
    const terminalMarker = path.join(temporary, label, "terminal.marker")
    await mkdir(home, { recursive: true })
    return {
      home,
      lockPath,
      utility,
      wrapperPath,
      wrapperEventsPath,
      terminalMarker,
      mode: "real",
      missingCommand: path.join(temporary, label, "missing-lock-utility"),
      ...overrides,
    }
  }

  async function completedActor(
    subtest: test.TestContext,
    options: Parameters<typeof startDeploymentLockActor>[1],
  ): Promise<DeploymentLockActorReport> {
    const actor = startDeploymentLockActor(subtest, options)
    const result = await actor.completion
    assert.equal(result.status, 0, result.stderr)
    const reports = deploymentLockActorReports(result.stdout)
    assert.equal(reports.length, 1, result.stdout)
    return reports[0]!
  }

  async function assertSuccessor(
    subtest: test.TestContext,
    options: Parameters<typeof startDeploymentLockActor>[1],
  ): Promise<void> {
    const report = await completedActor(subtest, {
      ...options,
      mode: "real",
      timeoutMs: 1_500,
      probeWatchdogTimeoutMs: undefined,
      holdAfterAcquire: false,
      wrapperEventsPath: `${options.wrapperEventsPath}.successor`,
    })
    assert.equal(report.phase, "acquired")
    assert.equal(report.contended, false)
    assert.equal(report.events.length, 1)
    assert.equal(await deploymentKernelLockIsFree(options.lockPath, utility), true)
  }

  function assertSettledHelperCleanup(
    report: DeploymentLockActorReport,
    candidateFdClosed?: boolean,
  ): void {
    assert.ok(report.cleanup)
    assert.equal(report.cleanup.abortListeners, 0)
    assert.deepEqual(
      report.cleanup.childCloseListeners,
      report.events.map(() => 0),
    )
    assert.deepEqual(
      report.cleanup.childErrorListeners,
      report.events.map(() => 0),
    )
    assert.deepEqual(
      report.cleanup.directChildrenAlive,
      report.events.map(() => false),
    )
    assert.equal(report.cleanup.immediates, 0)
    assert.equal(report.cleanup.lifecycleBarrierHeld, false)
    assert.equal(report.cleanup.settlementCount, 1)
    assert.equal(report.cleanup.timeouts, 0)
    if (candidateFdClosed !== undefined) {
      assert.equal(report.cleanup.candidateFdClosed, candidateFdClosed)
    }
  }

  function assertClosedAttemptChain(
    report: DeploymentLockActorReport,
    {
      minimumAttempts,
      contended,
    }: { minimumAttempts: number; contended: boolean },
  ): DeploymentLockActorEvent[] {
    assert.equal(report.phase, "acquired")
    assert.equal(report.error, undefined)
    assert.equal(report.contended, contended)
    assert.ok(
      report.events.length >= minimumAttempts,
      `expected at least ${minimumAttempts} attempts, got ${report.events.length}`,
    )
    const [first] = report.events
    assert.ok(first)
    assert.equal(report.fileDescriptor, first.fileDescriptor)
    assert.deepEqual(
      report.events.map((event) => event.attempt),
      report.events.map((_, index) => index + 1),
    )
    for (const [index, event] of report.events.entries()) {
      assert.equal(event.fileDescriptor, first.fileDescriptor)
      assert.equal(event.decisionDeadline, first.decisionDeadline)
      assert.ok(event.remainingMs > 0)
      assert.ok(event.watchdogMs > 0)
      assert.ok(event.watchdogMs <= event.remainingMs)
      assertProcessIsReaped(event.pid)
      if (index === 0) {
        assert.equal(event.previousPid, undefined)
        assert.equal(event.previousPidAlive, undefined)
        continue
      }
      const predecessor = report.events[index - 1]!
      assert.ok(event.observedAt >= predecessor.observedAt)
      assert.ok(event.remainingMs <= predecessor.remainingMs)
      assert.equal(event.previousPid, predecessor.pid)
      assert.equal(event.previousPidAlive, false)
    }
    assertSettledHelperCleanup(report)
    return report.events
  }

  function wrapperEventsForAttempt(
    report: DeploymentLockActorReport,
    wrapperEvents: Array<Record<string, unknown>>,
    attempt: number,
  ): Array<Record<string, unknown>> {
    const actorEvent = report.events[attempt - 1]
    assert.equal(actorEvent?.attempt, attempt)
    const spawns = wrapperEvents.filter(
      (event) => event.type === "spawn" && event.attempt === attempt,
    )
    assert.equal(spawns.length, 1)
    assert.equal(spawns[0]?.pid, actorEvent.pid)
    return wrapperEvents.filter((event) => event.pid === actorEvent.pid)
  }

  await t.test(
    "the default budget exposes one approximately 20 second deadline on a free real lock",
    async (subtest) => {
      const options = await caseOptions("default-budget")
      const report = await completedActor(subtest, options)
      assert.equal(report.phase, "acquired")
      assert.equal(report.contended, false)
      assert.equal(report.events.length, 1)
      const [event] = report.events
      assert.equal(event?.attempt, 1)
      assert.ok(event!.remainingMs >= 18_000, `remaining ${event!.remainingMs}ms`)
      assert.ok(event!.remainingMs <= 20_000, `remaining ${event!.remainingMs}ms`)
      const observedBudget = event!.decisionDeadline - event!.observedAt
      assert.ok(observedBudget >= 18_000, `observed budget ${observedBudget}ms`)
      assert.ok(observedBudget <= 20_000, `observed budget ${observedBudget}ms`)
      assert.equal(
        await deploymentKernelLockIsFree(options.lockPath, utility),
        true,
      )
    },
  )

  await t.test("direct real utility contention, watchdog close, timeout, and successor", async (subtest) => {
    const blockingUtility = blockingDeploymentLockUtility(utility)
    const retryOwnerOptions = await caseOptions("direct-watchdog-owner", {
      holdAfterAcquire: true,
    })
    const retryOwner = startDeploymentLockActor(subtest, retryOwnerOptions)
    await waitFor(() => retryOwner.stdoutText().endsWith("\n"), 5_000)
    const [retryOwnerReport] = deploymentLockActorReports(retryOwner.stdoutText())
    assert.equal(retryOwnerReport?.phase, "acquired")
    assert.equal(
      await deploymentKernelLockIsFree(retryOwnerOptions.lockPath, utility),
      false,
    )
    assert.ok(retryOwner.child.pid)

    const retryOptions = await caseOptions("direct-watchdog-owner", {
      mode: "direct-watchdog",
      timeoutMs: 3_000,
      probeWatchdogTimeoutMs: 100,
      blockingUtility,
      ownerPid: retryOwner.child.pid,
    })
    const retried = await completedActor(subtest, retryOptions)
    assert.equal(retried.phase, "acquired")
    assert.ok(retried.events.length >= 2)
    const [watchdogAttempt] = retried.events
    assert.ok(watchdogAttempt)
    for (const event of retried.events) {
      assert.equal(event.fileDescriptor, watchdogAttempt.fileDescriptor)
      assert.equal(event.decisionDeadline, watchdogAttempt.decisionDeadline)
      assertProcessIsReaped(event.pid)
    }
    for (const event of retried.events.slice(1)) {
      assert.equal(event.previousPidAlive, false)
    }
    const retryEvents = await readJsonLines(retryOptions.wrapperEventsPath)
    assert.deepEqual(
      retryEvents
        .filter((event) => event.type === "signal")
        .map((event) => event.signal),
      ["SIGTERM"],
    )
    assert.ok(retried.cleanup)
    assert.deepEqual(
      retried.cleanup.childCloseListeners,
      retried.events.map(() => 0),
    )
    assert.deepEqual(
      retried.cleanup.childErrorListeners,
      retried.events.map(() => 0),
    )
    assert.deepEqual(
      retried.cleanup.directChildrenAlive,
      retried.events.map(() => false),
    )
    assert.equal(retried.cleanup.abortListeners, 0)
    assert.equal(retried.cleanup.timeouts, 0)
    assert.equal(retried.cleanup.immediates, 0)
    const retryOwnerCompletion = await retryOwner.completion
    assert.equal(retryOwnerCompletion.status, 0, retryOwnerCompletion.stderr)

    const timeoutOwnerOptions = await caseOptions("direct-timeout-owner", {
      holdAfterAcquire: true,
    })
    const timeoutOwner = startDeploymentLockActor(subtest, timeoutOwnerOptions)
    await waitFor(() => timeoutOwner.stdoutText().endsWith("\n"), 5_000)
    const [timeoutOwnerReport] = deploymentLockActorReports(timeoutOwner.stdoutText())
    assert.equal(timeoutOwnerReport?.phase, "acquired")
    assert.equal(
      await deploymentKernelLockIsFree(timeoutOwnerOptions.lockPath, utility),
      false,
    )

    const timeoutOptions = await caseOptions("direct-timeout-owner", {
      mode: "direct-timeout",
      timeoutMs: 250,
      probeWatchdogTimeoutMs: 500,
      blockingUtility,
    })
    const timedOut = await completedActor(subtest, timeoutOptions)
    assert.equal(timedOut.phase, "error")
    assert.equal(timedOut.error, "deploy_lock_timeout")
    assert.equal(timedOut.events.length, 1)
    assertProcessIsReaped(timedOut.events[0]?.pid)
    const timeoutEvents = await readJsonLines(timeoutOptions.wrapperEventsPath)
    assert.deepEqual(
      timeoutEvents
        .filter((event) => event.type === "signal")
        .map((event) => event.signal),
      ["SIGTERM"],
    )
    assert.equal(timedOut.cleanup?.candidateFdClosed, true)
    assert.deepEqual(timedOut.cleanup?.childCloseListeners, [0])
    assert.deepEqual(timedOut.cleanup?.childErrorListeners, [0])
    assert.deepEqual(timedOut.cleanup?.directChildrenAlive, [false])
    assert.ok(timeoutOwner.child.pid)
    process.kill(timeoutOwner.child.pid, "SIGUSR1")
    const timeoutOwnerCompletion = await timeoutOwner.completion
    assert.equal(timeoutOwnerCompletion.status, 0, timeoutOwnerCompletion.stderr)
    await assertSuccessor(subtest, timeoutOptions)
  })

  await t.test("a watchdog-recovered wrapper is reaped before retrying the same descriptor", async (subtest) => {
    const options = await caseOptions("recoverable-wrapper", {
      mode: "recoverable",
      timeoutMs: 5_000,
      probeWatchdogTimeoutMs: 50,
      holdAfterAcquire: true,
    })
    const actor = startDeploymentLockActor(subtest, options)
    await waitFor(
      () =>
        actor.stdoutText().includes('"phase":"acquired"') &&
        actor.stdoutText().endsWith("\n"),
      7_000,
    )
    const [acquired] = deploymentLockActorReports(actor.stdoutText())
    assert.ok(acquired)
    assertClosedAttemptChain(acquired, {
      minimumAttempts: 2,
      contended: false,
    })
    const [first, second] = acquired.events
    assert.ok(second!.observedAt - first!.observedAt >= 1_000)

    const wrapperEvents = await readJsonLines(options.wrapperEventsPath)
    const firstWrapperEvents = wrapperEventsForAttempt(
      acquired,
      wrapperEvents,
      1,
    )
    const started = firstWrapperEvents.find((event) => event.type === "start")
    const delegated = firstWrapperEvents.find(
      (event) => event.type === "delegated",
    )
    const firstSignals = firstWrapperEvents.filter(
      (event) => event.type === "signal",
    )
    const firstTerms = firstWrapperEvents.filter((event) => event.type === "term")
    assert.ok(started)
    assert.equal(started.attempt, 1)
    assert.equal(started.device, acquired.device)
    assert.equal(started.inode, acquired.inode)
    assert.equal(started.fileDescriptor, 3)
    assert.equal(delegated?.attempt, 1)
    assert.equal(delegated?.status, 0)
    assertProcessIsReaped(Number(delegated?.delegatedPid))
    assert.equal(firstSignals[0]?.signal, "SIGTERM")
    assert.deepEqual(
      firstSignals.map((event) => event.signal),
      ["SIGTERM", "SIGKILL"],
    )
    assert.equal(firstTerms.length, 1)
    assert.equal(firstTerms[0]?.attempt, 1)
    assert.ok(
      wrapperEvents.indexOf(firstTerms[0]!) >
        wrapperEvents.indexOf(firstSignals[0]!),
    )
    assert.ok(
      wrapperEvents.indexOf(firstSignals[1]!) >
        wrapperEvents.indexOf(firstTerms[0]!),
    )
    assert.equal(await deploymentKernelLockIsFree(options.lockPath, utility), false)

    assert.ok(actor.child.pid)
    process.kill(actor.child.pid, "SIGUSR1")
    const result = await actor.completion
    assert.equal(result.status, 0, result.stderr)
    const reports = deploymentLockActorReports(result.stdout)
    assert.deepEqual(reports.map((report) => report.phase), ["acquired", "released"])
    assert.equal(await deploymentKernelLockIsFree(options.lockPath, utility), true)
    await assertSuccessor(subtest, options)
  })

  await t.test("watchdog-signaled TERM exits 0, 1, and 75 retry without recording contention", async (subtest) => {
    for (const status of [0, 1, 75]) {
      const options = await caseOptions(`watchdog-term-${status}`, {
        mode: `watchdog-exit-${status}`,
        timeoutMs: 5_000,
        probeWatchdogTimeoutMs: 100,
      })
      const report = await completedActor(subtest, options)
      assertClosedAttemptChain(report, {
        minimumAttempts: 2,
        contended: false,
      })
      const wrapperEvents = await readJsonLines(options.wrapperEventsPath)
      const firstWrapperEvents = wrapperEventsForAttempt(
        report,
        wrapperEvents,
        1,
      )
      const firstSignals = firstWrapperEvents.filter(
        (event) => event.type === "signal",
      )
      const firstTerms = firstWrapperEvents.filter(
        (event) => event.type === "term",
      )
      const delegated = firstWrapperEvents.find(
        (event) => event.type === "delegated",
      )
      assert.equal(delegated?.status, 0)
      assertProcessIsReaped(Number(delegated?.delegatedPid))
      assert.deepEqual(firstSignals.map((event) => event.signal), ["SIGTERM"])
      assert.equal(firstTerms.length, 1)
      assert.equal(firstTerms[0]?.attempt, 1)
      assert.equal(firstTerms[0]?.status, status)
      assert.ok(
        wrapperEvents.indexOf(firstTerms[0]!) >
          wrapperEvents.indexOf(firstSignals[0]!),
      )
      assert.equal(
        await deploymentKernelLockIsFree(options.lockPath, utility),
        true,
      )
    }
  })

  await t.test("two watchdog-closed probes precede one real successful third probe", async (subtest) => {
    const options = await caseOptions("double-watchdog-then-success", {
      mode: "double-watchdog-then-success",
      timeoutMs: 6_000,
      probeWatchdogTimeoutMs: 500,
      eventLoopDelayMs: 100,
      holdAfterAcquire: true,
    })
    const actor = startDeploymentLockActor(subtest, options)
    const actorStdout = actor.child.stdout
    assert.ok(actorStdout)
    type ActorCompletionResult = {
      status: number | null
      stdout: string
      stderr: string
    }
    type ActorObservation =
      | { kind: "line"; line: string }
      | { kind: "closed"; result: ActorCompletionResult }
      | { kind: "completion-error"; error: unknown }
      | { kind: "harness-stuck" }

    const closeBarrier = new Promise<{
      status: number | null
      signal: NodeJS.Signals | null
    }>((resolve) => {
      if (actor.child.exitCode !== null || actor.child.signalCode !== null) {
        resolve({
          status: actor.child.exitCode,
          signal: actor.child.signalCode,
        })
        return
      }
      actor.child.once("close", (status, signal) => resolve({ status, signal }))
    })

    function oracleErrorText(error: unknown): string {
      return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error)
    }

    async function oracleSnapshot(
      reason: string,
      details: Record<string, unknown> = {},
      completed?: ActorCompletionResult,
    ): Promise<Record<string, unknown>> {
      const status = completed === undefined
        ? actor.child.exitCode
        : completed.status
      const signal = actor.child.signalCode
      const stdout = completed === undefined
        ? actor.stdoutText()
        : completed.stdout
      const stderr = completed === undefined
        ? actor.stderrText()
        : completed.stderr
      let wrapperEvents = ""
      let wrapperEventsReadError: string | undefined
      try {
        wrapperEvents = await readFile(options.wrapperEventsPath, "utf8")
      } catch (error) {
        wrapperEventsReadError = oracleErrorText(error)
      }
      return {
        reason,
        pid: actor.child.pid,
        status,
        signal,
        stdout,
        stderr,
        wrapperEvents,
        ...(wrapperEventsReadError === undefined
          ? {}
          : { wrapperEventsReadError }),
        ...details,
      }
    }

    async function closeAndReapActor(): Promise<Record<string, unknown>> {
      const actorPid = actor.child.pid
      let killRequested = false
      let killError: string | undefined
      if (actor.child.exitCode === null && actor.child.signalCode === null) {
        try {
          killRequested = actor.child.kill("SIGKILL")
        } catch (error) {
          killError = oracleErrorText(error)
        }
      }
      const [completion, close] = await Promise.all([
        actor.completion.then(
          (result) => ({ kind: "closed" as const, result }),
          (error: unknown) => ({
            kind: "completion-error" as const,
            error: oracleErrorText(error),
          }),
        ),
        closeBarrier,
      ])
      const reapVerified =
        Number.isSafeInteger(actorPid) && Number(actorPid) > 0
      if (reapVerified) assertProcessIsReaped(actorPid)
      return {
        killRequested,
        ...(killError === undefined ? {} : { killError }),
        reapVerified,
        ...(reapVerified ? {} : { reapReason: "actor_not_spawned" }),
        completion,
        close,
      }
    }

    async function failActorOracle(
      reason: string,
      details: Record<string, unknown> = {},
      completed?: ActorCompletionResult,
    ): Promise<never> {
      const snapshot = await oracleSnapshot(reason, details, completed)
      subtest.diagnostic(`PRC015_ACTOR_ORACLE ${JSON.stringify(snapshot)}`)
      const close = await closeAndReapActor()
      assert.fail(
        `PRC015_ACTOR_ORACLE ${JSON.stringify({ snapshot, close })}`,
      )
    }

    async function awaitFirstActorReport(): Promise<void> {
      const observation = await new Promise<ActorObservation>((resolve) => {
        let settled = false
        let harnessTimer: ReturnType<typeof setTimeout> | undefined
        const finish = (value: ActorObservation) => {
          if (settled) return
          settled = true
          if (harnessTimer !== undefined) clearTimeout(harnessTimer)
          actorStdout.off("data", inspect)
          resolve(value)
        }
        const inspect = () => {
          const stdout = actor.stdoutText()
          const newline = stdout.indexOf("\n")
          if (newline >= 0) {
            finish({ kind: "line", line: stdout.slice(0, newline) })
          }
        }
        actorStdout.on("data", inspect)
        actor.completion.then(
          (result) => finish({ kind: "closed", result }),
          (error: unknown) => finish({ kind: "completion-error", error }),
        )
        harnessTimer = setTimeout(
          () => finish({ kind: "harness-stuck" }),
          30_000,
        )
        inspect()
      })

      if (observation.kind !== "line") {
        if (observation.kind === "closed") {
          await failActorOracle(
            "child_closed_before_report",
            {},
            observation.result,
          )
        }
        if (observation.kind === "completion-error") {
          await failActorOracle("actor_completion_error", {
            completionError: oracleErrorText(observation.error),
          })
        }
        await failActorOracle("actor_harness_stuck")
        throw new Error("actor_observation_unreachable")
      }

      let report: unknown
      try {
        report = JSON.parse(observation.line)
      } catch (error) {
        await failActorOracle("malformed_first_report", {
          line: observation.line,
          parseError: oracleErrorText(error),
        })
      }
      if (
        !report ||
        typeof report !== "object" ||
        Array.isArray(report)
      ) {
        await failActorOracle("invalid_first_report", {
          line: observation.line,
        })
      }
      const phase = (report as { phase?: unknown }).phase
      if (phase !== "acquired" && phase !== "error") {
        await failActorOracle("invalid_first_report", {
          line: observation.line,
        })
      }
      if (phase === "error") {
        await failActorOracle("actor_reported_error", { report })
      }
    }

    await awaitFirstActorReport()
    const [acquired] = deploymentLockActorReports(actor.stdoutText())
    assert.ok(acquired)
    assertClosedAttemptChain(acquired, {
      minimumAttempts: 3,
      contended: false,
    })

    const wrapperEvents = await readJsonLines(options.wrapperEventsPath)
    for (const attempt of [1, 2]) {
      const attemptEvents = wrapperEventsForAttempt(
        acquired,
        wrapperEvents,
        attempt,
      )
      const signal = attemptEvents.find((event) => event.type === "signal")
      const terms = attemptEvents.filter((event) => event.type === "term")
      const delegated = attemptEvents.find(
        (event) => event.type === "delegated",
      )
      assert.equal(delegated?.status, 0)
      assertProcessIsReaped(Number(delegated?.delegatedPid))
      assert.deepEqual(
        attemptEvents
          .filter((event) => event.type === "signal")
          .map((event) => event.signal),
        ["SIGTERM"],
      )
      assert.equal(terms.length, 1)
      assert.equal(terms[0]?.attempt, attempt)
      assert.equal(terms[0]?.status, 0)
      assert.ok(wrapperEvents.indexOf(terms[0]!) > wrapperEvents.indexOf(signal!))
    }

    const thirdEvents = wrapperEventsForAttempt(acquired, wrapperEvents, 3)
    const thirdDelegated = thirdEvents.find(
      (event) => event.type === "delegated",
    )
    assert.equal(thirdDelegated?.status, 0)
    assertProcessIsReaped(Number(thirdDelegated?.delegatedPid))
    assert.equal(
      thirdEvents.find((event) => event.type === "exit-intent")?.status,
      0,
    )
    assert.deepEqual(
      thirdEvents
        .filter((event) => event.type === "signal")
        .map((event) => event.signal),
      [],
    )
    assert.equal(
      thirdEvents.filter((event) => event.type === "term").length,
      0,
    )
    assert.deepEqual(acquired.cleanup?.childExitCodes.slice(0, 3), [0, 0, 0])
    assert.deepEqual(acquired.cleanup?.childSignalCodes.slice(0, 3), [null, null, null])
    assert.equal(
      await deploymentKernelLockIsFree(options.lockPath, utility),
      false,
    )

    assert.ok(actor.child.pid)
    process.kill(actor.child.pid, "SIGUSR1")
    const result = await actor.completion
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(
      deploymentLockActorReports(result.stdout).map((report) => report.phase),
      ["acquired", "released"],
    )
    assert.equal(
      await deploymentKernelLockIsFree(options.lockPath, utility),
      true,
    )
    await assertSuccessor(subtest, options)
  })

  await t.test("deadline and abort remain pending behind the verified-close safety barrier", async (subtest) => {
    for (const [mode, expectedError] of [
      ["delayed-close-timeout", "deploy_lock_timeout"],
      ["delayed-close-abort", "deploy_lock_interrupted"],
    ] as const) {
      const options = await caseOptions(mode, {
        mode,
        timeoutMs: 250,
        probeWatchdogTimeoutMs: 40,
        holdAfterError: true,
      })
      const actor = startDeploymentLockActor(subtest, options)
      let lifecycleBarrierYardstickError: unknown
      try {
        await waitFor(async () =>
          (await readJsonLines(options.wrapperEventsPath)).some(
            (event) => event.type === "lifecycle-barrier-held",
          ),
        4_000)
      } catch (error) {
        lifecycleBarrierYardstickError = error
      }

      if (lifecycleBarrierYardstickError !== undefined) {
        const safetyDeadline = Date.now() + 30_000
        const gracefulTeardownDeadline = safetyDeadline - 5_000
        const actorDrainDeadline = safetyDeadline - 1_000
        const actorPid = actor.child.pid
        const observedPids = new Set<number>()
        if (actorPid && Number.isSafeInteger(actorPid)) observedPids.add(actorPid)
        const cleanupActions: Array<Record<string, unknown>> = []
        const cleanupErrors: string[] = []
        const completion = actor.completion.then(
          (result) => ({ kind: "closed" as const, result }),
          (error: unknown) => ({
            kind: "completion-error" as const,
            error: error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error),
          }),
        )

        const errorText = (error: unknown): string =>
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)

        const processIsAlive = (pid: number | undefined): boolean => {
          if (!pid || !Number.isSafeInteger(pid)) return false
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        }

        const wrapperEvidence = async (): Promise<{
          parsed: Array<Record<string, unknown>>
          parseErrors: string[]
          raw: string
        }> => {
          let raw = ""
          try {
            raw = await readFile(options.wrapperEventsPath, "utf8")
          } catch (error) {
            return {
              parsed: [],
              parseErrors: [`read:${errorText(error)}`],
              raw,
            }
          }
          const parsed: Array<Record<string, unknown>> = []
          const parseErrors: string[] = []
          for (const [index, line] of raw
            .split("\n")
            .filter(Boolean)
            .entries()) {
            try {
              parsed.push(JSON.parse(line) as Record<string, unknown>)
            } catch (error) {
              parseErrors.push(
                `line_${index + 1}:${errorText(error)}:${line}`,
              )
            }
          }
          for (const event of parsed) {
            for (const value of [event.pid, event.delegatedPid]) {
              const pid = Number(value)
              if (Number.isSafeInteger(pid) && pid > 0) observedPids.add(pid)
            }
          }
          return {
            parsed,
            parseErrors,
            raw,
          }
        }

        const taskProcessRows = (): string[] => {
          const result = spawnSync(
            "/bin/ps",
            ["-ax", "-o", "pid=,ppid=,command="],
            { encoding: "utf8" },
          )
          if (result.status !== 0) {
            throw new Error(`task_process_scan_failed:${result.stderr}`)
          }
          const rows = result.stdout
            .split("\n")
            .filter((line) => line.includes(temporary))
          for (const row of rows) {
            const pid = Number.parseInt(row.trim(), 10)
            if (Number.isSafeInteger(pid) && pid > 0) observedPids.add(pid)
          }
          return rows
        }

        const evidenceSnapshot = async (
          stage: string,
        ): Promise<Record<string, unknown>> => {
          const wrapper = await wrapperEvidence()
          const timeline = wrapper.parsed.filter((event) =>
            [
              "spawn",
              "start",
              "delegated",
              "signal",
              "term",
              "lifecycle-barrier-held",
              "lifecycle-barrier-released",
            ].includes(String(event.type)),
          )
          const wrapperPids = Array.from(new Set(
            wrapper.parsed.flatMap((event) =>
              [event.pid, event.delegatedPid]
                .map((pid) => Number(pid))
                .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
            ),
          ))
          return {
            stage,
            actor: {
              pid: actorPid,
              status: actor.child.exitCode,
              signal: actor.child.signalCode,
              stdout: actor.stdoutText(),
              stderr: actor.stderrText(),
            },
            wrapperEvents: wrapper.raw,
            wrapperEventsParseErrors: wrapper.parseErrors,
            timeline,
            wrapperPids,
            taskProcesses: taskProcessRows(),
          }
        }

        const signalActor = (signal: NodeJS.Signals): void => {
          if (!actorPid || !Number.isSafeInteger(actorPid)) {
            cleanupErrors.push("actor_pid_missing")
            return
          }
          try {
            process.kill(actorPid, signal)
            cleanupActions.push({
              type: "actor-signal",
              signal,
              pid: actorPid,
              at: performance.now(),
            })
          } catch (error) {
            cleanupActions.push({
              type: "actor-signal-error",
              signal,
              pid: actorPid,
              error: errorText(error),
              at: performance.now(),
            })
          }
        }

        const waitWithinSafety = async (
          predicate: () => boolean | Promise<boolean>,
          deadline = safetyDeadline,
        ): Promise<boolean> => {
          while (Date.now() < deadline) {
            if (await predicate()) return true
            await delay(Math.min(20, Math.max(1, deadline - Date.now())))
          }
          return predicate()
        }

        let beforeCleanup: Record<string, unknown> = {}
        let afterCleanup: Record<string, unknown> = {}
        try {
          beforeCleanup = await evidenceSnapshot("four-second-miss")
        } catch (error) {
          cleanupErrors.push(`evidence_before_cleanup:${errorText(error)}`)
        } finally {
          let barrierReleaseRequested = false
          const releaseObservedBarrier = async (): Promise<boolean> => {
            const wrapper = await wrapperEvidence()
            const barrierHeld = wrapper.parsed.some(
              (event) => event.type === "lifecycle-barrier-held",
            )
            const barrierReleased = wrapper.parsed.some(
              (event) => event.type === "lifecycle-barrier-released",
            )
            if (
              barrierHeld &&
              !barrierReleased &&
              !barrierReleaseRequested &&
              processIsAlive(actorPid)
            ) {
              // Preserve the original arm ordering after a late barrier:
              // abort first only for delayed-close-abort, then release KILL.
              if (mode === "delayed-close-abort") {
                signalActor("SIGUSR1")
                await delay(50)
              }
              signalActor("SIGUSR2")
              barrierReleaseRequested = true
            }
            return barrierHeld
          }

          await waitWithinSafety(
            async () => {
              if (
                actor.stdoutText().includes("\n") ||
                !processIsAlive(actorPid)
              ) {
                return true
              }
              await releaseObservedBarrier()
              return false
            },
            gracefulTeardownDeadline,
          )
          let reportObserved = actor.stdoutText().includes("\n")

          if (processIsAlive(actorPid) && actor.stdoutText().includes("\n")) {
            signalActor("SIGUSR1")
          }

          let closed = await waitWithinSafety(
            () => !processIsAlive(actorPid),
            gracefulTeardownDeadline,
          )
          const wrapperBeforeForcedDrain = await wrapperEvidence()
          if (wrapperBeforeForcedDrain.parseErrors.length > 0) {
            cleanupErrors.push(
              ...wrapperBeforeForcedDrain.parseErrors.map(
                (error) => `wrapper_events:${error}`,
              ),
            )
          }
          try {
            taskProcessRows()
          } catch (error) {
            cleanupErrors.push(`task_process_pre_kill_scan:${errorText(error)}`)
          }

          // If graceful late-barrier release did not close the actor, terminate
          // exact task children first and leave the actor time to observe close,
          // emit its report, and release holdAfterError normally.
          for (const pid of observedPids) {
            if (pid === actorPid || !processIsAlive(pid)) continue
            try {
              process.kill(pid, "SIGKILL")
              cleanupActions.push({
                type: "task-child-signal",
                signal: "SIGKILL",
                pid,
                at: performance.now(),
              })
            } catch (error) {
              cleanupErrors.push(`task_child_kill_${pid}:${errorText(error)}`)
            }
          }
          if (!reportObserved && processIsAlive(actorPid)) {
            await waitWithinSafety(
              () =>
                actor.stdoutText().includes("\n") ||
                !processIsAlive(actorPid),
              actorDrainDeadline,
            )
            reportObserved = actor.stdoutText().includes("\n")
          }
          if (processIsAlive(actorPid) && actor.stdoutText().includes("\n")) {
            signalActor("SIGUSR1")
          }
          if (!closed) {
            closed = await waitWithinSafety(
              () => !processIsAlive(actorPid),
              actorDrainDeadline,
            )
          }
          if (!reportObserved) {
            cleanupErrors.push("actor_report_or_close_not_observed")
          }

          await wrapperEvidence()
          try {
            taskProcessRows()
          } catch (error) {
            cleanupErrors.push(`task_process_final_kill_scan:${errorText(error)}`)
          }
          for (const pid of observedPids) {
            if (pid === actorPid || !processIsAlive(pid)) continue
            try {
              process.kill(pid, "SIGKILL")
              cleanupActions.push({
                type: "task-child-final-signal",
                signal: "SIGKILL",
                pid,
                at: performance.now(),
              })
            } catch (error) {
              cleanupErrors.push(
                `task_child_final_kill_${pid}:${errorText(error)}`,
              )
            }
          }
          if (processIsAlive(actorPid)) signalActor("SIGKILL")
          const taskPidsReaped = await waitWithinSafety(
            () => Array.from(observedPids).every((pid) => !processIsAlive(pid)),
          )
          closed = !processIsAlive(actorPid)
          if (!taskPidsReaped) {
            cleanupErrors.push("task_pids_not_reaped_before_safety_limit")
          }
          if (!closed) cleanupErrors.push("actor_not_closed_before_safety_limit")

          const completed = await Promise.race([
            completion,
            delay(Math.max(0, safetyDeadline - Date.now())).then(() => ({
              kind: "safety-timeout" as const,
            })),
          ])
          cleanupActions.push({
            type: "actor-completion",
            completed,
            status: actor.child.exitCode,
            signal: actor.child.signalCode,
          })
          if (completed.kind !== "closed") {
            cleanupErrors.push(`actor_completion_${completed.kind}`)
          }

          const finalWrapper = await wrapperEvidence()
          if (finalWrapper.parseErrors.length > 0) {
            cleanupErrors.push(
              ...finalWrapper.parseErrors.map(
                (error) => `wrapper_events_final:${error}`,
              ),
            )
          }
          for (const pid of observedPids) {
            try {
              assertProcessIsReaped(pid)
            } catch (error) {
              cleanupErrors.push(`pid_${pid}_not_reaped:${errorText(error)}`)
            }
          }
          try {
            const rows = taskProcessRows()
            if (rows.length > 0) {
              cleanupErrors.push(`task_process_residue:${rows.join(" | ")}`)
            }
          } catch (error) {
            cleanupErrors.push(`task_process_postscan:${errorText(error)}`)
          }
          try {
            afterCleanup = await evidenceSnapshot("after-cleanup")
          } catch (error) {
            cleanupErrors.push(`evidence_after_cleanup:${errorText(error)}`)
          }
        }

        const failure = {
          reason: "lifecycle_barrier_not_observed_within_four_seconds",
          yardstickError: errorText(lifecycleBarrierYardstickError),
          beforeCleanup,
          cleanupActions,
          cleanupErrors,
          afterCleanup,
        }
        subtest.diagnostic(`PRC016_LIFECYCLE_EVIDENCE ${JSON.stringify(failure)}`)
        assert.fail(`PRC016_LIFECYCLE_EVIDENCE ${JSON.stringify(failure)}`)
      }

      const drainingEvents = await readJsonLines(options.wrapperEventsPath)
      const spawns = drainingEvents.filter((event) => event.type === "spawn")
      const signals = drainingEvents.filter((event) => event.type === "signal")
      const barrier = drainingEvents.find(
        (event) => event.type === "lifecycle-barrier-held",
      )
      assert.equal(actor.stdoutText(), "")
      assert.equal(spawns.length, 1)
      assert.deepEqual(signals.map((event) => event.signal), ["SIGTERM", "SIGKILL"])
      assert.ok(Number(signals[1]?.at) - Number(signals[0]?.at) >= 1_000)
      assert.ok(Number(barrier?.at) >= Number(barrier?.decisionDeadline))
      assert.equal(barrier?.abortListeners, 1)
      assert.equal(barrier?.childCloseListeners, 1)
      assert.equal(barrier?.childErrorListeners, 1)
      assert.equal(barrier?.timeouts, 0)
      assert.equal(barrier?.immediates, 0)
      assert.deepEqual(await readFile(options.lockPath), Buffer.alloc(0))
      const supervisedPid = Number(spawns[0]?.pid)
      assert.doesNotThrow(() => process.kill(supervisedPid, 0))

      if (mode === "delayed-close-abort") {
        assert.ok(actor.child.pid)
        process.kill(actor.child.pid, "SIGUSR1")
        await delay(50)
        assert.equal(actor.stdoutText(), "")
        assert.deepEqual(
          (await readJsonLines(options.wrapperEventsPath))
            .filter((event) => event.type === "signal")
            .map((event) => event.signal),
          ["SIGTERM", "SIGKILL"],
        )
      }

      assert.ok(actor.child.pid)
      process.kill(actor.child.pid, "SIGUSR2")
      await waitFor(() => actor.stdoutText().endsWith("\n"), 3_000)
      const [report] = deploymentLockActorReports(actor.stdoutText())
      assert.equal(report?.phase, "error")
      assert.equal(report.error, expectedError)
      assert.equal(report.events.length, 1)
      assert.equal(report.cleanup?.settlementCount, 1)
      assert.equal(report.cleanup?.candidateFdClosed, true)
      assert.equal(report.cleanup?.abortListeners, 0)
      assert.deepEqual(report.cleanup?.childCloseListeners, [0])
      assert.deepEqual(report.cleanup?.childErrorListeners, [0])
      assert.deepEqual(report.cleanup?.directChildrenAlive, [false])
      assert.equal(report.cleanup?.timeouts, 0)
      assert.equal(report.cleanup?.immediates, 0)
      assert.equal(report.cleanup?.lifecycleBarrierHeld, false)
      assertProcessIsReaped(supervisedPid)
      await assertSuccessor(subtest, options)
      assert.doesNotThrow(() => process.kill(actor.child.pid!, 0))
      process.kill(actor.child.pid, "SIGUSR1")
      const completed = await actor.completion
      assert.equal(completed.status, 0, completed.stderr)
    }
  })

  await t.test("a hung helper consumes the single deadline without an after-deadline retry", async (subtest) => {
    const options = await caseOptions("hung-budget", {
      mode: "hung-timeout",
      timeoutMs: 250,
      probeWatchdogTimeoutMs: 40,
    })
    const report = await completedActor(subtest, options)
    assert.equal(report.phase, "error")
    assert.equal(report.error, "deploy_lock_timeout")
    assert.doesNotMatch(JSON.stringify(report), /probe_timeout/)
    assert.equal(report.events.length, 1)
    assert.ok(report.events.every(
      (event) => event.observedAt <= event.decisionDeadline,
    ))
    assertProcessIsReaped(report.events[0]?.pid)
    const wrapperEvents = await readJsonLines(options.wrapperEventsPath)
    assert.ok(wrapperEvents.some((event) => event.type === "term"))
    await assertSuccessor(subtest, options)
  })

  await t.test("abort wins over a hung helper and prevents retry", async (subtest) => {
    const options = await caseOptions("abort-hung", {
      mode: "abort-hung",
      timeoutMs: 3_000,
      probeWatchdogTimeoutMs: 500,
      abortAfterMs: 100,
    })
    const report = await completedActor(subtest, options)
    assert.equal(report.phase, "error")
    assert.equal(report.error, "deploy_lock_interrupted")
    assert.equal(report.events.length, 1)
    assertProcessIsReaped(report.events[0]?.pid)
    const wrapperEvents = await readJsonLines(options.wrapperEventsPath)
    assert.ok(wrapperEvents.some((event) => event.type === "term"))
    await assertSuccessor(subtest, options)
  })

  await t.test("a delayed event loop consumes terminal 0, 1, and 75 statuses", async (subtest) => {
    for (const status of [0, 1, 75]) {
      const options = await caseOptions(`delayed-status-${status}`, {
        mode: `delayed-${status}`,
        timeoutMs: 3_000,
        probeWatchdogTimeoutMs: 500,
        eventLoopDelayMs: 700,
      })
      const report = await completedActor(subtest, options)
      assert.doesNotMatch(JSON.stringify(report), /probe_timeout/)
      assertClosedAttemptChain(report, {
        minimumAttempts: status === 0 ? 1 : 2,
        contended: status !== 0,
      })
      if (status === 0) assert.equal(report.events.length, 1)
      const wrapperEvents = await readJsonLines(options.wrapperEventsPath)
      const firstAttemptEvents = wrapperEventsForAttempt(
        report,
        wrapperEvents,
        1,
      )
      assert.deepEqual(
        firstAttemptEvents
          .filter((event) => event.type === "signal")
          .map((event) => event.signal),
        [],
      )
      const retryPids = new Set(report.events.slice(1).map((event) => event.pid))
      for (const signalEvent of wrapperEvents.filter(
        (event) => event.type === "signal",
      )) {
        assert.ok(retryPids.has(Number(signalEvent.pid)))
      }
      assert.equal(await readFile(options.terminalMarker, "utf8"), "terminal\n")
    }
  })

  await t.test("a real code 0 close delivered after the authority deadline times out once", async (subtest) => {
    const options = await caseOptions("late-code-0-after-deadline", {
      mode: "late-code-0-after-deadline",
      timeoutMs: 2_000,
      probeWatchdogTimeoutMs: 2_500,
      eventLoopDelayMs: 100,
      holdAfterError: true,
    })
    const actor = startDeploymentLockActor(subtest, options)
    await waitFor(async () =>
      (await readJsonLines(options.wrapperEventsPath)).some(
        (event) => event.type === "deadline-close-held",
      ),
    4_000)

    const heldEvents = await readJsonLines(options.wrapperEventsPath)
    const heldSpawns = heldEvents.filter((event) => event.type === "spawn")
    const held = heldEvents.find(
      (event) => event.type === "deadline-close-held",
    )
    assert.equal(actor.stdoutText(), "")
    assert.equal(heldSpawns.length, 1)
    assert.equal(heldSpawns[0]?.attempt, 1)
    const heldDelegated = heldEvents.find(
      (event) => event.type === "delegated",
    )
    assert.equal(heldDelegated?.status, 0)
    assertProcessIsReaped(Number(heldDelegated?.delegatedPid))
    assert.equal(
      heldEvents.find((event) => event.type === "exit-intent")?.status,
      0,
    )
    assert.deepEqual(
      heldEvents
        .filter((event) => event.type === "signal")
        .map((event) => event.signal),
      [],
    )
    assert.ok(Number(held?.at) <= Number(held?.decisionDeadline))
    assert.equal(
      await deploymentKernelLockIsFree(options.lockPath, utility),
      false,
    )

    await waitFor(() => actor.stdoutText().endsWith("\n"), 4_000)
    const [report] = deploymentLockActorReports(actor.stdoutText())
    assert.equal(report?.phase, "error")
    assert.equal(report.error, "deploy_lock_timeout")
    assert.equal(report.contended, undefined)
    assert.equal(report.events.length, 1)
    assert.ok(report.settledAt! >= report.events[0]!.decisionDeadline)
    assertSettledHelperCleanup(report, true)
    assert.deepEqual(report.cleanup?.childExitCodes, [0])
    assert.deepEqual(report.cleanup?.childSignalCodes, [null])
    assertProcessIsReaped(report.events[0]?.pid)

    const settledEvents = await readJsonLines(options.wrapperEventsPath)
    assert.equal(
      settledEvents.filter((event) => event.type === "after-kernel-acquire")
        .length,
      0,
    )
    assert.deepEqual(
      settledEvents
        .filter((event) => event.type === "signal")
        .map((event) => event.signal),
      [],
    )
    assert.deepEqual(await readFile(options.lockPath), Buffer.alloc(0))
    assert.equal(await noConfig(options.home), true)
    assert.doesNotMatch(
      actor.stdoutText(),
      /"phase":"(?:acquired|released)"|"outcome":"ready"/,
    )
    assert.equal(
      await deploymentKernelLockIsFree(options.lockPath, utility),
      true,
    )
    await assertSuccessor(subtest, options)

    assert.ok(actor.child.pid)
    assert.doesNotThrow(() => process.kill(actor.child.pid!, 0))
    process.kill(actor.child.pid, "SIGUSR1")
    const completed = await actor.completion
    assert.equal(completed.status, 0, completed.stderr)
  })

  await t.test("ENOENT and abnormal status 9 are terminal after exactly one attempt", async (subtest) => {
    for (const [mode, expected] of [
      ["enoent", "deploy_lock_primitive_unavailable"],
      ["exit-9", "deploy_lock_primitive_failed"],
    ] as const) {
      const options = await caseOptions(mode, { mode, timeoutMs: 5_000 })
      const report = await completedActor(subtest, options)
      assert.equal(report.phase, "error")
      assert.equal(report.error, expected)
      assert.equal(report.events.length, 1)
      if (report.events[0]?.pid) assertProcessIsReaped(report.events[0].pid)
    }
  })

  await t.test("a post-open path generation replacement fails identity fencing in one attempt", async (subtest) => {
    const options = await caseOptions("inode-replaced", {
      mode: "inode-replaced",
      timeoutMs: 1_500,
    })
    const report = await completedActor(subtest, options)
    assert.equal(report.phase, "error")
    assert.equal(report.error, "deploy_lock_file_identity_changed")
    assert.equal(report.events.length, 1)
    assertProcessIsReaped(report.events[0]?.pid)
    const wrapperEvents = await readJsonLines(options.wrapperEventsPath)
    assert.equal(
      wrapperEvents.find((event) => event.type === "delegated")?.status,
      0,
    )
    await assertSuccessor(subtest, options)
  })

  await t.test("owner and record-fence changes fail after one real utility attempt", async (subtest) => {
    for (const [mode, expected] of [
      ["owner-changed", "deploy_lock_file_identity_changed"],
      ["fence-corrupt", "deploy_lock_record_invalid"],
    ] as const) {
      const options = await caseOptions(mode, { mode, timeoutMs: 1_500 })
      const report = await completedActor(subtest, options)
      assert.equal(report.phase, "error")
      assert.equal(report.error, expected)
      assert.equal(report.events.length, 1)
      assertProcessIsReaped(report.events[0]?.pid)
      await assertSuccessor(subtest, options)
    }
  })
})

test("copied built CLI reports a localized bounded lock timeout without deployment effects", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip(`real deployment lock test is unsupported on ${process.platform}`)
    return
  }
  const temporary = await isolatedRoot(t, "deploy-built-lock-timeout-")
  const copiedDist = path.join(temporary, "dist")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "lock-timeout-package")
  const lockPath = path.join(home, ".digital-employee", ".deploy.lock")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const dwsMarker = path.join(temporary, "dws.marker")
  const qoderMarker = path.join(temporary, "qoder.jsonl")
  const wrapperPath = path.join(temporary, "lock-wrapper.mjs")
  const wrapperEventsPath = path.join(temporary, "owner-wrapper-events.jsonl")
  const utility = await realDeploymentLockUtility()
  await cp(path.join(root, "dist"), copiedDist, { recursive: true })
  await symlink(
    path.join(root, "node_modules"),
    path.join(copiedDist, "node_modules"),
    "dir",
  )
  const copiedConfig = path.join(copiedDist, "apps", "cli", "deploy", "config.js")
  const configSource = await readFile(copiedConfig, "utf8")
  assert.match(
    configSource,
    /child\.removeListener\("close", handleClose\)/,
  )
  assert.doesNotMatch(configSource, /child\.unref\(\)/)
  const timeoutAnchor = "timeoutMs = 20_000"
  assert.equal(configSource.split(timeoutAnchor).length - 1, 1)
  await writeFile(
    copiedConfig,
    configSource.replace(timeoutAnchor, "timeoutMs = 350"),
  )
  await mkdir(home)
  await mkdir(bin)
  await writeFile(
    path.join(bin, "qodercli"),
    "#!/usr/bin/env node\n" +
      "const { appendFileSync } = require('node:fs')\n" +
      `appendFileSync(${JSON.stringify(qoderMarker)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n` +
      "if (process.argv.slice(2).length === 1 && process.argv[2] === '--version') {\n" +
      "  process.stdout.write('1.1.12\\n')\n" +
      "  process.exit(0)\n" +
      "}\n" +
      "process.exit(9)\n",
    { mode: 0o755 },
  )
  await chmod(path.join(bin, "qodercli"), 0o755)
  await installObservableDws(bin, dwsMarker)
  await createEmployeePackage(packageDirectory, { name: "lock-timeout-package" })
  await writeFile(wrapperPath, deploymentLockWrapperSource, { mode: 0o700 })

  const owner = startDeploymentLockActor(t, {
    home,
    lockPath,
    utility,
    wrapperPath,
    wrapperEventsPath,
    mode: "real",
    timeoutMs: 2_000,
    holdAfterAcquire: true,
  })
  await waitFor(() =>
    owner.stdoutText().includes('"phase":"acquired"') &&
    owner.stdoutText().endsWith("\n")
  )
  const [ownerReport] = deploymentLockActorReports(owner.stdoutText())
  assert.equal(ownerReport?.phase, "acquired")
  assert.equal(ownerReport.contended, false)
  assert.equal(await deploymentKernelLockIsFree(lockPath, utility), false)
  const lockIdentity = await lstat(lockPath)
  const lockBytes = await readFile(lockPath)

  const result = runBuiltCli(
    [
      "deploy",
      packageDirectory,
      "--channel",
      "dingtalk",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--locale",
      "en",
      "--name",
      "Bounded Lock Timeout",
      "--yes",
    ],
    {
      entry: path.join(copiedDist, "apps", "cli", "bin.js"),
      environment: cliEnvironment({
        home,
        bin,
        extra: {
          QODER_PERSONAL_ACCESS_TOKEN: "lock-timeout-sentinel",
          DEPLOY_PROVIDER_MARKER: dwsMarker,
        },
      }),
    },
  )
  assert.equal(result.status, 1, result.stderr)
  assert.match(
    result.stderr,
    /Private deployment state could not be written \(deploy_lock_timeout\)\./,
  )
  assert.equal(result.stdout, "")
  assert.deepEqual(await readJsonLines(qoderMarker), [["--version"]])
  assert.equal(await noConfig(home), true)
  assert.equal(await markerMissing(dwsMarker), true)
  assert.deepEqual(deploymentPids(configPath), [])
  const afterContention = await lstat(lockPath)
  assert.equal(afterContention.dev, lockIdentity.dev)
  assert.equal(afterContention.ino, lockIdentity.ino)
  assert.deepEqual(await readFile(lockPath), lockBytes)

  assert.ok(owner.child.pid)
  process.kill(owner.child.pid, "SIGUSR1")
  const released = await owner.completion
  assert.equal(released.status, 0, released.stderr)
  assert.equal(await deploymentKernelLockIsFree(lockPath, utility), true)

  const successor = startDeploymentLockActor(t, {
    home,
    lockPath,
    utility,
    wrapperPath,
    wrapperEventsPath: `${wrapperEventsPath}.successor`,
    mode: "real",
    timeoutMs: 5_000,
  })
  const successorResult = await successor.completion
  assert.equal(successorResult.status, 0, successorResult.stderr)
  const [successorReport] = deploymentLockActorReports(successorResult.stdout)
  assert.equal(successorReport?.phase, "acquired")
  assert.equal(successorReport.contended, false)
})

test("retained descriptor lock fences contenders, cancels waiters, and releases on owner SIGKILL", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-retained-lock-")
  const home = path.join(temporary, "home")
  const preCancelledHome = path.join(temporary, "pre-cancelled-home")
  await mkdir(home)
  await mkdir(preCancelledHome)
  const configModule = path.join(root, "apps", "cli", "deploy", "config.ts")
const helperSource = `
const { acquireDeploymentLock } = await import(process.argv[1])
const mode = process.argv[2]
const utilityMarker = process.argv[3]
const controller = new AbortController()
if (mode === "pre-cancelled") controller.abort()
if (mode === "cancel") setTimeout(() => controller.abort(), 250)
if (mode === "controlled-cancel") process.once("SIGUSR2", () => controller.abort())
const hooks = mode === "controlled-cancel" ? {
  lockUtilityInvocation: () => ({
    command: process.execPath,
    args: [
      "-e",
      "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",
      utilityMarker,
    ],
  }),
} : mode === "crash-waiter" ? {
  lockUtilityInvocation: () => ({
    command: process.execPath,
    args: [
      "-e",
      "const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>process.exit(1),300)",
      utilityMarker,
    ],
  }),
} : {}
try {
  const lock = await acquireDeploymentLock({
    signal: controller.signal,
    timeoutMs: mode === "timeout" ? 500 : 5000,
    hooks,
  })
  process.stdout.write("acquired:" + String(lock.contended) + "\\n")
  if (mode === "hold") setInterval(() => {}, 1000)
  else await lock.release()
} catch (error) {
  process.stdout.write("error:" + (error instanceof Error ? error.message : "unknown") + "\\n")
}
`
  const startOwner = (
    mode: string,
    ownerHome = home,
    utilityMarker = "",
  ) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        helperSource,
        configModule,
        mode,
        utilityMarker,
      ],
      {
        cwd: root,
        env: cliEnvironment({ home: ownerHome }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk
    })
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    t.after(() => {
      if (!child.pid) return
      try {
        process.kill(child.pid, "SIGKILL")
      } catch {
        // The exact test-owned helper already exited.
      }
    })
    return { child, completion, stdout: () => stdout, stderr: () => stderr }
  }

  const preCancelled = startOwner("pre-cancelled", preCancelledHome)
  assert.equal(await preCancelled.completion, 0, preCancelled.stderr())
  assert.match(preCancelled.stdout(), /error:deploy_lock_interrupted/)
  assert.equal(
    await markerMissing(path.join(preCancelledHome, ".digital-employee")),
    true,
  )

  const first = startOwner("hold")
  await waitFor(() => first.stdout().includes("acquired:false"))
  const cancelled = startOwner("cancel")
  assert.equal(await cancelled.completion, 0, cancelled.stderr())
  assert.match(cancelled.stdout(), /error:deploy_lock_interrupted/)

  const hardUtilityMarker = path.join(temporary, "hard-lock-utility.pid")
  const hardCancelled = startOwner(
    "controlled-cancel",
    home,
    hardUtilityMarker,
  )
  assert.ok(hardCancelled.child.pid)
  await waitFor(async () => !await markerMissing(hardUtilityMarker))
  const utilityPid = Number.parseInt(
    await readFile(hardUtilityMarker, "utf8"),
    10,
  )
  assert.ok(Number.isSafeInteger(utilityPid) && utilityPid > 0)
  t.after(() => {
    try {
      process.kill(utilityPid, "SIGKILL")
    } catch {
      // The exact test-owned utility already exited.
    }
  })
  const utilityParent = spawnSync(
    "/bin/ps",
    ["-o", "ppid=", "-p", String(utilityPid)],
    { encoding: "utf8" },
  )
  assert.equal(utilityParent.status, 0, utilityParent.stderr)
  assert.equal(Number(utilityParent.stdout.trim()), hardCancelled.child.pid)
  const abortStartedAt = Date.now()
  process.kill(hardCancelled.child.pid, "SIGUSR2")
  await delay(250)
  process.kill(utilityPid, 0)
  assert.equal(hardCancelled.stdout(), "")
  assert.equal(await hardCancelled.completion, 0, hardCancelled.stderr())
  const abortElapsedMs = Date.now() - abortStartedAt
  assert.ok(abortElapsedMs >= 900, `hard kill elapsed ${abortElapsedMs}ms`)
  assert.ok(abortElapsedMs < 5_000, `hard kill elapsed ${abortElapsedMs}ms`)
  assert.equal(hardCancelled.stdout(), "error:deploy_lock_interrupted\n")
  assert.throws(
    () => process.kill(utilityPid, 0),
    (error: unknown) => Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH",
    ),
  )

  const timedOut = startOwner("timeout")
  assert.equal(await timedOut.completion, 0, timedOut.stderr())
  assert.equal(timedOut.stdout(), "error:deploy_lock_timeout\n")

  const crashUtilityMarker = path.join(temporary, "crash-lock-utility.pid")
  const crashedWaiter = startOwner("crash-waiter", home, crashUtilityMarker)
  assert.ok(crashedWaiter.child.pid)
  await waitFor(async () => !await markerMissing(crashUtilityMarker))
  const crashUtilityPid = Number.parseInt(
    await readFile(crashUtilityMarker, "utf8"),
    10,
  )
  assert.ok(Number.isSafeInteger(crashUtilityPid) && crashUtilityPid > 0)
  t.after(() => {
    try {
      process.kill(crashUtilityPid, "SIGKILL")
    } catch {
      // The bounded one-shot utility already exited.
    }
  })
  const crashedUtilityParent = spawnSync(
    "/bin/ps",
    ["-o", "ppid=", "-p", String(crashUtilityPid)],
    { encoding: "utf8" },
  )
  assert.equal(crashedUtilityParent.status, 0, crashedUtilityParent.stderr)
  assert.equal(
    Number(crashedUtilityParent.stdout.trim()),
    crashedWaiter.child.pid,
  )
  process.kill(crashedWaiter.child.pid!, "SIGKILL")
  await crashedWaiter.completion
  await waitFor(() => {
    try {
      process.kill(crashUtilityPid, 0)
      return false
    } catch {
      return true
    }
  }, 2_000)

  const successor = startOwner("once")
  await delay(1_000)
  assert.equal(successor.stdout(), "")
  assert.ok(first.child.pid)
  process.kill(first.child.pid, "SIGKILL")
  await first.completion
  assert.equal(await successor.completion, 0, successor.stderr())
  // The preceding cancelled/timeout waiters prove contention. Under a loaded
  // full suite this final successor may not finish its tsx bootstrap until
  // after the owner is killed, so only acquisition itself is authoritative.
  assert.match(successor.stdout(), /acquired:(?:true|false)/)
})

test("unsafe lock path and PATH spoof fail closed without touching sentinel bytes", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-lock-path-safety-")
  const home = path.join(temporary, "home")
  const configDirectory = path.join(home, ".digital-employee")
  const lockPath = path.join(configDirectory, ".deploy.lock")
  const sentinel = path.join(temporary, "sentinel.txt")
  const marker = path.join(temporary, "spoof.marker")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "lock-path-safety")
  await mkdir(home)
  await mkdir(configDirectory, { mode: 0o700 })
  await writeFile(sentinel, "lock-sentinel-bytes\n", { mode: 0o600 })
  const before = await lstat(sentinel)
  const beforeBytes = await readFile(sentinel)
  await symlink(sentinel, lockPath)
  await installFakeQoder(bin)
  await writeFile(
    path.join(bin, process.platform === "linux" ? "flock" : "lockf"),
    "#!/bin/sh\nprintf spoofed > \"$DEPLOY_LOCK_SPOOF_MARKER\"\nexit 0\n",
    { mode: 0o755 },
  )
  await createEmployeePackage(packageDirectory, { name: "lock-path-safety" })
  const result = runBuiltCli(
    [
      "deploy",
      packageDirectory,
      "--channel",
      "console",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--locale",
      "en",
      "--name",
      "Lock Path Safety",
      "--yes",
    ],
    {
      environment: cliEnvironment({
        home,
        bin,
        extra: {
          QODER_PERSONAL_ACCESS_TOKEN: "lock-path-sentinel",
          DEPLOY_LOCK_SPOOF_MARKER: marker,
        },
      }),
    },
  )
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /state could not be written/i)
  assert.equal(await markerMissing(marker), true)
  assert.equal(await readlink(lockPath), sentinel)
  const after = await lstat(sentinel)
  assert.equal(after.dev, before.dev)
  assert.equal(after.ino, before.ino)
  assert.deepEqual(await readFile(sentinel), beforeBytes)
  assert.equal(await noConfig(home), true)
})

test("unsafe lock file permissions fail closed without replacing the lock generation", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-lock-mode-safety-")
  const home = path.join(temporary, "home")
  const configDirectory = path.join(home, ".digital-employee")
  const lockPath = path.join(configDirectory, ".deploy.lock")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "lock-mode-safety")
  await mkdir(home)
  await mkdir(configDirectory, { mode: 0o700 })
  const lockBytes = Buffer.from("unsafe-lock-mode-sentinel\n")
  await writeFile(lockPath, lockBytes, { mode: 0o644 })
  const before = await lstat(lockPath)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "lock-mode-safety" })
  const result = runBuiltCli(
    [
      "deploy",
      packageDirectory,
      "--channel",
      "console",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--locale",
      "en",
      "--yes",
    ],
    {
      environment: cliEnvironment({
        home,
        bin,
        extra: { QODER_PERSONAL_ACCESS_TOKEN: "lock-mode-host-sentinel" },
      }),
    },
  )
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /state could not be written/i)
  const after = await lstat(lockPath)
  assert.equal(after.dev, before.dev)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mode & 0o777, 0o644)
  assert.deepEqual(await readFile(lockPath), lockBytes)
  assert.equal(await noConfig(home), true)
})

test("package-bound standalone-v1 is unsupported for every channel before prompts or effects", async (t) => {
  const channels = ["dingtalk", "lark", "wecom", "console", "http"]
  const engines: Array<string | undefined> = [
    undefined,
    "extractive",
    "openai-compatible",
  ]
  for (const channel of channels) {
    for (const engine of engines) {
      await t.test(`${channel}/${engine ?? "omitted-engine"}`, async (subtest) => {
        const temporary = await isolatedRoot(subtest, "deploy-standalone-unsupported-")
        const home = path.join(temporary, "home")
        const bin = path.join(temporary, "bin")
        const marker = path.join(temporary, "dws.marker")
        const packageDirectory = path.join(temporary, "standalone-bound")
        await mkdir(home)
        await installObservableDws(bin, marker)
        await createEmployeePackage(packageDirectory, { name: "standalone-bound" })
        const args = [
          "deploy",
          packageDirectory,
          "--channel",
          channel,
          "--runtime",
          "standalone-v1",
          "--locale",
          "en",
        ]
        if (engine) args.push("--engine", engine)

        const result = runBuiltCli(args, {
          environment: cliEnvironment({
            home,
            bin,
            extra: {
              DEPLOY_PROVIDER_MARKER: marker,
              OPENAI_API_KEY: "standalone-secret-sentinel",
              OPENAI_MODEL: "unused-model",
            },
          }),
        })
        assert.equal(result.status, 1, result.stderr)
        assert.match(result.stderr, /unsupported deployment/i)
        assert.match(result.stderr, /digital-employee legacy/)
        assert.doesNotMatch(result.stdout, /\?|Choice|Ready:/)
        assert.equal(await noConfig(home), true)
        assert.equal(await markerMissing(marker), true)
        assert.deepEqual(
          deploymentPids(path.join(home, ".digital-employee", "config.json")),
          [],
        )
      })
    }
  }
})

test("unavailable explicit Agent engine fails before every interactive prompt", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-preflight-before-prompts-")
  const home = path.join(temporary, "home")
  const packageDirectory = path.join(temporary, "preflight-bound")
  await mkdir(home)
  await createEmployeePackage(packageDirectory, { name: "preflight-bound" })

  const result = runBuiltCli(["deploy", packageDirectory, "--engine", "qoder"], {
    environment: cliEnvironment({ home }),
  })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /engine is unsupported, unavailable, or incompatible/i)
  assert.doesNotMatch(result.stdout, /\?|Choice|Language|Where|called/)
  assert.equal(await noConfig(home), true)
})

test("missing engine credentials fail closed with localized recovery guidance", async (t) => {
  const fixtures = [
    {
      locale: "en",
      recovery:
        /Set the QODER_PERSONAL_ACCESS_TOKEN environment variable, then rerun the same deploy command\./,
    },
    {
      locale: "zh-CN",
      recovery:
        /请设置 QODER_PERSONAL_ACCESS_TOKEN 环境变量，然后重新运行同一 deploy 命令。/,
    },
    {
      locale: "ja",
      recovery:
        /QODER_PERSONAL_ACCESS_TOKEN 環境変数を設定してから、同じdeployコマンドを再実行してください。/,
    },
  ]
  for (const fixture of fixtures) {
    await t.test(fixture.locale, async (subtest) => {
      const temporary = await isolatedRoot(subtest, "deploy-missing-token-")
      const home = path.join(temporary, "home")
      const bin = path.join(temporary, "bin")
      const packageDirectory = path.join(temporary, "missing-token")
      await mkdir(home)
      await installFakeQoder(bin)
      await createEmployeePackage(packageDirectory, { name: "missing-token" })
      const environment = cliEnvironment({ home, bin })
      delete environment.QODER_PERSONAL_ACCESS_TOKEN

      const result = runBuiltCli(
        [
          "deploy",
          packageDirectory,
          "--engine",
          "qoder",
          "--locale",
          fixture.locale,
        ],
        { environment },
      )

      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /qoder_service_token_not_configured/)
      assert.match(result.stderr, fixture.recovery)
      assert.doesNotMatch(result.stdout, /\?|Choice|Ready:/)
      assert.equal(await noConfig(home), true)
    })
  }
})

test("deploy parse failures are localized, actionable, and side-effect free", async (t) => {
  const locales = [
    { code: "en", marker: /Invalid --bogus/ },
    { code: "zh-CN", marker: /无效的 --bogus/ },
    { code: "ja", marker: /--bogusが無効/ },
  ]
  for (const locale of locales) {
    await t.test(locale.code, async (subtest) => {
      const temporary = await isolatedRoot(subtest, "deploy-unknown-option-")
      const home = path.join(temporary, "home")
      await mkdir(home)
      const result = runBuiltCli(
        ["deploy", "--bogus", "--locale", locale.code],
        { environment: cliEnvironment({ home }) },
      )
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, locale.marker)
      assert.match(result.stderr, /--package/)
      assert.doesNotMatch(result.stdout, /\?|Choice/)
      assert.equal(await noConfig(home), true)
    })
  }

  const temporary = await isolatedRoot(t, "deploy-malformed-option-")
  const home = path.join(temporary, "home")
  await mkdir(home)
  for (const args of [
    ["deploy", "--yes=maybe", "--locale", "en"],
    ["deploy", "one", "two", "--locale", "en"],
    ["deploy", "one", "--package", "two", "--locale", "en"],
  ]) {
    const result = runBuiltCli(args, { environment: cliEnvironment({ home }) })
    assert.equal(result.status, 1, result.stderr)
    assert.doesNotMatch(result.stdout, /\?|Choice/)
    assert.equal(await noConfig(home), true)
  }
})

test("invalid deploy values, option combinations, and incomplete automation fail localized before effects", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-invalid-matrix-")
  const packageDirectory = path.join(temporary, "invalid-matrix")
  await createEmployeePackage(packageDirectory, { name: "invalid-matrix" })
  const locales = [
    { code: "en", marker: /Invalid|Incompatible|requires/ },
    { code: "zh-CN", marker: /无效|不兼容|需要/ },
    { code: "ja", marker: /無効|互換性がありません|必要/ },
  ]
  const fixtures: Array<{
    name: string
    mutate(args: string[]): string[]
    expected: RegExp
  }> = [
    {
      name: "invalid-channel",
      mutate: (args) => args.map((value) => value === "console" ? "bogus" : value),
      expected: /channel/,
    },
    {
      name: "invalid-engine",
      mutate: (args) => args.map((value) => value === "qoder" ? "bogus" : value),
      expected: /engine/,
    },
    {
      name: "invalid-runtime",
      mutate: (args) =>
        args.map((value) => value === "agent-native" ? "bogus" : value),
      expected: /runtime/,
    },
    {
      name: "agent-native-with-standalone-engine",
      mutate: (args) =>
        args.map((value) => value === "qoder" ? "extractive" : value),
      expected: /engine\(agent-native\)/,
    },
    {
      name: "standalone-with-agent-engine",
      mutate: (args) =>
        args.map((value) =>
          value === "agent-native"
            ? "standalone-v1"
            : value === "qoder"
              ? "qoder"
              : value
        ),
      expected: /engine\(standalone-v1\)/,
    },
    ...["0", "65536", "12x"].map((port) => ({
      name: `invalid-port-${port}`,
      mutate: (args: string[]) => [
        ...args.map((value) => value === "console" ? "http" : value),
        "--port",
        port,
      ],
      expected: /port/,
    })),
    ...(["console", "dingtalk", "lark", "wecom"] as const).map(
      (channel) => ({
        name: `port-on-${channel}`,
        mutate: (args: string[]) => [
          ...args.map((value) => value === "console" ? channel : value),
          "--port",
          "3000",
        ],
        expected: /port_requires_http_channel/,
      }),
    ),
    ...(["channel", "engine", "runtime"] as const).map((field) => ({
      name: `missing-${field}`,
      mutate: (args: string[]) => {
        const index = args.indexOf(`--${field}`)
        return [...args.slice(0, index), ...args.slice(index + 2)]
      },
      expected: new RegExp(`--${field}`),
    })),
  ]
  for (const locale of locales) {
    for (const fixture of fixtures) {
      await t.test(`${locale.code}/${fixture.name}`, async (subtest) => {
        const home = path.join(
          temporary,
          `home-${locale.code}-${fixture.name}`,
        )
        const bin = path.join(
          temporary,
          `bin-${locale.code}-${fixture.name}`,
        )
        const marker = path.join(
          temporary,
          `effect-${locale.code}-${fixture.name}.marker`,
        )
        await mkdir(home)
        await installObservableProbe(bin, marker)
        const args = fixture.mutate([
          "deploy",
          packageDirectory,
          "--channel",
          "console",
          "--engine",
          "qoder",
          "--runtime",
          "agent-native",
          "--locale",
          locale.code,
          "--name",
          "Invalid Matrix",
          "--yes",
        ])
        const result = runBuiltCli(args, {
          environment: cliEnvironment({
            home,
            bin,
            extra: { DEPLOY_PROVIDER_MARKER: marker },
          }),
        })
        assert.equal(result.status, 1, result.stderr)
        assert.match(result.stderr, locale.marker)
        assert.match(result.stderr, fixture.expected)
        assert.doesNotMatch(result.stdout, /\?|Choice|Binding:|Ready:/)
        assert.equal(await markerMissing(marker), true)
        assert.equal(await noConfig(home), true)
        assert.deepEqual(
          deploymentPids(path.join(home, ".digital-employee", "config.json")),
          [],
        )
        void subtest
      })
    }
  }
})

test("every explicit empty or whitespace deploy value preserves authoritative state before prompts and effects in all locales", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-empty-values-")
  const packageDirectory = path.join(temporary, "empty-value-package")
  await createEmployeePackage(packageDirectory, { name: "empty-value-package" })
  const packageDigest = await computeEmployeePackageDirectoryDigest(
    packageDirectory,
  )
  const localReference = await realpath(packageDirectory)
  const locales = [
    { code: "en", system: "en_US.UTF-8", marker: /Invalid|employee package/i },
    { code: "zh-CN", system: "zh_CN.UTF-8", marker: /无效/ },
    { code: "ja", system: "ja_JP.UTF-8", marker: /無効/ },
  ]
  const fields = [
    "channel",
    "engine",
    "name",
    "locale",
    "runtime",
    "package",
    "port",
  ] as const
  for (const locale of locales) {
    for (const field of fields) {
      for (const syntax of [
        "equals-empty",
        "separate-empty",
        "equals-whitespace",
        "separate-whitespace",
      ] as const) {
        await t.test(`${locale.code}/${field}/${syntax}`, async (subtest) => {
          const home = path.join(
            temporary,
            `home-${locale.code}-${field}-${syntax}`,
          )
          const bin = path.join(
            temporary,
            `bin-${locale.code}-${field}-${syntax}`,
          )
          const marker = path.join(
            temporary,
            `effect-${locale.code}-${field}-${syntax}.marker`,
          )
          await mkdir(home)
          const configDirectory = path.join(home, ".digital-employee")
          const configPath = path.join(configDirectory, "config.json")
          await mkdir(configDirectory, { mode: 0o700 })
          const now = new Date(0).toISOString()
          const preservedBytes = Buffer.from(`${JSON.stringify({
            schemaVersion: "deploy-state.v1",
            locale: "en",
            channel: "console",
            botName: "Preserved Deployment",
            engine: "qoder",
            runtime: "agent-native",
            package: {
              name: "empty-value-package",
              version: "0.1.0",
              digest: packageDigest,
              localReference,
            },
            outcome: "pending_external_action",
            code: "console_foreground_start_required",
            updatedAt: now,
          }, null, 2)}\n`)
          await writeFile(configPath, preservedBytes, { mode: 0o600 })
          const preservedIdentity = await lstat(configPath)
          await installObservableProbe(bin, marker)
          const values: Record<(typeof fields)[number], string> = {
            channel: "http",
            engine: "qoder",
            name: "Empty Value Guard",
            locale: locale.code,
            runtime: "agent-native",
            package: packageDirectory,
            port: String(await freePort()),
          }
          const args = ["deploy"]
          for (const candidate of fields) {
            if (candidate === field) {
              const emptyValue = syntax.endsWith("whitespace") ? "   " : ""
              args.push(
                ...(syntax.startsWith("equals")
                  ? [`--${candidate}=${emptyValue}`]
                  : [`--${candidate}`, emptyValue]),
              )
            } else {
              args.push(`--${candidate}`, values[candidate])
            }
          }
          args.push("--yes")
          const result = runBuiltCli(args, {
            environment: cliEnvironment({
              home,
              bin,
              extra: {
                LANG: locale.system,
                LC_ALL: locale.system,
                DEPLOY_PROVIDER_MARKER: marker,
              },
            }),
          })
          assert.equal(result.status, 1, result.stderr)
          assert.match(result.stderr, locale.marker)
          assert.doesNotMatch(result.stdout, /\?|Choice|Where|called|Binding/)
          assert.equal(await markerMissing(marker), true)
          const after = await lstat(configPath)
          assert.equal(after.dev, preservedIdentity.dev)
          assert.equal(after.ino, preservedIdentity.ino)
          assert.deepEqual(await readFile(configPath), preservedBytes)
          assert.equal(
            (await readdir(configDirectory)).some((entry) =>
              entry.endsWith(".tmp")
            ),
            false,
          )
          assert.deepEqual(
            deploymentPids(configPath),
            [],
          )
          void subtest
        })
      }
    }
  }
})

test("unsupported explicit locale selects English even under a non-English system locale", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-invalid-locale-english-")
  const home = path.join(temporary, "home")
  await mkdir(home)
  const result = runBuiltCli(["deploy", "--locale", "not-a-locale"], {
    environment: cliEnvironment({
      home,
      extra: { LC_ALL: "zh_CN.UTF-8", LANG: "zh_CN.UTF-8" },
    }),
  })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Invalid locale\. Supported values:/)
  assert.doesNotMatch(result.stderr, /无效/)
  assert.equal(await noConfig(home), true)
})

test("interactive deploy defaults runtime to agent-native without a runtime prompt", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-interactive-runtime-default-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "interactive-bound")
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "interactive-bound" })

  const result = runBuiltCli(["deploy"], {
    cwd: packageDirectory,
    environment: cliEnvironment({
      home,
      bin,
      extra: { QODER_PERSONAL_ACCESS_TOKEN: "interactive-secret-sentinel" },
    }),
    input: "2\n1\n2\n\n",
  })
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /Which AI engine/)
  assert.doesNotMatch(result.stdout, /Which runtime should execute/)
  const config = JSON.parse(
    await readFile(path.join(home, ".digital-employee", "config.json"), "utf8"),
  ) as { runtime: string; outcome: string }
  assert.equal(config.runtime, "agent-native")
  assert.equal(config.outcome, "pending_external_action")
})

test("package mutation while overwrite confirmation is open fails before persistence or channel effects", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-package-prompt-race-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const marker = path.join(temporary, "host.marker")
  const packageDirectory = path.join(temporary, "prompt-race")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const knowledgePath = path.join(packageDirectory, "knowledge", "README.md")
  await mkdir(home)
  await installObservableProbe(bin, marker)
  await createEmployeePackage(packageDirectory, { name: "prompt-race" })
  const environment = cliEnvironment({
    home,
    bin,
    extra: {
      QODER_PERSONAL_ACCESS_TOKEN: "prompt-race-sentinel",
      DEPLOY_PROVIDER_MARKER: marker,
    },
  })
  const args = [
    "deploy",
    packageDirectory,
    "--channel",
    "console",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Prompt Race",
  ]
  const seed = runBuiltCli([...args, "--yes"], { environment })
  assert.equal(seed.status, 2, seed.stderr)
  const preservedBytes = await readFile(configPath)
  const preservedIdentity = await lstat(configPath)
  await rm(marker, { force: true })

  const pending = startBuiltCli(args, {
    environment,
    pipeInput: true,
  })
  t.after(() => {
    if (pending.child.exitCode === null && pending.child.signalCode === null) {
      pending.child.kill("SIGKILL")
    }
  })
  await waitFor(() =>
    /Overwrite existing configuration/.test(pending.stdoutText())
  )
  const preflightCalls = await readFile(marker)
  assert.deepEqual(preflightCalls, Buffer.from("called\n"))
  await writeFile(
    knowledgePath,
    `${await readFile(knowledgePath, "utf8")}\nmutated during prompt\n`,
  )
  pending.child.stdin?.end("y\n")
  const result = await pending.completion
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /employee package.*changed/i)
  assert.doesNotMatch(result.stdout, /Binding:|Ready:/)
  assert.deepEqual(await readFile(marker), preflightCalls)
  const after = await lstat(configPath)
  assert.equal(after.dev, preservedIdentity.dev)
  assert.equal(after.ino, preservedIdentity.ino)
  assert.deepEqual(await readFile(configPath), preservedBytes)
  assert.deepEqual(deploymentPids(configPath), [])
  assert.equal(
    (await readdir(path.dirname(configPath))).some((entry) =>
      entry.endsWith(".tmp")
    ),
    false,
  )
})

test("interactive answers survive separated stdin chunks and premature EOF fails closed", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-interactive-chunks-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "chunked-bound")
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "chunked-bound" })
  const environment = cliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "chunked-secret-sentinel" },
  })
  const chunked = startBuiltCli(["deploy"], {
    cwd: packageDirectory,
    environment,
    pipeInput: true,
  })
  assert.ok(chunked.child.stdin)
  for (const answer of ["2\n", "1\n", "2\n", "\n"]) {
    chunked.child.stdin.write(answer)
    await delay(100)
  }
  chunked.child.stdin.end()
  const chunkedResult = await chunked.completion
  assert.equal(
    chunkedResult.status,
    2,
    `${chunkedResult.stdout}\n${chunkedResult.stderr}`,
  )
  assert.match(
    chunkedResult.stdout,
    /1\) HTTP API — available; ready after authenticated readback/,
  )
  assert.match(
    chunkedResult.stdout,
    /2\) Console \(terminal\) — preview; pending_external_action/,
  )
  assert.match(
    chunkedResult.stdout,
    /3\) DingTalk — preview; pending_external_action/,
  )
  assert.doesNotMatch(
    chunkedResult.stdout,
    /Lark \(Feishu\)|WeCom — unavailable/,
  )
  assert.match(chunkedResult.stdout, /Choice \[1-3\]/)
  assert.doesNotMatch(chunkedResult.stdout, /Which runtime should execute/)
  const configPath = path.join(home, ".digital-employee", "config.json")
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    runtime: string
    outcome: string
  }
  assert.equal(config.runtime, "agent-native")
  assert.equal(config.outcome, "pending_external_action")

  const utf8Home = path.join(temporary, "utf8-home")
  await mkdir(utf8Home)
  const utf8 = startBuiltCli(["deploy"], {
    cwd: packageDirectory,
    environment: cliEnvironment({
      home: utf8Home,
      bin,
      extra: { QODER_PERSONAL_ACCESS_TOKEN: "utf8-secret-sentinel" },
    }),
    pipeInput: true,
  })
  assert.ok(utf8.child.stdin)
  for (const answer of ["2\n", "1\n", "2\n"]) {
    utf8.child.stdin.write(answer)
    await delay(50)
  }
  const encodedName = Buffer.from("钉钉助手\n", "utf8")
  utf8.child.stdin.write(encodedName.subarray(0, 1))
  await delay(50)
  utf8.child.stdin.write(encodedName.subarray(1, 4))
  await delay(50)
  utf8.child.stdin.end(encodedName.subarray(4))
  const utf8Result = await utf8.completion
  assert.equal(utf8Result.status, 2, utf8Result.stderr)
  const utf8Config = JSON.parse(
    await readFile(
      path.join(utf8Home, ".digital-employee", "config.json"),
      "utf8",
    ),
  ) as { botName: string }
  assert.equal(utf8Config.botName, "钉钉助手")

  const emptyHome = path.join(temporary, "empty-home")
  await mkdir(emptyHome)
  const ended = startBuiltCli(["deploy"], {
    cwd: packageDirectory,
    environment: cliEnvironment({ home: emptyHome, bin }),
    pipeInput: true,
  })
  assert.ok(ended.child.stdin)
  ended.child.stdin.end()
  const endedResult = await ended.completion
  assert.equal(endedResult.status, 1, endedResult.stderr)
  assert.match(endedResult.stderr, /input ended before a required answer/i)
  assert.equal(await noConfig(emptyHome), true)

  const oversizedHome = path.join(temporary, "oversized-home")
  await mkdir(oversizedHome)
  const oversized = runBuiltCli(["deploy"], {
    cwd: packageDirectory,
    environment: cliEnvironment({ home: oversizedHome, bin }),
    input: `${"x".repeat(4_097)}\n`,
  })
  assert.equal(oversized.status, 1, oversized.stderr)
  assert.match(oversized.stderr, /deploy_prompt_input_limit_exceeded/)
  assert.equal(await noConfig(oversizedHome), true)
})

test("paused deploy fencing prevents a different-port concurrent deploy from spawning", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-fenced-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "fenced-http")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const firstPort = await freePort()
  let secondPort = await freePort()
  while (secondPort === firstPort) secondPort = await freePort()
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "fenced-http" })
  await addValidFinalGateAssets(packageDirectory)
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: {
      QODER_PERSONAL_ACCESS_TOKEN: "fenced-secret-sentinel",
    },
  })
  const args = (port: number) => [
    "deploy",
    packageDirectory,
    "--channel",
    "http",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Fenced HTTP",
    "--port",
    String(port),
    "--yes",
  ]
  const first = startBuiltCli(args(firstPort), { environment })
  let second: ReturnType<typeof startBuiltCli> | undefined
  let firstParentStopped = false
  t.after(async () => {
    if (firstParentStopped && first.child.pid) {
      try {
        process.kill(first.child.pid, "SIGCONT")
        firstParentStopped = false
      } catch {
        // The parent already exited.
      }
    }
    const parents = second ? [first, second] : [first]
    for (const parent of parents) {
      if (parent.child.exitCode !== null || parent.child.signalCode !== null) {
        continue
      }
      try {
        parent.child.kill("SIGTERM")
      } catch {
        // The exact test-owned parent already exited.
      }
    }
    for (const pid of deploymentPids(configPath)) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // The exact test-owned worker already exited.
      }
    }
    for (const parent of parents) {
      const exited = await Promise.race([
        parent.completion.then(() => true, () => true),
        delay(2_000).then(() => false),
      ])
      if (
        !exited &&
        parent.child.exitCode === null &&
        parent.child.signalCode === null
      ) {
        try {
          parent.child.kill("SIGKILL")
        } catch {
          // The exact test-owned parent already exited.
        }
      }
    }
    await Promise.allSettled(parents.map((parent) => parent.completion))
    try {
      await waitFor(() => deploymentPids(configPath).length === 0, 2_000)
    } catch {
      for (const pid of deploymentPids(configPath)) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // The exact test-owned worker already exited.
        }
      }
      await waitFor(() => deploymentPids(configPath).length === 0, 2_000)
    }
    await rm(temporary, { recursive: true, force: true })
  })

  let trackedPid = 0
  await waitFor(async () => {
    try {
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        code?: string
        process?: { pid?: number; launchId?: string }
      }
      if (
        config.code === "http_final_verification_pending" &&
        config.process?.pid &&
        config.process.launchId
      ) {
        trackedPid = config.process.pid
        return true
      }
    } catch {
      // Atomic state has not appeared yet.
    }
    return false
  })
  assert.ok(first.child.pid)
  process.kill(first.child.pid, "SIGSTOP")
  firstParentStopped = true
  second = startBuiltCli(args(secondPort), { environment })
  await delay(500)
  assert.deepEqual(deploymentPids(configPath), [trackedPid])
  await assert.rejects(
    httpJson({ port: secondPort, path: "/health", timeoutMs: 200 }),
  )

  process.kill(first.child.pid, "SIGCONT")
  firstParentStopped = false
  const firstResult = await first.completion
  const secondResult = await second.completion
  assert.equal(firstResult.status, 0, firstResult.stderr)
  assert.equal(secondResult.status, 1, secondResult.stderr)
  assert.match(secondResult.stderr, /cannot be replaced safely/i)
  const finalConfig = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    endpoint: { port: number }
    process: { pid: number }
  }
  assert.equal(finalConfig.outcome, "ready")
  assert.equal(finalConfig.endpoint.port, firstPort)
  assert.equal(finalConfig.process.pid, trackedPid)
  assert.deepEqual(deploymentPids(configPath), [trackedPid])
  await stopVerifiedHttpProcess(trackedPid, firstPort)
  await waitFor(() => deploymentPids(configPath).length === 0)
})

test("a live exact HTTP deployment blocks every cross-channel replacement without effects", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-cross-channel-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const marker = path.join(temporary, "dws.marker")
  const packageDirectory = path.join(temporary, "cross-channel-http")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const port = await freePort()
  await mkdir(home)
  await installFakeQoder(bin)
  await installObservableDws(bin, marker)
  await createEmployeePackage(packageDirectory, { name: "cross-channel-http" })
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "cross-channel-sentinel" },
  })
  const httpArgs = [
    "deploy",
    packageDirectory,
    "--channel",
    "http",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Cross Channel",
    "--port",
    String(port),
    "--yes",
  ]
  const ready = runBuiltCli(httpArgs, { environment })
  assert.equal(ready.status, 0, ready.stderr)
  const readyConfig = JSON.parse(await readFile(configPath, "utf8")) as {
    process: { pid: number }
  }
  t.after(async () => {
    try {
      await stopVerifiedHttpProcess(readyConfig.process.pid, port)
    } catch {
      // The exact test-owned process already exited.
    }
  })
  const before = await lstat(configPath)
  const beforeBytes = await readFile(configPath)

  for (const channel of ["lark", "wecom", "console", "dingtalk"] as const) {
    const replacement = runBuiltCli(
      [
        "deploy",
        packageDirectory,
        "--channel",
        channel,
        "--engine",
        "qoder",
        "--runtime",
        "agent-native",
        "--locale",
        "en",
        "--name",
        "Cross Channel",
        "--yes",
      ],
      { environment },
    )
    assert.equal(replacement.status, 1, replacement.stderr)
    assert.match(replacement.stderr, /cannot be replaced safely/i)
    assert.doesNotMatch(replacement.stdout, /Ready:/)
    const after = await lstat(configPath)
    assert.equal(after.dev, before.dev)
    assert.equal(after.ino, before.ino)
    assert.deepEqual(await readFile(configPath), beforeBytes)
    assert.deepEqual(deploymentPids(configPath), [readyConfig.process.pid])
  }
  assert.equal(await markerMissing(marker), true)
  const health = await httpJson({ port, path: "/health" })
  assert.equal(health.body.pid, readyConfig.process.pid)
  await stopVerifiedHttpProcess(readyConfig.process.pid, port)
})

test("HTTP PID reuse with mismatched argv is preserved unsignaled in every locale", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-pid-reuse-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "pid-reuse")
  const configDirectory = path.join(home, ".digital-employee")
  const configPath = path.join(configDirectory, "config.json")
  const signalMarker = path.join(temporary, "sentinel.signal")
  const port = await freePort()
  await mkdir(home)
  await mkdir(configDirectory, { mode: 0o700 })
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "pid-reuse" })
  const sentinel = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { appendFileSync } from "node:fs";
const marker = process.argv[1];
for (const name of ["SIGTERM", "SIGINT"]) {
  process.on(name, () => appendFileSync(marker, name + "\\n"));
}
process.send?.({ type: "ready" });
setInterval(() => {}, 60000);`,
      signalMarker,
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  )
  assert.ok(sentinel.pid)
  t.after(() => {
    if (sentinel.exitCode === null && sentinel.signalCode === null) {
      sentinel.kill("SIGKILL")
    }
  })
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      sentinel.once("message", () => resolve())
      sentinel.once("error", reject)
    }),
    delay(5_000).then(() => {
      throw new Error("sentinel_did_not_start")
    }),
  ])
  const packageDigest = await computeEmployeePackageDirectoryDigest(
    packageDirectory,
  )
  const localReference = await realpath(packageDirectory)
  const now = new Date().toISOString()
  const bytes = Buffer.from(`${JSON.stringify({
    schemaVersion: "deploy-state.v1",
    locale: "en",
    channel: "http",
    botName: "PID Reuse",
    engine: "qoder",
    runtime: "agent-native",
    package: {
      name: "pid-reuse",
      version: "0.1.0",
      digest: packageDigest,
      localReference,
    },
    outcome: "ready",
    secretReferences: {
      httpTokenEnv: "DIGITAL_EMPLOYEE_HTTP_TOKEN",
    },
    endpoint: {
      protocol: "http",
      host: "127.0.0.1",
      port,
      askPath: "/v1/ask",
      healthPath: "/health",
    },
    process: {
      pid: sentinel.pid,
      startedAt: now,
      launchId: "1".repeat(32),
      activationFence: "2".repeat(32),
      activationState: "authorized",
    },
    deployedAt: now,
    updatedAt: now,
  }, null, 2)}\n`)
  await writeFile(configPath, bytes, { mode: 0o600 })
  const identity = await lstat(configPath)
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "pid-reuse-sentinel" },
  })
  for (const locale of [
    { code: "en", marker: /cannot be replaced safely/ },
    { code: "zh-CN", marker: /无法被安全替换/ },
    { code: "ja", marker: /安全に置換できない/ },
  ]) {
    const result = runBuiltCli([
      "deploy",
      packageDirectory,
      "--channel",
      "http",
      "--engine",
      "qoder",
      "--runtime",
      "agent-native",
      "--locale",
      locale.code,
      "--name",
      "PID Reuse",
      "--port",
      String(port),
      "--yes",
    ], { environment })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, locale.marker)
    assert.match(result.stderr, /http_runtime_identity_unverified/)
    assert.doesNotMatch(result.stdout, /Ready:/)
    const after = await lstat(configPath)
    assert.equal(after.dev, identity.dev)
    assert.equal(after.ino, identity.ino)
    assert.deepEqual(await readFile(configPath), bytes)
    assert.doesNotThrow(() => process.kill(sentinel.pid!, 0))
    assert.equal(await markerMissing(signalMarker), true)
    assert.deepEqual(deploymentPids(configPath), [])
  }
})

test("built CLI parent crash at the authorized activation barrier leaves no listener and the child exits bounded", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-orphaned-starting-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "orphaned-starting")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const port = await freePort()
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "orphaned-starting" })
  await addValidFinalGateAssets(packageDirectory)
  const baseEnvironment = httpCliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "orphaned-starting-sentinel" },
  })
  const args = [
    "deploy",
    packageDirectory,
    "--channel",
    "http",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Orphaned Starting",
    "--port",
    String(port),
    "--yes",
  ]
  let stopProbe = false
  let probeAccepted = false
  const probe = (async () => {
    while (!stopProbe) {
      const accepted = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port })
        let settled = false
        const finish = (value: boolean) => {
          if (settled) return
          settled = true
          socket.destroy()
          resolve(value)
        }
        socket.once("connect", () => finish(true))
        socket.once("error", () => finish(false))
        socket.setTimeout(25, () => finish(false))
      })
      probeAccepted ||= accepted
      await delay(5)
    }
  })()
  t.after(async () => {
    stopProbe = true
    await probe
  })
  const owner = startBuiltCli(args, { environment: baseEnvironment })
  t.after(() => {
    if (owner.child.exitCode === null && owner.child.signalCode === null) {
      owner.child.kill("SIGKILL")
    }
    for (const pid of deploymentPids(configPath)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // The exact test-owned runtime already exited.
      }
    }
  })
  let workerPid = 0
  await waitFor(async () => {
    try {
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        code?: string
        outcome?: string
        process?: { pid?: number; activationState?: string }
      }
      if (
        config.outcome === "pending_external_action" &&
        config.code !== "http_final_verification_pending" &&
        config.process?.pid &&
        config.process.activationState === "authorized"
      ) {
        workerPid = config.process.pid
        return true
      }
    } catch {
      // The implementation-owned authorized barrier has not appeared yet.
    }
    return false
  }, 20_000)
  assert.equal(probeAccepted, false, "runtime listened before parent-crash injection")
  assert.ok(owner.child.pid)
  process.kill(owner.child.pid, "SIGKILL")
  await owner.completion
  await waitFor(() => deploymentPids(configPath).length === 0, 5_000)
  stopProbe = true
  await probe
  assert.equal(probeAccepted, false, "runtime listened after parent crash")
  assert.doesNotMatch(owner.stdoutText(), /Ready:/)
  await assert.rejects(httpJson({ port, path: "/health", timeoutMs: 200 }))

  const retry = await runBuiltCliAsync(args, { environment: baseEnvironment })
  assert.equal(retry.status, 0, retry.stderr)
  const recovered = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    process: { pid: number }
  }
  assert.equal(recovered.outcome, "ready")
  assert.notEqual(recovered.process.pid, workerPid)
  await stopVerifiedHttpProcess(recovered.process.pid, port)
  await waitFor(() => deploymentPids(configPath).length === 0)
})

test("built CLI Ready-save parent crash leaves stale Ready unusable and reruns through a fresh lifecycle", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-orphaned-ready-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "orphaned-ready")
  const configDirectory = path.join(home, ".digital-employee")
  const configPath = path.join(configDirectory, "config.json")
  const providerMarker = path.join(temporary, "provider.marker")
  const preReleaseMarker = path.join(temporary, "pre-release.marker")
  const copiedDist = path.join(temporary, "copied-dist")
  const port = await freePort()
  await cp(path.join(root, "dist"), copiedDist, { recursive: true })
  await symlink(
    path.join(root, "node_modules"),
    path.join(copiedDist, "node_modules"),
    "dir",
  )
  const copiedIndex = path.join(copiedDist, "apps", "cli", "deploy", "index.js")
  const indexSource = await readFile(copiedIndex, "utf8")
  const releaseBoundary =
    '                if (!failureCode) {\n                    const releaseResult ='
  const delayedIndex = indexSource.replace(
    releaseBoundary,
    '                if (!failureCode) {\n' +
      `                    await (await import("node:fs/promises")).writeFile(${JSON.stringify(preReleaseMarker)}, "armed\\n");\n` +
      "                    await new Promise((resolve) => setTimeout(resolve, 30000));\n" +
      "                    const releaseResult =",
  )
  assert.notEqual(delayedIndex, indexSource, "pre-release crash barrier was not injected")
  await writeFile(copiedIndex, delayedIndex)
  await mkdir(home)
  await mkdir(configDirectory, { mode: 0o700 })
  await installObservableProbe(bin, providerMarker)
  await createEmployeePackage(packageDirectory, { name: "orphaned-ready" })
  await addValidFinalGateAssets(packageDirectory)
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: {
      QODER_PERSONAL_ACCESS_TOKEN: "orphaned-ready-sentinel",
      DEPLOY_PROVIDER_MARKER: providerMarker,
    },
  })
  const args = [
    "deploy",
    packageDirectory,
    "--channel",
    "http",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Orphaned Ready",
    "--port",
    String(port),
    "--yes",
  ]
  const owner = startBuiltCli(args, {
    environment,
    entry: path.join(copiedDist, "apps", "cli", "bin.js"),
  })
  t.after(async () => {
    if (owner.child.exitCode === null && owner.child.signalCode === null) {
      owner.child.kill("SIGKILL")
    }
    for (const pid of deploymentPids(configPath)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // The exact test-owned runtime already exited.
      }
    }
  })
  await waitFor(async () => !await markerMissing(preReleaseMarker), 20_000)
  const staleReady = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    process: { pid: number }
  }
  assert.equal(staleReady.outcome, "ready")
  assert.doesNotMatch(owner.stdoutText(), /Ready:/)
  const staleBytes = await readFile(configPath)
  const staleIdentity = await lstat(configPath)
  await rm(providerMarker, { force: true })

  const preReleaseHealth = await httpJson({ port, path: "/health" })
  assert.equal(preReleaseHealth.status, 200)
  assert.equal(preReleaseHealth.body.pid, staleReady.process.pid)
  const gatedAsk = await httpJson({
    port,
    path: "/v1/ask",
    method: "POST",
    body: JSON.stringify({ message: "must remain gated before release" }),
    headers: httpAuthorization(),
  })
  assert.equal(gatedAsk.status, 400)
  assert.deepEqual(gatedAsk.body.error, {
    code: "http_runtime_activation_incomplete",
    retryable: true,
  })
  assert.equal(await markerMissing(providerMarker), true)

  assert.ok(owner.child.pid)
  process.kill(owner.child.pid, "SIGKILL")
  const crashed = await owner.completion
  assert.equal(crashed.status, null)
  await waitFor(() => deploymentPids(configPath).length === 0, 5_000)
  await assert.rejects(httpJson({ port, path: "/health", timeoutMs: 200 }))
  assert.deepEqual(await readFile(configPath), staleBytes)
  const afterCrashIdentity = await lstat(configPath)
  assert.equal(afterCrashIdentity.dev, staleIdentity.dev)
  assert.equal(afterCrashIdentity.ino, staleIdentity.ino)
  assert.doesNotMatch(crashed.stdout, /Ready:/)

  const retry = await runBuiltCliAsync(args, { environment })
  assert.equal(retry.status, 0, retry.stderr)
  assert.match(retry.stdout, /Ready:/)
  const recovered = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    process: { pid: number }
  }
  assert.equal(recovered.outcome, "ready")
  assert.notEqual(recovered.process.pid, staleReady.process.pid)
  assert.deepEqual(deploymentPids(configPath), [recovered.process.pid])
  await stopVerifiedHttpProcess(recovered.process.pid, port)
  await waitFor(() => deploymentPids(configPath).length === 0)
})

test("HTTP activation source contains no child-adoption or pending-handoff path", async () => {
  for (const relative of [
    "apps/cli/deploy/http-runtime.ts",
    "apps/cli/deploy/channels.ts",
    "apps/cli/deploy/index.ts",
  ]) {
    const source = await readFile(path.join(root, relative), "utf8")
    assert.doesNotMatch(source, /\badopt(?:ion|ed|ing)?\b|pending[-_ ]handoff/i)
  }
})

test("SIGTERM after process tracking leaves no orphan and a retry reaches ready", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-http-interrupted-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "interrupted-http")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const port = await freePort()
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "interrupted-http" })
  await addValidFinalGateAssets(packageDirectory)
  const baseEnvironment = httpCliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "interrupted-secret-sentinel" },
  })
  const args = [
    "deploy",
    packageDirectory,
    "--channel",
    "http",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Interrupted HTTP",
    "--port",
    String(port),
    "--yes",
  ]
  const interrupted = startBuiltCli(args, { environment: baseEnvironment })
  t.after(async () => {
    for (const pid of deploymentPids(configPath)) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        // The exact test-owned worker already exited.
      }
    }
  })
  await waitFor(async () => {
    try {
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        code?: string
        process?: { pid?: number; activationState?: string }
      }
      return Boolean(
        config.code !== "http_final_verification_pending" &&
        config.process?.pid &&
        config.process.activationState === "authorized",
      )
    } catch {
      return false
    }
  })
  assert.ok(interrupted.child.pid)
  process.kill(interrupted.child.pid, "SIGTERM")
  const interruptedResult = await interrupted.completion
  assert.equal(interruptedResult.status, 1, interruptedResult.stderr)
  assert.match(interruptedResult.stderr, /interrupted/i)
  await waitFor(() => deploymentPids(configPath).length === 0)
  const failedConfig = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    code: string
    process?: unknown
  }
  assert.equal(failedConfig.outcome, "failed")
  assert.equal(failedConfig.code, "deploy_interrupted")
  assert.equal(failedConfig.process, undefined)

  const retry = await runBuiltCliAsync(args, { environment: baseEnvironment })
  assert.equal(retry.status, 0, retry.stderr)
  const readyConfig = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    process: { pid: number }
  }
  assert.equal(readyConfig.outcome, "ready")
  assert.deepEqual(deploymentPids(configPath), [readyConfig.process.pid])
  await stopVerifiedHttpProcess(readyConfig.process.pid, port)
  await waitFor(() => deploymentPids(configPath).length === 0)
})

test("DingTalk provider reconciliation uses exact JSON codes and remains pending after readback", async (t) => {
  const cases = [
    {
      mode: "success" as const,
      status: 2,
      commands: ["+list", "+create", "+get"],
      providerExpected: true,
    },
    {
      mode: "conflict" as const,
      status: 2,
      commands: ["+list", "+create", "+list", "+get"],
      providerExpected: true,
    },
    {
      mode: "create-invalid" as const,
      status: 2,
      commands: ["+list", "+create"],
      providerExpected: false,
    },
    {
      mode: "create-get-malformed" as const,
      status: 2,
      commands: ["+list", "+create", "+get"],
      providerExpected: false,
    },
    ...([
      "create-stderr-conflict",
      "create-stderr-malformed-code",
      "create-stderr-malformed",
      "create-stderr-oversized",
    ] as const).map((mode) => ({
      mode,
      status: 2,
      commands: ["+list", "+create"],
      providerExpected: false,
    })),
    {
      mode: "arbitrary" as const,
      status: 2,
      commands: ["+list", "+create"],
      providerExpected: false,
    },
    {
      mode: "ambiguous" as const,
      status: 2,
      commands: ["+list"],
      providerExpected: false,
    },
    {
      mode: "malformed" as const,
      status: 2,
      commands: ["+list"],
      providerExpected: false,
    },
    ...(["list-one-get-malformed", "list-one-get-conflict"] as const).map(
      (mode) => ({
        mode,
        status: 2,
        commands: ["+list", "+get"],
        providerExpected: false,
      }),
    ),
  ]

  for (const fixture of cases) {
    await t.test(fixture.mode, async (subtest) => {
      const temporary = await isolatedRoot(subtest, "deploy-dingtalk-provider-")
      const home = path.join(temporary, "home")
      const bin = path.join(temporary, "bin")
      const logPath = path.join(temporary, "dws.log")
      const providerState = path.join(temporary, "dws.state")
      const runtimeMarker = path.join(temporary, "runtime-effects.jsonl")
      const packageDirectory = path.join(temporary, "dingtalk-bound")
      const configPath = path.join(home, ".digital-employee", "config.json")
      await mkdir(home)
      await installVersionProbeWithRuntimeMarker(bin, runtimeMarker)
      await installFakeDws(bin, fixture.mode, logPath, providerState)
      await createEmployeePackage(packageDirectory, { name: "dingtalk-bound" })
      const args = [
        "deploy",
        packageDirectory,
        "--channel",
        "dingtalk",
        "--engine",
        "qoder",
        "--runtime",
        "agent-native",
        "--locale",
        "en",
        "--name",
        "Ding Bot",
        "--yes",
      ]
      const environment = cliEnvironment({
        home,
        bin,
        extra: { QODER_PERSONAL_ACCESS_TOKEN: "provider-host-secret-sentinel" },
      })
      const result = runBuiltCli(args, { environment })
      assert.equal(result.status, fixture.status, result.stderr)
      assert.doesNotMatch(
        `${result.stdout}${result.stderr}${await readFile(configPath, "utf8")}`,
        /provider-secret-sentinel|provider-host-secret-sentinel/,
      )
      if (fixture.status === 2) {
        assert.match(result.stderr, /Pending external action/)
        assert.match(result.stderr, /rerun deploy to resume/)
      } else {
        assert.match(result.stderr, /Deployment failed/)
      }
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Ready:|completed/i)
      await assert.rejects(access(runtimeMarker))
      const calls = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
      assert.deepEqual(calls.map((call) => call[1]), fixture.commands)
      for (const call of calls) {
        const format = call.indexOf("--format")
        assert.ok(format >= 0)
        assert.equal(call[format + 1], "json")
        assert.equal(call.some((value) => value.includes(packageDirectory)), false)
      }
      const creates = calls.filter((call) => call[1] === "+create")
      assert.ok(creates.length <= 1)
      for (const create of creates) assert.ok(create.includes("--yes"))
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        outcome: string
        code?: string
        package: { digest: string }
        provider?: { kind: string; resourceId: string }
        providerOperation?: { kind: string; operationId: string; name: string }
        endpoint?: unknown
        process?: unknown
        deployedAt?: unknown
      }
      assert.equal(
        config.outcome,
        fixture.status === 2 ? "pending_external_action" : "failed",
      )
      assert.equal(config.endpoint, undefined)
      assert.equal(config.process, undefined)
      assert.equal(config.deployedAt, undefined)
      if (fixture.providerExpected) {
        assert.deepEqual(config.provider, {
          kind: "dingtalk-app",
          resourceId: "app-verified-1",
          scope: testProviderScope(),
        })
      }

      if (
        fixture.mode === "create-invalid" ||
        fixture.mode === "create-get-malformed" ||
        fixture.mode === "create-stderr-conflict" ||
        fixture.mode === "create-stderr-malformed-code" ||
        fixture.mode === "create-stderr-malformed" ||
        fixture.mode === "create-stderr-oversized" ||
        fixture.mode === "arbitrary"
      ) {
        assert.equal(config.provider, undefined)
        assert.equal(config.providerOperation?.kind, "dingtalk-app-create")
        assert.match(config.providerOperation?.operationId ?? "", /^[a-f0-9]{32}$/)
        assert.equal(config.providerOperation?.name, "Ding Bot")
      }

      if (
        fixture.mode === "ambiguous" ||
        fixture.mode === "malformed" ||
        fixture.mode === "list-one-get-malformed" ||
        fixture.mode === "list-one-get-conflict"
      ) {
        assert.equal(
          calls.some((call) => ["+create", "+update", "+delete"].includes(call[1]!)),
          false,
        )
        assert.equal(config.provider, undefined)
        assert.equal(config.providerOperation, undefined)
      }

      if (fixture.mode === "create-invalid") {
        const operationId = config.providerOperation?.operationId
        const replay = runBuiltCli(args, { environment })
        assert.equal(replay.status, 2, replay.stderr)
        const replayCalls = (await readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
        assert.deepEqual(
          replayCalls.slice(calls.length).map((call) => call[1]),
          ["+list"],
        )
        assert.equal(
          replayCalls.filter((call) => call[1] === "+create").length,
          1,
        )

        await installFakeDws(
          bin,
          "list-one-get-malformed",
          logPath,
          providerState,
        )
        const exactFailureReplay = runBuiltCli(args, { environment })
        assert.equal(exactFailureReplay.status, 2, exactFailureReplay.stderr)
        assert.match(exactFailureReplay.stderr, /Pending external action/)
        const exactFailureCalls = (await readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
        assert.deepEqual(
          exactFailureCalls.slice(replayCalls.length).map((call) => call[1]),
          ["+list", "+get"],
        )
        assert.equal(
          exactFailureCalls.filter((call) => call[1] === "+create").length,
          1,
        )
        const exactFailureConfig = JSON.parse(
          await readFile(configPath, "utf8"),
        ) as {
          provider?: unknown
          providerOperation?: { operationId: string }
        }
        assert.equal(exactFailureConfig.provider, undefined)
        assert.equal(exactFailureConfig.providerOperation?.operationId, operationId)

        await installFakeDws(
          bin,
          "list-one-get-conflict",
          logPath,
          providerState,
        )
        const conflictingReplay = runBuiltCli(args, { environment })
        assert.equal(conflictingReplay.status, 2, conflictingReplay.stderr)
        assert.match(conflictingReplay.stderr, /Pending external action/)
        const conflictingCalls = (await readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
        assert.deepEqual(
          conflictingCalls.slice(exactFailureCalls.length).map((call) => call[1]),
          ["+list", "+get"],
        )
        assert.equal(
          conflictingCalls.filter((call) => call[1] === "+create").length,
          1,
        )
        const conflictingConfig = JSON.parse(
          await readFile(configPath, "utf8"),
        ) as {
          provider?: unknown
          providerOperation?: { operationId: string }
        }
        assert.equal(conflictingConfig.provider, undefined)
        assert.equal(conflictingConfig.providerOperation?.operationId, operationId)

        await installFakeDws(bin, "ambiguous", logPath, providerState)
        const ambiguousReplay = runBuiltCli(args, { environment })
        assert.equal(ambiguousReplay.status, 2, ambiguousReplay.stderr)
        assert.match(ambiguousReplay.stderr, /Pending external action/)
        const ambiguousCalls = (await readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
        assert.deepEqual(
          ambiguousCalls.slice(conflictingCalls.length).map((call) => call[1]),
          ["+list"],
        )
        assert.equal(
          ambiguousCalls.filter((call) => call[1] === "+create").length,
          1,
        )
        let uncertainConfig = JSON.parse(
          await readFile(configPath, "utf8"),
        ) as {
          outcome: string
          code: string
          provider?: unknown
          providerOperation?: { operationId: string }
        }
        assert.equal(uncertainConfig.outcome, "pending_external_action")
        assert.equal(
          uncertainConfig.code,
          "dingtalk_provider_create_indeterminate",
        )
        assert.equal(uncertainConfig.provider, undefined)
        assert.equal(uncertainConfig.providerOperation?.operationId, operationId)

        await rename(path.join(bin, "dws"), path.join(bin, "dws.off"))
        const unavailableReplay = runBuiltCli(args, { environment })
        assert.equal(unavailableReplay.status, 2, unavailableReplay.stderr)
        assert.match(unavailableReplay.stderr, /Pending external action/)
        const unavailableCalls = (await readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
        assert.deepEqual(unavailableCalls, ambiguousCalls)
        assert.equal(
          unavailableCalls.filter((call) => call[1] === "+create").length,
          1,
        )
        uncertainConfig = JSON.parse(
          await readFile(configPath, "utf8"),
        ) as typeof uncertainConfig
        assert.equal(uncertainConfig.outcome, "pending_external_action")
        assert.equal(
          uncertainConfig.code,
          "dingtalk_provider_create_indeterminate",
        )
        assert.equal(uncertainConfig.provider, undefined)
        assert.equal(uncertainConfig.providerOperation?.operationId, operationId)
        assert.equal(
          unavailableCalls.some((call) => ["+update", "+delete"].includes(call[1]!)),
          false,
        )
        await assert.rejects(access(runtimeMarker))
      }

      if (fixture.mode === "success") {
        const callsBeforeReplay = calls.length
        const replay = runBuiltCli(args, { environment })
        assert.equal(replay.status, 2, replay.stderr)
        const replayCalls = (await readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
        assert.deepEqual(
          replayCalls.slice(callsBeforeReplay).map((call) => call[1]),
          ["+get"],
        )
        assert.equal(
          replayCalls.filter((call) => call[1] === "+create").length,
          1,
        )

        const knowledgePath = path.join(
          packageDirectory,
          "knowledge",
          "README.md",
        )
        await writeFile(
          knowledgePath,
          `${await readFile(knowledgePath, "utf8")}\nDigest generation two.\n`,
        )
        const nextDigest = await computeEmployeePackageDirectoryDigest(
          packageDirectory,
        )
        assert.notEqual(config.package.digest, nextDigest)
        const digestReplay = runBuiltCli(args, { environment })
        assert.equal(digestReplay.status, 2, digestReplay.stderr)
        const digestCalls = (await readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
        assert.deepEqual(
          digestCalls.slice(replayCalls.length).map((call) => call[1]),
          ["+get"],
        )
        assert.equal(
          digestCalls.filter((call) => call[1] === "+create").length,
          1,
        )
        const rebound = JSON.parse(await readFile(configPath, "utf8")) as {
          package: { digest: string }
          provider: { kind: string; resourceId: string }
          outcome: string
        }
        assert.equal(rebound.package.digest, nextDigest)
        assert.equal(rebound.outcome, "pending_external_action")
        assert.deepEqual(rebound.provider, {
          kind: "dingtalk-app",
          resourceId: "app-verified-1",
          scope: testProviderScope(),
        })
      }

      if (fixture.mode === "arbitrary") {
        const operationId = config.providerOperation?.operationId
        assert.match(operationId ?? "", /^[a-f0-9]{32}$/)
        assert.equal(
          (config as { code?: string }).code,
          "dingtalk_provider_error_permission_denied",
        )
        assert.match(result.stderr, /dingtalk_provider_error_permission_denied/)
        const uncertainReplay = runBuiltCli(args, { environment })
        assert.equal(uncertainReplay.status, 2, uncertainReplay.stderr)
        const uncertainCalls = (await readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
        assert.deepEqual(
          uncertainCalls.slice(calls.length).map((call) => call[1]),
          ["+list"],
        )
        assert.equal(
          uncertainCalls.filter((call) => call[1] === "+create").length,
          1,
        )
        const uncertainConfig = JSON.parse(
          await readFile(configPath, "utf8"),
        ) as { providerOperation?: { operationId: string } }
        assert.equal(uncertainConfig.providerOperation?.operationId, operationId)

        await writeFile(providerState, JSON.stringify({ name: "Ding Bot" }))
        await installFakeDws(bin, "conflict", logPath, providerState)
        const retry = runBuiltCli(args, { environment })
        assert.equal(retry.status, 2, retry.stderr)
        const retryCalls = (await readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
        assert.deepEqual(
          retryCalls.slice(uncertainCalls.length).map((call) => call[1]),
          ["+list", "+get"],
        )
        assert.equal(
          retryCalls.filter((call) => call[1] === "+create").length,
          1,
        )
        const retryConfig = JSON.parse(
          await readFile(configPath, "utf8"),
        ) as {
          provider?: { resourceId: string }
          providerOperation?: unknown
        }
        assert.equal(retryConfig.provider?.resourceId, "app-verified-1")
        assert.equal(retryConfig.providerOperation, undefined)
      }
    })
  }
})

test("DingTalk exact-name readback preserves UTF-8 split across provider chunks", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-split-utf8-")
  const bin = path.join(temporary, "bin")
  const logPath = path.join(temporary, "dws.log")
  const providerState = path.join(temporary, "dws.state")
  await installFakeDws(bin, "split-multibyte", logPath, providerState)
  const originalPath = process.env.PATH
  const identified: string[] = []
  process.env.PATH = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
    .join(path.delimiter)
  try {
    const result = await reconcileDingTalkApplication(
      { name: "钉钉机器人" },
      {
        beforeBoundary: () => {},
        onProviderIdentified: (provider) => {
          identified.push(provider.resourceId)
        },
      },
    )
    assert.deepEqual(result, {
      status: "verified",
      code: "dingtalk_app_verified",
      provider: {
        kind: "dingtalk-app",
        resourceId: "app-verified-1",
        scope: testProviderScope(),
      },
    })
    assert.deepEqual(identified, ["app-verified-1"])
    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    assert.deepEqual(calls.map((call) => call[1]), ["+list", "+get"])
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
})

test("DingTalk provider passes the explicit documented DWS profile and config allowlist", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-environment-")
  const bin = path.join(temporary, "bin")
  const capturePath = path.join(temporary, "dws-environment.json")
  await mkdir(bin)
  const executable = path.join(bin, "dws")
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
const keys = ["DWS_CLIENT_ID", "DWS_CLIENT_SECRET", "DWS_CONFIG_DIR", "DWS_DISABLE_KEYCHAIN", "DWS_KEYCHAIN_DIR", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]
fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args, environment: Object.fromEntries(keys.map((key) => [key, process.env[key]])) }) + "\\n")
const identity = ${JSON.stringify(DEFAULT_DWS_IDENTITY)}
if (args[0] === "profile" && args[1] === "list") {
  process.stdout.write(JSON.stringify({ success: true, currentProfile: identity.profile, profiles: [{ ...identity, corpName: "Fixture Corp", userName: "Fixture User", isPrimary: true, isCurrent: true, isOrgCurrent: true }] }) + "\\n")
} else if (args[0] === "--profile" && args[1] === identity.profile && args[2] === "devapp" && args[3] === "+list") {
  process.stdout.write(JSON.stringify({ apps: [], count: 0, hasMore: false }) + "\\n")
} else {
  process.exitCode = 9
}
`,
    { mode: 0o755 },
  )
  await chmod(executable, 0o755)
  const expected: Record<string, string> = {
    DWS_CLIENT_ID: "fixture-client-id",
    DWS_CLIENT_SECRET: "fixture-client-credential",
    DWS_CONFIG_DIR: path.join(temporary, "dws-config"),
    DWS_DISABLE_KEYCHAIN: "1",
    DWS_KEYCHAIN_DIR: path.join(temporary, "dws-keychain"),
    HTTPS_PROXY: "http://127.0.0.1:8080",
    NO_PROXY: "127.0.0.1,localhost",
    NODE_EXTRA_CA_CERTS: path.join(temporary, "enterprise-ca.pem"),
  }
  const original = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(expected)) {
    original.set(key, process.env[key])
    process.env[key] = value
  }
  original.set("PATH", process.env.PATH)
  process.env.PATH = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
    .join(path.delimiter)
  try {
    const result = await reconcileDingTalkApplication(
      { name: "Environment Bot" },
      { beforeBoundary: () => {} },
    )
    assert.deepEqual(result, {
      status: "confirmation_required",
      code: "dingtalk_provider_confirmation_required",
    })
    const captures = (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        args: string[]
        environment: Record<string, string>
      })
    assert.deepEqual(captures.map(({ args }) => args), [
      ["profile", "list", "--format", "json"],
      [
        "--profile",
        DEFAULT_DWS_IDENTITY.profile,
        "devapp",
        "+list",
        "--name",
        "Environment Bot",
        "--page-size",
        "20",
        "--format",
        "json",
      ],
    ])
    for (const capture of captures) {
      assert.deepEqual(capture.environment, expected)
    }
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("DingTalk provider scope discovery fails closed before devapp effects", async (t) => {
  const original = new Map<string, string | undefined>()
  for (const key of ["PATH", "DWS_CLIENT_ID", "DWS_CLIENT_SECRET"]) {
    original.set(key, process.env[key])
  }
  const validProfile = {
    profile: DEFAULT_DWS_IDENTITY.profile,
    corpId: DEFAULT_DWS_IDENTITY.corpId,
    corpName: "Fixture Corp",
    userId: DEFAULT_DWS_IDENTITY.userId,
    userName: "Fixture User",
    clientId: DEFAULT_DWS_IDENTITY.clientId,
    isPrimary: true,
    isCurrent: true,
    isOrgCurrent: true,
  }
  const fixtures: Array<{
    name: string
    identity?: Record<string, unknown>
    clientId?: string
    clientSecret?: string
    code: string
    rawCalls: number
  }> = [
    {
      name: "half configured client id",
      clientId: "env-client-a",
      clientSecret: undefined,
      code: "dingtalk_provider_scope_invalid",
      rawCalls: 0,
    },
    {
      name: "half configured client secret",
      clientId: undefined,
      clientSecret: "secret-a",
      code: "dingtalk_provider_scope_invalid",
      rawCalls: 0,
    },
    {
      name: "profile command returns an invalid identity document",
      identity: { profileResponse: { success: false, profiles: [] } },
      code: "dingtalk_provider_scope_invalid",
      rawCalls: 1,
    },
    {
      name: "profile command is unavailable",
      identity: { profileUnavailable: true },
      code: "dingtalk_provider_scope_unavailable",
      rawCalls: 1,
    },
    {
      name: "profile has no current identity",
      identity: {
        profileResponse: {
          success: true,
          currentProfile: validProfile.profile,
          profiles: [{ ...validProfile, isCurrent: false }],
        },
      },
      code: "dingtalk_provider_scope_invalid",
      rawCalls: 1,
    },
    {
      name: "profile has multiple current identities",
      identity: {
        profileResponse: {
          success: true,
          currentProfile: validProfile.profile,
          profiles: [
            validProfile,
            {
              ...validProfile,
              profile: "corp-b:user-b",
              corpId: "corp-b",
              userId: "user-b",
              clientId: "profile-client-b",
            },
          ],
        },
      },
      code: "dingtalk_provider_scope_invalid",
      rawCalls: 1,
    },
    {
      name: "top-level current profile differs from selected identity",
      identity: {
        profileResponse: {
          success: true,
          currentProfile: "corp-b:user-b",
          profiles: [validProfile],
        },
      },
      code: "dingtalk_provider_scope_invalid",
      rawCalls: 1,
    },
    {
      name: "profile selector differs from corp and user identity",
      identity: {
        profileResponse: {
          success: true,
          currentProfile: "named-profile",
          profiles: [{ ...validProfile, profile: "named-profile" }],
        },
      },
      code: "dingtalk_provider_scope_invalid",
      rawCalls: 1,
    },
    {
      name: "profile corp identity is missing",
      identity: {
        profileResponse: {
          success: true,
          currentProfile: validProfile.profile,
          profiles: [{ ...validProfile, corpId: undefined }],
        },
      },
      code: "dingtalk_provider_scope_invalid",
      rawCalls: 1,
    },
    {
      name: "profile user identity is missing",
      identity: {
        profileResponse: {
          success: true,
          currentProfile: validProfile.profile,
          profiles: [{ ...validProfile, userId: undefined }],
        },
      },
      code: "dingtalk_provider_scope_invalid",
      rawCalls: 1,
    },
    {
      name: "selected profile has a duplicate non-current selector",
      identity: {
        profileResponse: {
          success: true,
          currentProfile: validProfile.profile,
          profiles: [validProfile, { ...validProfile, isCurrent: false }],
        },
      },
      code: "dingtalk_provider_scope_invalid",
      rawCalls: 1,
    },
    {
      name: "profile client identity is missing",
      identity: {
        profileResponse: {
          success: true,
          currentProfile: validProfile.profile,
          profiles: [{ ...validProfile, clientId: undefined }],
        },
      },
      code: "dingtalk_provider_scope_invalid",
      rawCalls: 1,
    },
  ]
  try {
    for (const fixture of fixtures) {
      await t.test(fixture.name, async (subtest) => {
        const temporary = await isolatedRoot(subtest, "deploy-dingtalk-scope-")
        const bin = path.join(temporary, "bin")
        const logPath = path.join(temporary, "dws.log")
        const statePath = path.join(temporary, "dws.state")
        await installFakeDws(bin, "success", logPath, statePath)
        if (fixture.identity) {
          await writeFile(
            `${statePath}.identity.json`,
            JSON.stringify({
              current: DEFAULT_DWS_IDENTITY,
              ...fixture.identity,
            }),
          )
        }
        process.env.PATH = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
          .join(path.delimiter)
        if (fixture.clientId === undefined) delete process.env.DWS_CLIENT_ID
        else process.env.DWS_CLIENT_ID = fixture.clientId
        if (fixture.clientSecret === undefined) delete process.env.DWS_CLIENT_SECRET
        else process.env.DWS_CLIENT_SECRET = fixture.clientSecret
        let createAttempts = 0
        let identified = 0
        const result = await reconcileDingTalkApplication(
          { name: "Scope Bot" },
          {
            allowWrite: true,
            beforeBoundary: () => {},
            onCreateAttempt: () => {
              createAttempts += 1
            },
            onProviderIdentified: () => {
              identified += 1
            },
          },
        )
        assert.deepEqual(result, {
          status: "failed",
          code: fixture.code,
          preserveState: true,
        })
        assert.equal(createAttempts, 0)
        assert.equal(identified, 0)
        await assert.rejects(access(logPath))
        if (fixture.rawCalls === 0) {
          await assert.rejects(access(`${logPath}.raw`))
        } else {
          const rawCalls = await readDwsRawCalls(logPath)
          assert.equal(rawCalls.length, fixture.rawCalls)
          assert.equal(rawCalls.some((call) => call.includes("devapp")), false)
          assert.equal(rawCalls.some((call) => call.includes("+create")), false)
        }
      })
    }
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("DingTalk abort during a boundary check never spawns DWS", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-boundary-abort-")
  const bin = path.join(temporary, "bin")
  const marker = path.join(temporary, "dws-called")
  await installObservableDws(bin, marker)
  const originalPath = process.env.PATH
  const controller = new AbortController()
  process.env.PATH = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
    .join(path.delimiter)
  try {
    const result = await reconcileDingTalkApplication(
      { name: "Boundary Abort" },
      {
        signal: controller.signal,
        beforeBoundary: async () => {
          controller.abort()
          await delay(10)
        },
      },
    )
    assert.deepEqual(result, {
      status: "failed",
      code: "deploy_interrupted",
    })
    await assert.rejects(access(marker))
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
})

test("DingTalk abort with a durable operation stays pending without spawning DWS", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-durable-abort-")
  const bin = path.join(temporary, "bin")
  const marker = path.join(temporary, "dws-called")
  await installObservableDws(bin, marker)
  const originalPath = process.env.PATH
  process.env.PATH = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
    .join(path.delimiter)
  const controller = new AbortController()
  controller.abort()
  try {
    const result = await deployDingTalk({
      schemaVersion: "deploy-state.v1",
      locale: "en",
      channel: "dingtalk",
      botName: "Durable Abort",
      engine: "qoder",
      runtime: "agent-native",
      outcome: "pending_external_action",
      providerOperation: {
        kind: "dingtalk-app-create",
        operationId: "a".repeat(32),
        name: "Durable Abort",
        attemptedAt: "2026-08-13T12:00:00.000Z",
        scope: testProviderScope(),
      },
      updatedAt: "2026-08-13T12:00:01.000Z",
    }, {
      signal: controller.signal,
      assertLockOwned: () => {},
    })
    assert.equal(result.outcome, "pending_external_action")
    assert.equal(result.code, "deploy_interrupted")
    assert.equal(result.preserveState, true)
    await assert.rejects(access(marker))
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
})

test("DingTalk provider scope fences durable operations and providers across identity drift", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-scope-fence-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const logPath = path.join(temporary, "dws.log")
  const providerState = path.join(temporary, "dws.state")
  const identityPath = `${providerState}.identity.json`
  const runtimeMarker = path.join(temporary, "runtime-effects.jsonl")
  const packageDirectory = path.join(temporary, "scope-fenced")
  const configPath = path.join(home, ".digital-employee", "config.json")
  const scopeB = {
    profile: "corp-b:user-b",
    corpId: "corp-b",
    userId: "user-b",
    clientId: "profile-client-b",
  }
  await mkdir(home)
  await installVersionProbeWithRuntimeMarker(bin, runtimeMarker)
  await installFakeDws(bin, "success", logPath, providerState)
  await writeFile(identityPath, JSON.stringify({
    current: DEFAULT_DWS_IDENTITY,
    next: scopeB,
    switchAfterCreate: true,
  }))
  await createEmployeePackage(packageDirectory, { name: "scope-fenced" })
  const baseExtra = {
    QODER_PERSONAL_ACCESS_TOKEN: "scope-host-secret-sentinel",
    DWS_CLIENT_ID: "env-client-a",
    DWS_CLIENT_SECRET: "scope-client-secret-v1",
    DWS_CONFIG_DIR: path.join(temporary, "config-storage-a"),
    DWS_KEYCHAIN_DIR: path.join(temporary, "keychain-storage-a"),
  }
  const args = [
    "deploy",
    packageDirectory,
    "--channel",
    "dingtalk",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Scope Bot",
    "--yes",
  ]
  const initial = runBuiltCli(args, {
    environment: cliEnvironment({ home, bin, extra: baseExtra }),
  })
  assert.equal(initial.status, 2, initial.stderr)
  assert.match(initial.stderr, /dingtalk_provider_scope_mismatch/)
  let config = JSON.parse(await readFile(configPath, "utf8")) as {
    provider?: { scope: ReturnType<typeof testProviderScope> }
    providerOperation?: {
      operationId: string
      scope: ReturnType<typeof testProviderScope>
    }
  }
  assert.equal(config.provider, undefined)
  assert.match(config.providerOperation?.operationId ?? "", /^[a-f0-9]{32}$/)
  const expectedScope = testProviderScope(
    DEFAULT_DWS_IDENTITY,
    baseExtra.DWS_CLIENT_ID,
  )
  assert.equal(expectedScope.digest, PROVIDER_SCOPE_GOLDEN)
  assert.deepEqual(config.providerOperation?.scope, expectedScope)
  let calls = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
  assert.deepEqual(calls.map((call) => call[1]), ["+list", "+create", "+get"])
  assert.equal(calls.filter((call) => call[1] === "+create").length, 1)
  await assert.rejects(access(runtimeMarker))

  const operationBytes = await readFile(configPath)
  const operationPersisted = operationBytes.toString("utf8")
  for (const secretOrIdentity of [
    DEFAULT_DWS_IDENTITY.corpId,
    DEFAULT_DWS_IDENTITY.userId,
    DEFAULT_DWS_IDENTITY.clientId,
    baseExtra.DWS_CLIENT_ID,
    baseExtra.DWS_CLIENT_SECRET,
    baseExtra.DWS_CONFIG_DIR,
    baseExtra.DWS_KEYCHAIN_DIR,
  ]) {
    assert.equal(operationPersisted.includes(secretOrIdentity), false)
  }
  const operationIdentity = await lstat(configPath)
  const rawBeforeOperationUnavailable = await readDwsRawCalls(logPath)
  await writeFile(identityPath, JSON.stringify({
    current: DEFAULT_DWS_IDENTITY,
    profileUnavailable: true,
  }))
  const unavailableOperation = runBuiltCli(args, {
    environment: cliEnvironment({ home, bin, extra: baseExtra }),
  })
  assert.equal(unavailableOperation.status, 2, unavailableOperation.stderr)
  assert.match(unavailableOperation.stderr, /dingtalk_provider_scope_unavailable/)
  assert.deepEqual(await readFile(configPath), operationBytes)
  const unavailableOperationIdentity = await lstat(configPath)
  assert.equal(unavailableOperationIdentity.dev, operationIdentity.dev)
  assert.equal(unavailableOperationIdentity.ino, operationIdentity.ino)
  const rawAfterOperationUnavailable = await readDwsRawCalls(logPath)
  assert.equal(
    rawAfterOperationUnavailable
      .slice(rawBeforeOperationUnavailable.length)
      .some((call) => call.includes("devapp")),
    false,
  )
  const driftCases = [
    {
      identity: {
        ...DEFAULT_DWS_IDENTITY,
        profile: "corp-b:user-a",
        corpId: "corp-b",
      },
      extra: {},
    },
    {
      identity: {
        ...DEFAULT_DWS_IDENTITY,
        profile: "corp-a:user-b",
        userId: "user-b",
      },
      extra: {},
    },
    {
      identity: {
        ...DEFAULT_DWS_IDENTITY,
        clientId: "profile-client-b",
      },
      extra: {},
    },
    {
      identity: DEFAULT_DWS_IDENTITY,
      extra: { DWS_CLIENT_ID: "env-client-b" },
    },
  ]
  for (const drift of driftCases) {
    const rawBefore = await readDwsRawCalls(logPath)
    await writeFile(identityPath, JSON.stringify({ current: drift.identity }))
    const replay = runBuiltCli(args, {
      environment: cliEnvironment({
        home,
        bin,
        extra: { ...baseExtra, ...drift.extra },
      }),
    })
    assert.equal(replay.status, 2, replay.stderr)
    assert.match(replay.stderr, /dingtalk_provider_scope_mismatch/)
    assert.deepEqual(await readFile(configPath), operationBytes)
    const after = await lstat(configPath)
    assert.equal(after.dev, operationIdentity.dev)
    assert.equal(after.ino, operationIdentity.ino)
    const rawAfter = await readDwsRawCalls(logPath)
    const addedRaw = rawAfter.slice(rawBefore.length)
    assert.equal(addedRaw.some((call) => call.includes("devapp")), false)
    assert.equal(addedRaw.some((call) => call.includes("+create")), false)
    const unchangedCalls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    assert.deepEqual(unchangedCalls, calls)
  }

  await writeFile(identityPath, JSON.stringify({ current: DEFAULT_DWS_IDENTITY }))
  await installFakeDws(bin, "conflict", logPath, providerState)
  const recoveryExtra = {
    ...baseExtra,
    DWS_CLIENT_SECRET: "scope-client-secret-v2",
    DWS_CONFIG_DIR: path.join(temporary, "config-storage-b"),
    DWS_KEYCHAIN_DIR: path.join(temporary, "keychain-storage-b"),
  }
  const recovered = runBuiltCli(args, {
    environment: cliEnvironment({ home, bin, extra: recoveryExtra }),
  })
  assert.equal(recovered.status, 2, recovered.stderr)
  calls = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
  assert.deepEqual(calls.slice(-2).map((call) => call[1]), ["+list", "+get"])
  assert.equal(calls.filter((call) => call[1] === "+create").length, 1)
  config = JSON.parse(await readFile(configPath, "utf8")) as typeof config
  assert.equal(config.providerOperation, undefined)
  assert.deepEqual(config.provider?.scope, expectedScope)
  const persisted = await readFile(configPath, "utf8")
  for (const secretOrIdentity of [
    DEFAULT_DWS_IDENTITY.corpId,
    DEFAULT_DWS_IDENTITY.userId,
    DEFAULT_DWS_IDENTITY.clientId,
    baseExtra.DWS_CLIENT_ID,
    baseExtra.DWS_CLIENT_SECRET,
    recoveryExtra.DWS_CLIENT_SECRET,
    baseExtra.DWS_CONFIG_DIR,
    recoveryExtra.DWS_CONFIG_DIR,
    baseExtra.DWS_KEYCHAIN_DIR,
    recoveryExtra.DWS_KEYCHAIN_DIR,
  ]) {
    assert.equal(persisted.includes(secretOrIdentity), false)
  }
  const providerBytes = await readFile(configPath)
  const providerIdentity = await lstat(configPath)

  const rawBeforeProviderUnavailable = await readDwsRawCalls(logPath)
  await writeFile(identityPath, JSON.stringify({
    current: DEFAULT_DWS_IDENTITY,
    profileUnavailable: true,
  }))
  const unavailableProvider = runBuiltCli(args, {
    environment: cliEnvironment({ home, bin, extra: recoveryExtra }),
  })
  assert.equal(unavailableProvider.status, 2, unavailableProvider.stderr)
  assert.match(unavailableProvider.stderr, /dingtalk_provider_scope_unavailable/)
  assert.deepEqual(await readFile(configPath), providerBytes)
  const unavailableProviderIdentity = await lstat(configPath)
  assert.equal(unavailableProviderIdentity.dev, providerIdentity.dev)
  assert.equal(unavailableProviderIdentity.ino, providerIdentity.ino)
  const rawAfterProviderUnavailable = await readDwsRawCalls(logPath)
  assert.equal(
    rawAfterProviderUnavailable
      .slice(rawBeforeProviderUnavailable.length)
      .some((call) => call.includes("devapp")),
    false,
  )

  await writeFile(identityPath, JSON.stringify({ current: scopeB }))
  const rawBeforeProviderMismatch = await readDwsRawCalls(logPath)
  const wrongProviderScope = runBuiltCli(args, {
    environment: cliEnvironment({
      home,
      bin,
      extra: {
        ...recoveryExtra,
        DWS_CLIENT_ID: "env-client-b",
      },
    }),
  })
  assert.equal(wrongProviderScope.status, 2, wrongProviderScope.stderr)
  assert.match(wrongProviderScope.stderr, /dingtalk_provider_scope_mismatch/)
  assert.deepEqual(await readFile(configPath), providerBytes)
  const providerAfter = await lstat(configPath)
  assert.equal(providerAfter.dev, providerIdentity.dev)
  assert.equal(providerAfter.ino, providerIdentity.ino)
  const rawAfterProviderMismatch = await readDwsRawCalls(logPath)
  const providerMismatchRaw = rawAfterProviderMismatch.slice(
    rawBeforeProviderMismatch.length,
  )
  assert.equal(providerMismatchRaw.some((call) => call.includes("devapp")), false)
  const finalCalls = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
  assert.deepEqual(finalCalls, calls)
  const rawCalls = await readDwsRawCalls(logPath)
  assertPinnedDevappCalls(rawCalls, DEFAULT_DWS_IDENTITY.profile)
  assert.equal(rawCalls.filter((call) => call.includes("+create")).length, 1)
})

test("DingTalk provider revalidates scope before persisting a create fence", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-precreate-scope-")
  const bin = path.join(temporary, "bin")
  const logPath = path.join(temporary, "dws.log")
  const statePath = path.join(temporary, "dws.state")
  await installFakeDws(bin, "success", logPath, statePath)
  await writeFile(`${statePath}.identity.json`, JSON.stringify({
    current: DEFAULT_DWS_IDENTITY,
    next: {
      profile: "corp-b:user-b",
      corpId: "corp-b",
      userId: "user-b",
      clientId: "profile-client-b",
    },
    switchAfterList: true,
  }))
  const original = new Map<string, string | undefined>()
  for (const key of ["PATH", "DWS_CLIENT_ID", "DWS_CLIENT_SECRET"]) {
    original.set(key, process.env[key])
  }
  let operations = 0
  process.env.PATH = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
    .join(path.delimiter)
  delete process.env.DWS_CLIENT_ID
  delete process.env.DWS_CLIENT_SECRET
  try {
    const result = await reconcileDingTalkApplication(
      { name: "Scope Bot" },
      {
        allowWrite: true,
        beforeBoundary: () => {},
        onCreateAttempt: () => {
          operations += 1
        },
        onProviderIdentified: () => {
          throw new Error("scope_drift_must_not_identify")
        },
      },
    )
    assert.deepEqual(result, {
      status: "failed",
      code: "dingtalk_provider_scope_mismatch",
      preserveState: true,
    })
    assert.equal(operations, 0)
    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    assert.deepEqual(calls.map((call) => call[1]), ["+list"])
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("DingTalk provider revalidates scope after persisting a create fence", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-post-fence-scope-")
  const bin = path.join(temporary, "bin")
  const logPath = path.join(temporary, "dws.log")
  const statePath = path.join(temporary, "dws.state")
  const identityPath = `${statePath}.identity.json`
  const scopeB = {
    profile: "corp-b:user-b",
    corpId: "corp-b",
    userId: "user-b",
    clientId: "profile-client-b",
  }
  await installFakeDws(bin, "success", logPath, statePath)
  await writeFile(identityPath, JSON.stringify({ current: DEFAULT_DWS_IDENTITY }))
  const original = new Map<string, string | undefined>()
  for (const key of ["PATH", "DWS_CLIENT_ID", "DWS_CLIENT_SECRET"]) {
    original.set(key, process.env[key])
  }
  process.env.PATH = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
    .join(path.delimiter)
  delete process.env.DWS_CLIENT_ID
  delete process.env.DWS_CLIENT_SECRET
  const operations: DeployProviderOperation[] = []
  try {
    const result = await reconcileDingTalkApplication(
      { name: "Scope Bot" },
      {
        allowWrite: true,
        beforeBoundary: () => {},
        onCreateAttempt: async (operation) => {
          operations.push(operation)
          await writeFile(identityPath, JSON.stringify({ current: scopeB }))
        },
        onProviderIdentified: () => {
          throw new Error("scope_drift_must_not_identify")
        },
      },
    )
    assert.deepEqual(result, {
      status: "indeterminate",
      code: "dingtalk_provider_scope_mismatch",
      preserveState: true,
    })
    assert.equal(operations.length, 1)
    assert.deepEqual(operations[0]!.scope, testProviderScope())
    const rawCalls = await readDwsRawCalls(logPath)
    assert.equal(rawCalls.some((call) => call.includes("+create")), false)
    assert.equal(rawCalls.filter((call) => call.includes("devapp")).length, 1)
    assertPinnedDevappCalls(rawCalls, DEFAULT_DWS_IDENTITY.profile)
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("DingTalk provider preserves a durable fence when scope drifts after an indeterminate create", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-post-create-scope-")
  const bin = path.join(temporary, "bin")
  const logPath = path.join(temporary, "dws.log")
  const statePath = path.join(temporary, "dws.state")
  const identityPath = `${statePath}.identity.json`
  const scopeB = {
    profile: "corp-b:user-b",
    corpId: "corp-b",
    userId: "user-b",
    clientId: "profile-client-b",
  }
  await installFakeDws(bin, "create-invalid", logPath, statePath)
  await writeFile(identityPath, JSON.stringify({
    current: DEFAULT_DWS_IDENTITY,
    next: scopeB,
    switchAfterCreate: true,
  }))
  const original = new Map<string, string | undefined>()
  for (const key of ["PATH", "DWS_CLIENT_ID", "DWS_CLIENT_SECRET"]) {
    original.set(key, process.env[key])
  }
  process.env.PATH = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
    .join(path.delimiter)
  delete process.env.DWS_CLIENT_ID
  delete process.env.DWS_CLIENT_SECRET
  const operations: DeployProviderOperation[] = []
  let identified = 0
  try {
    const result = await reconcileDingTalkApplication(
      { name: "Scope Bot" },
      {
        allowWrite: true,
        beforeBoundary: () => {},
        onCreateAttempt: (operation) => {
          operations.push(operation)
        },
        onProviderIdentified: () => {
          identified += 1
        },
      },
    )
    assert.deepEqual(result, {
      status: "indeterminate",
      code: "dingtalk_provider_scope_mismatch",
      preserveState: true,
    })
    assert.equal(operations.length, 1)
    assert.deepEqual(operations[0]!.scope, testProviderScope())
    assert.equal(identified, 0)
    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    assert.deepEqual(calls.map((call) => call[1]), ["+list", "+create"])
    const rawCalls = await readDwsRawCalls(logPath)
    assertPinnedDevappCalls(
      rawCalls.filter((call) => call.includes("devapp")),
      DEFAULT_DWS_IDENTITY.profile,
    )
    assert.equal(rawCalls.filter((call) => call.includes("+create")).length, 1)
    const createIndex = rawCalls.findIndex((call) => call.includes("+create"))
    assert.ok(createIndex >= 0)
    assert.deepEqual(rawCalls.slice(createIndex + 1), [
      ["profile", "list", "--format", "json"],
    ])
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("DingTalk provider reaps same-group descendants after a successful command", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-success-orphan-")
  const bin = path.join(temporary, "bin")
  const logPath = path.join(temporary, "dws.log")
  const statePath = path.join(temporary, "dws.state")
  const orphanPath = `${statePath}.orphan.json`
  await installFakeDws(bin, "success-orphan", logPath, statePath)
  const originalPath = process.env.PATH
  process.env.PATH = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
    .join(path.delimiter)
  const identified: string[] = []
  let orphanPid: number | undefined
  t.after(() => {
    if (!orphanPid) return
    try {
      process.kill(orphanPid, "SIGKILL")
    } catch {
      // The production cleanup already reaped the exact test-owned process.
    }
  })
  try {
    const result = await reconcileDingTalkApplication(
      { name: "Scope Bot" },
      {
        allowWrite: true,
        beforeBoundary: () => {},
        onCreateAttempt: () => {},
        onProviderIdentified: (provider) => {
          identified.push(provider.resourceId)
        },
      },
    )
    assert.equal(result.status, "verified")
    assert.deepEqual(identified, ["app-verified-1"])
    const orphan = JSON.parse(await readFile(orphanPath, "utf8")) as {
      pid: number
    }
    orphanPid = orphan.pid
    await waitFor(() => {
      try {
        process.kill(orphan.pid, 0)
        return false
      } catch {
        return true
      }
    })
    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    assert.deepEqual(calls.map((call) => call[1]), ["+list", "+create", "+get"])
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
})

test("DingTalk reconciliation exhausts bounded cursor pages before deciding identity", async (t) => {
  const fixtures = [
    {
      scenario: "page-two" as const,
      code: "dingtalk_app_verified",
      status: "verified",
      listCalls: 2,
      cursorValues: [undefined, "cursor-1"],
      identified: ["app-page-2"],
    },
    {
      scenario: "none" as const,
      code: "dingtalk_provider_create_indeterminate",
      status: "indeterminate",
      listCalls: 2,
      cursorValues: [undefined, "cursor-1"],
      identified: [],
      existingOperation: true,
    },
    {
      scenario: "ambiguous" as const,
      code: "dingtalk_provider_identity_ambiguous",
      status: "indeterminate",
      listCalls: 2,
      cursorValues: [undefined, "cursor-1"],
      identified: [],
    },
    ...([
      "missing-has-more",
      "typed-has-more",
      "typed-cursor",
      "conflicting-has-more",
      "conflicting-cursor",
      "missing-cursor",
      "empty-cursor",
      "unexpected-cursor",
      "oversized-cursor",
    ] as const).map((scenario) => ({
      scenario,
      code: "dingtalk_provider_list_invalid",
      status: "indeterminate",
      listCalls: 1,
      cursorValues: [undefined],
      identified: [] as string[],
    })),
    {
      scenario: "oversized-page" as const,
      code: "dingtalk_provider_pagination_limit",
      status: "indeterminate",
      listCalls: 1,
      cursorValues: [undefined],
      identified: [],
    },
    {
      scenario: "malformed-page-one" as const,
      code: "dingtalk_provider_invalid_json",
      status: "indeterminate",
      listCalls: 1,
      cursorValues: [undefined],
      identified: [],
    },
    {
      scenario: "unavailable-page-one" as const,
      code: "dingtalk_provider_error_provider_unavailable",
      status: "indeterminate",
      listCalls: 1,
      cursorValues: [undefined],
      identified: [],
    },
    {
      scenario: "malformed-page-two" as const,
      code: "dingtalk_provider_invalid_json",
      status: "indeterminate",
      listCalls: 2,
      cursorValues: [undefined, "cursor-1"],
      identified: [],
    },
    {
      scenario: "unavailable-page-two" as const,
      code: "dingtalk_provider_error_provider_unavailable",
      status: "indeterminate",
      listCalls: 2,
      cursorValues: [undefined, "cursor-1"],
      identified: [],
    },
    {
      scenario: "loop" as const,
      code: "dingtalk_provider_pagination_invalid",
      status: "indeterminate",
      listCalls: 2,
      cursorValues: [undefined, "cursor-loop"],
      identified: [],
    },
    {
      scenario: "cycle" as const,
      code: "dingtalk_provider_pagination_invalid",
      status: "indeterminate",
      listCalls: 3,
      cursorValues: [undefined, "cursor-a", "cursor-b"],
      identified: [],
    },
    {
      scenario: "limit" as const,
      code: "dingtalk_provider_pagination_limit",
      status: "indeterminate",
      listCalls: 20,
      cursorValues: [
        undefined,
        ...Array.from({ length: 19 }, (_, index) => `cursor-${index + 1}`),
      ],
      identified: [],
    },
  ]
  for (const fixture of fixtures) {
    await t.test(fixture.scenario, async (subtest) => {
      const temporary = await isolatedRoot(
        subtest,
        `deploy-dingtalk-pages-${fixture.scenario}-`,
      )
      const bin = path.join(temporary, "bin")
      const logPath = path.join(temporary, "dws.log")
      await installPaginatedDws(bin, fixture.scenario, logPath)
      const originalPath = process.env.PATH
      const identified: string[] = []
      let boundaries = 0
      process.env.PATH = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
        .join(path.delimiter)
      try {
        const result = await reconcileDingTalkApplication(
          { name: "Ding Bot" },
          {
            allowWrite: true,
            ...("existingOperation" in fixture && fixture.existingOperation
              ? {
                  existingOperation: {
                    kind: "dingtalk-app-create" as const,
                    operationId: "1".repeat(32),
                    name: "Ding Bot",
                    attemptedAt: new Date(0).toISOString(),
                    scope: testProviderScope(),
                  },
                }
              : {}),
            beforeBoundary: () => {
              boundaries += 1
            },
            onCreateAttempt: () => {
              throw new Error("pagination_must_not_create")
            },
            onProviderIdentified: (provider) => {
              identified.push(provider.resourceId)
            },
          },
        )
        assert.equal(result.status, fixture.status)
        assert.equal(result.code, fixture.code)
        assert.deepEqual(identified, fixture.identified)
        const calls = (await readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
        const listCalls = calls.filter((call) => call[1] === "+list")
        assert.equal(listCalls.length, fixture.listCalls)
        assert.equal(calls.some((call) => call[1] === "+create"), false)
        assert.deepEqual(
          listCalls.map((call) => {
            const index = call.indexOf("--cursor")
            return index < 0 ? undefined : call[index + 1]
          }),
          fixture.cursorValues,
        )
        for (const call of listCalls) {
          assert.equal(call[0], "devapp")
          assert.equal(call[call.indexOf("--name") + 1], "Ding Bot")
          assert.equal(call[call.indexOf("--page-size") + 1], "20")
          assert.equal(call[call.indexOf("--format") + 1], "json")
        }
        const rawCalls = (await readFile(`${logPath}.raw`, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
        assert.equal(boundaries, rawCalls.length * 2)
      } finally {
        if (originalPath === undefined) delete process.env.PATH
        else process.env.PATH = originalPath
      }
    })
  }
})

test("built DingTalk fresh identity faults stay resumable without provider or runtime effects", async (t) => {
  const fixtures = [
    { scenario: "ambiguous" as const, code: "dingtalk_provider_identity_ambiguous", listCalls: 2 },
    ...([
      "missing-has-more",
      "typed-has-more",
      "typed-cursor",
      "conflicting-has-more",
      "conflicting-cursor",
      "missing-cursor",
      "empty-cursor",
      "unexpected-cursor",
      "oversized-cursor",
    ] as const).map((scenario) => ({
      scenario,
      code: "dingtalk_provider_list_invalid",
      listCalls: 1,
    })),
    { scenario: "oversized-page" as const, code: "dingtalk_provider_pagination_limit", listCalls: 1 },
    { scenario: "malformed-page-one" as const, code: "dingtalk_provider_invalid_json", listCalls: 1 },
    { scenario: "malformed-page-two" as const, code: "dingtalk_provider_invalid_json", listCalls: 2 },
    { scenario: "unavailable-page-one" as const, code: "dingtalk_provider_error_provider_unavailable", listCalls: 1 },
    { scenario: "unavailable-page-two" as const, code: "dingtalk_provider_error_provider_unavailable", listCalls: 2 },
    { scenario: "loop" as const, code: "dingtalk_provider_pagination_invalid", listCalls: 2 },
    { scenario: "cycle" as const, code: "dingtalk_provider_pagination_invalid", listCalls: 3 },
    { scenario: "limit" as const, code: "dingtalk_provider_pagination_limit", listCalls: 20 },
    { scenario: "cli-unavailable" as const, code: "dingtalk_provider_cli_unavailable", listCalls: 0 },
  ]

  for (const fixture of fixtures) {
    await t.test(fixture.scenario, async (subtest) => {
      const temporary = await isolatedRoot(
        subtest,
        `deploy-dingtalk-fresh-${fixture.scenario}-`,
      )
      const home = path.join(temporary, "home")
      const bin = path.join(temporary, "bin")
      const logPath = path.join(temporary, "dws.log")
      const runtimeMarker = path.join(temporary, "runtime-effects.jsonl")
      const packageDirectory = path.join(temporary, "dingtalk-fresh")
      const configPath = path.join(home, ".digital-employee", "config.json")
      await mkdir(home)
      await installVersionProbeWithRuntimeMarker(bin, runtimeMarker)
      if (fixture.scenario !== "cli-unavailable") {
        await installPaginatedDws(bin, fixture.scenario, logPath)
      }
      await createEmployeePackage(packageDirectory, { name: "dingtalk-fresh" })
      const environment = cliEnvironment({
        home,
        bin,
        extra: { QODER_PERSONAL_ACCESS_TOKEN: "fresh-identity-sentinel" },
      })
      if (fixture.scenario === "cli-unavailable") {
        await symlink(process.execPath, path.join(bin, "node"))
        environment.PATH = [bin, "/usr/bin", "/bin"].join(path.delimiter)
      }
      const result = runBuiltCli([
        "deploy",
        packageDirectory,
        "--channel",
        "dingtalk",
        "--engine",
        "qoder",
        "--runtime",
        "agent-native",
        "--locale",
        "en",
        "--name",
        "Ding Bot",
        "--yes",
      ], {
        environment,
        timeoutMs: fixture.scenario === "limit" ? 60_000 : 20_000,
      })
      const scopeUnavailable = fixture.scenario === "cli-unavailable"
      assert.equal(result.status, scopeUnavailable ? 1 : 2, result.stderr)
      if (scopeUnavailable) {
        assert.match(result.stderr, /dingtalk_provider_scope_unavailable/)
        assert.match(result.stderr, /Deployment failed/)
      } else {
        assert.match(result.stderr, /Pending external action/)
        assert.match(result.stderr, /rerun deploy to resume/)
      }
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Ready:|completed/i)
      await assert.rejects(access(runtimeMarker))

      const calls = fixture.listCalls === 0
        ? []
        : (await readFile(logPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      assert.equal(calls.filter((call) => call[1] === "+list").length, fixture.listCalls)
      assert.equal(
        calls.some((call) => ["+create", "+update", "+delete"].includes(call[1]!)),
        false,
      )
      if (scopeUnavailable) {
        await assert.rejects(access(configPath))
        return
      }
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        outcome: string
        code: string
        provider?: unknown
        providerOperation?: unknown
        endpoint?: unknown
        process?: unknown
        deployedAt?: unknown
      }
      assert.doesNotMatch(
        `${result.stdout}${result.stderr}${JSON.stringify(config)}`,
        /fresh-identity-sentinel/,
      )
      assert.equal(config.outcome, "pending_external_action")
      assert.equal(config.code, fixture.code)
      assert.equal(config.provider, undefined)
      assert.equal(config.providerOperation, undefined)
      assert.equal(config.endpoint, undefined)
      assert.equal(config.process, undefined)
      assert.equal(config.deployedAt, undefined)
    })
  }
})

test("built DingTalk replay exhausts every continuation fault without a second create", async (t) => {
  for (const fixture of [
    { scenario: "page-two" as const, listCalls: 2, terminal: true },
    { scenario: "none" as const, listCalls: 2, terminal: false },
    { scenario: "ambiguous" as const, listCalls: 2, terminal: false },
    ...([
      "missing-has-more",
      "typed-has-more",
      "typed-cursor",
      "conflicting-has-more",
      "conflicting-cursor",
      "missing-cursor",
      "empty-cursor",
      "unexpected-cursor",
      "oversized-cursor",
      "oversized-page",
      "malformed-page-one",
      "unavailable-page-one",
    ] as const).map((scenario) => ({
      scenario,
      listCalls: 1,
      terminal: false,
    })),
    { scenario: "malformed-page-two" as const, listCalls: 2, terminal: false },
    { scenario: "unavailable-page-two" as const, listCalls: 2, terminal: false },
    { scenario: "loop" as const, listCalls: 2, terminal: false },
    { scenario: "cycle" as const, listCalls: 3, terminal: false },
    { scenario: "limit" as const, listCalls: 20, terminal: false },
  ]) {
    await t.test(fixture.scenario, async (subtest) => {
      const temporary = await isolatedRoot(
        subtest,
        `deploy-dingtalk-replay-${fixture.scenario}-`,
      )
      const home = path.join(temporary, "home")
      const bin = path.join(temporary, "bin")
      const logPath = path.join(temporary, "dws.log")
      const providerState = path.join(temporary, "dws.state")
      const runtimeMarker = path.join(temporary, "runtime-effects.jsonl")
      const packageDirectory = path.join(temporary, "dingtalk-replay")
      const configPath = path.join(home, ".digital-employee", "config.json")
      await mkdir(home)
      await installVersionProbeWithRuntimeMarker(bin, runtimeMarker)
      await installFakeDws(bin, "create-invalid", logPath, providerState)
      await createEmployeePackage(packageDirectory, {
        name: "dingtalk-replay",
      })
      const environment = cliEnvironment({
        home,
        bin,
        extra: { QODER_PERSONAL_ACCESS_TOKEN: "replay-sentinel" },
      })
      const args = [
        "deploy",
        packageDirectory,
        "--channel",
        "dingtalk",
        "--engine",
        "qoder",
        "--runtime",
        "agent-native",
        "--locale",
        "en",
        "--name",
        "Ding Bot",
        "--yes",
      ]
      const seed = runBuiltCli(args, { environment })
      assert.equal(seed.status, 2, seed.stderr)
      const seeded = JSON.parse(await readFile(configPath, "utf8")) as {
        providerOperation: DeployProviderOperation
      }
      const operation = seeded.providerOperation
      const seedCalls = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
      assert.deepEqual(seedCalls.map((call) => call[1]), ["+list", "+create"])

      await installPaginatedDws(bin, fixture.scenario, logPath)
      const replay = runBuiltCli(args, {
        environment,
        timeoutMs: fixture.scenario === "limit" ? 60_000 : 20_000,
      })
      assert.equal(replay.status, 2, replay.stderr)
      assert.match(replay.stderr, /Pending external action/)
      assert.match(replay.stderr, /rerun deploy to resume/)
      assert.doesNotMatch(`${replay.stdout}${replay.stderr}`, /Ready:|completed/i)
      await assert.rejects(access(runtimeMarker))
      const calls = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
      assert.equal(calls.filter((call) => call[1] === "+create").length, 1)
      assert.equal(
        calls.some((call) => ["+update", "+delete"].includes(call[1]!)),
        false,
      )
      const added = calls.slice(seedCalls.length)
      assert.equal(
        added.filter((call) => call[1] === "+list").length,
        fixture.listCalls,
      )
      assert.equal(
        added.filter((call) => call[1] === "+get").length,
        fixture.terminal ? 1 : 0,
      )
      assert.equal(added.some((call) => call[1] === "+create"), false)
      const after = JSON.parse(await readFile(configPath, "utf8")) as {
        outcome: string
        code: string
        provider?: { resourceId: string }
        providerOperation?: DeployProviderOperation
        endpoint?: unknown
        process?: unknown
        deployedAt?: unknown
      }
      assert.equal(after.outcome, "pending_external_action")
      assert.equal(after.endpoint, undefined)
      assert.equal(after.process, undefined)
      assert.equal(after.deployedAt, undefined)
      if (fixture.terminal) {
        assert.equal(after.provider?.resourceId, "app-page-2")
        assert.equal(after.providerOperation, undefined)
      } else {
        assert.equal(after.provider, undefined)
        assert.equal(
          after.code,
          "dingtalk_provider_create_indeterminate",
        )
        assert.deepEqual(after.providerOperation, operation)
      }
    })
  }
})

test("DingTalk create timeout treats parseable output as uncertain and replay is reconcile-only", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-timeout-")
  const bin = path.join(temporary, "bin")
  const logPath = path.join(temporary, "dws.log")
  const providerState = path.join(temporary, "dws.state")
  await installFakeDws(bin, "slow-success", logPath, providerState)
  const originalPath = process.env.PATH
  const operations: DeployProviderOperation[] = []
  const identified: string[] = []
  process.env.PATH = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
    .join(path.delimiter)
  try {
    const result = await reconcileDingTalkApplication(
      { name: "Ding Bot" },
      {
        allowWrite: true,
        // Source-mode supervision loads tsx before invoking the fake DWS binary;
        // keep the fault timeout above that bounded startup cost.
        commandTimeoutMs: 5_000,
        beforeBoundary: () => {},
        onCreateAttempt: (operation) => {
          operations.push(operation)
        },
        onProviderIdentified: (provider) => {
          identified.push(provider.resourceId)
        },
      },
    )
    assert.deepEqual(result, {
      status: "indeterminate",
      code: "dingtalk_provider_create_indeterminate",
    })
    assert.equal(operations.length, 1)
    assert.deepEqual(identified, [])
    const utility = JSON.parse(await readFile(providerState, "utf8")) as {
      pid: number
      descendantPid: number
      phase: string
    }
    assert.equal(utility.phase, "parseable-response-before-settlement")
    await waitFor(() => {
      try {
        process.kill(utility.pid, 0)
        return false
      } catch {
        return true
      }
    })
    await waitFor(() => {
      try {
        process.kill(utility.descendantPid, 0)
        return false
      } catch {
        return true
      }
    })

    const replay = await reconcileDingTalkApplication(
      { name: "Ding Bot" },
      {
        allowWrite: true,
        commandTimeoutMs: 5_000,
        existingOperation: operations[0]!,
        beforeBoundary: () => {},
        onCreateAttempt: () => {
          throw new Error("replay_must_not_create")
        },
        onProviderIdentified: () => {
          throw new Error("empty_reconciliation_must_not_identify")
        },
      },
    )
    assert.deepEqual(replay, {
      status: "indeterminate",
      code: "dingtalk_provider_create_indeterminate",
    })
    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    assert.deepEqual(calls.map((call) => call[1]), ["+list", "+create", "+list"])
    assert.equal(calls.filter((call) => call[1] === "+create").length, 1)
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
})

test("DingTalk abort after verified get but before provider persistence preserves replay-only recovery", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-post-get-abort-")
  const bin = path.join(temporary, "bin")
  const logPath = path.join(temporary, "dws.log")
  const providerState = path.join(temporary, "dws.state")
  await installFakeDws(bin, "success", logPath, providerState)
  const originalPath = process.env.PATH
  const controller = new AbortController()
  const operations: DeployProviderOperation[] = []
  process.env.PATH = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
    .join(path.delimiter)
  try {
    const interrupted = await reconcileDingTalkApplication(
      { name: "Ding Bot" },
      {
        signal: controller.signal,
        allowWrite: true,
        beforeBoundary: () => {},
        onCreateAttempt: (operation) => {
          operations.push(operation)
        },
        onProviderIdentified: () => {
          controller.abort()
          throw new Error("provider_persistence_interrupted")
        },
      },
    )
    assert.deepEqual(interrupted, {
      status: "indeterminate",
      code: "dingtalk_provider_state_write_failed",
      preserveState: true,
    })
    assert.equal(operations.length, 1)
    await installFakeDws(bin, "conflict", logPath, providerState)
    const identified: string[] = []
    const replay = await reconcileDingTalkApplication(
      { name: "Ding Bot" },
      {
        existingOperation: operations[0]!,
        allowWrite: true,
        beforeBoundary: () => {},
        onCreateAttempt: () => {
          throw new Error("replay_must_not_create")
        },
        onProviderIdentified: (provider) => {
          identified.push(provider.resourceId)
        },
      },
    )
    assert.deepEqual(replay, {
      status: "verified",
      code: "dingtalk_app_verified",
      provider: {
        kind: "dingtalk-app",
        resourceId: "app-verified-1",
        scope: testProviderScope(),
      },
    })
    assert.deepEqual(identified, ["app-verified-1"])
    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    assert.deepEqual(
      calls.map((call) => call[1]),
      ["+list", "+create", "+get", "+list", "+get"],
    )
    assert.equal(calls.filter((call) => call[1] === "+create").length, 1)
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
  }
})

test("DingTalk create abort preserves the operation and replay never creates again", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-abort-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const logPath = path.join(temporary, "dws.log")
  const providerState = path.join(temporary, "dws.state")
  const packageDirectory = path.join(temporary, "dingtalk-abort")
  const configPath = path.join(home, ".digital-employee", "config.json")
  await mkdir(home)
  await installFakeQoder(bin)
  await installFakeDws(bin, "slow-success", logPath, providerState)
  await createEmployeePackage(packageDirectory, { name: "dingtalk-abort" })
  const environment = cliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "dingtalk-abort-sentinel" },
  })
  const args = [
    "deploy",
    packageDirectory,
    "--channel",
    "dingtalk",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Ding Bot",
    "--yes",
  ]
  const interrupted = startBuiltCli(args, { environment })
  t.after(() => {
    if (!interrupted.child.pid) return
    try {
      process.kill(interrupted.child.pid, "SIGKILL")
    } catch {
      // The exact test-owned CLI already exited.
    }
  })
  await waitFor(async () => {
    try {
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        providerOperation?: unknown
      }
      const utility = JSON.parse(await readFile(providerState, "utf8")) as {
        phase?: string
      }
      return Boolean(
        config.providerOperation &&
        utility.phase === "parseable-response-before-settlement",
      )
    } catch {
      return false
    }
  }, 30_000)
  const durableFenceBytes = await readFile(configPath)
  const durableFenceIdentity = await lstat(configPath)
  const utility = JSON.parse(await readFile(providerState, "utf8")) as {
    pid: number
    descendantPid: number
  }
  assert.ok(interrupted.child.pid)
  process.kill(interrupted.child.pid, "SIGTERM")
  const result = await interrupted.completion
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /Pending external action/)
  await waitFor(() => {
    try {
      process.kill(utility.pid, 0)
      return false
    } catch {
      return true
    }
  })
  await waitFor(() => {
    try {
      process.kill(utility.descendantPid, 0)
      return false
    } catch {
      return true
    }
  })
  const interruptedConfig = JSON.parse(
    await readFile(configPath, "utf8"),
  ) as {
    outcome: string
    code?: string
    provider?: unknown
    providerOperation?: DeployProviderOperation
  }
  assert.equal(interruptedConfig.outcome, "pending_external_action")
  assert.equal(interruptedConfig.code, undefined)
  assert.equal(interruptedConfig.provider, undefined)
  assert.equal(interruptedConfig.providerOperation?.kind, "dingtalk-app-create")
  assert.deepEqual(await readFile(configPath), durableFenceBytes)
  const preservedFenceIdentity = await lstat(configPath)
  assert.equal(preservedFenceIdentity.dev, durableFenceIdentity.dev)
  assert.equal(preservedFenceIdentity.ino, durableFenceIdentity.ino)

  const callsBeforeReplay = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
  assert.deepEqual(callsBeforeReplay.map((call) => call[1]), ["+list", "+create"])
  const replay = runBuiltCli(args, { environment })
  assert.equal(replay.status, 2, replay.stderr)
  const replayCalls = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
  assert.deepEqual(
    replayCalls.slice(callsBeforeReplay.length).map((call) => call[1]),
    ["+list"],
  )
  assert.equal(replayCalls.filter((call) => call[1] === "+create").length, 1)
  const replayConfig = JSON.parse(await readFile(configPath, "utf8")) as {
    providerOperation?: DeployProviderOperation
  }
  assert.equal(
    replayConfig.providerOperation?.operationId,
    interruptedConfig.providerOperation?.operationId,
  )
})

test("DingTalk parent SIGKILL after a possible create effect preserves the durable fence and reaps DWS", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-parent-kill-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const logPath = path.join(temporary, "dws.log")
  const providerState = path.join(temporary, "dws.state")
  const packageDirectory = path.join(temporary, "dingtalk-parent-kill")
  const configPath = path.join(home, ".digital-employee", "config.json")
  await mkdir(home)
  await installFakeQoder(bin)
  await installFakeDws(bin, "slow-success", logPath, providerState)
  await createEmployeePackage(packageDirectory, {
    name: "dingtalk-parent-kill",
  })
  const environment = cliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "parent-kill-sentinel" },
  })
  const args = [
    "deploy",
    packageDirectory,
    "--channel",
    "dingtalk",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Ding Bot",
    "--yes",
  ]
  const owner = startBuiltCli(args, { environment })
  t.after(() => {
    if (owner.child.exitCode === null && owner.child.signalCode === null) {
      owner.child.kill("SIGKILL")
    }
  })
  let operation: DeployProviderOperation | undefined
  let utilityPid = 0
  let utilityDescendantPid = 0
  await waitFor(async () => {
    try {
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        providerOperation?: DeployProviderOperation
      }
      const utility = JSON.parse(await readFile(providerState, "utf8")) as {
        pid?: number
        descendantPid?: number
        phase?: string
      }
      if (
        config.providerOperation &&
        utility.pid &&
        utility.descendantPid &&
        utility.phase === "parseable-response-before-settlement"
      ) {
        operation = config.providerOperation
        utilityPid = utility.pid
        utilityDescendantPid = utility.descendantPid
        return true
      }
    } catch {
      // The durable create boundary is not visible yet.
    }
    return false
  }, 30_000)
  assert.ok(operation)
  assert.ok(owner.child.pid)
  const killedAt = Date.now()
  process.kill(owner.child.pid, "SIGKILL")
  const killed = await owner.completion
  assert.equal(killed.status, null)
  await waitFor(() => {
    try {
      process.kill(utilityPid, 0)
      return false
    } catch {
      return true
    }
  }, 5_000)
  await waitFor(() => {
    try {
      process.kill(utilityDescendantPid, 0)
      return false
    } catch {
      return true
    }
  }, 5_000)
  assert.ok(Date.now() - killedAt < 5_000)

  const afterKill = JSON.parse(await readFile(configPath, "utf8")) as {
    outcome: string
    provider?: unknown
    providerOperation?: DeployProviderOperation
  }
  assert.equal(afterKill.outcome, "pending_external_action")
  assert.equal(afterKill.provider, undefined)
  assert.deepEqual(afterKill.providerOperation, operation)
  const callsBeforeReplay = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
  assert.deepEqual(callsBeforeReplay.map((call) => call[1]), ["+list", "+create"])

  const replay = runBuiltCli(args, { environment })
  assert.equal(replay.status, 2, replay.stderr)
  assert.match(replay.stderr, /Pending external action/)
  const replayCalls = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
  assert.deepEqual(
    replayCalls.slice(callsBeforeReplay.length).map((call) => call[1]),
    ["+list"],
  )
  assert.equal(replayCalls.filter((call) => call[1] === "+create").length, 1)
  const finalConfig = JSON.parse(await readFile(configPath, "utf8")) as {
    code: string
    providerOperation?: DeployProviderOperation
  }
  assert.equal(finalConfig.code, "dingtalk_provider_create_indeterminate")
  assert.deepEqual(finalConfig.providerOperation, operation)
})

test("a durable DingTalk operation globally fences changed bindings until exact terminal reconciliation", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-global-fence-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const logPath = path.join(temporary, "dws.log")
  const providerState = path.join(temporary, "dws.state")
  const packageA = path.join(temporary, "a", "global-fence")
  const packageB = path.join(temporary, "b", "global-fence")
  const packageC = path.join(temporary, "c", "global-fence")
  const configPath = path.join(home, ".digital-employee", "config.json")
  await mkdir(home)
  await installFakeQoder(bin)
  await mkdir(path.dirname(packageA), { recursive: true })
  await createEmployeePackage(packageA, { name: "global-fence" })
  await mkdir(path.dirname(packageB), { recursive: true })
  await mkdir(path.dirname(packageC), { recursive: true })
  await cp(packageA, packageB, { recursive: true })
  await cp(packageA, packageC, { recursive: true })
  await writeFile(
    path.join(packageC, "knowledge", "README.md"),
    "changed package generation\n",
  )
  await installFakeDws(bin, "create-invalid", logPath, providerState)
  const environment = httpCliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "global-fence-sentinel" },
  })
  const args = (
    packageDirectory: string,
    channel: "dingtalk" | "console" | "http" | "lark" | "wecom" = "dingtalk",
    name = "Ding Bot",
  ) => [
    "deploy",
    packageDirectory,
    "--channel",
    channel,
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    name,
    "--yes",
  ]
  const seed = runBuiltCli(args(packageA), { environment })
  assert.equal(seed.status, 2, seed.stderr)
  const seeded = JSON.parse(await readFile(configPath, "utf8")) as {
    providerOperation: DeployProviderOperation
  }
  assert.equal(seeded.providerOperation.kind, "dingtalk-app-create")
  const operationId = seeded.providerOperation.operationId
  const preservedBytes = await readFile(configPath)
  const preservedIdentity = await lstat(configPath)
  const seedCalls = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
  assert.deepEqual(seedCalls.map((call) => call[1]), ["+list", "+create"])

  await installFakeDws(bin, "success", logPath, providerState)
  const blockedBindings = [
    { label: "name", args: args(packageA, "dingtalk", "Other Bot") },
    { label: "channel", args: args(packageA, "console") },
    { label: "local-reference", args: args(packageB) },
    { label: "digest", args: args(packageC) },
  ]
  for (const blocked of blockedBindings) {
    const result = runBuiltCli(blocked.args, { environment })
    assert.equal(result.status, 2, `${blocked.label}: ${result.stderr}`)
    assert.match(result.stderr, /Pending external action/)
    const after = await lstat(configPath)
    assert.equal(after.dev, preservedIdentity.dev)
    assert.equal(after.ino, preservedIdentity.ino)
    assert.deepEqual(await readFile(configPath), preservedBytes)
    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    assert.deepEqual(calls, seedCalls)
    assert.deepEqual(deploymentPids(configPath), [])
  }

  await installFakeDws(bin, "conflict", logPath, providerState)
  const reconciled = runBuiltCli(args(packageA), { environment })
  assert.equal(reconciled.status, 2, reconciled.stderr)
  const reconciledConfig = JSON.parse(await readFile(configPath, "utf8")) as {
    provider?: { resourceId: string }
    providerOperation?: unknown
  }
  assert.equal(reconciledConfig.provider?.resourceId, "app-verified-1")
  assert.equal(reconciledConfig.providerOperation, undefined)
  const reconciledCalls = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
  assert.deepEqual(
    reconciledCalls.slice(seedCalls.length).map((call) => call[1]),
    ["+list", "+get"],
  )

  await installFakeDws(bin, "success", logPath, providerState)
  const verifiedBytes = await readFile(configPath)
  const verifiedIdentity = await lstat(configPath)
  for (const blocked of [
    { label: "name", args: args(packageB, "dingtalk", "Other Bot") },
    { label: "channel", args: args(packageA, "console") },
    { label: "http", args: args(packageA, "http") },
    { label: "lark", args: args(packageA, "lark") },
    { label: "wecom", args: args(packageA, "wecom") },
  ]) {
    const next = runBuiltCli(blocked.args, { environment })
    assert.equal(next.status, 1, `${blocked.label}: ${next.stderr}`)
    assert.match(next.stderr, /unsupported/i)
    const finalCalls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
    assert.deepEqual(finalCalls, reconciledCalls)
    const after = await lstat(configPath)
    assert.equal(after.dev, verifiedIdentity.dev)
    assert.equal(after.ino, verifiedIdentity.ino)
    assert.deepEqual(await readFile(configPath), verifiedBytes)
  }
  assert.notEqual(operationId, "")
})

test("concurrent DingTalk deploy creates at most one app and interactive creation requires confirmation", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-dingtalk-concurrent-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const logPath = path.join(temporary, "dws.log")
  const providerState = path.join(temporary, "dws.state")
  const packageDirectory = path.join(temporary, "dingtalk-concurrent")
  await mkdir(home)
  await installFakeQoder(bin)
  await installFakeDws(bin, "success", logPath, providerState)
  await createEmployeePackage(packageDirectory, { name: "dingtalk-concurrent" })
  const environment = cliEnvironment({
    home,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "dingtalk-concurrent-sentinel" },
  })
  const args = [
    "deploy",
    packageDirectory,
    "--channel",
    "dingtalk",
    "--engine",
    "qoder",
    "--runtime",
    "agent-native",
    "--locale",
    "en",
    "--name",
    "Ding Bot",
    "--yes",
  ]
  const [left, right] = await Promise.all([
    runBuiltCliAsync(args, { environment }),
    runBuiltCliAsync(args, { environment }),
  ])
  assert.equal(left.status, 2, left.stderr)
  assert.equal(right.status, 2, right.stderr)
  const calls = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
  assert.equal(calls.filter((call) => call[1] === "+create").length, 1)
  assert.equal(calls.filter((call) => call[1] === "+get").length, 2)

  const confirmationHome = path.join(temporary, "confirmation-home")
  const confirmationLog = path.join(temporary, "confirmation.log")
  const confirmationState = path.join(temporary, "confirmation.state")
  await mkdir(confirmationHome)
  await installFakeDws(bin, "success", confirmationLog, confirmationState)
  const confirmationEnvironment = cliEnvironment({
    home: confirmationHome,
    bin,
    extra: { QODER_PERSONAL_ACCESS_TOKEN: "dingtalk-confirm-sentinel" },
  })
  const interactiveArgs = args.filter((value) => value !== "--yes")
  const declined = runBuiltCli(interactiveArgs, {
    environment: confirmationEnvironment,
    input: "n\n",
  })
  assert.equal(declined.status, 2, declined.stderr)
  assert.match(declined.stdout, /Create the DingTalk application/)
  let confirmationCalls = (await readFile(confirmationLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
  assert.deepEqual(confirmationCalls.map((call) => call[1]), ["+list"])

  const approved = runBuiltCli(interactiveArgs, {
    environment: confirmationEnvironment,
    input: "y\ny\n",
  })
  assert.equal(approved.status, 2, approved.stderr)
  confirmationCalls = (await readFile(confirmationLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
  assert.deepEqual(
    confirmationCalls.map((call) => call[1]),
    ["+list", "+list", "+create", "+get"],
  )
})
