# Verification ledger

Last updated: 2026-08-04

This file distinguishes shipped code from the environments in which it has
actually been exercised. A passing fixture test is not presented as a live
provider integration.

| Path | Evidence | Result |
| --- | --- | --- |
| Local answer and escalation | Public example files, extractive model, real CLI process | Verified |
| Automated suite | `npm run check` | 343/343 tests plus strict TypeScript, build and the repository security scan passed on 2026-08-04; provider fixtures do not make live model requests |
| Coverage gate | `npm run test:coverage` on Node.js 22.23.2 | 343/343 tests; 91.97% line, 73.48% branch and 90.44% function coverage |
| Strict TypeScript | `npm run typecheck` | 0 errors across shipped runtime sources |
| Agent-host install probes | Real local version/init probes plus bounded fixture processes | Qoder CLI 1.1.12, Codex CLI 0.146.0, Qwen Code 0.17.1 and CodeBuddy Code 2.106.4 found locally; Claude Code 2.1.209 is below the verified range and its probe failed; live authentication/model access not tested |
| Qoder run adapter | Adapter-specific deterministic child-process fixtures; not a reusable third-party certification harness | Qoder CLI 1.1.x SDK process-mode initialize/user/EOF transport, private auth payload, argument isolation, minimum read-only projection, filtered environment, exact read/search tool plus empty MCP/plugin/Skill attestation, package-aware preflight, atomic event publication, cross-delta exact-credential scrubbing, pre-truncation tool-value scrubbing, credential-bearing tool identifier/key rejection, schema-bound output redaction rejection, cancellation, file-identity checks, cleanup and terminal invariants verified; no live model request made |
| Claude Code run adapter | Adapter-specific deterministic version-locked child-process fixtures only | Claude Code `>=2.1.214 <2.2.0`, explicit `ANTHROPIC_API_KEY`, `--bare --tools ""`, strict empty MCP, disabled commands/session persistence, sealed UTF-8 stdin assets, empty isolated workspace, home, configuration and temp directories, runtime empty tool/MCP/plugin/Skill attestation, strict unknown-event rejection, process-group descendant cleanup, cancellation and terminal invariants verified on POSIX; no live model request made |
| Qwen Code run adapter | Exact-version child-process fixtures plus real local init against an unreachable loopback endpoint | Qwen Code `0.17.1`, explicit `OPENAI_API_KEY` and `OPENAI_MODEL`, sealed UTF-8 stdin assets, disposable empty workspace, home, configuration and temp directories, empty tool/MCP/slash-command surface and exact non-callable built-in Agent catalog, secret-safe structured output, cancellation, process-group cleanup and terminal invariants verified on POSIX; no model request reached a provider |
| CodeBuddy Code run adapter | Exact-version child-process fixtures plus real local init against an unreachable loopback endpoint | CodeBuddy Code `2.106.4`, explicit `CODEBUDDY_API_KEY` and `CODEBUDDY_MODEL`, sealed UTF-8 stdin assets, disposable empty workspace/config/session/temp state, exhaustive built-in deny list and final empty tool/MCP attestation, strict status/snapshot/unknown-event checks, secret-safe structured output, cancellation, process-group cleanup and terminal invariants verified on POSIX; no model request reached a provider |
| Probe-only compatibility | CLI integration fixture and source audit | Codex CLI 0.146.0 remains probe-only because `apply_patch` and other model-visible built-ins cannot all be reliably removed; its bounded `--version` subprocess probe does not authenticate, invoke a model or execute tools; missing service keys and unverified runnable-host versions fail closed |
| Employee package | `init`, static `validate`, schema parity and hostile path fixtures | Atomic scaffold verified; malformed Skill/YAML/JSON Schema, direct/nested traversal, symlinks, glob artifacts and policy mismatches rejected |
| Publisher-owned Runner kernel | Protocol, lease, replay, package snapshot and executor fixtures | Trusted-key Ed25519 task/receipt envelope verification, canonical event hash chains, signed monotonic renewals, fencing identity, nonce replay rejection, exact local package digest, read-only one-run snapshot, lease abort and stable signed failure receipts verified |
| Cross-repository Runner path | Manual compiled framework and private-platform acceptance harness; not yet a committed CI job | Platform claim → local package/Agent Host → 4 uploaded events → Runner-signed receipt → independent usage verification → settled Credit completed on 2026-08-04; the platform never received a local path, package bytes or Host credential |
| Real-local mem/doc read path (#42 Phase A) | Manual `scripts/real-local-harness.mjs` run against actual pinned services (mem `3335ebe`, doc `b22ff1d`), plus offline loopback-fake host/matrix tests in CI | 9/9 scenarios passed on 2026-08-06 (two-session granted resume with stable locators, cross-principal/workspace denial, wrong-revision/unauthorized/revoked-or-unlisted document reads, unreachable service, unsupported matrix); evidence class `real-local-e2e`, secret scan empty |
| MCP declaration | TypeScript and public Schema fixtures | stdio and HTTPS declarations accept environment names only; inline HTTP auth fields, insecure HTTP and duplicate servers rejected |
| Compiled package | `npm run build`; root and core `npm pack --dry-run --json` | `@fullstack-ai-infra/digital-employee@0.3.0` candidate built as 214 files/273,559 bytes; core built as 73 files/75,149 bytes, including the public protocol, lease, replay and package-digest exports |
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

Node.js 24.13.0 completed all 343 tests through `npm run check`, and Node 24 is
part of the regular CI matrix. Its experimental full-suite coverage reporter
can end with `Unexpected end of JSON input` while aggregating child-process
coverage, including three consecutive reproductions after every test passed on
the pre-fix `main` snapshot. The authoritative coverage job and release gate
therefore run on the repository-supported Node.js 22 line.
