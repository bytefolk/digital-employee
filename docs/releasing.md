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
   channel is complete, except the explicitly reported `bootstrap_required`
   state described below.

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
bootstrap, rerun the original failed `npm-core` job for `v0.3.0`.

## Standalone core bootstrap

npm Trusted Publishing cannot create a package's first public version. While
`packages/core/.npm-bootstrap-pending` exists, repeated package-level 404s for
`@fullstack-ai-infra/digital-employee-core` produce the visible, incomplete
`bootstrap_required` outcome without failing unrelated release channels.
Consumers can meanwhile use:

```text
@fullstack-ai-infra/digital-employee/core
```

The hardened workflow retains both verified `.tgz` files and their SHA-256
checksums. The historical `v0.3.0` core asset appears after the backfill command
above completes.

An npm scope owner must perform the one-time authenticated publication from the
verified GitHub Release core archive, then configure this repository and
`release.yml` as the package's Trusted Publisher. Only after the public package
exists and the trust binding is verified should the marker be removed. All
subsequent versions publish from CI without a long-lived npm credential.

If the owner publication succeeds before the marker-removal change is merged,
a rerun accepts only an exact registry-integrity match and reports
`bootstrap_verified_marker_cleanup_required`. It never republishes that version.
If the package exists but the target version is absent, the stale marker still
blocks CI publication until the trust binding is confirmed and the marker is
removed.
