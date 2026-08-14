# Contributor guide for coding agents

## Quick start (public npm 0.3.0)

To install and set up this framework as a dependency (no source checkout):

```bash
npm install @fullstack-ai-infra/digital-employee@0.3.0
npx digital-employee doctor --json
npx digital-employee init ./my-employee \
  --recipe minimal-answer.v1 \
  --author your-team
npx digital-employee validate ./my-employee --json
npx digital-employee eval ./my-employee --json
```

The current public npm version is `0.3.0`; the public quick path uses its
`init`, `doctor`, `validate`, `eval`, and `run` commands. It does not contain
the newer `setup` or package-bound `deploy` commands. Treat both as
source-only, unreleased previews until a later public release explicitly
includes them. For source evaluation, run `npm ci && npm run build` and invoke
the desired preview command from that exact checkout.

See [INSTALL.md](./INSTALL.md) for the full Agent-readable install path.

## Development guidelines

- Keep the runtime channel-, model-, and source-neutral.
- `profiles/answer-agent` is the first shipped role, not the core product.
- DWS is an optional connector. The console demo must work without DingTalk,
  DWS, or model credentials.
- Never commit credentials, personal identifiers, chat exports, internal URLs,
  private screenshots, or generated knowledge indexes.
- Read operations must use explicit allowlists. Write-capable tools require a
  separate approval policy and are out of scope for the first release.
- Add observable behavior tests for every change. Run `npm run check` before a
  pull request.
