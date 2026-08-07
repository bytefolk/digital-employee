# Contributor guide for coding agents

## Quick start (Agent-native install)

To install and set up this framework as a dependency (no source checkout):

```bash
npm install @fullstack-ai-infra/digital-employee
npx digital-employee setup --json
```

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
