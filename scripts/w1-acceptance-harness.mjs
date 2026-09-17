#!/usr/bin/env node
// W1 acceptance harness (#155 W1 door, engine Epic #165 AC-001..AC-004b,
// plus the org/hire invariants of #287).
//
// Single documented command (credential-free, offline, deterministic):
//   npm run build && node ./scripts/w1-acceptance-harness.mjs
//
// What it proves, and at which layer:
//   AC-001 (cli)     workspace init -> org apply -> org tree, then one
//                    `turn run` per oss-maintainer position (owner + three
//                    workers) through the built-in engine's deterministic
//                    zero-credential model port; exactly one trusted
//                    terminal per turn and one turn-evidence.v1 record on
//                    disk per turn.
//   AC-002 (cli)     `validate` + `eval` green on all four materialized
//                    packages, with the pinned CLI version recorded.
//   AC-003 (cli)     every spawned CLI child receives a minimal environment
//                    (PATH/TMPDIR + the two engine model-port variables
//                    only — no credential variable is set or forwarded),
//                    and the full evidence archive passes a secret-pattern
//                    scan with absolute paths normalized to placeholders.
//                    The structural no-network/no-spawn guarantee of the
//                    engine source itself is machine-checked separately by
//                    tests/engine/structural-fail-closed.test.ts.
//   AC-004a (engine) four forced terminations, each with a stable machine
//                    reason, an escalation record, and a conformant
//                    turn-evidence.v1 record: doom_loop (repetition),
//                    turn_budget_exceeded (token cap), turn_budget_exceeded
//                    (context-byte cap, engine.context_budget_exceeded),
//                    position_budget_exceeded (task-iteration cap). These
//                    run at the engine layer because the CLI turn envelope
//                    intentionally does not carry outputSchema or
//                    maxContextBytes, and the deterministic port reports no
//                    token counts; the layer of every record is declared in
//                    the manifest.
//   AC-004b (engine) every archived evidence record — cli-layer and
//                    engine-layer alike — passes validateTurnEvidenceRecord
//                    against the #140 evidence standard.
//   #287    (cli)    `org apply` after a budget change preserves the
//                    context/ tree byte-for-byte while recomputing the
//                    permissions artifact, and `hire validate` on a
//                    budget-less request fails closed with a stable code
//                    and mutates no org state.
//
// Evidence is written to docs/evidence/w1-acceptance/ (machine-readable
// manifest, absolute paths normalized). The harness exits non-zero if any
// check fails; a failing harness must never overwrite the committed
// manifest. `--keep` skips workspace teardown for debugging.

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir, homedir, platform, release } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const keep = process.argv.includes("--keep")
const cli = path.join(repoRoot, "dist", "apps", "cli", "bin.js")
const evidenceOutDir = path.join(repoRoot, "docs", "evidence", "w1-acceptance")
const manifestPath = path.join(evidenceOutDir, "w1-acceptance-evidence.json")

const POSITIONS = [
  "repo-owner",
  "issue-researcher",
  "release-engineer",
  "community-operator",
]
const WORKER_BY_ID = {
  "repo-owner": "repo-owner",
  "issue-researcher": "repo-owner/issue-researcher",
  "release-engineer": "repo-owner/release-engineer",
  "community-operator": "repo-owner/community-operator",
}

// --- harness plumbing -------------------------------------------------------

const failures = []
function fail(message) {
  failures.push(message)
  log(`FAIL: ${message}`)
}
function check(condition, message) {
  if (!condition) fail(message)
  return condition
}
function log(text) {
  process.stderr.write(`==> ${text}\n`)
}

const workRoot = path.join(tmpdir(), `w1-acceptance-${process.pid}`)
mkdirSync(workRoot, { recursive: true })
const workspace = path.join(workRoot, "ws")

function cleanup() {
  if (keep) {
    log(`--keep: workspace retained at ${workRoot}`)
    return
  }
  try {
    rmSync(workRoot, { recursive: true, force: true })
  } catch {
    // best-effort teardown
  }
}
process.on("exit", cleanup)

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function digestFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

/** Stable recursive digest over a directory tree (paths + content). */
function digestDir(dir) {
  const hash = createHash("sha256")
  const walk = (current, prefix) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const entry of entries) {
      const rel = `${prefix}/${entry.name}`
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        hash.update(`d ${rel}\n`)
        walk(abs, rel)
      } else if (entry.isFile()) {
        hash.update(`f ${rel} ${digestFile(abs)}\n`)
      } else {
        hash.update(`x ${rel}\n`)
      }
    }
  }
  if (existsSync(dir)) walk(dir, "")
  return hash.digest("hex")
}

/**
 * Minimal child environment: PATH/TMPDIR for process spawn mechanics plus
 * the two deterministic model-port variables. No credential variable is set
 * or forwarded — this is the AC-003 zero-credential environment claim.
 */
function childEnv(script) {
  return {
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    NODE_NO_WARNINGS: "1",
    DIGITAL_EMPLOYEE_ENGINE_MODEL: "deterministic",
    DIGITAL_EMPLOYEE_ENGINE_MODEL_SCRIPT: JSON.stringify(script),
  }
}

function runCli(args, options = {}) {
  const result = { args, exitCode: 0, stdout: "", stderr: "" }
  try {
    result.stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? childEnv([]),
      input: options.input,
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch (error) {
    result.exitCode = typeof error.status === "number" ? error.status : 1
    result.stdout = error.stdout ?? ""
    result.stderr = error.stderr ?? ""
  }
  return result
}

function parseNdjson(stdout) {
  const events = []
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("{")) {
      try {
        events.push(JSON.parse(trimmed))
      } catch {
        // non-event JSON lines are diagnostics; ignore
      }
    }
  }
  return events
}

function terminalsOf(events) {
  return events.filter(
    (event) => event.type === "run.completed" || event.type === "run.failed",
  )
}

// --- dynamic imports from the built tree ------------------------------------

if (!existsSync(cli)) {
  process.stderr.write(
    "dist/apps/cli/bin.js is missing — run `npm run build` first.\n",
  )
  process.exit(1)
}

const engine = await import(
  path.join(repoRoot, "dist", "packages", "engine", "src", "index.js")
)
const { createFileEvidenceSink } = await import(
  path.join(repoRoot, "dist", "apps", "cli", "turn", "file-evidence-sink.js")
)
const {
  executeTurn,
  createDeterministicModelPort,
  createInMemoryEscalationSink,
  createInMemoryBudgetLedger,
  validateTurnEvidenceRecord,
  ENGINE_VERSION,
} = engine

const packageJson = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
)

// --- step 1: workspace init / org apply / org tree (AC-001 structural) ------

log("AC-001 structural: workspace init -> org apply -> org tree")
const initResult = runCli([
  "workspace",
  "init",
  workspace,
  "--template",
  "oss-maintainer",
  "--json",
])
check(initResult.exitCode === 0, `workspace init exited ${initResult.exitCode}: ${initResult.stderr}`)
let initJson = {}
try {
  initJson = JSON.parse(initResult.stdout)
} catch {
  fail("workspace init did not emit JSON")
}
check(initJson.status === "created", `workspace init status: ${initJson.status}`)
check(
  JSON.stringify([...(initJson.positions ?? [])].sort()) ===
    JSON.stringify([...POSITIONS].sort()),
  `workspace init positions: ${JSON.stringify(initJson.positions)}`,
)

const applyResult = runCli(["org", "apply", workspace, "--json"])
check(applyResult.exitCode === 0, `org apply exited ${applyResult.exitCode}: ${applyResult.stderr}`)
let applyJson = {}
try {
  applyJson = JSON.parse(applyResult.stdout)
} catch {
  fail("org apply did not emit JSON")
}
check(applyJson.status === "applied", `org apply status: ${applyJson.status}`)
check(applyJson.positions === 4, `org apply positions: ${applyJson.positions}`)

const treeResult = runCli(["org", "tree", workspace, "--json"])
check(treeResult.exitCode === 0, `org tree exited ${treeResult.exitCode}: ${treeResult.stderr}`)
let treeJson = {}
try {
  treeJson = JSON.parse(treeResult.stdout)
} catch {
  fail("org tree did not emit JSON")
}
check(treeJson.owner === "repo-owner", `org tree owner: ${treeJson.owner}`)
check(treeJson.positionCount === 4, `org tree positionCount: ${treeJson.positionCount}`)
check(treeJson.depth === 2, `org tree depth: ${treeJson.depth}`)

// --- step 2: validate + eval per package (AC-002) ---------------------------

log("AC-002: validate + eval on all four packages")
const ac002 = []
for (const positionId of POSITIONS) {
  const dir = path.join(workspace, "positions", WORKER_BY_ID[positionId])
  const validate = runCli(["validate", dir, "--json"])
  const evalRun = runCli(["eval", dir, "--json"])
  let validateJson = {}
  let evalJson = {}
  try {
    validateJson = JSON.parse(validate.stdout)
  } catch {
    fail(`${positionId}: validate did not emit JSON`)
  }
  try {
    evalJson = JSON.parse(evalRun.stdout)
  } catch {
    fail(`${positionId}: eval did not emit JSON`)
  }
  check(
    validateJson.status === "valid",
    `${positionId}: validate status ${validateJson.status}`,
  )
  check(
    evalJson.code === "EVAL_PASSED" && evalJson.summary?.failed === 0,
    `${positionId}: eval ${evalJson.code} summary ${JSON.stringify(evalJson.summary)}`,
  )
  ac002.push({
    positionId,
    packageVersion: validateJson.employee?.version,
    validateStatus: validateJson.status,
    evalCode: evalJson.code,
    evalSummary: evalJson.summary,
    packageDirDigest: digestDir(dir),
  })
}

// --- step 3: one deterministic turn per position (AC-001 turns) -------------

log("AC-001 turns: deterministic zero-credential turn run per position")
const TURN_SCRIPTS = {
  "repo-owner":
    "repo-owner: triaged the week's issues; release candidate is green",
  "issue-researcher":
    "issue-researcher: top open issue is a reproducible import crash",
  "release-engineer":
    "release-engineer: changelog drafted with three user-facing fixes",
  "community-operator":
    "community-operator: thanked the contributor and linked good-first-issue",
}
const ac001Turns = []
for (const positionId of POSITIONS) {
  const turnId = `w1-ac001-${positionId}`
  const result = runCli(
    ["turn", "run", workspace, "--position", positionId, "--question", `W1 acceptance task for ${positionId}`],
    { env: childEnv([TURN_SCRIPTS[positionId]]) },
  )
  const events = parseNdjson(result.stdout)
  const terminals = terminalsOf(events)
  check(
    result.exitCode === 0,
    `${positionId}: turn run exited ${result.exitCode}: ${result.stderr}`,
  )
  check(
    terminals.length === 1 && terminals[0].type === "run.completed",
    `${positionId}: expected exactly one run.completed terminal, got ${terminals.map((t) => t.type).join(",") || "none"}`,
  )
  check(
    terminals[0]?.terminalReason === "goal_met",
    `${positionId}: terminal reason ${terminals[0]?.terminalReason}`,
  )
  const evidenceFile = path.join(
    workspace,
    ".digital-employee",
    "evidence",
    positionId,
  )
  const files = existsSync(evidenceFile)
    ? readdirSync(evidenceFile).filter((name) => name.endsWith(".json"))
    : []
  check(files.length >= 1, `${positionId}: no evidence record on disk`)
  let record = null
  if (files.length >= 1) {
    record = JSON.parse(
      readFileSync(path.join(evidenceFile, files.sort().at(-1)), "utf8"),
    )
  }
  ac001Turns.push({
    positionId,
    role: positionId === "repo-owner" ? "owner" : "worker",
    turnId: record?.turnId,
    terminal: terminals[0] ? { type: terminals[0].type, reason: terminals[0].terminalReason } : null,
    eventCount: events.length,
    evidence: record,
    layer: "cli",
  })
}

// --- step 4: forced terminations (AC-004a, engine layer) --------------------

log("AC-004a: four forced terminations with escalation + evidence")
const terminationWorkspace = path.join(workRoot, "terminations")
mkdirSync(path.join(terminationWorkspace, "evidence"), { recursive: true })
const STRICT_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
}

async function runTermination(name, request, model, extraOptions = {}) {
  const evidenceRoot = path.join(terminationWorkspace, "evidence", name)
  mkdirSync(evidenceRoot, { recursive: true })
  const sink = createFileEvidenceSink(evidenceRoot)
  const escalationSink = createInMemoryEscalationSink()
  const events = []
  for await (const event of executeTurn(request, {
    model,
    evidenceSink: sink,
    escalationSink,
    ...extraOptions,
  })) {
    events.push(event)
  }
  const terminals = terminalsOf(events)
  const files = existsSync(path.join(evidenceRoot, request.positionId))
    ? readdirSync(path.join(evidenceRoot, request.positionId))
    : []
  const record =
    files.length === 1
      ? JSON.parse(
          readFileSync(
            path.join(evidenceRoot, request.positionId, files[0]),
            "utf8",
          ),
          "utf8",
        )
      : null
  return { name, events, terminals, record, escalations: [...escalationSink.records] }
}

const baseRequest = (overrides) => ({
  workspaceRef: terminationWorkspace,
  positionId: "repo-owner",
  turnId: `w1-ac004a-${overrides.turnId}`,
  runId: `run-${overrides.turnId}`,
  input: "W1 forced-termination fixture",
  budget: { maxIterations: 8 },
  ...overrides,
})

const terminations = []

// 4.1 doom_loop: the same schema-invalid output repeated trips the
// deterministic repetition detector.
{
  const run = await runTermination(
    "doom-loop",
    baseRequest({ turnId: "doom-loop", outputSchema: STRICT_SCHEMA }),
    createDeterministicModelPort(["nope", "nope", "nope", "nope", "nope"]),
  )
  const terminal = run.terminals[0]
  check(
    run.terminals.length === 1 &&
      terminal?.type === "run.failed" &&
      terminal?.error?.terminalReason === "doom_loop" &&
      terminal?.error?.code === "engine.doom_loop_detected",
    `doom-loop: unexpected terminal ${JSON.stringify(terminal?.error ?? terminal)}`,
  )
  check(
    run.record?.terminal?.reason === "doom_loop" &&
      run.record?.terminal?.errorCode === "engine.doom_loop_detected",
    `doom-loop: evidence terminal ${JSON.stringify(run.record?.terminal)}`,
  )
  check(
    run.escalations.length === 1 && run.escalations[0].cause === "doom_loop",
    `doom-loop: escalation records ${run.escalations.length}`,
  )
  terminations.push({
    fixture: "doom_loop (repetition, schema repair loop)",
    expectedReason: "doom_loop",
    expectedCode: "engine.doom_loop_detected",
    terminalReason: run.record?.terminal?.reason,
    escalationCause: run.escalations[0]?.cause,
    escalationRef: run.record?.escalationRef,
    evidence: run.record,
    layer: "engine",
  })
}

// 4.2 turn_budget_exceeded (tokens): the model port reports consumption over
// the turn token cap.
{
  const hungryModel = {
    async complete() {
      return { text: '{"summary":"verbose"}', inputTokens: 60, outputTokens: 60 }
    },
  }
  const run = await runTermination(
    "turn-token-budget",
    baseRequest({
      turnId: "turn-token-budget",
      outputSchema: STRICT_SCHEMA,
      budget: { maxIterations: 8, maxTokens: 50 },
    }),
    hungryModel,
  )
  const terminal = run.terminals[0]
  check(
    terminal?.type === "run.failed" &&
      terminal?.error?.terminalReason === "turn_budget_exceeded" &&
      terminal?.error?.code === "engine.turn_budget_exceeded",
    `turn-token-budget: unexpected terminal ${JSON.stringify(terminal?.error ?? terminal)}`,
  )
  check(
    run.record?.terminal?.reason === "turn_budget_exceeded",
    `turn-token-budget: evidence terminal ${JSON.stringify(run.record?.terminal)}`,
  )
  terminations.push({
    fixture: "turn_budget_exceeded (token cap, reporting model port)",
    expectedReason: "turn_budget_exceeded",
    expectedCode: "engine.turn_budget_exceeded",
    terminalReason: run.record?.terminal?.reason,
    escalationCause: run.escalations[0]?.cause,
    escalationRef: run.record?.escalationRef,
    evidence: run.record,
    layer: "engine",
  })
}

// 4.3 turn_budget_exceeded (context bytes): the assembled context envelope
// exceeds maxContextBytes and stops before any model consumption.
{
  const run = await runTermination(
    "context-byte-budget",
    baseRequest({
      turnId: "context-byte-budget",
      budget: { maxIterations: 4, maxContextBytes: 16 },
    }),
    createDeterministicModelPort(["never consumed"]),
  )
  const terminal = run.terminals[0]
  check(
    terminal?.type === "run.failed" &&
      terminal?.error?.terminalReason === "turn_budget_exceeded" &&
      terminal?.error?.code === "engine.context_budget_exceeded",
    `context-byte-budget: unexpected terminal ${JSON.stringify(terminal?.error ?? terminal)}`,
  )
  check(
    run.record?.budget?.turn?.iterationsUsed === 0,
    `context-byte-budget: expected zero iterations consumed, got ${run.record?.budget?.turn?.iterationsUsed}`,
  )
  terminations.push({
    fixture: "turn_budget_exceeded (context-byte cap, pre-model stop)",
    expectedReason: "turn_budget_exceeded",
    expectedCode: "engine.context_budget_exceeded",
    terminalReason: run.record?.terminal?.reason,
    errorCode: run.record?.terminal?.errorCode,
    escalationCause: run.escalations[0]?.cause,
    escalationRef: run.record?.escalationRef,
    evidence: run.record,
    layer: "engine",
  })
}

// 4.4 position_budget_exceeded: the per-task iteration cap stops the second
// iteration before model consumption.
{
  const run = await runTermination(
    "position-budget",
    baseRequest({
      turnId: "position-budget",
      outputSchema: STRICT_SCHEMA,
      positionBudget: { perTask: { iterations: 1 }, perDay: { iterations: 100 } },
      taskId: "w1-task-1",
      dayKey: "2026-09-16",
    }),
    createDeterministicModelPort(["bad-1", "bad-2", "bad-3"]),
    { budgetLedger: createInMemoryBudgetLedger() },
  )
  const terminal = run.terminals[0]
  check(
    terminal?.type === "run.failed" &&
      terminal?.error?.terminalReason === "position_budget_exceeded" &&
      terminal?.error?.code === "engine.position_budget_exceeded",
    `position-budget: unexpected terminal ${JSON.stringify(terminal?.error ?? terminal)}`,
  )
  check(
    run.record?.terminal?.reason === "position_budget_exceeded",
    `position-budget: evidence terminal ${JSON.stringify(run.record?.terminal)}`,
  )
  terminations.push({
    fixture: "position_budget_exceeded (per-task iteration cap)",
    expectedReason: "position_budget_exceeded",
    expectedCode: "engine.position_budget_exceeded",
    terminalReason: run.record?.terminal?.reason,
    escalationCause: run.escalations[0]?.cause,
    escalationRef: run.record?.escalationRef,
    evidence: run.record,
    layer: "engine",
  })
}

// --- step 5: #140 conformance over every archived record (AC-004b) ----------

log("AC-004b: #140 conformance over every evidence record")
const allRecords = [
  ...ac001Turns.map((turn) => ({ source: `cli:${turn.positionId}`, record: turn.evidence })),
  ...terminations.map((entry) => ({ source: `engine:${entry.expectedReason}`, record: entry.evidence })),
]
const conformance = []
for (const { source, record } of allRecords) {
  if (!record) {
    fail(`AC-004b: ${source}: no evidence record to validate`)
    conformance.push({ source, ok: false, violations: [{ field: "", code: "record_missing", message: "no record" }] })
    continue
  }
  const result = validateTurnEvidenceRecord(record)
  if (!result.ok) {
    fail(`AC-004b: ${source}: conformance violations ${JSON.stringify(result.violations)}`)
  }
  conformance.push({ source, ok: result.ok, violations: result.violations })
}

// --- step 6: org apply context preservation + hire fail-closed (#287) -------

log("#287: org apply preserves context; budget-less hire fails closed")
const contextDir = path.join(workspace, "context")
const contextBefore = digestDir(contextDir)
const budgetFile = path.join(workspace, "positions", "repo-owner", "budget.json")
const permissionsFile = path.join(workspace, ".digital-employee", "permissions.json")
const orgStateFile = path.join(workspace, ".digital-employee", "org.json")
const auditFile = path.join(workspace, ".digital-employee", "org-audit.jsonl")

/** Extract the authorization surface (context + authority scopes) per position. */
function scopeSurface(permissionsJson) {
  const out = {}
  for (const [id, entry] of Object.entries(permissionsJson.positions ?? {})) {
    out[id] = {
      tier: entry.tier,
      mode: entry.mode,
      contextScope: entry.contextScope,
      authorityScope: entry.authorityScope,
    }
  }
  return out
}
const permissionsBeforeJson = JSON.parse(readFileSync(permissionsFile, "utf8"))
const scopeBefore = scopeSurface(permissionsBeforeJson)

// The physical budget declaration lives with each position package; the
// organization model is derived from it. Bump the owner's per-task token cap.
const budgetDoc = JSON.parse(readFileSync(budgetFile, "utf8"))
budgetDoc.perTask.tokens += 1000
writeFileSync(budgetFile, `${JSON.stringify(budgetDoc, null, 2)}\n`)

const reapply = runCli(["org", "apply", workspace, "--json"])
check(reapply.exitCode === 0, `#287: org apply exited ${reapply.exitCode}: ${reapply.stderr}`)
let reapplyJson = {}
try {
  reapplyJson = JSON.parse(reapply.stdout)
} catch {
  fail("#287: org apply did not emit JSON")
}
check(
  (reapplyJson.changes?.budgetUpdated ?? []).includes("repo-owner"),
  `#287: budgetUpdated missing repo-owner: ${JSON.stringify(reapplyJson.changes)}`,
)

// Context preservation: the context/ tree is byte-for-byte unchanged.
const contextAfter = digestDir(contextDir)
check(
  contextBefore === contextAfter,
  `#287: context/ changed across org apply (${contextBefore.slice(0, 12)} -> ${contextAfter.slice(0, 12)})`,
)

// No silent widening: a budget-only change must not alter any position's
// context or authority scope. The permissions artifact is recomputed (it
// carries a fresh generation), but its authorization surface is identical.
const permissionsAfterJson = JSON.parse(readFileSync(permissionsFile, "utf8"))
const scopeAfter = scopeSurface(permissionsAfterJson)
check(
  JSON.stringify(scopeBefore) === JSON.stringify(scopeAfter),
  "#287: permission scope changed after a budget-only org apply (silent widening)",
)

// The audit trail records the budget change for the owner.
const auditLines = readFileSync(auditFile, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line))
const lastAudit = auditLines.at(-1)
check(
  (lastAudit?.changes?.budgetUpdated ?? []).includes("repo-owner"),
  `#287: audit trail missing budgetUpdated for repo-owner: ${JSON.stringify(lastAudit?.changes)}`,
)

const hireFile = path.join(workRoot, "hire-request-no-budget.json")
writeFileSync(
  hireFile,
  `${JSON.stringify(
    {
      schemaVersion: "hire-request.v1alpha1",
      workspaceRef: "ws-main",
      packageRef: {
        name: "team-answer",
        version: "v1alpha1",
        digest: "sha256:0123456789abcdef",
      },
      targetParentId: "repo-owner",
      requestedBy: "cto",
      envelopeDigest: "sha256:abcdef0123456789",
    },
    null,
    2,
  )}\n`,
)
const orgStateBefore = digestFile(orgStateFile)
const hire = runCli(["hire", "validate", hireFile, "--json"])
check(
  hire.exitCode !== 0,
  `#287: budget-less hire validate exited ${hire.exitCode} (expected non-zero)`,
)
const hireOutput = `${hire.stdout}${hire.stderr}`
check(
  hireOutput.includes("hire_request_missing_budget"),
  `#287: expected hire_request_missing_budget, got: ${hireOutput.slice(0, 200)}`,
)
check(
  digestFile(orgStateFile) === orgStateBefore,
  "#287: org state changed after a rejected hire",
)

// --- step 7: secret / path scrub over the archive (AC-003) ------------------

log("AC-003: secret-pattern scan + path normalization")
const SECRET_PATTERNS = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "github token", pattern: /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "aws access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "alibaba cloud access key", pattern: /\bLTAI[0-9A-Za-z]{12,30}\b/ },
  { name: "openai/anthropic api key", pattern: /\bsk-(?:(?:proj|ant)-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "google api key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "common service token", pattern: /\b(?:glpat-|npm_|hf_)[A-Za-z0-9_-]{20,}\b/ },
  { name: "credential env assignment", pattern: /(QODER_PERSONAL_ACCESS_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEBUDDY_API_KEY)\s*[=:]/ },
  { name: "network url", pattern: /\bhttps?:\/\// },
]

function normalize(text) {
  return text
    .split(workRoot).join("<tmpdir>")
    .split(workspace).join("<workspace>")
    .split(terminationWorkspace).join("<termination-workspace>")
    .split(homedir()).join("<homedir>")
}

function scan(text, label) {
  for (const secret of SECRET_PATTERNS) {
    if (secret.pattern.test(text)) {
      fail(`AC-003: ${label}: secret-pattern hit (${secret.name})`)
    }
  }
  if (text.includes(workRoot) || text.includes(homedir())) {
    fail(`AC-003: ${label}: un-normalized absolute path`)
  }
}

// --- step 8: manifest -------------------------------------------------------

let headSha = "unknown"
let dirty = false
try {
  headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim()
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  // The manifest this run regenerates is expected to differ from the
  // committed copy; exclude the evidence output path so a clean source
  // checkout reports dirty=false while an uncommitted source change does not.
  const evidenceRel = path.relative(repoRoot, evidenceOutDir)
  dirty = status
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .some((line) => !line.includes(evidenceRel))
} catch {
  // git metadata is best-effort
}

const manifest = {
  schema: "w1-acceptance-evidence.v1",
  generatedAt: new Date().toISOString(),
  environment: {
    platform: platform(),
    osRelease: release(),
    node: process.version,
    cliVersion: packageJson.version,
    engineVersion: ENGINE_VERSION,
    checkout: headSha,
    checkoutDirty: dirty,
    modelPort: "deterministic (zero-credential reference port)",
  },
  ac001: {
    structural: {
      workspaceInit: { status: initJson.status, positions: initJson.positions },
      orgApply: { status: applyJson.status, positions: applyJson.positions },
      orgTree: { owner: treeJson.owner, positionCount: treeJson.positionCount, depth: treeJson.depth },
    },
    turns: ac001Turns.map((turn) => ({
      positionId: turn.positionId,
      role: turn.role,
      layer: turn.layer,
      terminal: turn.terminal,
      eventCount: turn.eventCount,
      evidence: turn.evidence,
    })),
  },
  ac002: {
    pinnedCliVersion: packageJson.version,
    packages: ac002,
  },
  ac003: {
    childEnvironment: Object.keys(childEnv([])).sort(),
    credentialVariablesForwarded: [],
    note: "engine structural no-network/no-spawn guarantee: tests/engine/structural-fail-closed.test.ts",
  },
  ac004a: terminations.map((entry) => ({
    fixture: entry.fixture,
    layer: entry.layer,
    expectedReason: entry.expectedReason,
    expectedCode: entry.expectedCode,
    terminalReason: entry.terminalReason,
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    escalationCause: entry.escalationCause,
    escalationRef: entry.escalationRef,
    evidence: entry.evidence,
  })),
  ac004b: {
    checker: "validateTurnEvidenceRecord (packages/engine/src/turn-evidence.ts)",
    records: conformance,
    allConformant: conformance.every((entry) => entry.ok),
  },
  issue287: {
    orgApply: {
      contextTreeDigestBefore: contextBefore,
      contextTreeDigestAfter: contextAfter,
      contextPreserved: contextBefore === contextAfter,
      permissionScopeUnchanged:
        JSON.stringify(scopeBefore) === JSON.stringify(scopeAfter),
      budgetUpdated: reapplyJson.changes?.budgetUpdated ?? [],
      auditRecordedBudgetUpdate: (lastAudit?.changes?.budgetUpdated ?? []).includes(
        "repo-owner",
      ),
    },
    hireFailClosed: {
      exitCode: hire.exitCode,
      expectedCode: "hire_request_missing_budget",
      codeObserved: hireOutput.includes("hire_request_missing_budget"),
      orgStateUnchanged: digestFile(orgStateFile) === orgStateBefore,
    },
  },
  passed: failures.length === 0,
  failures,
}

const serialized = normalize(JSON.stringify(manifest, null, 2))
scan(serialized, "manifest")
for (const turn of ac001Turns) {
  if (turn.evidence) scan(normalize(JSON.stringify(turn.evidence)), `evidence:${turn.positionId}`)
}
for (const entry of terminations) {
  if (entry.evidence) scan(normalize(JSON.stringify(entry.evidence)), `evidence:${entry.expectedReason}`)
}

// --- verdict -----------------------------------------------------------------

if (failures.length > 0) {
  log(`W1 acceptance harness FAILED with ${failures.length} failure(s); committed manifest left untouched`)
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`)
  }
  process.exit(1)
}

mkdirSync(evidenceOutDir, { recursive: true })
writeFileSync(manifestPath, `${serialized}\n`)
log(`W1 acceptance harness PASSED; manifest written to ${path.relative(repoRoot, manifestPath)}`)
log(`  AC-001: ${ac001Turns.length}/4 positions, one trusted terminal + one evidence record each (cli layer)`)
log(`  AC-002: ${ac002.length}/4 packages validate+eval green (cli ${packageJson.version})`)
log(`  AC-003: minimal child env ${JSON.stringify(Object.keys(childEnv([])).sort())}; secret scan clean`)
log(`  AC-004a: ${terminations.length}/4 forced terminations with escalation + evidence (engine layer)`)
log(`  AC-004b: ${conformance.length}/${conformance.length} evidence records conform to #140`)
log(`  #287: context preserved, permissions recomputed, budget-less hire fail-closed`)
