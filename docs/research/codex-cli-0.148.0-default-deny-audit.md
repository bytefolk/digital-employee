# Codex CLI 0.148.0 default-deny re-audit

## Decision

**NO-GO. Codex CLI 0.148.0 remains probe-only.** A deterministic local
Responses fixture observed `apply_patch` in the model-visible `tools` request
even after user config, shell, unified execution, Apps, plugins, Skill search,
multi-agent, image, and workspace-dependency surfaces were disabled. A
disabled web search, request-user-input, and update-plan surface did not
remove `apply_patch`. A read-only sandbox or Prompt instruction cannot
substitute for removing a disallowed tool.

In addition, four candidate removal surfaces that this project had not yet
probed were rejected by `--strict-config` as unrecognized fields on 0.148.0:
`tools.apply_patch.enabled`, `--disable apply_patch`,
`features.apply_patch`, and `tools.apply_patch="disabled"`. No config path
exists in the audited release to express an apply-patch tool removal.

Upstream intent is corroborating evidence, not a substitute for the dynamic
probe: the request to allow disabling the built-in `apply_patch` tool was
closed as not planned
([openai/codex#8161](https://github.com/openai/codex/issues/8161),
2026-02-23), and the broader request to disable built-in tools for MCP-only
execution remains open without an enforcement surface
([openai/codex#6049](https://github.com/openai/codex/issues/6049)).

No runnable Adapter, registry entry, or support claim is introduced by this
research result.

## Fixed target and public sources

- Official release: [`rust-v0.148.0`](https://github.com/openai/codex/releases/tag/rust-v0.148.0),
  published as a non-prerelease on 2026-08-18.
- Tag commit: [`3ba0f711642a888aec92a611a3f3b2211157ff89`](https://github.com/openai/codex/commit/3ba0f711642a888aec92a611a3f3b2211157ff89).
- npm package: `@openai/codex@0.148.0`, Apache-2.0, integrity
  `sha512-bh5kH9+BMrFaHGmLeoSansPdfRksvr4UXzjQInns/KRO7r8VJ+6AAW+SqUsE8XcG3+OW/mI4EEy8Gpo9UDXGvQ==`.
- GitHub release archive `codex-aarch64-apple-darwin.tar.gz` SHA-256, as
  published in the release asset metadata:
  `758916aa38efa7ad076a050830fcbef1a7ed6f41efae9c1cceaeef63e428fc2b`.
- Audited npm-package-extracted, signed darwin-arm64 executable SHA-256:
  `b0308517b20543012fa2171aa3d46ce455a7456c4eb2a552ab9468ba4eeb1e50`.

The archive digest and executable digest identify different byte sequences;
the dynamic probe below executed the npm-package-extracted signed executable.

The pinned source still registers `apply_patch` whenever an execution
environment is present and the selected model declares an apply-patch tool
type; the registration condition has no separate allowlist check:
[`spec_plan.rs`](https://github.com/openai/codex/blob/3ba0f711642a888aec92a611a3f3b2211157ff89/codex-rs/core/src/tools/spec_plan.rs#L1101-L1105).
The model-visible custom-tool definition is explicit in
[`apply_patch_spec.rs`](https://github.com/openai/codex/blob/3ba0f711642a888aec92a611a3f3b2211157ff89/codex-rs/core/src/tools/handlers/apply_patch_spec.rs#L9-L25).
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

Set `CODEX_BIN` to the official 0.148.0 binary from the pinned npm package,
then run:

```bash
node scripts/audit-codex-host.js --codex-bin "$CODEX_BIN"
```

The script refuses any version other than 0.148.0. Its bounded `codex exec`
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
[`tests/fixtures/agent-hosts/codex-cli-0.148.0-no-go.json`](../../tests/fixtures/agent-hosts/codex-cli-0.148.0-no-go.json).

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
| Model-visible tool removal | **FAIL (E3)** | After every expressible tool reduction above, the dynamic request inventory still contains disallowed `apply_patch`. Candidate removal surfaces (`tools.apply_patch.enabled`, `--disable apply_patch`, `features.apply_patch`, `tools.apply_patch="disabled"`) are not accepted by `--strict-config` on this release. |
| Pinned source registration path | **FAIL-supporting (E2)** | Exact-tag source registers `apply_patch` from model metadata whenever an environment exists, with no allowlist check. |
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
