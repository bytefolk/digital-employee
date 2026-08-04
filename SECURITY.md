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

`run --engine qoder` currently supports only the version-gated Qoder CLI 1.1.x
read-only path covered by Adapter-specific deterministic process fixtures. Keep
`QODER_PERSONAL_ACCESS_TOKEN` in the deployment environment; never add it to
`employee.json`, `SKILL.md`, MCP declarations or assets. The adapter
intentionally does not inherit arbitrary process environment variables, user
settings, plugins, hooks, Skills or MCP servers.

Local assets must be listed explicitly in `assets` and match the read policy.
Each run copies only that intersection into a temporary projection and rejects
symlinks, oversized files, files whose device/inode/size/change-time identity
changes during projection, unexpected native tools, MCP servers, plugins,
Skills, working directories and permission modes. Run identifiers are reserved
before asynchronous staging, so cancellation also applies before process
launch. `network: deny` covers employee tool/MCP data-plane egress, not Qoder's
authentication and model control plane.

The adapter sends task input and projected Skill instructions through Qoder's
SDK-mode stdin JSONL control protocol, not its process argument vector. It
materializes the PAT in a mode-`0600` file under the per-run private temporary
directory, points qodercli at that file, omits the original PAT variable from
the child environment, and performs bounded credential/root cleanup before the
terminal event becomes observable. Repeated cleanup failure changes the
terminal result to `qoder_cleanup_failed`; it is never reported as a successful
run. Operators should still place the temporary root on encrypted ephemeral
storage and run periodic cleanup as a defense against host or process crashes.
Prefer
`digital-employee run --stdin` or `--input-file` as well; the convenience
`--question` and `--input` options necessarily expose their values in the outer
CLI argument vector. Do not treat a shared machine account as a tenant
boundary; use an isolated OS account or container for hosted deployments. No
current Host Adapter is an OS-level sandbox.

Native stream messages are validated as a whole before normalized events are
forwarded. Once a protocol or runtime-policy mismatch is detected, buffered
assistant/tool events are discarded and only the post-cleanup failed terminal
is emitted.

## Supported versions

Until the first stable release, only the latest tagged `0.x` release receives
security fixes.
