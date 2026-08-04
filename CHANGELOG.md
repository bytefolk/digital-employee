# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

These changes are a source preview for the next minor release. The published
`0.1.0` artifacts remain the frozen `standalone-v1` compatibility release.

### Breaking changes

- **Source-checkout startup:** Running `npm start` without arguments no longer
  starts the `standalone-v1` configured channel. It prints Agent-native CLI
  help and exits. Use `npm run legacy:start -- [options]` to retain that
  behavior.
- **Source-built container startup:** Running the image without arguments no
  longer starts the compatibility HTTP server on port 3000, and the image no
  longer declares `EXPOSE 3000`. Existing deployments must explicitly pass
  `legacy serve --config ./dist/configs/demo.json --host 0.0.0.0 --port 3000`.
  The published `0.1.0` image is unchanged.

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
- Added probe-only catalog entries for Qwen Code and CodeBuddy Code alongside
  Claude Code and Codex. Documentation claims never satisfy runnable package
  compatibility.
- Added the first runnable Host Adapter and `run --engine qoder` path for Qoder
  CLI 1.1.x, verified by Adapter-specific deterministic process fixtures. It
  uses a stateless read-only projection,
  isolated configuration, filtered environment, stdin JSONL initialization and
  task transport, native stream normalization, package-aware preflight,
  pre-launch cancellation, file-identity checks, runtime policy attestation,
  SDK process-mode authentication, protocol-major validation, atomic native
  event validation, pre-terminal credential cleanup, and outer JSON Schema
  validation.
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
