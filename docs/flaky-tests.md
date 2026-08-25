# Flaky test registry

Archived registry of test cases known to flake under heavy local load. A case
belongs here only after the clean-main-baseline adjudication: a fresh `main`
worktree (`npm ci && npm run build`) reproduces the same failure without the
change under review, while `main` CI stays green. Flaky status never waives a
required CI check; it only governs local-adjudication expectations.

Registry format: one row per case, append-only; removal requires a revision
decision recorded on the owning Issue.

| Test file | Test name | Flake signature | Adjudication record |
|---|---|---|---|
| `tests/apps/deploy-cli.test.ts` | `HTTP activation protocol fails closed across EOF, timeout, forged tuple, generation, and lock-fence faults` | Timing assertion fails under sustained local CPU load (observed >55s wall time) | Issue #193 / PR #195: clean-main baseline at `c1a6ced` reproduced the identical failure without the change; `main` CI runs (incl. 32867830529) green; changed-file intersection empty |
| `tests/apps/deploy-cli.test.ts` | `deployment lock deadline and supervised-helper matrix uses the real platform primitive` | Deadline wall-clock assertion slips under load | Same adjudication as above (Issue #193 / PR #195, batch of four) |
| `tests/apps/deploy-cli.test.ts` | `retained descriptor lock fences contenders, cancels waiters, and releases on owner SIGKILL` | SIGKILL/signal-timing assertion slips under load | Same adjudication as above (Issue #193 / PR #195, batch of four) |
| `tests/apps/deploy-cli.test.ts` | DingTalk provider timing cases (scope fence / provider timeout class) | Provider wall-clock timeout assertions slip under load | Same adjudication as above (Issue #193 / PR #195, batch of four) |

Local rerun protocol for an adjudicated flaky batch: rerun the two new or
changed test files in isolation
(`npx tsx --test --test-concurrency=1 <changed files>`), and treat the
flaky-batch failures as non-blocking only when all three adjudication
conditions hold (clean-main reproduction, green `main` CI, empty changed-file
intersection). Record the adjudication evidence in the PR's Validation section.
