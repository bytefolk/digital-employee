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
node ./dist/apps/cli/bin.js doctor --engine qoder
```

After an Agent-native `0.2.0` or later release is actually published, the
equivalent global commands will be:

```bash
digital-employee init ./team-answer --author your-team
digital-employee validate ./team-answer
digital-employee doctor --engine qoder
```

`init` requires a new, Agent-Skill-compatible target directory and never
merges into or overwrites an existing directory. It builds in a sibling
temporary directory and renames only after every file is complete. `validate`
is static: it does not import employee code,
load knowledge into a model, connect to MCP, read credentials or make a paid
request. With `--engine`, it adds a bounded executable/version probe, the same
package/policy preflight used by `run`, and fail-closed capability comparison.
The Qoder adapter additionally requires a configured
`QODER_PERSONAL_ACCESS_TOKEN`; it still does not spend credits or verify model
entitlement until `run`. Claude Code and Codex remain probe-only.

The first real run path is:

```bash
export QODER_PERSONAL_ACCESS_TOKEN='...'
printf '%s\n' '{"message":"What does the approved material say?"}' | \
  node ./dist/apps/cli/bin.js run ../team-answer --engine qoder --stdin
```

This command starts Qoder and may consume credits. `--stdin` and
`--input-file` keep task data out of the outer CLI argument vector;
`--question` and `--input` remain conveniences for non-sensitive local input.
The adapter is currently a one-shot, local/single-tenant technical preview,
restricted to Qoder CLI 1.1.x versions covered by its deterministic repository
fixtures, a new stateless session, read-only local assets, no MCP and no
attachments. These Adapter-specific fixtures are not a reusable certification
harness. This is not yet the long-running employee service used for marketplace
rental.

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
employee. The Qoder v1 adapter enforces the data-plane meaning by exposing no
shell, web, Agent or MCP tools.

## Host projection

The package does not contain one universal command line. A Host Adapter maps
the same abstract request into each host:

| Portable intent | Claude Code projection | Qoder projection | Codex projection |
| --- | --- | --- | --- |
| Skill instructions | Claude Skill/project instructions | `initialize` control message in v1 | Codex Skill/`AGENTS.md` |
| External tools | MCP configuration | MCP configuration | MCP configuration |
| Read-only files | Enforced tool/directory policy | Narrowed tool set and permissions | Sandbox plus verified tool policy |
| Result stream | Native stream JSON parser | Native stream JSON parser | `codex exec --json` parser |
| Output contract | Native schema if available, then outer validation | Outer validation unless verified native support | Native output schema, then outer validation |

This table describes projection responsibility, not a claim that every adapter
is already implemented. Qoder 1.1.x has the first runnable, stateless read-only
adapter. Claude Code and Codex expose installation probes and
documentation-derived capability data only. Documentation-derived support
never passes compatibility. Codex tool allowlisting, for example, remains
`unknown`; a package requiring it is rejected even though Codex documents a
filesystem sandbox.

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

The current source implements the first two plus a one-shot Qoder adapter. The
third still needs an Agent-native `service start` wrapper; the fourth belongs
to the separate platform/pricing phase.

## Current and next commands

| Command | State |
| --- | --- |
| `init` | Implemented |
| `validate` | Implemented; static plus optional host compatibility |
| `doctor` | Implemented; local readiness only, never starts a model run |
| `run --engine qoder` | Implemented for Qoder CLI 1.1.x; stateless, read-only, no MCP/attachments |
| `run --engine claude-code|codex` | Planned; current definitions are probe-only |
| `project --engine` | Planned: generates host-specific files |
| `package` | Planned: deterministic archive, integrity and signing metadata |

The explicit `legacy ask|sync|start|serve` namespace is the `standalone-v1`
compatibility path. The old top-level names remain deprecated aliases through
`0.x`. `run --engine qoder` is a separate path, never imports the legacy
runtime eagerly, never wraps Qoder as the old runtime's completion model, and
never falls back to legacy when a host fails.

The Qoder adapter enables qodercli's SDK process mode and uses its stdin/stdout
JSONL protocol: it writes a per-run, mode-`0600` authentication payload,
performs the `initialize` handshake, sends projected Skill instructions and
task input over stdin, then half-closes input for the one-shot run. It requires
the runtime to attest a compatible protocol major and explicit empty
Skill/plugin lists before submitting the task. Only temporary paths and policy
flags are passed as process arguments. The project does not vendor or depend on
the separately licensed Qoder Agent SDK package; the transport is version
pinned and covered by Qoder-specific deterministic fixtures for CLI 1.1.x.
Operators remain responsible for the selected host's license and service terms.
Multi-tenant hosting still requires a real OS or container/sandbox boundary; a
CLI tool policy is not tenant isolation.
