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
