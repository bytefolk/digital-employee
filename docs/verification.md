# Verification ledger

Last updated: 2026-08-03

This file distinguishes shipped code from the environments in which it has
actually been exercised. A passing fixture test is not presented as a live
provider integration.

| Path | Evidence | Result |
| --- | --- | --- |
| Local answer and escalation | Public example files, extractive model, real CLI process | Verified |
| Automated suite | `npm run check` | 300/300 tests plus the repository security scan passed on 2026-08-03; provider fixtures do not make live model requests |
| Strict TypeScript | `npm run typecheck` | 0 errors across shipped runtime sources |
| Agent-host install probes | Real local version/init probes plus bounded fixture processes | Qoder CLI 1.1.12, Codex CLI 0.146.0, Qwen Code 0.17.1 and CodeBuddy Code 2.106.4 found locally; Claude Code 2.1.209 is below the verified range and its probe failed; live authentication/model access not tested |
| Qoder run adapter | Real child-process conformance fixtures only | Qoder CLI 1.1.x SDK process-mode initialize/user/EOF transport, private auth payload, argument isolation, minimum read-only projection, filtered environment, exact read/search tool plus empty MCP/plugin/Skill attestation, package-aware preflight, atomic event publication, cancellation, file-identity checks, cleanup and terminal invariants verified; no live model request made |
| Claude Code run adapter | Version-locked child-process conformance fixtures only | Claude Code `>=2.1.214 <2.2.0`, explicit `ANTHROPIC_API_KEY`, `--bare --tools ""`, strict empty MCP, disabled commands/session persistence, sealed UTF-8 stdin assets, empty isolated workspace, home, configuration and temp directories, runtime empty tool/MCP/plugin/Skill attestation, strict unknown-event rejection, process-group descendant cleanup, cancellation and terminal invariants verified on POSIX; no live model request made |
| Qwen Code run adapter | Exact-version child-process fixtures plus real local init against an unreachable loopback endpoint | Qwen Code `0.17.1`, explicit `OPENAI_API_KEY` and `OPENAI_MODEL`, sealed UTF-8 stdin assets, disposable empty workspace, home, configuration and temp directories, empty tool/MCP/slash-command surface and exact non-callable built-in Agent catalog, secret-safe structured output, cancellation, process-group cleanup and terminal invariants verified on POSIX; no model request reached a provider |
| CodeBuddy Code run adapter | Exact-version child-process fixtures plus real local init against an unreachable loopback endpoint | CodeBuddy Code `2.106.4`, explicit `CODEBUDDY_API_KEY` and `CODEBUDDY_MODEL`, sealed UTF-8 stdin assets, disposable empty workspace/config/session/temp state, exhaustive built-in deny list and final empty tool/MCP attestation, strict status/snapshot/unknown-event checks, secret-safe structured output, cancellation, process-group cleanup and terminal invariants verified on POSIX; no model request reached a provider |
| Probe-only compatibility | CLI integration fixture and source audit | Codex CLI 0.146.0 remains probe-only because `apply_patch` and other model-visible built-ins cannot all be reliably removed; missing service keys and unverified runnable-host versions fail closed |
| Employee package | `init`, static `validate`, schema parity and hostile path fixtures | Atomic scaffold verified; malformed Skill/YAML/JSON Schema, direct/nested traversal, symlinks, glob artifacts and policy mismatches rejected |
| MCP declaration | TypeScript and public Schema fixtures | stdio and HTTPS declarations accept environment names only; inline HTTP auth fields, insecure HTTP and duplicate servers rejected |
| Compiled package | `npm run build`; root and core `npm pack --dry-run` | ESM, declarations, source maps, Agent/package/MCP contracts and schemas, CLI, compatibility runtime, `answer-agent` manifest, and public fixtures only |
| Second profile | Explicitly allowlisted `minimal-reader` fixture through source and compiled runtimes | Answered with one approved citation; no core/CLI switch change |
| Dependency audit | `npm audit --omit=dev --audit-level=high` | 0 known vulnerabilities |
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
npm audit --omit=dev --audit-level=high
```
