# Contributor guide for coding agents

## Quick start (release-receipt selected npm version)

To install and set up this framework as a dependency (no source checkout):

If the release receipt verifies `0.6.1` on npm, install that exact version:

```bash
npm install @fullstack-ai-infra/digital-employee@0.6.1
```

Otherwise, use the recorded public `0.6.0` fallback:

```bash
npm install @fullstack-ai-infra/digital-employee@0.6.0
```

After either installation path:

```bash
npx digital-employee doctor --json
npx digital-employee init ./my-employee \
  --recipe minimal-answer.v1 \
  --author your-team
npx digital-employee validate ./my-employee --json
npx digital-employee eval ./my-employee --json
```

This checkout declares package version `0.6.1`; its manifest or packed artifacts
do not establish npm, tag, GHCR, or GitHub Release availability. Verify the
release receipt before treating a version as available. The recorded public npm
release `0.6.0` remains the fallback and provides its `init`, `doctor`,
`validate`, `eval`, `run`, `setup`, and package-bound `deploy` commands. For
source evaluation, run `npm ci && npm run build` and invoke the desired command
from that exact checkout.

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
