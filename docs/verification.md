# Verification ledger

Last updated: 2026-08-04

This file distinguishes shipped code from the environments in which it has
actually been exercised. A passing fixture test is not presented as a live
provider integration.

| Path | Evidence | Result |
| --- | --- | --- |
| Local answer and escalation | Public example files, extractive model, real CLI process | Verified |
| Automated suite | `npm run check` | 182/182 tests passed; security check passed |
| Strict TypeScript | `npm run typecheck` | 0 errors across shipped runtime sources |
| Agent-host install probes | Real local `doctor --json` plus bounded fixture processes | Qoder CLI 1.1.12 and Codex CLI 0.146.0 found locally; Claude Code version probe failed; live authentication/model access not tested |
| Qoder run adapter | Adapter-specific deterministic child-process fixtures; not a reusable third-party certification harness | Qoder 1.1.x SDK process-mode initialize/user/EOF transport, private auth payload, argument isolation, minimum read-only projection, filtered environment, package-aware preflight, protocol/plugin/Skill/runtime-policy attestation, atomic event publication, run-ID reservation, pre-launch cancellation, pre-terminal credential cleanup, file inode/change-time checks, iterator cleanup, malformed/oversized output, non-zero exit, timeout and terminal invariants verified; no live model request made |
| Probe-only compatibility | CLI integration fixture | Claude Code, Codex, Qwen Code and CodeBuddy Code remain probe-only; their bounded `--version` subprocess probes do not attempt authentication, invoke a model or execute tools; missing Qoder service token and unverified versions fail closed |
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
