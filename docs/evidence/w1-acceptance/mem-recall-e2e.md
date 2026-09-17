# #286 W1 mem recall-seam E2E evidence (cross-process persistence + recall)

Environment: macOS arm64 (darwin 24.5.0), Node v26.7.0, digital-employee CLI
`0.6.1` (built from the W1 acceptance branch; engine `0.1.0`), mem server at
`bytefolk/mem` `f1cc9eb` (origin/main, 2026-09-16) started via
`go run ./cmd/memd` on `127.0.0.1:8321`, pgvector `pg16` + MinIO from the
pinned compose digests (isolated compose project, fresh database, auto-migrate
on). Run window 2026-09-17 01:03–01:09 (+08:00).

Credential handling: the mem deployment runs `MEM_REGISTRATION_MODE=open` on
loopback with a freshly registered throwaway tenant; both the admin session
token (`mem_…PLBE`) and the position token (`mem_…-GKA`) were generated
locally for this run, held only in a `chmod 600` file outside the repository,
and are masked here. No production credential was used or exposed.

Scope honesty: this is the **W1 recall-seam demo** (#161 recall seam, #286).
Production mem recall remains an M2–M3 deliverable per the roadmap. The
deterministic zero-credential model port produced the turn outputs; no live
model provider was invoked.

## 0. Contract pre-flight finding (matrix pin drift)

`recipes/real-local-context/component-matrix.json` pins mem at `3335ebe`.
That build's `/v1/capabilities` response **lacks the `permissions_manage`
permission key** that the current `mem-http.v1` adapter on `main` requires
(`PERMISSION_KEYS` closed set), so the pinned server fails the adapter
pre-flight with `MEMORY_DENIED` before any recall. mem `f1cc9eb` (origin/main)
emits the full contract and passes. All evidence below was produced against
`f1cc9eb`. The matrix pin needs a refresh — tracked as a finding of this run.

Additionally: the `go build`-produced `memd` binary was silently SIGKILLed by
the host macOS security policy in this environment (exit 137, zero output,
valid ad-hoc signature, re-signing did not help); `go run ./cmd/memd` starts
identically and survives. Startup method recorded for reproducibility.

## 1. Workspace configuration (workspace-memory.v1)

`workspace init --template oss-maintainer` + `org apply`, then the workspace
manifest carries:

```json
"memory": {
  "schemaVersion": "workspace-memory.v1",
  "adapter": "mem-http.v1",
  "enabled": true,
  "mode": "required",
  "baseUrlEnv": "MEM_W1_BASE_URL",
  "memWorkspaceIdEnv": "MEM_W1_WORKSPACE_ID",
  "pinnedRevisionEnv": "MEM_W1_REVISION",
  "bindings": {
    "repo-owner": {
      "tokenEnv": "MEM_REPO_OWNER_TOKEN",
      "memoryScopeEnv": "MEM_REPO_OWNER_SCOPE"
    }
  }
}
```

Operator environment (600-file, never in argv): `MEM_W1_BASE_URL=http://127.0.0.1:8321`,
`MEM_W1_WORKSPACE_ID=d5ec547d-a893-423b-a52c-8902e9e74310`,
`MEM_W1_REVISION=dev` (the dev build's `/v1/version` string),
`MEM_REPO_OWNER_SCOPE=/DigitalEmployees/repo-owner`, position token
`scopes:["read","write"] paths:["/"]`. Adapter pre-flight (`/v1/version` +
`/v1/capabilities`) verified: `features.memory=true`, `read=true`,
`write=true`, `search/delete/permissions_manage/provider_modify/workspace_*=false`.

## 2. Cold start: bootstrap memory + grant (admin side)

durable-context recall denies a principal with **zero unrevoked grants**
(`context_scope_denied`), and the engine's required-mode turn fails closed
before any model consumption in that state (observed: `run.failed`,
`engine.memory_denied`, `retryable:false`). The demo therefore bootstraps via
the mem admin surface, simulating the org-side approval role:

```
POST /v1/memories            (admin, Idempotency-Key) -> 201
  memory 409dd6d8-d83c-4d6c-bae5-924a24479c76  path=/DigitalEmployees/repo-owner
POST /v1/durable-context/grants (admin)          -> grant 491c8fd6-6359-43f2-9caf-ce52864c799b
  principal=position.repo-owner
POST /v1/durable-context/recall (position token) -> 200, hits=1
```

**Finding**: digital-employee has no grant-management surface today; a fresh
position in `required` memory mode cannot complete its first turn until an
admin grants at least one memory. Recorded as a product gap for the M2 mem
line (not silently worked around in the product code).

## 3. Session A — decision persisted (process 1)

```
$ DIGITAL_EMPLOYEE_ENGINE_MODEL=deterministic \
  DIGITAL_EMPLOYEE_ENGINE_MODEL_SCRIPT='["repo-owner: decided to cut release 0.6.2 on Friday; blocking crash issue assigned to issue-researcher"]' \
  node dist/apps/cli/bin.js turn run /tmp/w1-286-ws --position repo-owner \
    --question "Record this week release decision"
digital-employee: memory enabled (adapter mem-http.v1)
run.started  96f47945-3b21-42ee-8796-eba457f0341b
model.delta  (scripted decision text)
run.completed terminalReason=goal_met
```

memd request log for this turn: `POST /v1/durable-context/recall -> 200`
(before the model), then `POST /v1/memories -> 201` and readback
`GET /v1/memories/d770eb28-… -> 200` (the CLI's post-completion
`writeTaskState`).

Evidence `.digital-employee/evidence/repo-owner/a4e95e71-b8a7-4e10-ba7e-ea33b1c2a4d7.json`:

- `terminal: {status: completed, reason: goal_met}`
- `memory: {mode: required, adapterIdentity: mem-http.v1, memoryScope:
  /DigitalEmployees/repo-owner, itemCount: 1, totalBytes: 272}` — the
  bootstrap recall, digest-only
- decision memory written: `d770eb28-3d77-4d5e-8547-8ff8540e695b`

Admin then approves the decision for the position (simulated org approval):
`POST /v1/durable-context/grants` -> grant `8353a25e-44d5-40a9-931f-dd67f10d2648`.

## 4. Session B — cross-process recall (process 2, fresh PID, fresh turnId)

```
$ DIGITAL_EMPLOYEE_ENGINE_MODEL=deterministic \
  DIGITAL_EMPLOYEE_ENGINE_MODEL_SCRIPT='["repo-owner: confirmed Friday release plan stands; crash issue research in progress"]' \
  node dist/apps/cli/bin.js turn run /tmp/w1-286-ws --position repo-owner \
    --question "Continue from last decision: what is the release plan?"
digital-employee: memory enabled (adapter mem-http.v1)
run.completed terminalReason=goal_met
```

Evidence `c4fa3fc1-02ad-4f23-a71d-19a800053a8c.json` — the recall block now
carries **Session A's decision as the first item**:

| # | locator | content digest | provenance digest |
|---|---|---|---|
| 1 | `mem://memories/d770eb28-3d77-4d5e-8547-8ff8540e695b@1` | `dc58be12a95016bc…` | `db0e285022d72daa…` |
| 2 | `mem://memories/409dd6d8-d83c-4d6c-bae5-924a24479c76@1` | `4998fc104a8e3105…` | `f53829076f5b7ffa…` |

`itemCount: 2`, `totalBytes: 557`, `stateVersion: 1` each. Session B is a
distinct OS process started after Session A exited; no in-process state was
shared. This is the #286 claim: a decision made in one session is persisted
to the memory plane and recalled in a new session on a different process.

A third turn (`94afe7b9-4ca7-41e8-ae27-b6e462c7b5d8`, also `goal_met`,
`itemCount: 2`) ran while both grants were still active and shows the same
stable recall set.

All three evidence records pass `validateTurnEvidenceRecord` (#285 checker,
#140 standard) — checked in-process against the built engine barrel.

## 5. Negative control — revocation is enforced end to end

```
POST /v1/durable-context/grants/8353a25e-…/revoke -> 200
POST /v1/durable-context/grants/491c8fd6-…/revoke -> 200
POST /v1/durable-context/recall                   -> 403 context_scope_denied
turn run (mode=required)                          -> run.failed
  error.code=engine.memory_denied  terminalReason=memory_denied  retryable=false
```

The revoked turn consumed **no model output** (the scripted completion never
appears in the event stream) and wrote no evidence record — the engine fails
closed before model consumption, exactly as the memory-seam contract
specifies. Revocation on the mem side is immediately visible to the engine.

## 6. Teardown

memd stopped; compose project `mem-w1-286` torn down with `down -v`
(postgres + minio volumes deleted); throwaway tokens die with the deleted
database. The 600-permission credential file is outside the repository and
was not committed.

## Findings summary

1. **Matrix pin drift**: `component-matrix.json` mem pin `3335ebe` predates
   the adapter's `permissions_manage` contract key; the pin must move to a
   commit ≥ the capabilities-contract change (`f1cc9eb` verified). mem
   origin/main also already resolves MinIO images from quay.io after the
   Docker Hub withdrawal — the same registry failure this run hit with the
   pinned compose file.
2. **Cold-start grant gap**: required-mode memory + zero grants = first turn
   fails closed. No DE-side grant/approval surface exists yet (M2 mem line).
3. **Host quirk**: built `memd` binaries are SIGKILLed by this macOS host's
   security policy; `go run` is the reproducible startup path here.
