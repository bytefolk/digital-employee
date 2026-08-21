# Clean-machine install notes

This file collects honest install experience reports from clean machines.
Each note records the machine, installed version, golden-path result, friction
points, fault paths hit, and recovery steps. Recurring friction items feed into
[#139](https://github.com/fullstack-ai-infra/digital-employee/issues/139) (UX
improvements) and the [Adoption Quickstart (Epic
#91)](https://github.com/fullstack-ai-infra/digital-employee/issues/91).

## Privacy discipline

- No secrets, API keys, tokens, or credentials.
- No personal identifiers (email, username, account IDs).
- No private URLs, internal hostnames, or network paths.
- Screenshots must be redacted before attaching.
- Transcripts must use the exact output — no manual beautification.

## Template

Copy the block below for each new note:

```markdown
### YYYY-MM-DD — <short summary>

- **Machine:** <OS, architecture, distro/version>
- **Installed version:** <tag or commit hash>
- **Node.js:** <version>
- **npm:** <version>
- **Agent Hosts found:** <list, or "none">
- **Golden-path result:** <pass/fail/partial>
- **Steps:**
  1. <step>
  2. <step>
- **Friction points:**
  - <what confused, delayed, or broke>
- **Fault paths hit:**
  - <error, exit code, and how you recovered>
- **Recovery:**
  - <what you did to move forward>
```

---

## Notes

### 2026-08-21 — WSL2 Ubuntu 26.04, npm 0.4.0, golden-path pass

- **Machine:** Ubuntu 26.04 (Resolute Raccoon) x86_64, WSL2 on Windows 11, kernel 6.18.33.2
- **Installed version:** `@fullstack-ai-infra/digital-employee@0.4.0` (npm)
- **Node.js:** v24.19.0
- **npm:** 11.17.0
- **Agent Hosts found:** Claude Code 2.1.235 (available, `ANTHROPIC_API_KEY` not configured); Qoder CLI, Qwen Code, CodeBuddy Code, Codex CLI (not found)
- **Golden-path result:** pass (all credential-free steps succeeded)
- **Steps:**
  1. `npm init -y` in an empty directory
  2. `npm install @fullstack-ai-infra/digital-employee@0.4.0` — 36 packages added, 0 vulnerabilities
  3. `npx digital-employee doctor --json` — reported `"status": "installed"`, `"runnable": false`, 5 hosts probed
  4. `npx digital-employee init ./my-employee --recipe minimal-answer.v1 --author your-team` — 6 files created
  5. `npx digital-employee validate ./my-employee --json` — `"status": "valid"`
  6. `npx digital-employee eval ./my-employee --json` — `"status": "passed"`, 1/1 cases passed
  7. `npx digital-employee deploy ./my-employee --channel http --engine claude-code --runtime agent-native --port 3000 --yes` — exited 1 with `claude_api_key_not_configured` (correct fail-closed)
  8. `npx digital-employee setup --json` — `"status": "ready"`, scaffolded employee, listed next steps
- **Friction points:**
  - `npm install` produced a `npm warn allow-scripts` notice about `esbuild` postinstall scripts; harmless but may alarm first-time users who see "1 package has install scripts not yet covered by allowScripts."
  - `doctor` reports `"runnable": false` even when a Host binary is found — the message is accurate (no credential configured), but a first-time user might interpret "runnable: false" as "the Host is broken" rather than "you haven't configured a service key yet."
  - `deploy` correctly fails, but the error message `The selected engine is unsupported, unavailable, or incompatible (claude_api_key_not_configured)` is a single-line stderr output. A user who didn't read the install guide carefully might not know to set `ANTHROPIC_API_KEY` — the error code is clear but the recovery path is not stated in the message itself.
  - `setup` is a convenience command that combines doctor + init, but it is not listed in the `--help` overview's top-level commands section (only in the Agent-native usage section). A user scanning the README might miss it.
- **Fault paths hit:**
  - `deploy` with missing API key → exit 1, error message `claude_api_key_not_configured` (correct fail-closed)
- **Recovery:**
  - No recovery needed for the credential-free path. The `deploy` failure is expected behavior.

### 2026-08-21 — WSL2 Ubuntu 26.04, source checkout (main 1fb0af6), golden-path pass

- **Machine:** Ubuntu 26.04 (Resolute Raccoon) x86_64, WSL2 on Windows 11, kernel 6.18.33.2
- **Installed version:** source checkout, commit `1fb0af6` (main branch HEAD)
- **Node.js:** v24.19.0
- **npm:** 11.17.0
- **Agent Hosts found:** Claude Code 2.1.235 (available, no API key)
- **Golden-path result:** pass (all credential-free steps succeeded)
- **Steps:**
  1. `git clone https://github.com/fullstack-ai-infra/digital-employee.git`
  2. `npm ci` — 45 packages added, 0 vulnerabilities, 1 `npm warn allow-scripts` notice for esbuild
  3. `npm run typecheck` — passed (both tsconfig.json and tsconfig.test.json)
  4. `npm run build` — passed (clean, compile, copy assets)
  5. `npm test` — 1431 tests, 1430 passed, 1 failed (see friction below)
  6. `node ./dist/apps/cli/bin.js doctor --json` — `"status": "installed"`, `"runnable": false`
  7. `node ./dist/apps/cli/bin.js init /tmp/my-employee-source --recipe minimal-answer.v1 --author your-team` — 6 files created
  8. `node ./dist/apps/cli/bin.js validate /tmp/my-employee-source --json` — `"status": "valid"`
  9. `node ./dist/apps/cli/bin.js eval /tmp/my-employee-source --json` — `"status": "passed"`
- **Friction points:**
  - `npm test` produced 1 failure in `tests/apps/deploy-cli.test.ts`: `HTTP activation protocol fails closed across EOF, timeout, forged tuple, generation, and lock-fence faults`. The test asserts `expectParentIpcLossReleasesLease` and reports `true !== false`. This failure has so far only been observed under WSL2; the hypothesis is that it stems from IPC timing differences in WSL2's process model. Confirmation against a native Ubuntu runner CI record is still needed. A developer working on WSL2 should be aware of this observation.
  - `npm ci` warns about `esbuild` postinstall scripts not covered by `allowScripts` — same as the npm consumer path.
  - The `npm run check` gate (`typecheck && build && test && governance:check && security:check`) takes ~6 minutes end-to-end, dominated by the test suite (~5.5 min). First-time contributors may be surprised by the duration.
- **Fault paths hit:**
  - Test failure in `deploy-cli.test.ts` (observed under WSL2; native Linux CI confirmation pending)
- **Recovery:**
  - The single test failure is currently observed only under WSL2. Native Linux CI (GitHub Actions, Ubuntu runner) results should be checked to confirm the hypothesis.

---

## Recurring friction → issue tracker

Friction items that appear across multiple install notes are promoted here
and linked to the relevant issues for resolution.

| Friction | First reported | Linked issue | Status |
| --- | --- | --- | --- |
| `doctor` reports `"runnable": false` even when a Host binary is found — unclear to first-time users that it means "no credential configured" | 2026-08-21 | [#139](https://github.com/fullstack-ai-infra/digital-employee/issues/139) | Open |
| `deploy` error messages state the error code but not the recovery action (e.g., "set `ANTHROPIC_API_KEY`") | 2026-08-21 | [#139](https://github.com/fullstack-ai-infra/digital-employee/issues/139) | Open |
| `setup` command not discoverable from `--help` top-level overview | 2026-08-21 | [#139](https://github.com/fullstack-ai-infra/digital-employee/issues/139) | Open |
| `deploy-cli.test.ts` IPC test failure observed under WSL2; hypothesis is WSL2 process-model timing difference, native Linux CI confirmation pending | 2026-08-21 | [#91](https://github.com/fullstack-ai-infra/digital-employee/issues/91) (AC-001 CI gate) | Open |
| `npm ci` / `npm install` warn about `esbuild` `allowScripts` — harmless but noisy for first-time users | 2026-08-21 | [#139](https://github.com/fullstack-ai-infra/digital-employee/issues/139) | Open |