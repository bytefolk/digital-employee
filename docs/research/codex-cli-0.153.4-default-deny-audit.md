# Codex CLI 0.153.4 default-deny re-audit

## Decision

**NO-GO.** Codex CLI 0.153.4 cannot be admitted as a runnable `agent-host.v1`
Adapter. The blocker is unchanged from the 0.147.0 and 0.148.0 audits: the
model-visible tool inventory still contains `apply_patch`, and no expressible
configuration surface removes it.

This record exists because 0.153.4 was the current stable release while
0.148.0 was the newest version the probe would accept. It answers "is this
still NO-GO on the version people actually have installed" without requiring
anyone to repeat a source edit by hand.

| Field | Value |
| --- | --- |
| Audited version | `codex-cli 0.153.4` |
| Policy | `digital-employee-default-deny.v1` |
| Record schema | `codex-host-research-record.v1` |
| Verdict | `NO_GO` |
| Blocker | `model_visible_disallowed_tool:apply_patch` |

## Fixed target and public sources

- Upstream [openai/codex#8161](https://github.com/openai/codex/issues/8161)
  ("Allow users to disable the built-in `apply_patch`") is **closed as
  `not_planned`**, verified 2026-09-08.
- Upstream [openai/codex#6049](https://github.com/openai/codex/issues/6049)
  ("Ability to disable built-in tools for MCP-only execution") is **open** with
  no landed switch, verified 2026-09-08.

Re-auditing on a newer release is therefore not expected to change the verdict
until #6049 lands an actual toggle. Version bumps alone have now been checked
through 0.153.4 and no longer justify a fresh audit on their own.

## Safety boundary

The probe uses no live provider, credential or model. It binds a loopback HTTP
fixture and points Codex at it through `model_providers`, so the audited
request inventory is what Codex would have sent, captured without contacting
a real endpoint. `--sandbox read-only` is configured. No hostile fixture was
executed: this audit establishes admission failure, not adversarial hardening
results.

## Reproduction

```bash
CODEX_BIN="$(command -v codex)"
"$CODEX_BIN" --version   # codex-cli 0.153.4

node scripts/audit-codex-host.js --codex-bin "$CODEX_BIN" --expect-version 0.153.4
```

`--expect-version` is required here: the probe defaults to
`AUDITED_CODEX_VERSION` (0.148.0) and fails closed on a mismatch, so that a
record can never silently describe a different build than the one it audited.
Without the flag the run exits 2 with
`expected codex-cli 0.148.0, found 0.153.4`.

Observed record fields:

```json
{
  "auditedVersion": "0.153.4",
  "policy": "digital-employee-default-deny.v1",
  "modelVisibleTools": ["apply_patch"],
  "eventTypes": ["thread.started", "turn.completed", "turn.started"],
  "processExitCode": 0,
  "axes": { "implemented": false, "fixtureConformant": false, "liveQualified": false },
  "verdict": "NO_GO",
  "blocker": "model_visible_disallowed_tool:apply_patch"
}
```

### Candidate removal surfaces, all rejected

Each was run against 0.153.4 with `--strict-config --ephemeral
--ignore-user-config --skip-git-repo-check --sandbox read-only`:

| Attempt | Result |
| --- | --- |
| `-c tools.apply_patch.enabled=false` | `Error loading config.toml: unknown configuration field 'tools.apply_patch' in -c/--config override` |
| `-c features.apply_patch=false` | `Error loading config.toml: unknown configuration field 'features.apply_patch' in -c/--config override` |
| `-c tools.apply_patch="disabled"` | `Error loading config.toml: unknown configuration field 'tools.apply_patch' in -c/--config override` |
| `--disable apply_patch` | `Error: Unknown feature flag: apply_patch` |

Event types are identical to the 0.148.0 audit, so no protocol change
accompanied the version range.

## Qualification vector ledger

| #30 / R2 vector | Result | Evidence and boundary |
| --- | --- | --- |
| Model-visible tool removal | **FAIL (E3)** | The dynamic request inventory contains disallowed `apply_patch`. All four candidate removal surfaces above are rejected by `--strict-config` on this release. |
| Native event validation | OBSERVED, NOT QUALIFIED | Three lifecycle event types were observed; malformed, duplicate and post-terminal cases were not exercised. |
| Single terminal outcome | NOT VERIFIED | One nominal static response is not an adversarial terminal-outcome test. |
| Deadline / cancellation | NOT VERIFIED | No App Server `turn/interrupt` or deadline race was executed. |
| Process-tree cleanup | NOT VERIFIED | No child/grandchild fixture was launched through a Codex Adapter. |
| Credential boundary | NOT VERIFIED | The probe uses no real credential, but did not test rejection or leak paths. |
| Filesystem enforcement | NOT VERIFIED | `--sandbox read-only` was configured; no hostile write was executed. Tool visibility already fails admission. |
| Network enforcement | NOT VERIFIED | Only loopback transport was used; no adversarial external-network attempt was executed. |
| MCP isolation | NOT VERIFIED | No MCP server was configured or exercised. |
| Skill / plugin isolation | NOT VERIFIED | No hostile Skill or plugin fixture was exercised. |
| Output Schema behavior | NOT VERIFIED | No schema success/failure fixture was executed. |

## Three independent axes

| Axis | Result | Reason |
| --- | --- | --- |
| `implemented` | `false` | No Codex `agent-host.v1` Adapter is introduced. |
| `fixture-conformant` | `false` | Mandatory default-deny tool enforcement fails at the dynamic inventory step. |
| `live-qualified` | `false` | Live provider, authentication and model use were intentionally prohibited. |

## Why an Embedder registration does not route around this

`deriveEmployeeHostRequirements` in
[`packages/core/src/employee-package.ts`](../../packages/core/src/employee-package.ts)
adds `tool_allowlist` to the required capability set for **every** employee
package, unconditionally — approval gates a permitted call and cannot
substitute for removing a tool that was never granted.
`assessAgentHostCompatibility` treats a required capability that is not
`supported` as blocking, and additionally requires
`capabilitySource === "conformance_test"`. `runEmployeePackage` then fails with
non-retryable `agent_host_incompatible`.

So registering a Codex Adapter through the trusted Embedder API
(`./host-runtime`) removes the need for a product decision about shipping a
built-in Host, but it does not remove this gate. The only way past it is for
the registered Adapter to report `tool_allowlist: "supported"` and
`capabilitySource: "conformance_test"` when neither holds, which defeats the
check this audit exists to enforce. That is not an approved path.
