# Digital Employee

[简体中文](README.zh-CN.md)

Digital Employee is a local-first, conversation-first digital-organization
workspace. The long-term direction (tracked in
[Epic #155](https://github.com/fullstack-ai-infra/digital-employee/issues/155)):
turn one business directory into a directly addressable AI team — a directory
is one business, a position is one addressable digital employee, and a
conversation is work carried out with that position's Context and permission
boundary. Positions run on a built-in, TypeScript-native execution engine as
the default Host
([Epic #165](https://github.com/fullstack-ai-infra/digital-employee/issues/165),
design state); external Agent Host adapters remain an option, not a
dependency. The roadmap and strategy live in
[docs/strategy.md](docs/strategy.md) and [docs/roadmap.md](docs/roadmap.md).

## Where Digital Employee sits

Agent frameworks (Claude Code, Qoder, Qwen Code, CodeBuddy, Codex…) answer
**how work gets done**; multi-agent systems answer **how work gets operated**.
Digital Employee answers **who to ask and who is responsible**: it maps a
business into addressable positions with visible context and permission
boundaries, so a user can name the right digital employee for the job instead
of orchestrating tools by hand.

The pitch we are moving toward: the barrier to entry is low — a business owner
does not need to write prompts or wire up an Agent Host by hand. Name a
position, get an answer with its source, and the owner stays accountable for
the whole organization. **The complete direction is planned, not yet
released**: `workspace init`, `org tree`, and `org apply` exist only in
current source after `0.4.0`; `chat @position` and its durable Workbench
integration remain planned (see the status table below).

## Capability status

> [!WARNING]
> Digital Employee is under active development. Interfaces and package formats
> may change before a stable release.

| Capability | Status |
| --- | --- |
| `init`, `doctor`, `validate`, `eval`, one-shot `run`, `setup` | **Released** in public npm `0.4.0`; fixture `eval` does not prove live model entitlement |
| package-bound `deploy` | **Released** in `0.4.0` within its documented fail-closed boundary (HTTP can reach `ready`; DingTalk reconciliation is externally HOLD) |
| Employee-package / Skill / Schema / eval contracts, Agent Host Adapters | **Released** in `0.4.0`; Host adapters are `preview` and `fixture-conformant`, not live-qualified |
| `standalone-v1` compatibility runtime | **Released** compatibility path; not the target for new mainline capabilities |
| Old-track issues after the 2026-08-23 pivot | Disposed per the approved #164 ledger — KEEP 11 / REPURPOSE 9 / PARK 5; see the [old-track disposition ledger](docs/roadmap.md#old-track-wrap-up-and-issue-disposition) |
| `workspace init` (oss-maintainer template) | **Shipped** in current source as a prototype after `0.4.0` (#156); not part of the published `0.4.0` artifact |
| `org tree` / `org apply` | **Shipped in current source after `0.4.0`**; not part of the published `0.4.0` artifact |
| Explicit owner → one direct-report delegation | **Source preview / deterministic E3** after `0.4.0`; Workbench persistence/UI and per-Host E4 remain unverified ([boundary](docs/delegation.md)) |
| `chat @position` | **Planned** Workbench integration (Epic #155 first milestone) |
| Long-term Context via `mem` + `context`, permission boundaries | **Planned** (design state, Epic #155 first milestone / M2) |
| Built-in execution engine (default Host, S1 read-only core) | **Planned** (design state, Epic #165; aligned with the first milestone, due 2026-09-30) |
| oss-maintainer showcase (quickstart form) | **Planned** (Epic #155 M1) |
| Channel expansion (Lark/WeCom) | **Planned later**; excluded from the first milestone |

Nothing in the planned rows is available today. Do not use a source `main`
checkout, PR, or candidate as if it were a published capability.

## Run

Requires Node.js 20 or later.

### Run from npm

Start with the exact public release:

```bash
mkdir digital-employee-workspace
cd digital-employee-workspace
npm init -y
npm install @fullstack-ai-infra/digital-employee@0.4.0
npx digital-employee doctor --json
npx digital-employee init ./my-employee \
  --recipe minimal-answer.v1 \
  --author your-team
npx digital-employee validate ./my-employee --json
npx digital-employee eval ./my-employee --json
```

`doctor`, `init`, `validate`, and `eval` do not invoke a model. A live `run`
requires one supported Agent Host and its service credential:

| Engine | Credential |
| --- | --- |
| `qoder` | `QODER_PERSONAL_ACCESS_TOKEN` |
| `claude-code` | `ANTHROPIC_API_KEY` |
| `qwen-code` | `OPENAI_API_KEY` and `OPENAI_MODEL` |
| `codebuddy` | `CODEBUDDY_API_KEY` and `CODEBUDDY_MODEL` |

### Run from source

```bash
git clone https://github.com/fullstack-ai-infra/digital-employee.git
cd digital-employee
npm ci
npm run build
node ./dist/apps/cli/bin.js init ./my-employee \
  --recipe minimal-answer.v1 \
  --author your-team
node ./dist/apps/cli/bin.js validate ./my-employee
node ./dist/apps/cli/bin.js eval ./my-employee --json
```

### Try the setup command

`setup` combines the model-free host probe and package scaffolding steps.
From a clean workspace:

```bash
cd /path/to/empty/workspace
node /path/to/reviewed/digital-employee/dist/apps/cli/bin.js setup --json
```

### Try the deploy command

`deploy` binds a validated package to a truthful local deployment outcome.
This HTTP example requires both the selected Agent Host credential and an
explicit HTTP bearer token. It also requires Qoder CLI 1.1.x to be installed:

```bash
export QODER_PERSONAL_ACCESS_TOKEN='...'
export DIGITAL_EMPLOYEE_HTTP_TOKEN='...'
node ./dist/apps/cli/bin.js deploy ./my-employee \
  --channel http \
  --engine qoder \
  --runtime agent-native \
  --port 3000 \
  --yes
```

Only HTTP can currently reach `ready`. Console returns
`pending_external_action`; DingTalk remains fail-closed pending external
provider-contract validation, with no live create or reconciliation claim;
Lark and WeCom are unsupported.
Do not present fixture-backed provider tests as live-tenant verification. The
full outcome, locking, recovery, and secret-handling contract is in
[Deploy](docs/deploy.md).

## Runner on a publisher-owned machine

Every application/service employee runs on the publisher or operator's own
computer or server. The private platform stores listing identity, package
digest, Quote, lease, events and settlement records. It never stores a local
package path, employee package contents or Agent Host credentials, and it never
dials into the operator machine.

V0.3 provides an embeddable one-shot Runner executor and a signed-renewal lease
state machine. A long-running Runner must use outbound calls only: claim a
task, accept a platform-signed lease, resolve the employee package by identity
on the local machine, invoke a local Agent Host, and upload hash-chained events
plus a signed receipt. A separate platform `UsageVerifier` must approve
billable facts; Runner-attested tokens never debit Credits directly.

See the [Runner integration path](docs/runner.md) and [ADR 0002](docs/decisions/0002-runner-execution-boundary.md).
There is no claim that a deployable `runner start` network daemon exists yet;
the seller-owned daemon, durable local replay/outbox, reconnect and outbound
platform client remain open-framework work on the old track, which is
finished rather than extended; the surviving scope is recorded in the
[old-track disposition ledger](docs/roadmap.md#old-track-wrap-up-and-issue-disposition).
Server-side device registration, task dispatch,
`UsageVerifier`, Quote, Credit and settlement APIs remain private platform
work.

Every runnable adapter is stateless and one-shot. It requires an explicit
deployment service credential and never reuses a personal CLI login. Unlike
the commands above, `run` starts a real Agent/model run and may consume the
selected provider's credits. For example, the Qoder path is:

```bash
export QODER_PERSONAL_ACCESS_TOKEN='...'
node ./dist/apps/cli/bin.js validate ../team-answer --engine qoder
printf '%s\n' '{"message":"What does the approved handbook say?"}' | \
  node ./dist/apps/cli/bin.js run ../team-answer --engine qoder --stdin
```

Generate `QODER_PERSONAL_ACCESS_TOKEN` as a Personal Access Token in your
Qoder account settings; it is a deployment service credential, not a personal
CLI login. If the token is missing, invalid or expired, `run` fails closed
with `qoder_service_token_not_configured` or `qoder_access_token_invalid`
before any trusted output is produced.

Select `claude-code`, `qwen-code` or `codebuddy` in the same commands after
configuring that adapter's service API key. `--stdin`/`--input-file` keep task
data out of the outer process arguments. Claude Code, Qwen Code and CodeBuddy
receive only a sealed, bounded UTF-8 rendering of manifest-selected assets;
they run with empty isolated working, home and configuration directories and
must attest an empty model-visible tool and MCP surface before output is
trusted. Claude additionally attests empty plugins, Skills and slash commands;
Qwen disables slash commands and pins its unreachable built-in agent catalog;
CodeBuddy denies every built-in tool in the verified version because its empty
`--tools` flag alone is insufficient. Qoder instead receives a minimum
read-only file projection and must attest its exact read/search tool set plus
empty MCP/Skill/plugin sets. Qoder assistant text is held until process and
credential cleanup succeeds, then scrubbed as one value with the exact service
credential. Tool values are scrubbed before truncation, credential-bearing tool
identifiers and keys are rejected, and schema-bound structured output that
would require credential or pattern redaction fails closed. Across all
built-in Adapters, `structured_output` means Adapter-enforced terminal validity
against one bounded, immutable, synchronous Schema snapshot, not Host-native
constrained generation. Every Adapter validates the unchanged terminal JSON:
repair, coercion, defaults, field removal, or redaction cannot manufacture a
passing value, and any post-validation safety scrub that would mutate a
schema-bound value fails closed. Qoder additionally accepts only synchronous
Schemas of at most 16 KiB and compiles them before projection or any Qoder
subprocess. An invalid, oversized, or asynchronous Schema therefore
short-circuits before even the bounded, credential-free `--version` readiness
probe.

These paths are local/single-tenant technical previews, not a marketplace-ready
online employee service. All four reject MCP, attachments, session resume,
write tools and approval callbacks. Their model control plane remains reachable,
while employee tool/MCP data-plane network access is denied. Conformance
fixtures have been run, but live model entitlement has not been tested.
The runnable preview is currently POSIX-only so descendant process groups can
be terminated and verified before a terminal event is published.

## Release status

The tagged `0.4.0` release is public through the root and core npm packages,
GHCR, and GitHub Releases:

| Channel | Command or download |
| --- | --- |
| npm (CLI) | `npm install --global @fullstack-ai-infra/digital-employee@0.4.0` |
| npm (core) | `npm install @fullstack-ai-infra/digital-employee-core@0.4.0` |
| GHCR | `docker pull ghcr.io/fullstack-ai-infra/digital-employee:0.4.0` |
| GitHub Release | Download the root/core packages and checksums from [`v0.4.0`](https://github.com/fullstack-ai-infra/digital-employee/releases/tag/v0.4.0) |

The standalone `@fullstack-ai-infra/digital-employee-core@0.4.0` package is
public. Its one-time registry bootstrap is complete, and subsequent versions
publish from `release.yml` through npm Trusted Publishing. The current `main`
branch contains changes made after the tag and is not itself a published
release. Do not retag or overwrite `0.4.0`, `0.3.0` or `0.1.0`.

The frozen `0.1.0` compatibility release is distributed through three public
channels:

| Channel | Command or download |
| --- | --- |
| npm | `npm install --global @fullstack-ai-infra/digital-employee@0.1.0` |
| GHCR | `docker pull ghcr.io/fullstack-ai-infra/digital-employee:0.1.0` |
| GitHub Release | Download the package and checksum from [Releases](https://github.com/fullstack-ai-infra/digital-employee/releases) |

That release contains only the historical answer runtime. Its container starts
the old HTTP demo and does not contain Qoder or the new package commands:

```bash
docker run --rm -p 3000:3000 \
  ghcr.io/fullstack-ai-infra/digital-employee:0.1.0
```

The current source `Dockerfile` installs an already verified npm candidate and
defaults to help. It does not rebuild from the source checkout. Follow the
[candidate build and staging steps](docs/distribution.md), then enter `legacy`
explicitly only when testing the compatibility runtime:

```bash
docker build -t digital-employee:candidate .
docker run --rm digital-employee:candidate
docker run --rm -p 3000:3000 digital-employee:candidate \
  legacy serve \
  --config ./node_modules/@fullstack-ai-infra/digital-employee/dist/configs/demo.json \
  --host 0.0.0.0 --port 3000
```

## What the product owns

- the workspace skeleton and organization model: the directory tree is the org
  chart, and every hire carries a budget (skeleton shipped as a prototype in
  current source; organization commands planned, not delivered);
- position conversation with Context and permission boundaries (planned, not
  delivered);
- the built-in TypeScript-native execution engine as the default Host, with
  external Agent Host adapters retained as an option (planned; the S1 slice is
  a read-only core);
- portable, versioned employee packages and deterministic package digests;
- default-deny Agent Host adapters and runtime policy for one-shot runs;
- sealed local execution inputs, normalized events, and signed receipts;
- truthful deployment outcomes, lifecycle state, and recovery boundaries.

Employees run on the publisher's or operator's own machine; this repository is
not a hosted marketplace. Marketplace, billing, settlement and other
company-internal transactions stay private.

## Documentation

- [Install and Agent Host setup](INSTALL.md)
- [Employee package contract](docs/employee-package.md)
- [Hire request contract](docs/hire-contract.md)
- [Agent Host support policy](docs/agent-hosts.md)
- [Deploy contract and recovery](docs/deploy.md)
- [Runner integration boundary](docs/runner.md)
- [MemoryPort and pinned mem adapter](docs/memory-port.md)
- [Explicit single-hop delegation boundary](docs/delegation.md)
- [Architecture](docs/architecture.md)
- [Strategy](docs/strategy.md) and [roadmap](docs/roadmap.md)
- [Verification](docs/verification.md) and [release process](docs/releasing.md)
- [Knowledge asset convention](docs/knowledge/asset-convention.md) and [knowledge source quality bar](docs/knowledge/knowledge-source-quality-bar.md)
- [Security policy](SECURITY.md)

## Community and support

Use [GitHub Issues](https://github.com/fullstack-ai-infra/digital-employee/issues)
for bugs, feature requests, and reproducible integration reports.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[AGENTS.md](AGENTS.md) before opening a pull request. Please follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Development

```bash
npm ci
npm run check
```

Release candidates also pass coverage, security, archive, and clean-installed
package-consumer gates. A source checkout is not a published release.

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for
attribution information.
