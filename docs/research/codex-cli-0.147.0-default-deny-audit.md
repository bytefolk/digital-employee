# Codex CLI 0.147.0 default-deny re-audit

## Decision

**NO-GO. Codex CLI 0.147.0 remains probe-only.** A deterministic local
Responses fixture observed `apply_patch` in the model-visible `tools` request
even after user config, shell, unified execution, Apps, plugins, Skill search,
multi-agent, image, and workspace-dependency surfaces were disabled. A
disabled web search, request-user-input, and update-plan surface did not remove
`apply_patch`. A read-only sandbox or Prompt instruction cannot substitute for
removing a disallowed tool.

No runnable Adapter, registry entry, or support claim is introduced by this
research result.

## Fixed target and public sources

- Official release: [`rust-v0.147.0`](https://github.com/openai/codex/releases/tag/rust-v0.147.0),
  published as a non-prerelease on 2026-08-07.
- Tag commit: [`be6e8eac029b183056b7e4402879f15d2c85f61b`](https://github.com/openai/codex/commit/be6e8eac029b183056b7e4402879f15d2c85f61b).
- npm package: `@openai/codex@0.147.0`, Apache-2.0, integrity
  `sha512-EQLEXecAG2ptxI7UpBMo2TR/ga5596/c/OsYF/0LoUDh5JANZ7IoGqlzBEWbuEVQ76JePIbtTW/ihCkp1a7Z3w==`.
- GitHub release archive `codex-aarch64-apple-darwin.tar.gz` SHA-256, as
  published in the release asset metadata:
  `75984b81f92a71b0c0f4b3b5cad80e5c57177e4d8c8b4b1e13db703b20dc4358`.
- Audited npm-package-extracted, signed darwin-arm64 executable SHA-256:
  `19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37`.

The archive digest and executable digest identify different byte sequences;
the dynamic probe below executed the npm-package-extracted signed executable.

The pinned source registers `apply_patch` whenever an execution environment is
present and the selected model declares an apply-patch tool type; the
registration condition has no separate allowlist check:
[`spec_plan.rs`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/tools/spec_plan.rs#L1016-L1020).
The model-visible custom-tool definition is explicit in
[`apply_patch_spec.rs`](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L9-L25).
Those source observations are E2 support for, not a replacement for, the E3
dynamic inventory below.

## Safety boundary

The probe creates fresh temporary HOME, `CODEX_HOME`, XDG config/cache, temp,
and workspace directories; passes a minimal environment allowlist with a
non-secret placeholder; uses `--ignore-user-config` and `--ephemeral`; disables
analytics; and points the only model provider at an HTTP fixture bound to
`127.0.0.1`. The fixture accepts exactly `POST /v1/responses`, returns static
Responses events, and performs no model inference. The prompt asks for no tool
call, no tool output or model payload is saved, and the record contains no
headers, credentials, prompts, private paths, or account state.

No real provider was configured, and the expected loopback request was
observed. External-network behavior and remote-write behavior were not
independently measured and remain `NOT_VERIFIED`. The probe did not use a
personal login, entitlement, paid model, or remote MCP server.

## Reproduction

Set `CODEX_BIN` to the official 0.147.0 binary from the pinned npm package, then
run:

```bash
node scripts/audit-codex-host.js --codex-bin "$CODEX_BIN"
```

The script refuses any version other than 0.147.0. Its bounded `codex exec`
invocation uses:

```text
--strict-config --ephemeral --ignore-user-config --skip-git-repo-check
--sandbox read-only --json --model gpt-5.2
--disable shell_tool --disable unified_exec --disable apps
--disable plugins --disable skill_search --disable multi_agent
--disable view_image --disable workspace_dependencies
analytics.enabled=false
web_search="disabled"
tools.experimental_request_user_input.enabled=false
tools.update_plan.enabled=false
```

Observed sanitized record:
[`tests/fixtures/agent-hosts/codex-cli-0.147.0-no-go.json`](../../tests/fixtures/agent-hosts/codex-cli-0.147.0-no-go.json).

The model-visible tools were exactly:

```json
["apply_patch"]
```

The CLI exited 0 and emitted `thread.started`, `turn.started`, and
`turn.completed`. This is E3 evidence for the tool inventory and the stable
NO-GO blocker. It is not proof of adversarial event validation or cleanup.

## Qualification vector ledger

| #30 / R2 vector | Result | Evidence and boundary |
| --- | --- | --- |
| Model-visible tool removal | **FAIL (E3)** | After every expressible tool reduction above, the dynamic request inventory still contains disallowed `apply_patch`. |
| Pinned source registration path | **FAIL-supporting (E2)** | Exact-tag source registers `apply_patch` from model metadata whenever an environment exists. |
| Native event validation | OBSERVED, NOT QUALIFIED | Three lifecycle event types were observed; malformed, duplicate, and post-terminal cases were not exercised. |
| Single terminal outcome | NOT VERIFIED | One nominal static response is not an adversarial terminal-outcome test. |
| Deadline / cancellation | NOT VERIFIED | No App Server `turn/interrupt` or deadline race was executed. |
| Process-tree cleanup | NOT VERIFIED | No child/grandchild fixture was launched through a Codex Adapter. |
| Credential boundary | NOT VERIFIED | The probe uses no real credential, but did not test rejection or leak paths. |
| Filesystem enforcement | NOT VERIFIED | `--sandbox read-only` was configured; no hostile write was executed. Tool visibility already fails admission. |
| Network enforcement | NOT VERIFIED | Only loopback transport was used; no adversarial external-network attempt was executed. |
| MCP isolation | NOT VERIFIED | No MCP server was configured or exercised. |
| Skill / plugin isolation | NOT VERIFIED | Features were disabled, but no hostile Skill or plugin fixture was exercised. |
| Output Schema behavior | NOT VERIFIED | No schema success/failure fixture was executed. |

## Three independent axes

| Axis | Result | Reason |
| --- | --- | --- |
| `implemented` | `false` | No Codex `agent-host.v1` Adapter is introduced. |
| `fixture-conformant` | `false` | Mandatory default-deny tool enforcement fails at the dynamic inventory step. |
| `live-qualified` | `false` | Live provider/authentication/model use was intentionally prohibited. |

The next re-audit trigger is a stable upstream interface that can enforce an
explicit model-visible built-in tool allowlist (including removal of
`apply_patch`) for a normal execution environment. Until then, issue #34
remains research-only and Codex remains probe-only.
