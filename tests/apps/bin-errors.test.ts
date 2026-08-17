import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const cli = path.join(root, "apps", "cli", "bin.ts")

function runCli(
  args: string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root,
    encoding: "utf8",
    input,
    timeout: 30_000,
  })
}

test("help prints usage on stdout with a clean exit", () => {
  for (const args of [["help"], ["--help"], ["-h"]]) {
    const result = runCli(args)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, "")
    assert.match(result.stdout, /Agent-native usage:/)
    assert.match(result.stdout, /Runner \(outbound worker/)
  }
})

test("deploy --help prints the deploy help text", () => {
  const result = runCli(["deploy", "--help", "--locale", "en"])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, "")
  assert.match(result.stdout, /Language|language|Deploy|deploy/)
})

test("unknown top-level command fails with a stable code", () => {
  const result = runCli(["frobnicate"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "digital-employee: unknown_command:frobnicate\n")
})

test("unknown legacy subcommand fails with a stable code", () => {
  const result = runCli(["legacy", "frobnicate"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "digital-employee: unknown_legacy_command:frobnicate\n")
})

test("run requires an engine before anything else", () => {
  const result = runCli(["run", ".", "--input", '{"message":"x"}', "--json"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "digital-employee: run_requires_engine\n")
})

test("run rejects an unknown engine", () => {
  const result = runCli(["run", ".", "--engine", "bogus", "--question", "x"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "digital-employee: unknown_agent_host:bogus\n")
})

test("run accepts exactly one input source", () => {
  const result = runCli([
    "run",
    ".",
    "--engine",
    "qoder",
    "--question",
    "x",
    "--input",
    '{"message":"x"}',
  ])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "digital-employee: run_accepts_one_input_source\n")
})

test("run rejects invalid JSON input", () => {
  const result = runCli(["run", ".", "--engine", "qoder", "--input", "{"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "digital-employee: run_input_invalid_json\n")
})

test("run requires input when none is given", () => {
  const result = runCli(["run", ".", "--engine", "qoder"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "digital-employee: run_requires_input\n")
})

test("run rejects oversized stdin input", () => {
  const oversized = `{"message":"${"x".repeat(1024 * 1024)}"}`
  const result = runCli(["run", ".", "--engine", "qoder", "--stdin"], oversized)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "digital-employee: run_input_too_large\n")
})

test("doctor rejects an unknown engine", () => {
  const result = runCli(["doctor", "--engine", "bogus"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "digital-employee: unknown_agent_host:bogus\n")
})

test("validate rejects an unknown engine", () => {
  const result = runCli(["validate", ".", "--engine", "bogus"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "digital-employee: unknown_agent_host:bogus\n")
})

// runner commands lazily import runner-commands.js, which loads node:sqlite
// and emits an unavoidable ExperimentalWarning on stderr. Match the stable
// error line with includes() instead of exact stderr equality.

test("runner init validates required arguments", () => {
  const cases: Array<[string[], string]> = [
    [[], "runner_init_requires_runner_id"],
    [["--runner-id", "r1"], "runner_init_requires_seller_id"],
    [
      ["--runner-id", "r1", "--seller-id", "s1"],
      "runner_init_requires_endpoint",
    ],
  ]
  for (const [args, code] of cases) {
    const result = runCli(["runner", "init", ...args])
    assert.equal(result.status, 1, args.join(" "))
    assert.equal(result.stdout, "")
    assert.ok(
      result.stderr.includes(`digital-employee: ${code}\n`),
      `${args.join(" ")} → ${result.stderr}`,
    )
  }
})

test("runner init uses --home and writes a machine-readable config", () => {
  const home = `${root}/.tmp-runner-init-bin-test-${process.pid}`
  try {
    const result = runCli([
      "runner",
      "init",
      "--home",
      home,
      "--runner-id",
      "bin-runner",
      "--seller-id",
      "bin-seller",
      "--endpoint",
      "https://example.invalid/",
      "--json",
    ])
    assert.equal(result.status, 0, result.stderr)
    assert.ok(!result.stderr.includes("digital-employee:"), result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.config.runnerId, "bin-runner")
    assert.equal(output.config.sellerId, "bin-seller")
    assert.equal(output.config.platformEndpoint, "https://example.invalid/")
    assert.equal(output.created, true)
  } finally {
    spawnSync("rm", ["-rf", home])
  }
})

test("runner rejects an unknown subcommand", () => {
  const result = runCli(["runner", "frobnicate"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.ok(
    result.stderr.includes("digital-employee: unknown_runner_command:frobnicate\n"),
    result.stderr,
  )
})

test("stdio-host requires a config path", () => {
  const result = runCli(["stdio-host"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "digital-employee: stdio_host_config_required\n")
})

test("parse failures print one stable stderr line even with --json", () => {
  const result = runCli(["run", "--json"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "digital-employee: run_requires_engine\n")
})
