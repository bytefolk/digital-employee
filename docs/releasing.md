# Release operations

Stable tags (`vMAJOR.MINOR.PATCH`) are the only release entry point. The
release workflow verifies that the tag still resolves to the event commit and
that the commit is reachable from `origin/main`. It then builds the root and
standalone core npm archives once. npm and GitHub Releases consume those exact
verified archives; they do not rebuild them.

## Normal release

1. Merge a commit whose root/core package versions and changelog agree.
2. Create the matching stable tag on that commit.
3. Let `.github/workflows/release.yml` reconcile npm, GitHub Releases, and
   GHCR. Release runs share the maximum GitHub Actions concurrency queue (up
   to 100 pending runs) instead of replacing the previous pending release.
4. Read the `release-status` job summary. A green run means every requested
   channel is complete.

Registry authentication uses npm Trusted Publishing (GitHub OIDC). Do not add
an `NPM_TOKEN` or `NODE_AUTH_TOKEN` repository secret.

Trusted Publishing authenticates `npm publish`, but it does not authenticate
`npm dist-tag`. If an exact version already exists while `latest` is missing,
invalid, or points to an older version, the workflow fails closed instead of
guessing or introducing a long-lived token. An npm owner must first verify the
target version and then repair the tag interactively with `npm dist-tag add`;
the CI repair can be rerun afterward. A newer valid `latest` is always retained.

Repository administrators must protect `refs/tags/v*` from update and deletion
with a tag ruleset. Every registry-writing job revalidates the remote tag
immediately before its write, but only server-side tag protection closes the
remaining check/write race.

## Repair one channel

Run repairs from the release tag itself so the workflow identity, checked-out
source, and provenance all refer to the same commit:

```bash
gh workflow run release.yml \
  --ref vX.Y.Z \
  -f target=npm-core
```

Valid targets are `all`, `npm-root`, `npm-core`, `github-release`, and `ghcr`.
Repair runs use a non-`latest` npm dist-tag and do not update GHCR `latest`.
Existing GitHub Release assets and immutable GHCR version tags are reused only
when their bytes or release identity match; conflicts fail closed.

GHCR reconciliation currently treats repository package-write access as a
trusted boundary. It compares the two version aliases by image digest and
checks revision/source/version OCI labels, but those labels are not a
cryptographic build attestation. Do not describe `v0.3.0` as attested: its
historical image has no GitHub or OCI attestation, and provenance cannot be
truthfully added after the build. A future version should use a two-phase flow
(push by digest, attest and verify, then promote version and `latest` tags).

The dispatch definition must already exist at the selected tag. In particular,
the historical `v0.3.0` tag predates this repair entry point. Its missing
GitHub Release assets can be reconstructed by the current default-branch CI:

```bash
gh workflow run release.yml \
  --ref main \
  -f target=github-release \
  -f release_tag=v0.3.0
```

This exceptional path only operates on an existing stable tag and existing
GitHub Release. It verifies that the tag is reachable from `main`, rebuilds at
the tag commit, refuses changed existing assets, and uploads only missing
assets. npm and GHCR jobs are not selected. After resolving the external npm
bootstrap, the original failed `npm-core` job for `v0.3.0` was rerun and
completed successfully.

## Completed standalone core bootstrap

npm Trusted Publishing cannot create a package's first public version. The
one-time bootstrap for
`@fullstack-ai-infra/digital-employee-core@0.3.0` is complete, and this
repository's `release.yml` is registered as the package's Trusted Publisher.
`packages/core/.npm-bootstrap-pending` has therefore been removed. All
subsequent versions publish from CI without a long-lived npm credential.

The removed marker was a temporary bootstrap state. While it existed,
package-level 404s produced the visible, incomplete `bootstrap_required`
outcome without failing unrelated release channels. It must not be recreated
for routine release failures. A missing package now fails hard; an absent
target version follows the normal CI publish path, while authentication or
publication errors fail hard.

Consumers can install the standalone package or import the root-package
subpath:

```text
@fullstack-ai-infra/digital-employee-core
@fullstack-ai-infra/digital-employee/core
```

The hardened workflow retains both verified `.tgz` files and their SHA-256
checksums. The historical `v0.3.0` GitHub Release contains the root and core
archives plus both checksums.
