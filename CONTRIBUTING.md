# Contributing

Thank you for helping make digital employees safer and easier to reuse.

## Development

Requirements: Node.js 20 or newer and npm 10 or newer.

```bash
npm ci
npm run typecheck
npm run build
npm run check
```

Write shipped application, package, connector, profile, and test code in
strict TypeScript. `npm run typecheck` checks both runtime and test projects.
Keep ESM import specifiers ending in `.js`; TypeScript's
NodeNext resolution maps those specifiers to source `.ts` files and preserves
valid imports in compiled output. Do not hand-edit or commit generated
`dist/` files. JavaScript in `scripts/` is limited to build/release automation
and must never become a runtime dependency.

Create a focused branch, add tests for user-visible behavior, and open a pull
request against `main`. Keep generated data and credentials out of commits.

## Product direction and issue routing

Read the [product strategy](docs/strategy.md) for the stable scope boundary and
the [roadmap](docs/roadmap.md) for milestone sequence, current issue ownership
and acceptance gates before proposing cross-cutting work.

Choose the narrowest issue type:

- use the roadmap-item form for a milestone outcome, architectural contract,
  cross-package change or work that changes a roadmap dependency or gate;
- use the bug form for a reproducible regression against current behavior;
- use the connector form for an isolated channel, knowledge source, model or
  tool connector whose permissions and data boundary can be reviewed alone.

Do not request “support all Agents” or claim Agent support from a product name
alone. A ready proposal identifies the user outcome, exact interface and
version range, enforceable capability/policy boundary, normalized behavior and
observable evidence. Marketplace accounts, pricing, Quote/Credit, billing,
settlement and server-side device/task/usage services belong in the separate
private platform, not this repository.

## Connector rules

Every connector must:

1. operate only on explicitly configured sources or tools;
2. keep credentials in environment variables or the provider's credential
   store;
3. redact message bodies, user identifiers, and URLs from default logs;
4. enforce time, size, and concurrency limits;
5. document read/write effects and required permissions;
6. include tests for rejected inputs and provider failures.

Write-capable connectors must expose a preview and explicit approval step. The
first release accepts read-only connectors only.
