# Deploy CLI walkthrough — 2026-08-22

Issue: #139 (REQ-001, REQ-002). Scope: the beginner golden path
(`doctor → init → validate → eval → deploy → setup`) and the four fault
paths a beginner actually hits (missing service key, port occupied,
incompatible Host version, invalid package).

## Method

- CLI built from this checkout (`npm ci && npm run build`), invoked as
  `node ./dist/apps/cli/bin.js …`.
- Clean environment: fresh empty `HOME`, `PATH` restricted to Node plus a
  fixture `qodercli` (reports version `1.1.12`, serves the conformance
  fixture) and, where noted, a fixture `claude` (reports `2.1.214`).
  No real credentials, hosts, or machine identifiers appear below; scratch
  paths are written as `$WORK`, package digests are truncated, and all
  tokens were inert sentinel values that are never printed by the CLI.
- Every command below was executed; exit codes are the observed ones.

## Golden path (REQ-001)

The happy path itself is sound: `init`, `validate`, `eval`, and a
token-equipped HTTP deploy all succeed, and `/health` plus an authenticated
`/v1/ask` readback return the expected contracts. The friction is in
wording, ordering, and feedback around the failures.

### G1. `doctor` hides the blocking reason in human output

```
$ digital-employee doctor
Agent hosts:
- Claude Code: not_found [runnable]
- Qoder CLI: not_ready (1.1.12) [runnable]
- Codex CLI: not_found [probe-only]
- Qwen Code: not_found [runnable]
- CodeBuddy Code: not_found [runnable]

Local readiness only; model access is verified only by a real run.
exit=0
```

`not_ready` is never explained in the human view; the blocking issue
(`qoder_service_token_not_configured` and its remediation) only exists in
`--json`. A beginner sees "not_ready", gets exit 0, and learns nothing
about what to fix. Improvement (not landed here): print the first blocking
issue code per host in the human view.

### G2. `validate --engine` names a code but no fix

```
$ digital-employee validate ./my-employee --engine qoder
Static package valid: my-employee@0.1.0
Checked 5 declared file(s).
Qoder CLI: incompatible
- blocked: qoder_service_token_not_configured
- blocked: host_not_ready
exit=1
```

`qoder_service_token_not_configured` is a machine code; nothing says "set
`QODER_PERSONAL_ACCESS_TOKEN`". Same finding class as F1 below.

### G3. Interactive deploy asks for the engine before the language

```
$ digital-employee deploy ./my-employee
? Which AI engine should run it?
  1) claude-code
  2) qoder
  3) qwen-code
  4) codebuddy
  Choice [1-4]: ? Language / 语言
  ...
```

The first prompt a non-English beginner sees is the engine list, before any
language choice (system-locale detection aside). The list also shows all
four engines with no availability hint, so beginners happily pick engines
that are not installed or not configured, and only then hit F1. The locale
keys `deploy.engine_logged_in` / `deploy.engine_not_found` exist but are
unused. Improvement (not landed here): move the language prompt first and
annotate engine choices with detected availability.

### G4. `setup` reports READY for unauthenticated hosts

```
$ digital-employee setup
...
Agent Hosts:
  [+] Claude Code (2.1.214 (Claude Code))
  [+] Qoder CLI (1.1.12)
  [-] Codex CLI
  ...
Status: READY

Next steps:
  1. Run `digital-employee doctor` to verify end-to-end readiness.
  1. Run `digital-employee validate` to check the employee package.
exit=0
```

Two problems: (a) `[+]`/`READY` only means the binary was found — no
credential check — so the beginner is told READY and `deploy` immediately
fails closed one minute later; (b) the "Next steps" list prints `1.` for
every item. Improvement (not landed here): label hosts
"installed (credentials not checked)" and fix the numbering.

### G5. Dead copy drift: `deploy.done_http` points at `/answer`

The locale key `deploy.done_http` says
`POST to http://127.0.0.1:{port}/answer`, but the deployed endpoint is
`/v1/ask` (the runtime rejects anything else). The key is currently unused
by the code; if it is ever re-enabled it sends beginners to a dead path.
Several other wizard-era keys (`deploy.deploying`, `deploy.done_*`,
`deploy.step_app_created`, …) are likewise unreferenced. Improvement (not
landed here): delete or re-audit dead keys.

## Fault paths (REQ-002)

The CLI fails closed correctly in every case (nonzero exit, no partial
state, no started processes — verified against the config file and port
state). What is missing is "what do I do next".

### F1. Missing service key — no recovery action  → FIXED here

```
$ digital-employee deploy ./my-employee --channel http --engine claude-code --runtime agent-native --locale en --yes
The selected engine is unsupported, unavailable, or incompatible (claude_api_key_not_configured).
exit=1
```

Same shape for qoder (`qoder_service_token_not_configured`), qwen
(`qwen_api_key_not_configured` / `qwen_model_not_configured`) and codebuddy
(`codebuddy_api_key_not_configured` / `codebuddy_model_not_configured`).
The message never names the environment variable to set.

### F2. Port occupied — the message tells the wrong story  → FIXED here

```
$ digital-employee deploy ./my-employee --channel http --engine qoder --runtime agent-native --locale en --port 3458 --yes
Package: my-employee@0.1.0 · sha256:c0466e71… · runtime=agent-native
Deployment failed (http_process_state_write_failed).
Private deployment state could not be written (http_process_state_write_failed).
exit=1
```

Port `3458` was held by another listener. The state file was in fact written
correctly and the orphaned runtime was cleaned up — the failure is that the
runtime child could not bind the port (the `listening` activation ack never
arrives). Telling a beginner "state could not be written" sends them
debugging disk permissions instead of freeing the port.

### F3. Incompatible Host version — no upgrade hint  → FIXED here

```
$ digital-employee deploy ./my-employee --channel console --engine qoder --runtime agent-native --locale en --yes   # qodercli 0.9.0 on PATH
The selected engine is unsupported, unavailable, or incompatible (qoder_version_not_conformance_verified).
exit=1
```

Same shape for `claude_version_not_conformance_verified`,
`qwen_version_not_conformance_verified`,
`codebuddy_version_not_conformance_verified`, plus
`host_executable_not_found` and `host_version_probe_failed`. No mention of
upgrading the host or of `doctor` as the diagnostic.

### F4. Invalid package — jargon code, no recovery  → FIXED here

```
$ digital-employee deploy ./does-not-exist --channel console --engine qoder --runtime agent-native --locale en --yes
Invalid employee package (enoent).
exit=1
$ digital-employee deploy ./not-a-package --channel console --engine qoder --runtime agent-native --locale en --yes   # directory without employee.json
Invalid employee package (enoent).
exit=1
```

`enoent` is errno jargon, and a directory that simply lacks `employee.json`
produces the same code. Nothing points at `digital-employee init`.

### F5. HTTP channel without a token — unnamed variable  → FIXED here

```
$ digital-employee deploy ./my-employee --channel http --engine qoder --runtime agent-native --locale en --yes   # no DIGITAL_EMPLOYEE_HTTP_TOKEN
Deployment did not run (http_token_required).
exit=1
```

The message does not name `DIGITAL_EMPLOYEE_HTTP_TOKEN`, so the beginner
cannot act on it.

## What this change lands (REQ-003, AC-002)

One improvement, end-to-end: **every fail-closed deploy error above now
prints a recovery line** telling the user the exact next action, localized
in `en` / `zh-CN` / `ja` through the JSON-only locale catalogs (no
hard-coded strings in CLI code):

- F1/F3: per-code `deploy.recovery_*` guidance after
  `deploy.error_engine_unavailable` (credentials, host version, missing
  executable, probe failure, platform), with a generic doctor-pointer
  fallback for any other preflight code.
- F4: a recovery line after `deploy.error_invalid_package` pointing at the
  package path contract and `digital-employee init`.
- F5: a recovery line naming `DIGITAL_EMPLOYEE_HTTP_TOKEN`.
- F2: the `listening` activation failure now renders
  `deploy.error_http_listen_failed` guidance (free the port or pass
  `--port`) instead of the misleading state-write sentence. The outcome
  code, persisted state code, exit codes, and fail-closed ordering are
  unchanged (REQ-004).

Behavior contract: exit codes (1 / 2 / 0), failure codes, state-file
semantics, and cleanup ordering are all identical; only human-facing copy
changed.
