# Security policy

## Reporting

Do not open a public issue for credential exposure, authorization bypass,
private-data disclosure, SSRF, command injection, or another vulnerability.
Use GitHub's private vulnerability reporting for this repository.

## Data boundary

Digital Employee is self-hosted, but configured model and source providers may
receive data. Operators are responsible for:

- approving each indexed source;
- choosing a model provider permitted to process that data;
- setting retention and deletion policies;
- protecting DingTalk, DWS, and model credentials;
- reviewing citations and audit events before enabling any write action.

OpenAI-compatible provider URLs are operator configuration, not user input.
Without `allowPrivateNetwork`, the adapter rejects literal and DNS-resolved
private addresses before each request. Keep TLS verification enabled and do not
delegate model endpoint configuration to untrusted callers.

The `answer-agent` profile is read-only. It does not grant permission to scan
an account, organization, drive, chat history, or repository automatically.

## Agent-host boundary

The source preview contains four conformance-tested, one-shot adapters with a
deliberately narrow boundary:

- Qoder CLI 1.1.x uses a minimum read-only file projection;
- Claude Code `>=2.1.214 <2.2.0`, Qwen Code `0.17.1` and CodeBuddy Code
  `2.106.4` are context-only and receive selected local assets as bounded,
  data-encoded values.

Each adapter requires an explicit deployment service credential. Qoder uses
`QODER_PERSONAL_ACCESS_TOKEN`; Claude uses `ANTHROPIC_API_KEY`; Qwen requires
`OPENAI_API_KEY` and `OPENAI_MODEL`, with optional `OPENAI_BASE_URL`; CodeBuddy
requires `CODEBUDDY_API_KEY` and `CODEBUDDY_MODEL`, with optional
`CODEBUDDY_BASE_URL` and a validated `CODEBUDDY_INTERNET_ENVIRONMENT`. Never add
these values to `employee.json`, `SKILL.md`, MCP declarations or assets. The
adapters do not reuse a personal CLI login or inherit arbitrary environment
variables, user settings, hooks, plugins, Skills or MCP servers.

Local assets must be listed explicitly in `assets` and match the read policy.
All projections reject symlinks, oversized files and files whose
device/inode/size/change-time identity changes during inspection. Qoder copies
only that intersection into a private read-only workspace and must attest the
exact expected read/search tools plus empty MCP, Skill and plugin sets. The
three context-only adapters accept only bounded UTF-8 regular files, seal their
path, length, digest and content into the stdin task envelope, and launch with
empty isolated working, home and configuration directories. All three must
attest empty model-visible tools and MCP servers. Claude also attests empty
plugins, Skills and slash commands. Qwen disables every built-in slash command
and pins the exact built-in agent catalog for `0.17.1`; those definitions are
not callable because the Agent tool is absent. CodeBuddy 2.106.4 receives an
exhaustive `--disallowedTools` list in addition to `--tools ""`, because a real
local handshake proved the empty flag alone leaves its tool surface populated.
Any unexpected tool or subagent event fails the run. This inline projection is
task context, not a filesystem grant.

Data encoding prevents host-side path/command expansion; it does not make an
asset semantically inert to the model. Assets remain untrusted prompt input and
can attempt instruction injection while still producing schema-valid output.
Adversarial-asset evaluations and domain-level citation/answer checks are a
required deployment gate before an employee can be offered to other users.

Path, symlink, canonical-path and file-identity checks are defense in depth for
the local/single-tenant preview; they are not an OS isolation boundary against
another process that can concurrently rename ancestor directories. A
multi-tenant service must first place each employee package in an immutable
snapshot or tenant sandbox/container and run the Adapter inside that boundary.

Task input, projected Skill instructions, output Schema and inline assets are
sent through stdin/native stream protocols rather than the host argument
vector. Host-specific keys are passed only through each adapter's allowlisted
credential channel; Qoder additionally materializes its PAT in a mode-`0600`
file and removes the original variable from the child environment. Per-run
credential, home, configuration, workspace and reservation cleanup completes
before a terminal event becomes observable. A cleanup failure replaces success
with an explicit failed terminal.

All four paths reject MCP, attachments, session resume, write tools and
approval callbacks. `network: deny` covers employee tool/MCP data-plane egress,
not the selected host's authentication and model control plane; that control
plane must remain reachable for a cloud-backed model run. Run identifiers are
reserved before asynchronous staging, so cancellation also applies before
process launch.

Codex remains probe-only. In Codex CLI 0.146.0, disabling the shell execution
features does not reliably remove every model-visible built-in tool, notably
`apply_patch`. Read-only filesystem permissions or prompt instructions do not
repair that tool-surface mismatch, so the adapter cannot claim the required
default-deny tool allowlist.

Prefer `digital-employee run --stdin` or `--input-file`; the convenience
`--question` and `--input` options necessarily expose their values in the outer
CLI argument vector. Place temporary roots on encrypted ephemeral storage and
run periodic cleanup as defense against host or process crashes. Do not treat a
shared machine account as a tenant boundary; use an isolated OS account or
container for hosted deployments. No current Host Adapter is an OS-level
sandbox.

Native stream messages are validated before normalized events are forwarded.
Once a protocol or runtime-policy mismatch is detected, buffered output is
discarded and only the post-cleanup failed terminal is emitted. Automated
conformance fixtures do not establish live model entitlement, provider terms or
multi-tenant isolation; no live model request was used for the current
verification claim.

## Supported versions

Until the first stable release, only the latest tagged `0.x` release receives
security fixes.
