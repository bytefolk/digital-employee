/**
 * Fail-closed org command orchestration (#157 REQ-002/REQ-003/REQ-004/REQ-005,
 * #159 permission boundaries).
 *
 *   org tree [workspace]              render the reporting hierarchy
 *   org tree [workspace] --json       org-tree.v1 machine output
 *   org apply [workspace]             directory-tree driven apply
 *   org scope <position> [workspace]  derived Context/Authority Scope
 *
 * The command reuses the deploy/workspace i18n and fail-closed conventions:
 * input is validated before any effect, every failure carries a stable
 * `workspace_org_*` code with a localized recovery line, and JSON mode emits
 * `{ status: "failed", code }`.
 */

import path from "node:path"

import {
  detectSystemLocale,
  getAvailableLocales,
  hasMessage,
  setLocale,
  t,
} from "../deploy/i18n.js"
import type { SupportedLocale } from "../deploy/i18n.js"
import { safeFailureCode } from "../workspace/index.js"
import {
  applyOrganization,
  buildOrgTree,
  loadOrgModel,
  ORG_AUDIT_FILE,
  ORG_MODEL_FILE,
  ORG_PERMISSIONS_FILE,
  ORG_STATE_DIR,
} from "./model.js"
import type { OrgChangeSet, OrgTreeNode } from "./model.js"
import {
  deriveOrganizationPermissions,
  evaluateContextAccess,
  evaluateToolAuthority,
} from "./permissions.js"
import type { PermissionDecision } from "./permissions.js"

export interface OrgOptions {
  subcommand?: string
  args: string[]
  locale?: string
  json?: boolean
  help?: boolean
  tool?: string
  context?: string
  providedOptions?: ReadonlySet<string>
}

const ORG_OPTIONS = ["json", "locale", "help", "tool", "context"]

function supported(values: readonly string[]): string {
  return values.join("|")
}

function failInput(field: string, values: readonly string[], json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ status: "failed", code: `invalid_${field}` }, null, 2)}\n`,
    )
  } else {
    process.stderr.write(
      `${t("org.error_invalid_value", { field, supported: supported(values) })}\n`,
    )
  }
  process.exitCode = 1
}

function failOrg(key: string, code: string, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ status: "failed", code }, null, 2)}\n`)
  } else {
    process.stderr.write(`${t(key, { code })}\n`)
  }
  process.exitCode = 1
}

/**
 * Render the localized recovery line for a fail-closed org code. Org-domain
 * recovery keys live under `org.recovery_<code>`; budget codes reuse the
 * shared `workspace.recovery_<code>` catalog entries.
 */
function writeOrgRecovery(code: string, vars: Record<string, string> = {}): void {
  const orgKey = `org.recovery_${code}`
  if (hasMessage(orgKey)) {
    process.stderr.write(`${t(orgKey, vars)}\n`)
    return
  }
  const workspaceKey = `workspace.recovery_${code}`
  if (hasMessage(workspaceKey)) {
    process.stderr.write(`${t(workspaceKey, vars)}\n`)
  }
}

function explicitLocaleFromArgv(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!
    if (value.startsWith("--locale=")) return value.slice("--locale=".length)
    if (value === "--locale") return argv[index + 1]
  }
  return undefined
}

function initialLocale(requested: string | undefined, json: boolean): SupportedLocale {
  const locales = getAvailableLocales()
  if (requested !== undefined) {
    return locales.includes(requested) ? (requested as SupportedLocale) : "en"
  }
  return json ? "en" : detectSystemLocale()
}

interface OrgTargetOptions {
  directory?: string
  json: boolean
  help?: boolean
  argsCount: number
}

function resolveWorkspace(options: OrgTargetOptions): string {
  const directory = options.directory?.trim()
  return path.resolve(directory && directory.length > 0 ? directory : ".")
}

function failTooManyDirectories(json: boolean): void {
  failOrg(
    "org.error_incompatible_options",
    "workspace_org_accepts_one_directory",
    json,
  )
  writeOrgRecovery("workspace_org_accepts_one_directory")
}

function renderTreeLines(
  nodes: readonly OrgTreeNode[],
  owner: string,
  prefix: string,
  lines: string[],
  rootLevel: boolean,
): void {
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1
    const connector = rootLevel ? "" : last ? "└── " : "├── "
    const label = node.id === owner ? `${node.id} [owner]` : node.id
    lines.push(`${prefix}${connector}${label}`)
    const childPrefix = rootLevel ? "" : prefix + (last ? "    " : "│   ")
    renderTreeLines(node.children, owner, childPrefix, lines, false)
  })
}

async function orgTree(options: OrgTargetOptions): Promise<void> {
  const json = options.json
  if (options.help) {
    process.stdout.write(`${t("org.help_tree")}\n`)
    return
  }
  if (options.argsCount > 1) {
    failTooManyDirectories(json)
    return
  }
  const workspace = resolveWorkspace(options)
  try {
    const { model } = await loadOrgModel(workspace)
    const tree = buildOrgTree(model)
    if (json) {
      process.stdout.write(`${JSON.stringify(tree, null, 2)}\n`)
      return
    }
    process.stdout.write(
      `${t("org.tree_header", { business: tree.business, owner: tree.owner })}\n`,
    )
    const lines: string[] = []
    renderTreeLines(tree.tree, tree.owner, "", lines, true)
    for (const line of lines) process.stdout.write(`${line}\n`)
    process.stdout.write(
      `${t("org.tree_summary", {
        count: String(tree.positionCount),
        depth: String(tree.depth),
      })}\n`,
    )
  } catch (error) {
    const code = safeFailureCode(error, "workspace_org_tree_failed")
    failOrg("org.error_aborted", code, json)
    writeOrgRecovery(code)
  }
}

function changeCount(changes: OrgChangeSet): number {
  return (
    changes.hired.length +
    changes.moved.length +
    changes.dismissed.length +
    changes.budgetUpdated.length
  )
}

function reportingLabel(reportTo: string | null): string {
  return reportTo === null ? t("org.apply_root") : reportTo
}

async function orgApply(options: OrgTargetOptions): Promise<void> {
  const json = options.json
  if (options.help) {
    process.stdout.write(`${t("org.help_apply")}\n`)
    return
  }
  if (options.argsCount > 1) {
    failTooManyDirectories(json)
    return
  }
  const workspace = resolveWorkspace(options)
  let result
  try {
    result = await applyOrganization(workspace)
  } catch (error) {
    const code = safeFailureCode(error, "workspace_org_apply_failed")
    failOrg("org.error_aborted", code, json)
    writeOrgRecovery(code)
    return
  }
  const { model, changes, bootstrapped, paths } = result
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "applied",
          business: model.business,
          owner: model.owner,
          bootstrapped,
          positions: model.roles.length,
          changes: {
            hired: changes.hired.map((role) => role.id),
            moved: changes.moved,
            dismissed: changes.dismissed.map((role) => role.id),
            budgetUpdated: changes.budgetUpdated,
          },
          organization: `${ORG_STATE_DIR}/${ORG_MODEL_FILE}`,
          audit: `${ORG_STATE_DIR}/${ORG_AUDIT_FILE}`,
          permissions: `${ORG_STATE_DIR}/${ORG_PERMISSIONS_FILE}`,
        },
        null,
        2,
      )}\n`,
    )
    return
  }
  if (bootstrapped) {
    process.stdout.write(`${t("org.apply_bootstrapped")}\n`)
  }
  for (const role of changes.hired) {
    process.stdout.write(
      `${t("org.apply_hired", {
        position: role.id,
        reportTo: reportingLabel(role.reportTo),
      })}\n`,
    )
  }
  for (const moved of changes.moved) {
    process.stdout.write(
      `${t("org.apply_moved", {
        position: moved.id,
        from: reportingLabel(moved.from),
        to: reportingLabel(moved.to),
      })}\n`,
    )
  }
  for (const role of changes.dismissed) {
    process.stdout.write(`${t("org.apply_dismissed", { position: role.id })}\n`)
  }
  for (const position of changes.budgetUpdated) {
    process.stdout.write(`${t("org.apply_budget_updated", { position })}\n`)
  }
  if (changeCount(changes) === 0) {
    process.stdout.write(`${t("org.apply_no_changes")}\n`)
  }
  process.stdout.write(
    `${t("org.apply_done", { count: String(changeCount(changes)) })}\n`,
  )
}

interface OrgScopeOptions {
  positionId?: string
  directory?: string
  tool?: string
  context?: string
  json: boolean
  help?: boolean
  argsCount: number
}

async function orgScope(options: OrgScopeOptions): Promise<void> {
  const json = options.json
  if (options.help) {
    process.stdout.write(`${t("org.help_scope")}\n`)
    return
  }
  if (options.argsCount > 2) {
    failTooManyDirectories(json)
    return
  }
  const positionId = options.positionId?.trim() || ""
  if (!positionId) {
    failOrg("org.error_aborted", "workspace_org_position_required", json)
    writeOrgRecovery("workspace_org_position_required")
    return
  }
  if (options.tool !== undefined && options.context !== undefined) {
    failOrg(
      "org.error_incompatible_options",
      "workspace_org_scope_accepts_one_request",
      json,
    )
    writeOrgRecovery("workspace_org_scope_accepts_one_request")
    return
  }
  const workspace = resolveWorkspace({
    directory: options.directory,
    json,
    argsCount: 0,
  })
  let permissions
  try {
    const { model } = await loadOrgModel(workspace)
    permissions = deriveOrganizationPermissions(model)
  } catch (error) {
    const code = safeFailureCode(error, "workspace_org_scope_failed")
    failOrg("org.error_aborted", code, json)
    writeOrgRecovery(code)
    return
  }
  const entry = permissions.positions[positionId]
  if (!entry) {
    failOrg("org.error_aborted", "workspace_org_position_unknown", json)
    writeOrgRecovery("workspace_org_position_unknown")
    return
  }

  const renderDenial = (
    decision: Extract<PermissionDecision, { status: "denied" }>,
    subject: string,
  ): void => {
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "denied",
            code: decision.code,
            position: positionId,
            requested: subject,
            redirectTo: decision.redirectTo,
          },
          null,
          2,
        )}\n`,
      )
    } else {
      process.stderr.write(`${t("org.error_denied", { code: decision.code })}\n`)
      writeOrgRecovery(decision.code, { owner: decision.redirectTo })
    }
    process.exitCode = 1
  }

  try {
    if (options.tool !== undefined) {
      const decision = evaluateToolAuthority(permissions, positionId, options.tool)
      if (decision.status === "denied") {
        renderDenial(decision, options.tool)
        return
      }
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            { status: "allowed", position: positionId, tool: options.tool },
            null,
            2,
          )}\n`,
        )
      } else {
        process.stdout.write(
          `${t("org.scope_tool_allowed", {
            position: positionId,
            tool: options.tool,
          })}\n`,
        )
      }
      return
    }
    if (options.context !== undefined) {
      const decision = evaluateContextAccess(
        permissions,
        positionId,
        options.context,
      )
      if (decision.status === "denied") {
        renderDenial(decision, options.context)
        return
      }
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            { status: "allowed", position: positionId, path: options.context },
            null,
            2,
          )}\n`,
        )
      } else {
        process.stdout.write(
          `${t("org.scope_context_allowed", {
            position: positionId,
            path: options.context,
          })}\n`,
        )
      }
      return
    }
  } catch (error) {
    const code = safeFailureCode(error, "workspace_org_scope_failed")
    failOrg("org.error_aborted", code, json)
    writeOrgRecovery(code)
    return
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`)
    return
  }
  process.stdout.write(`${t("org.scope_position", { position: entry.position })}\n`)
  process.stdout.write(`${t("org.scope_tier", { tier: entry.tier })}\n`)
  process.stdout.write(`${t("org.scope_mode", { mode: entry.mode })}\n`)
  process.stdout.write(
    `${t("org.scope_context_read", { scopes: entry.contextScope.read.join(", ") })}\n`,
  )
  const tools = entry.authorityScope.tools.allow
  process.stdout.write(
    `${t("org.scope_tools_allow", { tools: tools.length > 0 ? tools.join(", ") : t("org.scope_none") })}\n`,
  )
  process.stdout.write(`${t("org.scope_writes")}\n`)
  if (entry.authorityScope.delegation.allow) {
    process.stdout.write(
      `${t("org.scope_delegation_allowed", {
        targets:
          entry.authorityScope.delegation.targets.length > 0
            ? entry.authorityScope.delegation.targets.join(", ")
            : t("org.scope_none"),
      })}\n`,
    )
  } else {
    process.stdout.write(
      `${t("org.scope_delegation_denied", {
        escalateTo: reportingLabel(entry.authorityScope.delegation.escalateTo),
      })}\n`,
    )
  }
}

function renderOrgHelp(): void {
  const locales = getAvailableLocales()
  process.stdout.write(`${t("org.help", { locales: supported(locales) })}\n`)
}

export async function org(options: OrgOptions = { args: [] }): Promise<void> {
  const json = options.json === true
  const locales = getAvailableLocales()

  setLocale(initialLocale(options.locale, json))
  if (
    options.providedOptions?.has("locale") &&
    (options.locale === undefined || !locales.includes(options.locale))
  ) {
    failInput("locale", locales, json)
    return
  }

  const subcommand = options.subcommand
  if (!subcommand || subcommand === "help") {
    renderOrgHelp()
    return
  }
  if (subcommand === "tree") {
    return orgTree({
      directory: options.args[0],
      json,
      help: options.help,
      argsCount: options.args.length,
    })
  }
  if (subcommand === "apply") {
    return orgApply({
      directory: options.args[0],
      json,
      help: options.help,
      argsCount: options.args.length,
    })
  }
  if (subcommand === "scope") {
    return orgScope({
      positionId: options.args[0],
      directory: options.args[1],
      tool: options.tool,
      context: options.context,
      json,
      help: options.help,
      argsCount: options.args.length,
    })
  }
  failOrg(
    "org.error_unknown_subcommand",
    `workspace_org_unknown_subcommand:${subcommand}`,
    json,
  )
}

/**
 * Render a localized, side-effect-free parse failure for the org command
 * domain (mirrors the workspace command's renderer).
 */
export function renderOrgParseFailure(
  argv: readonly string[],
  error: unknown,
): void {
  const locales = getAvailableLocales()
  const requestedLocale = explicitLocaleFromArgv(argv)
  setLocale(
    requestedLocale !== undefined
      ? locales.includes(requestedLocale)
        ? (requestedLocale as SupportedLocale)
        : "en"
      : detectSystemLocale(),
  )
  const message = error instanceof Error ? error.message : "invalid_arguments"
  const field = message.match(/'(--[A-Za-z0-9-]+)'/)?.[1] ?? "arguments"
  failInput(field, ORG_OPTIONS.map((entry) => `--${entry}`), false)
}
