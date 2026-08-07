# Agent-native install

This document is the single entry point for Agent Hosts. Drop the link to this
file into any capable Agent Host (Qoder CLI, Claude Code, CodeBuddy Code, etc.)
and ask it to set up the framework.

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
```

The `setup` command:
1. Verifies Node.js >= 20.
2. Probes for installed Agent Hosts (Qoder CLI, Claude Code, Qwen Code, CodeBuddy).
3. Scaffolds a minimal employee package in the working directory if none exists.
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
| Qoder CLI | Qoder API key (`QODER_API_KEY`) | At run time only |
| Claude Code | Anthropic API key or OAuth | At run time only |
| Qwen Code | DashScope API key | At run time only |
| CodeBuddy | CodeBuddy session | At run time only |

Credentials are never needed during `setup` or `validate`. They are requested
only when executing a live `run`.

## Failure semantics

Every step fails closed:
- If Node.js < 20: exit 1 with `node_version_unsupported`.
- If no Agent Host found: exit with status `partial` and actionable message.
- If scaffold fails: exit 1 with `employee_scaffold_failed`.

All errors are machine-readable in `--json` mode.
