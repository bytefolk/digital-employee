# Verification ledger

Last reviewed: 2026-08-25

This file distinguishes shipped code from the environments in which it has
actually been exercised. A passing fixture test is not presented as a live
provider integration.

Dated counts below are historical snapshots tied to their stated date. Public
`0.4.0` is the current tagged release and contains the package-bound deploy;
changes merged after that tag are not themselves a published release, and
their exact-head test counts and package sizes are deliberately not inferred
from an earlier run.

| Path | Evidence | Result |
| --- | --- | --- |
| Local answer and escalation | Public example files, extractive model, real CLI process | Verified |
| Automated suite (historical source snapshot) | `npm run check` on Node.js 24.13.0 | 1,176/1,176 tests plus strict TypeScript, build and the repository security scan passed on 2026-08-10; this historical snapshot is not a current-head claim, and provider fixtures do not make live model requests |
| Coverage gate (historical pre-deploy baseline) | `npm run test:coverage` on Node.js 22.23.2 | 343/343 tests on 2026-08-04; 91.97% line, 73.48% branch and 90.44% function coverage; not presented as coverage for the newer deploy surface |
| Strict TypeScript | `npm run typecheck` | 0 errors across shipped runtime sources |
| Agent-host install probes | Real local version/init probes plus bounded fixture processes | Qoder CLI 1.1.17, Codex CLI 0.148.0, Qwen Code 0.17.1 and CodeBuddy Code 2.106.4 found locally; Claude Code 2.1.209 is below the verified range and its probe failed; live authentication/model access not tested |
| Qoder run adapter | Adapter-specific deterministic child-process fixtures plus checked-in `structured-action.v1` package negotiation; not a reusable third-party certification harness | Qoder CLI 1.1.x SDK process-mode initialize/user/EOF transport, private auth payload, argument isolation, minimum read-only projection, filtered environment, exact read/search tool plus empty MCP/plugin/Skill attestation, package-aware preflight, atomic event publication, cross-delta exact-credential scrubbing, pre-truncation tool-value scrubbing, credential-bearing tool identifier/key rejection, and cancellation/cleanup invariants verified. `structured_output` additionally covers strict matching, prose/fence/truncated/malformed JSON, mismatch/extra fields, `false` Schema, absent Schema, credential mutation, buffered cancellation, independent deadline handling, and invalid/oversized/async Schema rejection before any Qoder process. A real model-free Qoder 1.1.17 probe made the public `senior-architect-pass-coach@0.3.0` employee compatible through ordinary package validation; unverified versions fail closed. This is Adapter-specific fixture evidence (`capabilitySource: conformance_test`), no Qoder qualification record was generated, `liveQualified` remains false, and no live model request was made. |
| Claude Code run adapter | Adapter-specific deterministic version-locked child-process fixtures only | Claude Code `>=2.1.214 <2.2.0`, explicit `ANTHROPIC_API_KEY`, `--bare --tools ""`, strict empty MCP, disabled commands/session persistence, sealed UTF-8 stdin assets, empty isolated workspace, home, configuration and temp directories, runtime empty tool/MCP/plugin/Skill attestation, strict unknown-event rejection, process-group descendant cleanup, cancellation and terminal invariants verified on POSIX; no live model request made |
| Qwen Code run adapter | Exact-version child-process fixtures plus real local init against an unreachable loopback endpoint | Qwen Code `0.17.1`, explicit `OPENAI_API_KEY` and `OPENAI_MODEL`, sealed UTF-8 stdin assets, disposable empty workspace, home, configuration and temp directories, empty tool/MCP/slash-command surface and exact non-callable built-in Agent catalog, secret-safe structured output, cancellation, process-group cleanup and terminal invariants verified on POSIX; no model request reached a provider |
| CodeBuddy Code run adapter | Exact-version child-process fixtures plus real local init against an unreachable loopback endpoint | CodeBuddy Code `2.106.4`, explicit `CODEBUDDY_API_KEY` and `CODEBUDDY_MODEL`, sealed UTF-8 stdin assets, disposable empty workspace/config/session/temp state, exhaustive built-in deny list and final empty tool/MCP attestation, strict status/snapshot/unknown-event checks, secret-safe structured output, cancellation, process-group cleanup and terminal invariants verified on POSIX; no model request reached a provider |
| Issue #113 capability evidence | Deterministic marker fixtures across all four runnable Adapters plus the exact-version table in `docs/agent-hosts.md` | Schema bytes asserted absent from argv, process environment values, and the public event stream on Qoder, Claude, Qwen and CodeBuddy; exact locked Host versions named (Qoder `1.1.x` family / fixture `1.1.12`, Claude Code `>=2.1.214 <2.2.0`, Qwen Code `0.17.1`, CodeBuddy Code `2.106.4`); fixture conformance only with `liveQualified: false`; no tool, MCP, write, network or approval authority added; the later versioned release proving generic downstream selection remains a separate release gate |
| Claude-local turn-run model port (#182) | `tests/apps/claude-local-model-port.test.ts` fixtures plus manual gate exercise against a local Claude Code install | Zero-tool spawn, environment construction, stream parsing, `claude_local_not_logged_in` / `claude_local_version_not_supported` / `claude_local_binary_unavailable` fail-closed gates verified; AC-001 live authenticated turn remains NOT VERIFIED (no logged-in install on the verification machine; the local `claude` binary exits 137 under SIGKILL) |
| Qoder turn-run model port (#185) | `tests/apps/qoder-model-port.test.ts` and `tests/apps/turn-run.test.ts` deterministic fixtures plus manual spawn-surface repro on head 5e18005 (macOS arm64, Node v24.13.0, qodercli 1.1.29 conformant) | Token enters only via the `QODER_PERSONAL_ACCESS_TOKEN` environment allowlist; missing token fails closed exit 1 with `qoder_service_token_not_configured` (manually reproduced, empty stdout); probe returns usable for qodercli 1.1.29 and rejects out-of-family versions; no token counts returned (`usage_events: unknown`) with iteration budgets still applied; AC-001 live authenticated turn remains NOT VERIFIED pending Issue #177 token authorization |
| Probe-only compatibility | CLI integration fixture and source audit | Codex CLI 0.148.0 remains probe-only because `apply_patch` and other model-visible built-ins cannot all be reliably removed; its bounded `--version` subprocess probe does not authenticate, invoke a model or execute tools; missing service keys and unverified runnable-host versions fail closed |
| Employee package | `init`, static `validate`, schema parity and hostile path fixtures | Atomic scaffold verified; malformed Skill/YAML/JSON Schema, direct/nested traversal, symlinks, glob artifacts and policy mismatches rejected |
| Package-bound deploy | Built-CLI and direct fault fixtures in `tests/apps/deploy-cli.test.ts`; clean installed-tarball consumer gate in `release.yml` | The source test surface covers exact package/cwd binding, localized automation and help, private atomic state, HTTP health/ask readback, activation and cleanup faults, locks, races and replay fences. The release gate additionally installs the exact root tgz in a clean prefix, scaffolds a recipe, reports the installed version, starts a fake-Qoder HTTP deployment, reads health/ask, and proves PID cleanup. Deploy shipped in public `0.4.0` through that workflow; `0.3.0` predates deploy. DingTalk fixtures remain E3 only and real provider E4 remains external HOLD. |
| Publisher-owned Runner kernel | Protocol, lease, replay, package snapshot and executor fixtures | Trusted-key Ed25519 task/receipt envelope verification, canonical event hash chains, signed monotonic renewals, fencing identity, nonce replay rejection, exact local package digest, read-only one-run snapshot, lease abort and stable signed failure receipts verified |
| Cross-repository Runner path | Manual compiled framework and private-platform acceptance harness; not yet a committed CI job | Platform claim → local package/Agent Host → 4 uploaded events → Runner-signed receipt → independent usage verification → settled Credit completed on 2026-08-04; the platform never received a local path, package bytes or Host credential |
| Real-local mem/doc read path (#42 Phase A) | Manual `scripts/real-local-harness.mjs` run against actual pinned services (mem `3335ebe`, doc `b22ff1d`), plus offline loopback-fake host/matrix tests in CI | 9/9 scenarios passed on 2026-08-06 (two-session granted resume with stable locators, cross-principal/workspace denial, wrong-revision/unauthorized/revoked-or-unlisted document reads, unreachable service, unsupported matrix); evidence class `real-local-e2e`, secret scan empty |
| MCP declaration | TypeScript and public Schema fixtures | stdio and HTTPS declarations accept environment names only; inline HTTP auth fields, insecure HTTP and duplicate servers rejected |
| Compiled package | Public `v0.4.0` and `v0.3.0` artifacts; current-source `npm pack --json` and release consumer gate | `0.4.0` is the current public root/core release; `0.3.0` remains public and historical. Current-source release policy requires immutable archive digest checks plus clean-tarball import/init/setup/deploy/health/ask/PID-cleanup verification; per-change file counts and byte sizes are recorded per change, not inferred from a tag. |
| Second profile | Explicitly allowlisted `minimal-reader` fixture through source and compiled runtimes | Answered with one approved citation; no core/CLI switch change |
| Dependency audit | `npm audit --audit-level=high` | 0 known vulnerabilities |
| Container | Built the current source `Dockerfile`; ran it with no arguments, then with explicit `legacy serve` | Default Agent-native help verified; explicit compatibility `/health` and `/v1/ask` verified |
| HTTP session isolation | Client-selected request, actor, and session IDs are rejected; each built-in HTTP call receives a server-generated isolated session | Verified by automated test |
| DWS `doc read` | Created a document containing public test text, then loaded that explicitly approved node through `DwsKnowledgeSource` | Verified: 1 document returned and the known sentence matched |
| DWS Minutes, chat, Wiki, and Drive commands | Leaf schema/help contract checks plus process-boundary fixtures | Not live-provider tested in this release |
| DingTalk Stream | Injected SDK/client/network/clock tests for ACK, normalization, dedupe, reconnect, reply, and shutdown | Live app credentials not tested in this public repository |
| OpenAI-compatible provider | Bounded HTTP fixture tests | Live provider key not tested in this public repository |

The DWS verification did not search or ingest existing business content. It
used one newly created document containing only public test text. Profile,
organization, user, document, and URL identifiers are deliberately omitted
from this repository.

To repeat the local and container-independent checks:

```bash
npm ci
npm run typecheck
npm run build
npm run check
npm run test:coverage
npm audit --audit-level=high
```

The historical 2026-08-10 snapshot completed all 1,176 tests through
`npm run check` on Node.js 24.13.0, and Node 24 is part of the regular CI
matrix. This is not a final-current-head deploy result. Its experimental
full-suite coverage reporter
can end with `Unexpected end of JSON input` while aggregating child-process
coverage, including three consecutive reproductions after every test passed on
the pre-fix `main` snapshot. The authoritative coverage job and release gate
therefore run on the repository-supported Node.js 22 line.
