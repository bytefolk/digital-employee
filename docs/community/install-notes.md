# Install notes

Standing collection point for clean-machine install experience reports
(Issue [#141](https://github.com/fullstack-ai-infra/digital-employee/issues/141),
part of the Adoption track
[#91](https://github.com/fullstack-ai-infra/digital-employee/issues/91)).

Anyone who installs the framework on a machine that did not build it is
encouraged to append a note below. Recurring friction is folded back into the
deploy CLI experience work
([#139](https://github.com/fullstack-ai-infra/digital-employee/issues/139))
and the Quickstart
([#91](https://github.com/fullstack-ai-infra/digital-employee/issues/91)).

## Privacy discipline

Notes are public repository content. The repo's standing rules apply:

- No secrets, API keys, tokens or credential fragments — not even redacted
  copies if the original is short enough to guess.
- No personal identifiers, employee names, internal chat exports or private
  URLs.
- Describe environments generically: OS, architecture, Node/npm versions and
  package version. Hostnames, usernames and paths stay out.
- Screenshots must be redacted or omitted; prefer pasted command output with
  identifiers removed.

## Template

Copy this block and append it below the newest note:

```markdown
### <date> — <OS/arch, e.g. macOS 15 arm64>

- Installed version: <package version, e.g. 0.4.0>
- Toolchain: Node <version>, npm <version>
- Steps followed: <link or short list, e.g. INSTALL.md golden path>
- Golden-path result: <pass/fail per step: install / doctor / init / validate / eval>
- Friction points: <what confused you, in order hit; "none" is a valid answer>
- Fault paths hit and recovery: <error codes seen and how you recovered; "none" is valid>
```

## Notes

### 2026-08-21 — macOS 15.5 arm64

- Installed version: 0.4.0
- Toolchain: Node v24.13.0, npm 11.6.2
- Steps followed: `INSTALL.md` golden path in a fresh empty directory
  (`npm init -y` → `npm install @fullstack-ai-infra/digital-employee@0.4.0` →
  `doctor --json` → `init --recipe minimal-answer.v1` → `validate --json` →
  `eval --json`)
- Golden-path result: all five steps pass. Install took ~5s with
  0 vulnerabilities; `validate` reports `"status": "valid"`; `eval` reports
  `EVAL_CASE_PASSED` for the scaffolded case.
- Friction points:
  - `doctor` prints a top-level `"runnable": false` when any host is missing
    credentials, while individual hosts can still be fully ready (here `codex`
    reported `installed`/`available`). A first-time reader has to scan the
    per-host entries to learn that a live run is possible. The per-host issue
    codes themselves are good: each one names the next action
    (`qoder_service_token_not_configured`, `qwen_api_key_not_configured`,
    `codebuddy_api_key_not_configured`).
  - `claude-code` reported `probe_failed` (`host_version_probe_failed`)
    because this machine has no usable Claude CLI; the same limitation is
    already tracked in
    [#125](https://github.com/fullstack-ai-infra/digital-employee/issues/125)
    and [#138](https://github.com/fullstack-ai-infra/digital-employee/issues/138).
- Fault paths hit and recovery: none. No step required recovery on this run.
