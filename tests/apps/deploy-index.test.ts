import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createEmployeePackage } from "../../apps/cli/employee-package.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const driver = path.join(root, "tests", "apps", "fixtures", "deploy-index-driver.mjs")
const qoderFixture = path.join(root, "tests", "apps", "fixtures", "fake-qoder.mjs")

async function isolatedRoot(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  return directory
}

async function installFakeQoder(bin: string): Promise<void> {
  await mkdir(bin)
  const executable = path.join(bin, "qodercli")
  const fixture = path.join(bin, "fake-qoder.mjs")
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

async function installFailingDws(bin: string): Promise<void> {
  await writeFile(path.join(bin, "dws"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
}

function runDeploy(
  options: Record<string, unknown>,
  {
    home,
    bin,
    input = "",
  }: { home: string; bin?: string; input?: string },
) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"]
      .filter(Boolean)
      .join(path.delimiter),
    QODER_PERSONAL_ACCESS_TOKEN: "deploy-index-test-token",
  }
  return spawnSync(
    process.execPath,
    ["--import", "tsx", driver, JSON.stringify(options)],
    {
      cwd: root,
      encoding: "utf8",
      input,
      timeout: 30_000,
      env: environment,
    },
  )
}

function configPath(home: string): string {
  return path.join(home, ".digital-employee", "config.json")
}

async function configExists(home: string): Promise<boolean> {
  try {
    await access(configPath(home))
    return true
  } catch {
    return false
  }
}

async function readConfig(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath(home), "utf8")) as Record<
    string,
    unknown
  >
}

function fullProvidedOptions(): string[] {
  return [
    "channel",
    "engine",
    "runtime",
    "name",
    "locale",
    "package",
    "yes",
  ]
}

test("deploy --help prints help and does not touch config", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-index-help-")
  const home = path.join(temporary, "home")
  await mkdir(home)
  const result = runDeploy({ help: true, locale: "en" }, { home })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /digital-employee deploy \[package-path\]/)
  assert.equal(await configExists(home), false)
})

test("--yes without a runtime flag fails before package resolution", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-index-flags-")
  const home = path.join(temporary, "home")
  await mkdir(home)
  const result = runDeploy(
    { channel: "console", engine: "qoder", yes: true, locale: "en" },
    { home },
  )
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /--runtime/)
  assert.equal(await configExists(home), false)
})

test("an invalid explicit channel fails before package resolution", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-index-channel-")
  const home = path.join(temporary, "home")
  await mkdir(home)
  const result = runDeploy(
    {
      channel: "bogus",
      locale: "en",
      providedOptions: ["channel"],
    },
    { home },
  )
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /Invalid channel/)
  assert.match(result.stderr, /dingtalk\|lark\|wecom\|console\|http/)
  assert.equal(await configExists(home), false)
})

test("a complete console deploy persists a pending config and exits 2", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-index-console-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "console-deploy")
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "console-deploy" })
  const result = runDeploy(
    {
      packagePath: packageDirectory,
      channel: "console",
      engine: "qoder",
      runtime: "agent-native",
      name: "console-bot",
      locale: "en",
      yes: true,
      providedOptions: fullProvidedOptions(),
    },
    { home, bin },
  )
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stdout, /Package: console-deploy@/)
  assert.match(result.stderr, /Pending external action \(console_foreground_start_required\)/)
  const saved = await readConfig(home)
  assert.equal(saved.schemaVersion, "deploy-state.v1")
  assert.equal(saved.channel, "console")
  assert.equal(saved.engine, "qoder")
  assert.equal(saved.runtime, "agent-native")
  assert.equal(saved.botName, "console-bot")
  assert.equal(saved.locale, "en")
  assert.equal(saved.outcome, "pending_external_action")
  assert.equal(saved.code, "console_foreground_start_required")
  const binding = saved.package as Record<string, unknown>
  assert.equal(binding.name, "console-deploy")
  assert.match(String(binding.digest), /^sha256:[a-f0-9]{64}$/)
  assert.equal(typeof saved.updatedAt, "string")
})

test("standalone-v1 deploy is unsupported and writes no config", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-index-standalone-")
  const home = path.join(temporary, "home")
  const packageDirectory = path.join(temporary, "standalone-pkg")
  await mkdir(home)
  await createEmployeePackage(packageDirectory, { name: "standalone-pkg" })
  const result = runDeploy(
    {
      packagePath: packageDirectory,
      channel: "console",
      engine: "openai-compatible",
      runtime: "standalone-v1",
      name: "standalone-bot",
      locale: "en",
      yes: true,
      providedOptions: fullProvidedOptions(),
    },
    { home },
  )
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /Unsupported deployment \(package_deploy_standalone_unsupported\)/)
  assert.equal(await configExists(home), false)
})

test("dingtalk deploy fails closed when dws is unavailable", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-index-dingtalk-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "dingtalk-pkg")
  await mkdir(home)
  await installFakeQoder(bin)
  await installFailingDws(bin)
  await createEmployeePackage(packageDirectory, { name: "dingtalk-pkg" })
  const result = runDeploy(
    {
      packagePath: packageDirectory,
      channel: "dingtalk",
      engine: "qoder",
      runtime: "agent-native",
      name: "dingtalk-bot",
      locale: "en",
      yes: true,
      providedOptions: fullProvidedOptions(),
    },
    { home, bin },
  )
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /Deployment failed \(dingtalk_provider_scope_unavailable\)/)
  assert.equal(await configExists(home), false)
})

test("an existing deployment aborts on overwrite refusal and keeps state", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-index-abort-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "abort-pkg")
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "abort-pkg" })
  const first = runDeploy(
    {
      packagePath: packageDirectory,
      channel: "console",
      engine: "qoder",
      runtime: "agent-native",
      name: "abort-bot",
      locale: "en",
      yes: true,
      providedOptions: fullProvidedOptions(),
    },
    { home, bin },
  )
  assert.equal(first.status, 2, first.stderr)
  const before = await readConfig(home)
  const second = runDeploy(
    {
      packagePath: packageDirectory,
      channel: "console",
      engine: "qoder",
      runtime: "agent-native",
      name: "abort-bot",
      locale: "en",
      providedOptions: fullProvidedOptions(),
    },
    { home, bin, input: "n\n" },
  )
  assert.equal(second.status, 1, second.stdout)
  assert.match(second.stderr, /did not run \(deploy_aborted\)/)
  const after = await readConfig(home)
  assert.deepEqual(after, before)
})

test("an existing deployment is overwritten on confirmation", async (t) => {
  const temporary = await isolatedRoot(t, "deploy-index-overwrite-")
  const home = path.join(temporary, "home")
  const bin = path.join(temporary, "bin")
  const packageDirectory = path.join(temporary, "overwrite-pkg")
  await mkdir(home)
  await installFakeQoder(bin)
  await createEmployeePackage(packageDirectory, { name: "overwrite-pkg" })
  const first = runDeploy(
    {
      packagePath: packageDirectory,
      channel: "console",
      engine: "qoder",
      runtime: "agent-native",
      name: "overwrite-bot",
      locale: "en",
      yes: true,
      providedOptions: fullProvidedOptions(),
    },
    { home, bin },
  )
  assert.equal(first.status, 2, first.stderr)
  const before = await readConfig(home)
  const second = runDeploy(
    {
      packagePath: packageDirectory,
      channel: "console",
      engine: "qoder",
      runtime: "agent-native",
      name: "overwrite-bot",
      locale: "en",
      providedOptions: fullProvidedOptions(),
    },
    { home, bin, input: "y\n" },
  )
  assert.equal(second.status, 2, second.stderr)
  const after = await readConfig(home)
  assert.notEqual(after.updatedAt, before.updatedAt)
  assert.equal(after.outcome, "pending_external_action")
})
