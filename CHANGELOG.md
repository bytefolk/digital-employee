# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Added the strict `employee-profile.v1` manifest and runtime API compatibility contract.
- Added explicit profile, source, model, channel, and tool registries plus a fail-closed local module loader.

### Changed

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
