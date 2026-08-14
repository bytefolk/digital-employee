# Agent-native install

This document is the single entry point for Agent Hosts. Drop the link to this
file into any capable Agent Host (Qoder CLI, Claude Code, CodeBuddy Code, etc.)
and ask it to set up the framework.

## Published-versus-source boundary

The current public npm release is `0.3.0`. It contains the Agent-native
`setup`, `init`, `doctor`, `validate`, `eval`, and `run` paths, but it does not
contain the newer package-bound `deploy` command. The deploy documentation and
implementation on the current source branch are a pre-release preview. Do not
present `npx digital-employee deploy` as an installed-package capability until
a later public release explicitly includes it.

## Prerequisites

- Node.js >= 20
- One supported Agent Host installed locally

## Install steps (deterministic, credential-free)

```bash
# 1. Install the published package as a dependency
npm init -y 2>/dev/null || true
npm install @fullstack-ai-infra/digital-employee

# 2. Run setup — this verifies environment, probes hosts, scaffolds an employee
npx digital-employee setup --json

# 3. Continue inside the scaffolded package
cd my-employee
```

The `setup` command:
1. Verifies Node.js >= 20.
2. Probes for installed Agent Hosts (Qoder CLI, Claude Code, Qwen Code, CodeBuddy).
3. Scaffolds a minimal employee package in `./my-employee` if none exists.
4. Reports structured status (JSON with `--json` flag).

No personal CLI login, credential, or environment variable is required for setup.

## Verify

```bash
npx digital-employee doctor --json
npx digital-employee validate --json
```

Both must report success. If `doctor` reports `"status": "not_found"`, install a
supported Agent Host first.

## What comes next

After setup completes:
1. Edit `SKILL.md` in the scaffolded directory to define the employee's role.
2. Add approved knowledge files to the `knowledge/` directory.
3. Run `npx digital-employee eval` to verify fixture conformance.
4. Run `npx digital-employee run --engine <host> --question "..."` for a live test.

## Per-Host configuration

| Host | Credential required | When |
| --- | --- | --- |
| Qoder CLI | `QODER_PERSONAL_ACCESS_TOKEN` | At run time only |
| Claude Code | `ANTHROPIC_API_KEY` | At run time only |
| Qwen Code | `OPENAI_API_KEY` and `OPENAI_MODEL` | At run time only |
| CodeBuddy Code | `CODEBUDDY_API_KEY` and `CODEBUDDY_MODEL` | At run time only |

Credentials are never needed during `setup` or `validate`. They are requested
only when executing a live `run`.

To evaluate package-bound deploy before it is released, use a reviewed source
checkout, run `npm ci && npm run build`, and invoke
`node ./dist/apps/cli/bin.js deploy ...`. That proves only the exact source
commit you built; it is not evidence that npm `0.3.0` contains deploy.

## Failure semantics

Every step fails closed:
- If Node.js < 20: exit 1 with `node_version_unsupported`.
- If no Agent Host found: exit with status `partial` and actionable message.
- If scaffold fails: exit 1 with `employee_scaffold_failed`.

All errors are machine-readable in `--json` mode.
