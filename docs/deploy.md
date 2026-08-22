# Package-bound local deploy

`digital-employee deploy` is a fail-closed local orchestration command. It
validates one exact `employee-package.v1alpha1` directory, binds its name,
version and canonical content digest, preflights the selected Agent Host, and
only then reaches a channel boundary.

## Invocation contract

The positional package path and `--package` are equivalent. At most one
positional path is allowed, and a positional path cannot be combined with
`--package`. If neither form is present, the current directory is used.
Interactive deploy defaults directly to `agent-native`; it never offers an
implicit standalone fallback. A complete automation invocation uses `--yes`
and must also provide `--channel`, `--engine`, and `--runtime`:

```bash
export QODER_PERSONAL_ACCESS_TOKEN='...'
export DIGITAL_EMPLOYEE_HTTP_TOKEN='...'
node ./dist/apps/cli/bin.js deploy ./team-answer \
  --channel http \
  --engine qoder \
  --runtime agent-native \
  --name "Team Answer" \
  --locale en \
  --port 3000 \
  --yes
```

`--yes` suppresses confirmations; it does not choose non-defaultable values.
Under `--yes`, locale defaults to `en`, the name defaults to the localized
value for the effective locale (`Digital Employee` under the default English
locale), and an HTTP port defaults to `3000`; channel, engine, and runtime
remain required. `--port` is HTTP-only. More than one positional path, or a
positional path combined with `--package`, exits 1. An omitted package defaults
to the current directory.
Package validation and explicit engine support, availability, and package
compatibility checks complete before prompts, config writes, provider calls,
or runtime starts. Package-bound `standalone-v1` is a truthful unsupported
boundary in this milestone; use `digital-employee legacy ...` for the existing
compatibility runtime.

Run the source-built `deploy --help --locale en`, `zh-CN`, or `ja` for the
complete current value and option list. Help exits 0 without a prompt, config
write, provider call, or process start. Package-bound deploy first shipped in
the tagged `0.4.0` release.

## Outcomes and channel truth

| Outcome | Exit | Meaning |
| --- | ---: | --- |
| `ready` | 0 | A local runtime passed exact persisted-state, package-digest, process, endpoint, and live readback gates. |
| `pending_external_action` | 2 | A resumable provider or foreground action remains, or a provider write has an indeterminate result. |
| `unsupported` | 1 | The requested capability is intentionally not implemented by package-bound deploy. |
| `failed` or invalid input | 1 | Validation, provider, persistence, process, or readback failed. |

Only HTTP can currently become `ready`. Console remains pending because it
requires an attached foreground process. DingTalk is fail-closed on an external
DWS pagination-contract HOLD described below; no real application create or
reconciliation is currently claimed. Lark and WeCom live deployment remain
unsupported here.

## Private state and lifecycle

Ordinary state is stored at `$HOME/.digital-employee/config.json` using the
strict `deploy-state.v1` schema. The directory is owner-only mode `0700` and
the file is mode `0600`. While the retained authoritative lock is valid, writes
use a compare-and-swap generation check, same-directory atomic rename,
directory sync, and reopened digest verification. The fingerprint is generation
evidence under that lock; it is not an independent ownership mechanism.
Unknown fields, malformed cross-field combinations, unsafe permissions,
symlinks, non-regular files, and changed generations fail closed without
replacing the original bytes.

The allowlisted state contains the selected locale/channel/name/engine/runtime,
exact package name/version/digest, the private local restart reference, outcome
and timestamps, optional loopback HTTP endpoint/process identity, optional
DingTalk provider identity or create-operation fence, and symbolic secret
references. Raw credentials are never accepted. The private local package path
is needed for local restart/readback but is never printed in normal output or
placed in a remote protocol, receipt, or log.

This schema represents one global local deployment slot, not a registry. Only
HTTP state may contain `endpoint` and `process`; `ready` requires both a process
and `deployedAt`, and `deployedAt` exists if and only if the outcome is Ready.
Only DingTalk may contain `provider` or `providerOperation`, and the two cannot
coexist.

An exact DingTalk `resourceId` is an ownership binding. Until an explicit
detach/delete migration exists, deploy refuses a channel change or bot-name
change that would orphan that verified resource. The original state bytes and
remote identity remain untouched. Package or engine rebinding under the same
DingTalk name reconciles the existing id rather than creating a replacement.

HTTP deployment requires a non-empty `DIGITAL_EMPLOYEE_HTTP_TOKEN`.
`POST /v1/ask` requires the exact `Authorization: Bearer <token>` header;
missing or incorrect credentials receive 401. `/health` remains an
unauthenticated loopback readiness endpoint. The state stores only
`secretReferences.httpTokenEnv = "DIGITAL_EMPLOYEE_HTTP_TOKEN"`, never the raw
value, and the credential is not placed in process arguments or response
artifacts. Reuse requires the same symbolic binding and live value; removing or
changing it fails closed without replacing the verified process.

HTTP startup is parent-coupled. The runtime progresses through durable
`prepared` and `authorized` process states, starts listening only after exact
IPC and state checks, and keeps `/v1/ask` gated during final verification. The
parent publishes `ready` only after fresh state, package, process, endpoint,
and health readbacks, then sends the exact Ready generation and activation
tuple as the release message. The child reopens and validates that authoritative
Ready state and tuple under the inherited fd 4 lease, removes its parent-loss
handler, closes fd 4, enables requests, and acknowledges release. Once that
release message has been validated, the child is autonomous even if the parent
does not observe the acknowledgement. The parent retains its own authoritative
lock descriptor for a post-release state and endpoint readback and the final
output boundary, then releases it. This prevents an old child from extending
the lock into a future owner.

A successfully enqueued release is therefore an irreversible signaling
boundary: the parent never rolls back or signals that child merely because the
exact acknowledgement is missing, delayed, or conflicting. The current run
still exits nonzero and prints no Ready result unless it observes the exact
acknowledgement and completes the retained-lock post-release readback. The
durable/live evidence is preserved so a fresh exact rerun can verify and reuse
the child; no new public handoff or adoption state is introduced.

Every parent loss before the child validates release makes the child exit in a
bounded interval. In particular, parent death after the Ready save but before
release may leave a stale Ready-shaped file; that file is never accepted as
live readiness or reused for output. An exact rerun must establish a fresh
process lifecycle and new live readback. Other interruptions either verify
cleanup and record failure or retain a truthful pending state for manual
recovery.

An existing HTTP PID is never signaled or replaced from PID alone. Exact
runtime arguments and live readiness must match the stored identity. Starting,
stale, or identity-unverified processes cause localized fail-closed guidance;
the original state is preserved and no replacement runtime is started.
This milestone adds no public `status`, `restart`, or `stop` command. An exact
rerun performs state and live readback for safe reuse. Recovery guidance never
asks an operator to kill an unverified PID blindly.

## Local lock and filesystem scope

`.deploy.lock` is an owner-only regular file whose opened descriptor is held
for the complete transaction. The implementation uses the absolute system
`lockf` utility on macOS, FreeBSD, and OpenBSD and `flock` on Linux. The child
inherits the verified lock-file descriptor for the same inode as fd 4. It
validates the descriptor, published inode, owner, record nonce, full activation
tuple, and state generation at every effect boundary. The parent reasserts
ownership around authority-dependent reads and before provider, spawn,
activation, termination, and final-Ready boundaries. Lock acquisition polls
short-lived nonblocking probes and is bounded; it never leaves a long-lived
orphan waiter. An interrupted utility is terminated, hard-killed if necessary,
and reaped before settlement. Parent loss before release makes the child exit;
cleanup never targets an unrelated PID. Unsupported operating systems fail
closed.

This is cooperative, advisory locking for a supported local filesystem. Do not
place `$HOME/.digital-employee` on NFS, CIFS/SMB, a synchronized network mount,
or another filesystem whose `lockf`/`flock`, inode, rename, or `fsync` semantics
are not local and reliable. It is not distributed coordination. The regular CI
matrix is configured to exercise Linux on Ubuntu; macOS, FreeBSD, and OpenBSD
use the separately implemented `lockf` path.

## DingTalk reconciliation

The write-capable DingTalk deploy provider is separate from the read-only DWS
knowledge connector. Application reconciliation uses current `dws` JSON
commands only:

```text
dws profile list --format json
dws --profile <corpId>:<userId> devapp +list --name <name> --page-size 20 --format json
dws --profile <corpId>:<userId> devapp +list --name <name> --page-size 20 --cursor <nextCursor> --format json
dws --profile <corpId>:<userId> devapp +create --name <name> --desc <description> --format json --yes
dws --profile <corpId>:<userId> devapp +get --unified-app-id <id> --format json
```

Deploy resolves one exact current `corpId:userId` profile from the local,
non-refreshing profile index and binds both the verified provider and every durable
create fence to a domain-separated SHA-256 digest of the non-secret tenant,
user, profile client, and explicit client-id identity. Raw identity fields,
client secrets, and storage paths are never persisted. Every provider call is
pinned to that profile. The same scope is revalidated before and immediately
after publishing a create fence, and again before an operation fence can be
cleared; scope drift leaves the last durable state byte-for-byte unchanged and
performs no `devapp` or remote-application call in the new provider scope.
Client-secret rotation and credential-storage relocation remain safe when the
semantic profile/client identity is unchanged.

Listing is deliberately strict: each page must contain a boolean `hasMore`,
and a non-empty `nextCursor` must exist if and only if `hasMore` is true. The
provider follows at most 20 pages of 20 applications and rejects missing,
malformed, contradictory, cyclic, unavailable, or over-limit continuation
state as indeterminate after any durable create attempt. It never treats a
missing continuation contract as a terminal first page.

External integration HOLD: the installed DWS `v1.0.55-beta.4` at commit
`72cb8f1` accepts and forwards `--cursor`, but its current devapp projection
emits only `{count, apps}` and drops `hasMore`/`nextCursor`. This is visible in
the upstream [`+list` input path](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/72cb8f188ebead44f039384299393c0e260591fe/internal/shortcut/devapp/devapp.go#L35-L53)
and [`{count, apps}` output projection](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/72cb8f188ebead44f039384299393c0e260591fe/internal/shortcut/devapp/devapp.go#L108-L114).
The installed `--mock` command reproduces the omission in json, raw, pretty,
and ndjson formats, while its help says continuation should use an output
`nextCursor`; format and field flags do not restore it. Therefore real DingTalk
deploy currently stops fail-closed at listing and cannot create. Closure needs
an upstream/frozen DWS output contract that preserves continuation metadata;
first-page inference is not an acceptable workaround.

Before a create call, deploy durably records a random
`dingtalk-app-create` operation identity. A retry with that operation is
reconcile-only: it may list/read back an exact application but will never issue
a second create. Once `providerOperation` exists, timeout, abort, signal,
malformed output, missing CLI, empty reconciliation, or ambiguous identity
remains `pending_external_action` with the operation preserved. An already-existing
result is accepted only from one unambiguous machine-readable provider code
followed by unique exact-name readback. Multiple, malformed, truncated, or
prose-only error codes are indeterminate. Parsing covers the shipped DWS JSON
[root error envelope](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/72cb8f188ebead44f039384299393c0e260591fe/internal/app/root.go#L118-L133)
and its nested machine-code forms, while never inferring a code from prose.
DWS authentication/configuration is passed through only via an explicit
allowlist (`DWS_CLIENT_ID`, `DWS_CLIENT_SECRET`, `DWS_CONFIG_DIR`,
`DWS_DISABLE_KEYCHAIN`, and `DWS_KEYCHAIN_DIR`); credentials are not persisted
or printed. `--yes` authorizes the write without a prompt; otherwise the
operator must confirm it.

Once `+create` is invoked, every non-success result—including a well-formed
provider machine error—remains indeterminate. It cannot prove that no remote
write occurred, so the durable operation fence is retained and subsequent
runs are read-only reconciliation until a unique list/get readback is safely
persisted.

The detached HTTP runtime receives only the selected Agent Host's credential
variables, the explicitly referenced HTTP token, and a small operational
allowlist. At activation it creates a private read-only package snapshot,
binds that snapshot to the configured digest, and serves all requests from the
snapshot instead of the publisher's mutable source directory.

## Legacy local-state recovery

Older prototypes may have written a permissive config file or a raw
`openaiKey`. The current CLI deliberately refuses such state. Do not print or
copy the old value into a new config. Move the entire
`~/.digital-employee` directory to an owner-only quarantine, rotate the exposed
credential at its provider, then rerun deploy with credentials supplied only
through the documented environment-variable names. The CLI recreates its
directory and state with `0700`/`0600` permissions.

The public test suite uses deterministic DWS fixtures. The fixture conflict
codes are not established as canonical `create_dev_app` codes by current DWS
source/docs or a live tenant. It therefore does not claim a live DingTalk
tenant deployment, a verified conflict-code mapping, or E4 provider evidence.
