import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  resolveWorkspaceContext,
  WorkspaceContextConfigError,
} from "../../apps/cli/turn/context-config.js"
import {
  OSS_MAINTAINER_TEMPLATE,
  renderOrganizationFile,
  renderWorkspaceManifest,
} from "../../apps/cli/workspace/templates.js"
import { validateOrganizationDocument } from "../../apps/cli/org/budget.js"
import { deriveOrganizationPermissions } from "../../apps/cli/org/permissions.js"

const WORKSPACE_INSTANCE = "11111111-1111-4111-8111-111111111111"
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const FAKE_CLI = path.join(TEST_DIR, "..", "fixtures", "context-fake-cli.mjs")

async function createWorkspace(options: {
  contextPort?: Record<string, unknown>
}): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "turn-context-ws-"))
  const digests: Record<string, { name: string; version: string; digest: string }> = {}
  for (const role of OSS_MAINTAINER_TEMPLATE.roles) {
    digests[role.id] = {
      name: role.id,
      version: "0.1.0",
      digest: `sha256:${"a".repeat(64)}`,
    }
  }
  const organization = renderOrganizationFile(
    OSS_MAINTAINER_TEMPLATE,
    "context-test",
    workspace,
    digests,
    "2026-08-24T00:00:00.000Z",
  )
  await writeFile(
    path.join(workspace, organization.portablePath),
    organization.content,
  )
  const validated = validateOrganizationDocument(
    JSON.parse(new TextDecoder().decode(organization.content)),
  )
  await mkdir(path.join(workspace, ".digital-employee"))
  await writeFile(
    path.join(workspace, ".digital-employee", "permissions.json"),
    `${JSON.stringify(deriveOrganizationPermissions(validated), null, 2)}\n`,
  )
  const manifest = JSON.parse(
    new TextDecoder().decode(
      renderWorkspaceManifest(
        OSS_MAINTAINER_TEMPLATE,
        "context-test",
        "2026-08-24T00:00:00.000Z",
        WORKSPACE_INSTANCE,
      ).content,
    ),
  ) as Record<string, unknown>
  if (options.contextPort) {
    manifest.contextPort = options.contextPort
  }
  await writeFile(
    path.join(workspace, "workspace.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return workspace
}

function block(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "workspace-context.v1",
    adapter: "context-cli.v1",
    enabled: true,
    mode: "required",
    contextWorkspaceIdEnv: "CONTEXT_WORKSPACE_ID",
    pinnedRevisionEnv: "CONTEXT_PINNED_REVISION",
    bindings: {
      "repo-owner": {
        tokenEnv: "CONTEXT_REPO_OWNER_TOKEN",
        contextScopeEnv: "CONTEXT_REPO_OWNER_SCOPE",
      },
    },
    ...overrides,
  }
}

const env = {
  CONTEXT_WORKSPACE_ID: "workspace-instance",
  CONTEXT_PINNED_REVISION: "f63f57f",
  CONTEXT_REPO_OWNER_TOKEN: "context_test_token",
  CONTEXT_REPO_OWNER_SCOPE: "position.repo-owner",
}

test("#304 AC-003: workspaces without contextPort stay disabled", async () => {
  const workspace = await createWorkspace({})
  try {
    assert.deepEqual(
      await resolveWorkspaceContext({ workspace, positionId: "repo-owner" }),
      { status: "disabled", reason: "binding_absent" },
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("#304 AC-003: enabled false is disabled without creating an adapter", async () => {
  const workspace = await createWorkspace({
    contextPort: block({ enabled: false }),
  })
  try {
    assert.deepEqual(
      await resolveWorkspaceContext({ workspace, positionId: "repo-owner" }),
      { status: "disabled", reason: "disabled_by_config" },
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("#304 AC-002: required-mode missing env fails closed", async () => {
  const workspace = await createWorkspace({ contextPort: block() })
  try {
    await assert.rejects(
      () =>
        resolveWorkspaceContext({
          workspace,
          positionId: "repo-owner",
          env: {},
        }),
      (error: unknown) =>
        error instanceof WorkspaceContextConfigError &&
        error.code === "workspace_context_workspace_id_not_configured",
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("#304 AC-002: optional-mode missing env degrades", async () => {
  const workspace = await createWorkspace({
    contextPort: block({ mode: "optional" }),
  })
  try {
    assert.deepEqual(
      await resolveWorkspaceContext({
        workspace,
        positionId: "repo-owner",
        env: {},
      }),
      { status: "disabled", reason: "optional_unusable" },
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("#304 AC-001: enabled binding resolves a ContextPort", async () => {
  const workspace = await createWorkspace({ contextPort: block() })
  try {
    const result = await resolveWorkspaceContext({
      workspace,
      positionId: "repo-owner",
      env: { ...process.env, ...env },
      command: [process.execPath, FAKE_CLI],
    })
    assert.equal(result.status, "enabled")
    if (result.status === "enabled") {
      assert.equal(result.adapterIdentity, "context-cli.v1")
      assert.equal(result.workspaceId, "workspace-instance")
      assert.equal(typeof result.port.recall, "function")
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
