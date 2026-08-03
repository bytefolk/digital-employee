# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

These changes are a source preview for the next minor release. The published
`0.1.0` artifacts remain the frozen `standalone-v1` compatibility release.

### Added

- Added the host-neutral `employee-package.v1alpha1` manifest, source package
  scaffold, static validation, and public JSON Schema.
- Added `employee-mcp.v1alpha1` for host-neutral stdio/HTTPS MCP declarations
  with environment-variable secret references.
- Added the `agent-host.v1` adapter/event/capability contract and fail-closed
  host compatibility assessment.
- Added an explicit, host-neutral `AgentHostRegistry` and trusted embedder API.
  Host IDs and aliases cannot shadow each other; employee packages cannot
  discover or install adapters, and deployments can inject only adapters they
  register deliberately.
- Added local-only `doctor`, `init`, and `validate` CLI commands; diagnosis
  probes executable versions without starting a model run.
- Added built-in catalog entries for Claude Code, Qoder CLI, Codex CLI, Qwen
  Code and CodeBuddy Code. Documentation claims never satisfy runnable package
  compatibility, and Codex remains probe-only because Codex CLI 0.146.0 cannot
  reliably remove every model-visible built-in tool, notably `apply_patch`.
- Added a runnable Host Adapter and `run --engine qoder` path for
  conformance-tested Qoder CLI 1.1.x. It uses a stateless read-only projection,
  isolated configuration, filtered environment, stdin JSONL initialization and
  task transport, native stream normalization, package-aware preflight,
  pre-launch cancellation, file-identity checks, runtime policy attestation,
  SDK process-mode authentication, protocol-major validation, atomic native
  event validation, pre-terminal credential cleanup, and outer JSON Schema
  validation.
- Added runnable, stateless context-only adapters for Claude Code
  `>=2.1.214 <2.2.0`, Qwen Code `0.17.1` and CodeBuddy Code `2.106.4`. They use
  explicit service API keys instead of personal login state, sealed bounded
  UTF-8 asset values over stdin, empty isolated workspace, home, configuration
  and temp directories, version-specific zero-tool/MCP runtime attestation,
  filtered environments, strict unknown-event and secret-output handling,
  bounded cleanup, POSIX process-group termination, cancellation and
  post-cleanup terminal events. Qwen also
  disables its built-in slash commands; CodeBuddy exhaustively denies every
  tool exposed by 2.106.4 because its empty `--tools` flag alone is ineffective.
  MCP, attachments, session resume, write tools, approval callbacks and Windows
  execution remain unsupported; live model entitlement was not tested.
- Added `--stdin` and `--input-file` task sources so callers can keep task data
  out of the outer CLI argument vector.
- Added the strict `employee-profile.v1` manifest and runtime API compatibility contract.
- Added explicit profile, source, model, channel, and tool registries plus a fail-closed local module loader.

### Changed

- Reframed the existing model/retriever execution path as the
  `standalone-v1` compatibility runtime; new Agent behavior targets external
  Agent hosts through adapters instead of extending a second general loop.
- Added the explicit `legacy ask|sync|start|serve` namespace. Existing
  top-level commands remain deprecated aliases through `0.x`; Agent-native
  commands do not eagerly import or fall back to the compatibility runtime.
- Changed zero-argument `npm start` and the source-built container to show the
  Agent-native CLI help. Compatibility services now require an explicit
  `legacy ...` entry point.
- npm releases now use GitHub Actions OIDC trusted publishing instead of a long-lived repository token.
- Shipped runtime, connector, profile, application, and test sources now use
  strict TypeScript; npm and CLI entry points execute generated ESM from
  `dist/` with declarations and source maps.
- `answer-agent` and all shipped connectors now assemble through registry entries instead of CLI conditionals; legacy 0.1 profile strings remain supported.
- The first-release runtime now rejects any deployment or profile that requests write capability.

## [0.1.0] - 2026-08-01

### Added

- Generic digital employee runtime with a read-only `answer-agent` profile.
- Approved filesystem, Git, and optional DWS knowledge sources.
- Console and optional DingTalk channels.
- OpenAI-compatible and zero-credential extractive model providers.
