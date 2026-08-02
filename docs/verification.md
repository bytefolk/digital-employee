# Verification ledger

Last updated: 2026-08-02

This file distinguishes shipped code from the environments in which it has
actually been exercised. A passing fixture test is not presented as a live
provider integration.

| Path | Evidence | Result |
| --- | --- | --- |
| Local answer and escalation | Public example files, extractive model, real CLI process | Verified |
| Automated suite | `npm run check` | 99 passed; security check passed |
| Strict TypeScript | `npm run typecheck` | 0 errors across shipped runtime sources |
| Compiled package | `npm run build`; root and core `npm pack --dry-run` | ESM, declarations, source maps, CLI, config/profile schemas, `answer-agent` manifest, and public fixtures only |
| Second profile | Explicitly allowlisted `minimal-reader` fixture through source and compiled runtimes | Answered with one approved citation; no core/CLI switch change |
| Dependency audit | `npm audit --omit=dev --audit-level=high` | 0 known vulnerabilities |
| Container | Built `Dockerfile`, started the image, called `/health` and `/v1/ask` | Verified |
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
