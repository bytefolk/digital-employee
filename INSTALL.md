# Agent-native install

This document is the single entry point for Agent Hosts. Drop the link to this
file into any capable Agent Host (Qoder CLI, Claude Code, CodeBuddy Code, etc.)
and ask it to set up the framework.

## Published-versus-source boundary

The current public npm release is `0.3.0`. It contains the Agent-native `init`,
`doctor`, `validate`, `eval`, and `run` paths. It does not contain the newer
`setup` convenience command or package-bound `deploy` command. Both commands
on the current source branch are unreleased previews. Do not present
`npx digital-employee setup` or `npx digital-employee deploy` as an
installed-package capability until a later public release explicitly includes
them.

## Prerequisites

- Node.js >= 20
- One supported Agent Host installed locally

## Install steps (deterministic, credential-free)

```bash
# 1. Install the published package as a dependency
npm init -y 2>/dev/null || true
npm install @fullstack-ai-infra/digital-employee@0.3.0

# 2. Diagnose the installed Agent Hosts without invoking a model
npx digital-employee doctor --json

# 3. Scaffold an employee package with a command shipped in 0.3.0
npx digital-employee init ./my-employee \
  --recipe minimal-answer.v1 \
  --author your-team
```

`doctor` probes the supported Agent Host executables and reports structured
status with `--json`; it does not authenticate or invoke a model. `init`
creates `./my-employee` deterministically from the selected public recipe. No
personal CLI login, credential, or environment variable is required for these
steps.

## Verify

```bash
npx digital-employee validate ./my-employee --json
npx digital-employee eval ./my-employee --json
```

Both must report success. If the earlier `doctor` step reports
`"status": "not_found"`, install a supported Agent Host before a live `run`.

## What comes next

After initialization and verification complete:
1. Edit `SKILL.md` in the scaffolded directory to define the employee's role.
2. Add approved knowledge files to the `knowledge/` directory.
3. Rerun `validate` and `eval` after package changes.
4. Run `npx digital-employee run ./my-employee --engine <host> --question "..."`
   for a live test.

## Per-Host configuration

| Host | Credential required | When |
| --- | --- | --- |
| Qoder CLI | `QODER_PERSONAL_ACCESS_TOKEN` | At run time only |
| Claude Code | `ANTHROPIC_API_KEY` | At run time only |
| Qwen Code | `OPENAI_API_KEY` and `OPENAI_MODEL` | At run time only |
| CodeBuddy Code | `CODEBUDDY_API_KEY` and `CODEBUDDY_MODEL` | At run time only |

Credentials are never needed during `doctor`, `init`, `validate`, or `eval`.
They are requested only when executing a live `run`.

## Current-source previews (unreleased)

To evaluate `setup` or package-bound `deploy`, use a reviewed source checkout
and run `npm ci && npm run build`. From the empty workspace you want to
scaffold, invoke the built `setup` command by its checkout path:

```bash
cd /path/to/empty/workspace
node /path/to/reviewed/digital-employee/dist/apps/cli/bin.js setup --json
```

Invoke `node ./dist/apps/cli/bin.js deploy ...` from the exact checkout when
evaluating deploy. These commands prove only the source commit you built; they
are not evidence that npm `0.3.0` contains `setup` or `deploy`.

## Failure semantics

The published commands fail closed:
- Node.js < 20 is outside the supported environment.
- If no Agent Host is found, `doctor` reports `"status": "not_found"` and exits 1.
- If the target already exists, `init` reports `INIT_TARGET_ALREADY_EXISTS` and exits 1.
- Invalid packages or fixtures make `validate` or `eval` exit 1.

Use `--json` where the command advertises it for machine-readable output.
