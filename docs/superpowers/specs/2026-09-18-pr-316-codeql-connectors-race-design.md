# PR #316 CodeQL connectors race fix

Date: 2026-09-18

## Problem

CodeQL reports a high-severity potential file-system race at
`apps/cli/org/model.ts:265`. The current connector declaration reader checks
`connectors.json` with `lstat`, then opens the path again with `readFile`. A
concurrent replacement can therefore make the validated object differ from
the bytes parsed by the process.

## Design

- Open `connectors.json` once with `O_RDONLY | O_NOFOLLOW` and read through the
  resulting file handle.
- Before and after reading, compare the handle's regular-file identity and
  metadata (device, inode, size, mtime, ctime) with the published path.
- Reject symlinks, non-regular files, replacements, truncation, and metadata
  changes with the existing `position_connectors_invalid:<id>` fail-closed
  error. Parse and validate only the bytes read from the verified handle.
- Add a deterministic regression test that replaces the path during the read
  barrier and proves the declaration is rejected without trusting replacement
  bytes.

## Scope

Only the connector declaration read path and its regression coverage change.
Organization model semantics, connector schema validation, and optional-file
backward compatibility remain unchanged. No release, tag, or unrelated
refactor is included.

## Verification

Run the focused organization/connector tests, TypeScript type checks, and the
repository's security/static checks. Re-read PR #316's CodeQL check after the
branch is pushed.
