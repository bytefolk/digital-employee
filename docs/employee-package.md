# Portable employee package

`employee-package.v1alpha1` is the source format for an Agent-native digital
employee. It is intentionally smaller than a deployment and independent of a
specific model vendor or Agent CLI.

The normative schema is
[`configs/employee-package.schema.json`](../configs/employee-package.schema.json).
The TypeScript validator is part of the public core package.

## Create and validate a package

From a source checkout:

```bash
npm run build
node ./dist/apps/cli/bin.js init ../team-answer \
  --name team-answer \
  --author your-team
node ./dist/apps/cli/bin.js validate ../team-answer
node ./dist/apps/cli/bin.js doctor
```

After an Agent-native `0.2.0` or later release is actually published, the
equivalent global commands will be:

```bash
digital-employee init ./team-answer --author your-team
digital-employee validate ./team-answer
digital-employee doctor
```

`init` requires a new, Agent-Skill-compatible target directory and never
merges into or overwrites an existing directory. It builds in a sibling
temporary directory and renames only after every file is complete. `validate`
is static: it does not import employee code,
load knowledge into a model, connect to MCP, read credentials or make a paid
request. With `--engine`, it adds a bounded executable/version probe, the same
package/policy preflight used by `run`, and fail-closed capability comparison.
Runnable adapter preflight requires an explicit deployment credential rather
than a personal CLI login: `QODER_PERSONAL_ACCESS_TOKEN` for Qoder,
`ANTHROPIC_API_KEY` for Claude, `OPENAI_API_KEY` plus `OPENAI_MODEL` for Qwen,
or `CODEBUDDY_API_KEY` plus `CODEBUDDY_MODEL` for CodeBuddy. Optional Qwen and
CodeBuddy Base URL settings are deployment configuration. Preflight does not
spend credits or verify model entitlement; that remains untested until a real
`run`. Codex remains probe-only.

One real run path is:

```bash
export QODER_PERSONAL_ACCESS_TOKEN='...'
printf '%s\n' '{"message":"What does the approved material say?"}' | \
  node ./dist/apps/cli/bin.js run ../team-answer --engine qoder --stdin
```

This command starts Qoder and may consume credits. The same `validate/run`
shape accepts `--engine claude-code`, `qwen-code` or `codebuddy` after its
service API key and required model setting are configured. `--stdin` and
`--input-file` keep task data out of the outer CLI argument vector;
`--question` and `--input` remain conveniences for non-sensitive local input.

The four adapters are one-shot local/single-tenant technical previews. Qoder
CLI 1.1.x receives a minimum read-only projection. Claude Code
`>=2.1.214 <2.2.0`, Qwen Code `0.17.1` and CodeBuddy Code `2.106.4` receive only
a sealed, bounded UTF-8 value containing manifest-selected assets and run with
empty isolated working, home and configuration directories. All four use a new
stateless session, validate the exact runtime tool/MCP/plugin/Skill surface and
reject MCP, attachments, resume, writes and approval callbacks. None is the
long-running employee service used for marketplace rental, and live model
entitlement has not been tested.

The employee name and the directory containing `SKILL.md` use the portable
[Agent Skills naming subset](https://agentskills.io/specification): lowercase
letters, digits and single hyphens, at most 64 characters.

## Generated layout

```text
team-answer/
├── employee.json
├── SKILL.md
├── schemas/
│   ├── input.schema.json
│   └── output.schema.json
├── knowledge/
│   └── README.md
└── evals/
    └── cases.json
```

The minimum common source is `SKILL.md + JSON Schema`. MCP is added through the
validated [`employee-mcp.v1alpha1`](../configs/employee-mcp.schema.json)
declaration when the employee needs external capabilities. `knowledge/` is
optional approved local material; large or private knowledge should stay in an
authorized external system rather than be published in the package. Every
local file made available to a run must also be listed explicitly in `assets`;
policy globs grant a maximum scope but never discover package files.

## Manifest fields

| Field | Meaning |
| --- | --- |
| `name`, `version` | Stable package identity; version follows SemVer |
| `description`, `license`, `authors` | Distribution metadata, never secrets or tenant data |
| `host.protocol` | Normalized adapter contract, currently `agent-host.v1` |
| `host.requiredCapabilities` | Additional role-specific features; security requirements are derived from policy |
| `entrypoints.skill` | Canonical portable Skill instructions |
| `entrypoints.inputSchema` / `outputSchema` | Public task and result contracts |
| `entrypoints.mcp` | Optional stdio/HTTPS MCP declaration with environment-variable secret references only |
| `policy` | Abstract filesystem, network, MCP and approval requirements; every MCP tool requests a maximum read/write mode |
| `assets` | Explicit regular files shipped with the package |

All file references use forward-slash `./` paths. Artifact paths and policy
globs are validated separately. Absolute paths, parent traversal, undeclared
fields and symlinked artifacts are rejected, followed by a resolved root
containment check. File count and total size are bounded. Secret values and
local account identifiers do not
belong in a package; a deployment binds secret names through its host or
service environment.

An MCP tool's `requestedMode` is a request, never a self-granted safety label.
Before a runnable adapter exposes the tool, preflight must compare the request
with trusted connector/registry metadata and block any missing or more
side-effectful tool. The package is not an authorization boundary.

`policy.network: "deny"` means employee tool/MCP data-plane egress is denied.
It does not block the selected Agent host from reaching its own authentication
and model control plane; otherwise no cloud-model host could execute the
employee. The runnable adapters enforce the data-plane meaning by exposing no
shell, web, Agent or MCP tools. Qoder exposes only the attested read/search set;
the three context-only adapters expose no native tools at all.

## Host projection

The package does not contain one universal command line. A Host Adapter maps
the same abstract request into each host:

| Portable intent | Qoder CLI 1.1.x | Claude/Qwen/CodeBuddy context-only adapters | Codex CLI |
| --- | --- | --- | --- |
| Skill instructions | `initialize` control message | Sealed stdin task envelope | Probe-only; no run projection |
| External tools | Rejected in this preview | Rejected in this preview | Probe-only; no run projection |
| Read-only files | Minimum read-only projection with exact read/search tools | Bounded UTF-8 assets inlined as data-encoded, still-untrusted model input; empty native filesystem/tool surface | Probe-only; no run projection |
| Result stream | Native stream JSON parser | Version-specific native stream parser | Probe-only; parser research only |
| Output contract | Native result plus outer validation | Native result/schema where verified, then outer validation | Probe-only; no run projection |

The runnable version gates are Qoder CLI 1.1.x, Claude Code
`>=2.1.214 <2.2.0`, Qwen Code exactly `0.17.1` and CodeBuddy Code exactly
`2.106.4`; unverified versions fail closed. Codex exposes only an installation
probe and documentation-derived capability data. Its `tool_allowlist` remains
`unknown` because Codex CLI 0.146.0 cannot reliably remove every model-visible
built-in tool, notably `apply_patch`; a package requiring the default-deny tool
boundary is rejected even when the filesystem policy is read-only.

## DWS answer employee recipe

The DWS Workbench answer bot maps cleanly into this package:

| Existing concern | Employee package / outer runtime |
| --- | --- |
| Answer persona and operating rules | `SKILL.md` |
| Repository and approved knowledge | `knowledge/` or authorized MCP server |
| Read/Grep/Glob restriction | Abstract read-only policy projected by the adapter |
| DingTalk Stream and immediate ACK | Channel adapter in the outer service |
| Deduplication, cooldown and queue | Outer service job lifecycle |
| Session memory and FAQ | Memory capability outside the Agent loop |
| Claude/Qoder process and stream parser | Host Adapter |
| Human escalation | Normalized result plus outer escalation policy |

The reusable part is this separation. The original large DWS prompt, directory
assumptions and local private indexes are not package content.

Following that evidence, distribution is split into independent artifacts:

1. the Apache-licensed `digital-employee` CLI/core and Host Adapter contract;
2. a portable employee source package (`employee.json`, `SKILL.md`, Schemas,
   declared assets/evals), which is the future marketplace unit;
3. an operator-owned deployment binding (selected host binary, service token,
   channel credentials, queue limits and sandbox), which is never published as
   employee content;
4. future marketplace listing and metering metadata, which references a signed
   employee package/version but stays outside this repository's runtime
   contract.

The current source implements the first two plus four one-shot Host Adapters.
The third still needs an Agent-native `service start` wrapper; the fourth
belongs to the separate platform/pricing phase.

## Current and next commands

| Command | State |
| --- | --- |
| `init` | Implemented |
| `validate` | Implemented; static plus optional host compatibility |
| `doctor` | Implemented; local readiness only, never starts a model run |
| `run --engine qoder` | Implemented for Qoder CLI 1.1.x; stateless, read-only, no MCP/attachments |
| `run --engine claude-code|qwen-code|codebuddy` | Implemented for the exact version gates above; stateless, context-only, no MCP/attachments |
| `run --engine codex` | Probe-only; blocked on reliable removal of all model-visible built-in tools |
| `project --engine` | Planned: generates host-specific files |
| `package` | Planned: deterministic archive, integrity and signing metadata |

The explicit `legacy ask|sync|start|serve` namespace is the `standalone-v1`
compatibility path. The old top-level names remain deprecated aliases through
`0.x`. Agent-host `run --engine` is a separate path, never imports the legacy
runtime eagerly, never wraps a Host as the old runtime's completion model, and
never falls back to legacy when a host fails.

The Qoder adapter enables qodercli's SDK process mode and uses its stdin/stdout
JSONL protocol: it writes a per-run, mode-`0600` authentication payload,
performs the `initialize` handshake, sends projected Skill instructions and
task input over stdin, then half-closes input for the one-shot run. It requires
the runtime to attest a compatible protocol major and explicit empty
Skill/plugin lists before submitting the task. Only temporary paths and policy
flags are passed as process arguments. The project does not vendor or depend on
the separately licensed Qoder Agent SDK package; the transport is version
pinned and conformance tested against Qoder CLI 1.1.x. Operators remain
responsible for the selected host's license and service terms. Multi-tenant
hosting still requires a real OS or container/sandbox boundary; a CLI tool
policy is not tenant isolation.

The Claude adapter runs `--bare --tools "" --strict-mcp-config
--disable-slash-commands --no-session-persistence`. Claude, Qwen and CodeBuddy
receive Skill, task, Schema and selected UTF-8 asset values through stdin, not
argv, and use disposable empty workspace, home, configuration or session
directories. Their runtime initialization must report no model-visible tools
or MCP servers before output is trusted. Claude additionally reports no
plugins, Skills or slash commands; Qwen disables slash commands and pins the
0.17.1 built-in Agent catalog; CodeBuddy uses an exhaustive 2.106.4 tool deny
list because its empty `--tools` option is not sufficient. Each uses only its
explicit service API key/model configuration; personal host login state is
neither read nor copied. These restrictions are capability boundaries, not a
claim that a live provider account or marketplace deployment has been verified.
