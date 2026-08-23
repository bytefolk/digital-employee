/**
 * Black-box tests for `digital-employee org` (#157 V2/V3, #159).
 *
 * Requirement trace:
 *   https://github.com/fullstack-ai-infra/digital-employee/issues/157 (R3)
 *   AC-002: org tree renders hierarchy/depth; --json passes org-tree.v1
 *           fixture checks.
 *   AC-003: org apply recomputes permissions (seam verified; memory recall
 *           lands with I-05).
 *   AC-004: directory-tree operations — add hires, move changes the
 *           reporting line, delete dismisses with an audit record.
 *   AC-005: budget gate — a hire without a fully allocated budget fails
 *           closed with a stable code and the org model stays unchanged.
 *   https://github.com/fullstack-ai-infra/digital-employee/issues/159 (R2)
 *   AC-001: owner vs worker authority tiers differ as specified.
 *   AC-002: worker asking owner-only/secret info is rejected with a
 *           redirect to the owner.
 *   AC-003: write operations are default-deny.
 */

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const builtCli = path.join(root, "dist", "apps", "cli", "bin.js")
const orgTreeFixture = path.join(
  root,
  "tests",
  "apps",
  "fixtures",
  "org-tree-oss-maintainer.json",
)

function cliEnvironment(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  delete environment.LANG
  delete environment.LC_ALL
  return {
    ...environment,
    HOME: home,
    PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    ...extra,
  }
}

function runCli(
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  return spawnSync(process.execPath, [builtCli, ...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    input: "",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  })
}

async function freshHome(t: test.TestContext): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "org-cli-home-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>
}

async function initWorkspace(
  t: test.TestContext,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const target = path.join(home, "oss")
  const result = runCli(
    ["workspace", "init", target, "--template", "oss-maintainer"],
    env,
    home,
  )
  assert.equal(result.status, 0, result.stderr)
  return target
}

function statePaths(target: string) {
  return {
    stateDir: path.join(target, ".digital-employee"),
    model: path.join(target, ".digital-employee", "org.json"),
    audit: path.join(target, ".digital-employee", "org-audit.jsonl"),
    permissions: path.join(target, ".digital-employee", "permissions.json"),
  }
}

async function readAuditEntries(auditPath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(auditPath, "utf8")
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Craft a hire by cloning the issue-researcher package into a new position
 * directory, rewriting the package identity, and (optionally) writing a
 * budget.json declaration.
 */
async function craftHirePackage(
  target: string,
  parentSegments: string[],
  newId: string,
  budget: Record<string, unknown> | undefined,
): Promise<string> {
  const source = path.join(target, "positions", "repo-owner", "issue-researcher")
  const destination = path.join(target, "positions", ...parentSegments, newId)
  await cp(source, destination, { recursive: true })
  const manifestPath = path.join(destination, "employee.json")
  const manifest = (await readJson(manifestPath)) as Record<string, unknown>
  manifest.name = newId
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const skillPath = path.join(destination, "SKILL.md")
  const skill = await readFile(skillPath, "utf8")
  await writeFile(skillPath, skill.replaceAll("issue-researcher", newId))
  const budgetPath = path.join(destination, "budget.json")
  if (budget === undefined) {
    await rm(budgetPath, { force: true })
  } else {
    await writeFile(budgetPath, `${JSON.stringify(budget, null, 2)}\n`)
  }
  return destination
}

const VALID_HIRE_BUDGET = {
  perTask: { tokens: 15_000, iterations: 6 },
  perDay: { tokens: 150_000, iterations: 48 },
}

test("org apply bootstraps the organization model, audit log, and permissions", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)
  const paths = statePaths(target)

  const result = runCli(["org", "apply", target, "--json"], env, home)
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>
  assert.equal(parsed.status, "applied")
  assert.equal(parsed.bootstrapped, true)
  assert.equal(parsed.positions, 4)
  assert.deepEqual(parsed.changes, {
    hired: [],
    moved: [],
    dismissed: [],
    budgetUpdated: [],
  })

  // Private state files exist with owner-only permissions.
  const modelStat = await stat(paths.model)
  assert.equal(modelStat.mode & 0o777, 0o600)
  const auditStat = await stat(paths.audit)
  assert.equal(auditStat.mode & 0o777, 0o600)
  const permissionsStat = await stat(paths.permissions)
  assert.equal(permissionsStat.mode & 0o777, 0o600)
  const stateStat = await stat(paths.stateDir)
  assert.equal(stateStat.mode & 0o777, 0o700)

  // The applied model carries the full workspace-org.v1 contract.
  const model = await readJson(paths.model)
  assert.equal(model.schemaVersion, "workspace-org.v1")
  assert.equal(model.business, "oss")
  assert.equal(model.owner, "repo-owner")
  const roles = model.roles as Array<Record<string, unknown>>
  assert.deepEqual(
    [...roles.map((role) => String(role.id))].sort(),
    ["community-operator", "issue-researcher", "release-engineer", "repo-owner"],
  )
  for (const role of roles) {
    const budget = role.budget as Record<string, unknown>
    assert.ok(budget.perTask, `budget.perTask for ${String(role.id)}`)
    assert.ok(budget.perDay, `budget.perDay for ${String(role.id)}`)
  }

  // The audit log records the bootstrap apply (append-only JSONL).
  const audit = await readAuditEntries(paths.audit)
  assert.equal(audit.length, 1)
  assert.equal(audit[0]!.schemaVersion, "org-audit.v1")
  assert.equal(audit[0]!.bootstrapped, true)
  assert.equal(audit[0]!.positionCount, 4)

  // Permission recomputation seam (#159): tiers derived from the org model.
  const permissions = await readJson(paths.permissions)
  assert.equal(permissions.schemaVersion, "org-permissions.v1")
  const positions = permissions.positions as Record<string, Record<string, unknown>>
  assert.equal(positions["repo-owner"]!.tier, "owner")
  assert.equal(positions["issue-researcher"]!.tier, "worker")
})

test("org apply is idempotent on an unchanged tree", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)
  const paths = statePaths(target)
  assert.equal(runCli(["org", "apply", target, "--json"], env, home).status, 0)

  const second = runCli(["org", "apply", target, "--json"], env, home)
  assert.equal(second.status, 0, second.stderr)
  const parsed = JSON.parse(second.stdout) as Record<string, unknown>
  assert.equal(parsed.status, "applied")
  assert.equal(parsed.bootstrapped, false)
  assert.deepEqual(parsed.changes, {
    hired: [],
    moved: [],
    dismissed: [],
    budgetUpdated: [],
  })
  const audit = await readAuditEntries(paths.audit)
  assert.equal(audit.length, 2)
})

test("AC-004: adding a position directory with a valid package and budget hires it", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)
  const paths = statePaths(target)
  assert.equal(runCli(["org", "apply", target, "--json"], env, home).status, 0)

  await craftHirePackage(target, ["repo-owner"], "support-engineer", VALID_HIRE_BUDGET)

  const result = runCli(["org", "apply", target, "--json"], env, home)
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>
  assert.deepEqual(parsed.changes, {
    hired: ["support-engineer"],
    moved: [],
    dismissed: [],
    budgetUpdated: [],
  })

  const model = await readJson(paths.model)
  const hired = (model.roles as Array<Record<string, unknown>>).find(
    (role) => role.id === "support-engineer",
  )
  assert.ok(hired, "support-engineer exists in the applied model")
  assert.equal(hired.reportTo, "repo-owner")
  assert.deepEqual(hired.budget, VALID_HIRE_BUDGET)
  const pkg = hired.package as Record<string, unknown>
  assert.match(String(pkg.digest), /^sha256:[a-f0-9]{64}$/)
  assert.equal(
    pkg.localReference,
    path.join(target, "positions", "repo-owner", "support-engineer"),
  )
  // Hire default-deny posture: no tools granted until declared (#159).
  assert.deepEqual(hired.toolAllow, [])

  // The audit entry records the full hired position (budget included).
  const audit = await readAuditEntries(paths.audit)
  const lastEntry = audit.at(-1)!
  const changes = lastEntry.changes as Record<string, unknown>
  const hiredRecords = changes.hired as Array<Record<string, unknown>>
  assert.equal(hiredRecords.length, 1)
  assert.equal(hiredRecords[0]!.id, "support-engineer")
  assert.deepEqual(hiredRecords[0]!.budget, VALID_HIRE_BUDGET)

  // org tree shows the new position reporting to its parent.
  const tree = runCli(["org", "tree", target], env, home)
  assert.equal(tree.status, 0, tree.stderr)
  assert.match(tree.stdout, /support-engineer/)

  const permissions = await readJson(paths.permissions)
  const positions = permissions.positions as Record<string, Record<string, unknown>>
  assert.equal(positions["support-engineer"]!.tier, "worker")
})

test("AC-005: hires without a fully allocated budget fail closed with zero org changes", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)
  const paths = statePaths(target)
  assert.equal(runCli(["org", "apply", target, "--json"], env, home).status, 0)

  const samples: Array<{
    name: string
    budget: Record<string, unknown> | undefined
    code: string
    recovery: RegExp
  }> = [
    {
      name: "missing-budget",
      budget: undefined,
      code: "workspace_org_budget_missing",
      recovery: /Declare a budget/,
    },
    {
      name: "partial-budget",
      budget: { perTask: { tokens: 1_000 } },
      code: "workspace_org_budget_not_allocated",
      recovery: /Fully allocate the budget/,
    },
    {
      name: "invalid-budget",
      budget: { perTask: { tokens: 0 }, perDay: { tokens: 1 } },
      code: "workspace_org_budget_invalid",
      recovery: /Fix the budget caps/,
    },
  ]
  for (const sample of samples) {
    await rm(path.join(target, "positions", "repo-owner", sample.name), {
      recursive: true,
      force: true,
    })
    await craftHirePackage(target, ["repo-owner"], sample.name, sample.budget)
    const beforeModel = await readFile(paths.model, "utf8")
    const beforeAudit = await readFile(paths.audit, "utf8")
    const beforePermissions = await readFile(paths.permissions, "utf8")

    const jsonResult = runCli(["org", "apply", target, "--json"], env, home)
    assert.equal(jsonResult.status, 1, `expected fail-closed for ${sample.name}`)
    const parsed = JSON.parse(jsonResult.stdout) as Record<string, unknown>
    assert.equal(parsed.status, "failed")
    assert.equal(parsed.code, sample.code)

    const textResult = runCli(["org", "apply", target], env, home)
    assert.equal(textResult.status, 1)
    assert.match(textResult.stderr, sample.recovery)

    // The organization model is byte-for-byte unchanged (no partial writes).
    assert.equal(await readFile(paths.model, "utf8"), beforeModel, sample.name)
    assert.equal(await readFile(paths.audit, "utf8"), beforeAudit, sample.name)
    assert.equal(
      await readFile(paths.permissions, "utf8"),
      beforePermissions,
      sample.name,
    )
    await rm(path.join(target, "positions", "repo-owner", sample.name), {
      recursive: true,
      force: true,
    })
  }
})

test("AC-005: an invalid hire before the first apply leaves no organization state", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)
  await craftHirePackage(target, ["repo-owner"], "unbudgeted", undefined)

  const result = runCli(["org", "apply", target, "--json"], env, home)
  assert.equal(result.status, 1)
  assert.equal(
    (JSON.parse(result.stdout) as Record<string, unknown>).code,
    "workspace_org_budget_missing",
  )
  await assert.rejects(stat(path.join(target, ".digital-employee")))
})

test("AC-004: moving a position directory changes the reporting line", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)
  const paths = statePaths(target)
  assert.equal(runCli(["org", "apply", target, "--json"], env, home).status, 0)

  const source = path.join(target, "positions", "repo-owner", "community-operator")
  const destination = path.join(
    target,
    "positions",
    "repo-owner",
    "release-engineer",
    "community-operator",
  )
  await rename(source, destination)

  const result = runCli(["org", "apply", target, "--json"], env, home)
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>
  assert.deepEqual(parsed.changes, {
    hired: [],
    moved: [{ id: "community-operator", from: "repo-owner", to: "release-engineer" }],
    dismissed: [],
    budgetUpdated: [],
  })

  const model = await readJson(paths.model)
  const moved = (model.roles as Array<Record<string, unknown>>).find(
    (role) => role.id === "community-operator",
  )
  assert.ok(moved)
  assert.equal(moved.reportTo, "release-engineer")
  assert.equal(
    (moved.package as Record<string, unknown>).localReference,
    destination,
  )

  const audit = await readAuditEntries(paths.audit)
  const lastChanges = audit.at(-1)!.changes as Record<string, unknown>
  assert.deepEqual(lastChanges.moved, [
    { id: "community-operator", from: "repo-owner", to: "release-engineer" },
  ])

  const tree = JSON.parse(
    runCli(["org", "tree", target, "--json"], env, home).stdout,
  ) as Record<string, unknown>
  assert.equal(tree.depth, 3)
})

test("AC-004: deleting a position directory dismisses it with an audit record", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)
  const paths = statePaths(target)
  assert.equal(runCli(["org", "apply", target, "--json"], env, home).status, 0)

  const modelBefore = await readJson(paths.model)
  const dismissedSource = (modelBefore.roles as Array<Record<string, unknown>>).find(
    (role) => role.id === "release-engineer",
  )
  assert.ok(dismissedSource)

  await rm(path.join(target, "positions", "repo-owner", "release-engineer"), {
    recursive: true,
    force: true,
  })
  const result = runCli(["org", "apply", target, "--json"], env, home)
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>
  assert.deepEqual(
    (parsed.changes as Record<string, unknown>).dismissed,
    ["release-engineer"],
  )

  const model = await readJson(paths.model)
  assert.ok(
    !(model.roles as Array<Record<string, unknown>>).some(
      (role) => role.id === "release-engineer",
    ),
    "dismissed position removed from the model",
  )

  // No silent removal: the audit entry carries the full dismissed record.
  const audit = await readAuditEntries(paths.audit)
  const lastChanges = audit.at(-1)!.changes as Record<string, unknown>
  const dismissed = lastChanges.dismissed as Array<Record<string, unknown>>
  assert.equal(dismissed.length, 1)
  assert.equal(dismissed[0]!.id, "release-engineer")
  assert.deepEqual(dismissed[0]!.budget, dismissedSource.budget)
  assert.ok(dismissed[0]!.package, "dismissed record keeps its package binding")

  const permissions = await readJson(paths.permissions)
  assert.ok(
    !(permissions.positions as Record<string, unknown>)["release-engineer"],
    "permissions recomputed without the dismissed position",
  )
})

test("org apply fails closed on stray non-position entries under positions/", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)
  const paths = statePaths(target)
  assert.equal(runCli(["org", "apply", target, "--json"], env, home).status, 0)
  const beforeModel = await readFile(paths.model, "utf8")

  await mkdir(path.join(target, "positions", "stray"), { recursive: true })
  const dirCase = runCli(["org", "apply", target, "--json"], env, home)
  assert.equal(dirCase.status, 1)
  assert.equal(
    (JSON.parse(dirCase.stdout) as Record<string, unknown>).code,
    "workspace_org_tree_position_invalid",
  )
  await rm(path.join(target, "positions", "stray"), { recursive: true, force: true })

  await writeFile(path.join(target, "positions", "notes.txt"), "stray\n")
  const fileCase = runCli(["org", "apply", target, "--json"], env, home)
  assert.equal(fileCase.status, 1)
  assert.equal(
    (JSON.parse(fileCase.stdout) as Record<string, unknown>).code,
    "workspace_org_tree_position_invalid",
  )
  assert.equal(await readFile(paths.model, "utf8"), beforeModel)
})

test("org apply fails closed on duplicate position ids", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)
  const paths = statePaths(target)
  assert.equal(runCli(["org", "apply", target, "--json"], env, home).status, 0)
  const beforeModel = await readFile(paths.model, "utf8")

  // Clone issue-researcher to the top level: one id at two locations.
  await craftHirePackage(target, [], "issue-researcher", VALID_HIRE_BUDGET)

  const result = runCli(["org", "apply", target, "--json"], env, home)
  assert.equal(result.status, 1)
  assert.equal(
    (JSON.parse(result.stdout) as Record<string, unknown>).code,
    "workspace_org_tree_duplicate_position",
  )
  assert.equal(await readFile(paths.model, "utf8"), beforeModel)
})

test("org commands outside a workspace fail closed and point at workspace init", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const empty = path.join(home, "empty")
  await mkdir(empty)

  const apply = runCli(["org", "apply", empty, "--json"], env, home)
  assert.equal(apply.status, 1)
  assert.equal(
    (JSON.parse(apply.stdout) as Record<string, unknown>).code,
    "workspace_org_workspace_not_initialized",
  )
  const applyText = runCli(["org", "apply", empty], env, home)
  assert.equal(applyText.status, 1)
  assert.match(applyText.stderr, /workspace init/)

  const tree = runCli(["org", "tree", empty, "--json"], env, home)
  assert.equal(tree.status, 1)
  assert.equal(
    (JSON.parse(tree.stdout) as Record<string, unknown>).code,
    "workspace_org_workspace_not_initialized",
  )
})

test("AC-002: org tree renders hierarchy and depth; --json passes the org-tree.v1 fixture", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)

  const text = runCli(["org", "tree", target], env, home)
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /oss \(owner: repo-owner\)/)
  assert.match(text.stdout, /^repo-owner \[owner\]$/m)
  assert.match(text.stdout, /├── community-operator/)
  assert.match(text.stdout, /├── issue-researcher/)
  assert.match(text.stdout, /└── release-engineer/)
  assert.match(text.stdout, /positions: 4 · depth: 2/)

  const json = runCli(["org", "tree", target, "--json"], env, home)
  assert.equal(json.status, 0, json.stderr)
  const parsed = JSON.parse(json.stdout) as Record<string, unknown>
  const fixture = (await readJson(orgTreeFixture)) as Record<string, unknown>
  // updatedAt is the applied-state timestamp: assert the ISO shape, then mask
  // it to the fixture value so the frozen-shape comparison stays
  // deterministic.
  assert.match(
    String(parsed.updatedAt),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/,
  )
  parsed.updatedAt = fixture.updatedAt
  assert.deepEqual(parsed, fixture)

  // org tree is read-only: it never materializes organization state.
  await assert.rejects(stat(path.join(target, ".digital-employee")))
})

test("org help surfaces usage; unknown subcommands fail closed", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)

  const help = runCli(["org", "help"], env, home)
  assert.equal(help.status, 0)
  assert.match(help.stdout, /digital-employee org apply \[workspace\]/)
  assert.match(help.stdout, /digital-employee org scope <position>/)

  const treeHelp = runCli(["org", "tree", "--help"], env, home)
  assert.equal(treeHelp.status, 0)
  assert.match(treeHelp.stdout, /org-tree\.v1/)

  const unknown = runCli(["org", "frobnicate", "--json"], env, home)
  assert.equal(unknown.status, 1)
  assert.equal(
    (JSON.parse(unknown.stdout) as Record<string, unknown>).code,
    "workspace_org_unknown_subcommand:frobnicate",
  )
})

test("org tree/apply reject multiple directory arguments", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)

  const tree = runCli(["org", "tree", "one", "two", "--json"], env, home)
  assert.equal(tree.status, 1)
  assert.equal(
    (JSON.parse(tree.stdout) as Record<string, unknown>).code,
    "workspace_org_accepts_one_directory",
  )
  const apply = runCli(["org", "apply", "one", "two", "--json"], env, home)
  assert.equal(apply.status, 1)
  assert.equal(
    (JSON.parse(apply.stdout) as Record<string, unknown>).code,
    "workspace_org_accepts_one_directory",
  )
})

test("#159 AC-001: org scope derives owner vs worker tiers from the org model", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)

  const owner = runCli(["org", "scope", "repo-owner", target, "--json"], env, home)
  assert.equal(owner.status, 0, owner.stderr)
  const ownerScope = JSON.parse(owner.stdout) as Record<string, unknown>
  assert.equal(ownerScope.tier, "owner")
  assert.deepEqual(ownerScope.contextScope, { read: ["./"] })
  const ownerAuthority = ownerScope.authorityScope as Record<string, unknown>
  assert.equal(ownerAuthority.writes, "deny")
  assert.deepEqual(
    (ownerAuthority.tools as Record<string, unknown>).allow,
    ["Read", "Grep", "Glob"],
  )
  assert.deepEqual(ownerAuthority.delegation, {
    allow: true,
    targets: ["community-operator", "issue-researcher", "release-engineer"],
    escalateTo: null,
  })

  const worker = runCli(
    ["org", "scope", "issue-researcher", target, "--json"],
    env,
    home,
  )
  assert.equal(worker.status, 0, worker.stderr)
  const workerScope = JSON.parse(worker.stdout) as Record<string, unknown>
  assert.equal(workerScope.tier, "worker")
  assert.deepEqual(workerScope.contextScope, {
    read: ["./positions/repo-owner/issue-researcher/", "./context/"],
  })
  const workerAuthority = workerScope.authorityScope as Record<string, unknown>
  assert.equal(workerAuthority.writes, "deny")
  assert.deepEqual(workerAuthority.delegation, {
    allow: false,
    targets: [],
    escalateTo: "repo-owner",
  })

  // The two tiers differ as specified (context breadth + delegation).
  assert.notDeepEqual(ownerScope.contextScope, workerScope.contextScope)
  assert.notDeepEqual(ownerAuthority.delegation, workerAuthority.delegation)
})

test("#159: allowlisted tools pass; undeclared and write tools are denied toward the owner", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)

  const allowed = runCli(
    ["org", "scope", "issue-researcher", target, "--tool", "Read", "--json"],
    env,
    home,
  )
  assert.equal(allowed.status, 0, allowed.stderr)
  assert.deepEqual(JSON.parse(allowed.stdout), {
    status: "allowed",
    position: "issue-researcher",
    tool: "Read",
  })

  const denied = runCli(
    ["org", "scope", "issue-researcher", target, "--tool", "Write", "--json"],
    env,
    home,
  )
  assert.equal(denied.status, 1)
  assert.deepEqual(JSON.parse(denied.stdout), {
    status: "denied",
    code: "workspace_org_authority_denied",
    position: "issue-researcher",
    requested: "Write",
    redirectTo: "repo-owner",
  })

  const deniedText = runCli(
    ["org", "scope", "issue-researcher", target, "--tool", "Write"],
    env,
    home,
  )
  assert.equal(deniedText.status, 1)
  assert.match(deniedText.stderr, /workspace_org_authority_denied/)
  // The rejection points at the correct entry: the owner position.
  assert.match(deniedText.stderr, /repo-owner/)
})

test("#159 AC-002: a worker asking owner-only context is rejected and pointed at the owner", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)

  // Owner-only: the organization state itself.
  const secret = runCli(
    [
      "org",
      "scope",
      "issue-researcher",
      target,
      "--context",
      ".digital-employee/org.json",
      "--json",
    ],
    env,
    home,
  )
  assert.equal(secret.status, 1)
  const secretParsed = JSON.parse(secret.stdout) as Record<string, unknown>
  assert.equal(secretParsed.status, "denied")
  assert.equal(secretParsed.code, "workspace_org_context_denied")
  assert.equal(secretParsed.redirectTo, "repo-owner")

  // Another position's context is out of scope too.
  const sibling = runCli(
    [
      "org",
      "scope",
      "issue-researcher",
      target,
      "--context",
      "./positions/repo-owner/release-engineer/employee.json",
      "--json",
    ],
    env,
    home,
  )
  assert.equal(sibling.status, 1)
  assert.equal(
    (JSON.parse(sibling.stdout) as Record<string, unknown>).code,
    "workspace_org_context_denied",
  )

  // The worker's own slice and the shared context directory stay readable.
  const own = runCli(
    [
      "org",
      "scope",
      "issue-researcher",
      target,
      "--context",
      "./positions/repo-owner/issue-researcher/SKILL.md",
      "--json",
    ],
    env,
    home,
  )
  assert.equal(own.status, 0, own.stderr)
  assert.equal((JSON.parse(own.stdout) as Record<string, unknown>).status, "allowed")

  const shared = runCli(
    ["org", "scope", "issue-researcher", target, "--context", "./context/README.md", "--json"],
    env,
    home,
  )
  assert.equal(shared.status, 0, shared.stderr)

  // The owner reads everything, including the organization state.
  const ownerRead = runCli(
    ["org", "scope", "repo-owner", target, "--context", ".digital-employee/org.json", "--json"],
    env,
    home,
  )
  assert.equal(ownerRead.status, 0, ownerRead.stderr)

  // Parent traversal never escapes the workspace.
  const traversal = runCli(
    ["org", "scope", "issue-researcher", target, "--context", "../escape", "--json"],
    env,
    home,
  )
  assert.equal(traversal.status, 1)
  assert.equal(
    (JSON.parse(traversal.stdout) as Record<string, unknown>).code,
    "workspace_org_context_path_invalid",
  )
})

test("#159: scope requests fail closed on unknown or missing positions", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)

  const unknown = runCli(["org", "scope", "ghost", target, "--json"], env, home)
  assert.equal(unknown.status, 1)
  assert.equal(
    (JSON.parse(unknown.stdout) as Record<string, unknown>).code,
    "workspace_org_position_unknown",
  )

  const missing = runCli(["org", "scope", "--json"], env, home)
  assert.equal(missing.status, 1)
  assert.equal(
    (JSON.parse(missing.stdout) as Record<string, unknown>).code,
    "workspace_org_position_required",
  )

  const both = runCli(
    [
      "org",
      "scope",
      "repo-owner",
      target,
      "--tool",
      "Read",
      "--context",
      "./x",
      "--json",
    ],
    env,
    home,
  )
  assert.equal(both.status, 1)
  assert.equal(
    (JSON.parse(both.stdout) as Record<string, unknown>).code,
    "workspace_org_scope_accepts_one_request",
  )
})

test("org scope honors --locale zh-CN for denials", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)

  const denied = runCli(
    [
      "org",
      "scope",
      "issue-researcher",
      target,
      "--tool",
      "Write",
      "--locale",
      "zh-CN",
    ],
    env,
    home,
  )
  assert.equal(denied.status, 1)
  assert.match(denied.stderr, /权限被拒绝/)
  assert.match(denied.stderr, /repo-owner/)
})

test("org apply updates budgets when a position's budget.json changes", async (t) => {
  const home = await freshHome(t)
  const env = cliEnvironment(home)
  const target = await initWorkspace(t, home, env)
  const paths = statePaths(target)
  assert.equal(runCli(["org", "apply", target, "--json"], env, home).status, 0)

  const budgetPath = path.join(
    target,
    "positions",
    "repo-owner",
    "issue-researcher",
    "budget.json",
  )
  const updated = {
    perTask: { tokens: 30_000, iterations: 10 },
    perDay: { tokens: 240_000, iterations: 80 },
  }
  await writeFile(budgetPath, `${JSON.stringify(updated, null, 2)}\n`)

  const result = runCli(["org", "apply", target, "--json"], env, home)
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>
  assert.deepEqual(
    (parsed.changes as Record<string, unknown>).budgetUpdated,
    ["issue-researcher"],
  )
  const model = await readJson(paths.model)
  const role = (model.roles as Array<Record<string, unknown>>).find(
    (entry) => entry.id === "issue-researcher",
  )
  assert.deepEqual(role!.budget, updated)
})
