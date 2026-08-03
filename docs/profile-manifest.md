# Employee profile manifest v1

> Compatibility note: `employee-profile.v1` belongs to the
> `standalone-v1` model/retriever runtime. New Agent-native employee source
> packages use [`employee-package.v1alpha1`](employee-package.md).

`employee-profile.v1` is the portable contract for a role that can be installed
into a compatible Digital Employee runtime. It describes role policy and
requested capabilities; it does not grant access to a deployment.

The normative JSON Schema is
[`configs/profile.schema.json`](../configs/profile.schema.json). The shipped
[`answer-agent` manifest](../profiles/answer-agent/profile.json) and the
test-only [`minimal-reader` manifest](../tests/fixtures/runtime/minimal-reader.profile.json)
are the two normative examples.

## Portable manifest versus deployment overlay

| Portable manifest | Local deployment configuration |
| --- | --- |
| Stable profile name and semantic version | Employee instance ID and display name |
| Runtime API compatibility range | Installed registry entries |
| Instructions and escalation defaults | Approved source instances and paths |
| Supported channel, model, source, memory, and tool kinds | Model endpoint and environment-variable bindings |
| Requested read/write permissions | Permissions actually granted by the operator |
| Dependencies, entry points, assets, provenance, and optional integrity metadata | Credentials, private identifiers, and organization-specific targets |

Secret values, local filesystem paths, tenant/user identifiers, and source
instance IDs must never appear in a portable manifest. `configuration` may
declare symbolic `secretReferences`; a deployment binds those references to a
secret manager or environment variable without copying the value into either
file.

`permissions` are requests, not grants. The current runtime accepts only
profiles that are read-only, request no write tools, and read source types
explicitly declared in both `capabilities.sources` and
`permissions.read.sourceTypes`.

## Identity and compatibility

- `schemaVersion` is exactly `employee-profile.v1`.
- `name` is the stable registry identifier; `version` follows SemVer.
- `compatibility.runtimeApi` uses the deliberately small v1 range form
  `>=x.y.z <a.b.c`. The current runtime API is `1.0.0`.
- `provenance` identifies the public source repository and may pin a revision.
- `entrypoints.profile` and `integrity` describe a distributable bundle. A
  manifest entry point does not authorize execution by itself.

Unsupported schema versions, incompatible runtime API ranges, unknown manifest
fields, duplicate identifiers, missing declared capabilities, and an exact
deployment version mismatch are fatal. Optional dependencies that are not
selected by the deployment are allowed. V1 has no compatibility warning that
silently changes behavior.

`integrity` is defined now so future bundles have a stable place for per-file
SHA-256 digests. Source-tree built-ins are registered explicitly and do not yet
use bundle integrity verification; signing and remote distribution are separate
work.

## Registry and local modules

Profiles, sources, models, channels, and tools share one explicit registry.
Every registration has a stable identifier, a factory, and an interface check.
Duplicate identifiers and incompatible instances fail closed.

The CLI registers only shipped built-ins. It never scans a directory or imports
the entry point named by a manifest. A host may request local extension modules
in its deployment overlay:

```json
{
  "extensions": {
    "modules": ["./approved-profile.mjs"]
  }
}
```

Loading remains disabled unless the embedding caller grants the exact resolved
file through an absolute allowlist:

```js
await createRuntime(configPath, {
  moduleAllowlist: [path.resolve(configDirectory, "approved-profile.mjs")]
})
```

Remote URL specifiers, parent-path traversal, symlinked files/directories,
non-files, and paths absent from the caller allowlist are rejected before
import. An extension must export `register(registry)`. Package discovery,
implicit loading, remote downloads, marketplace installation, and write-tool
activation are not part of this contract.

## Migrating a 0.1 deployment

The 0.1 string form remains supported during the 0.x line:

```json
{ "employee": { "id": "team-answer", "profile": "answer-agent" } }
```

New deployments should pin the installed manifest version:

```json
{
  "employee": {
    "id": "team-answer",
    "profile": { "name": "answer-agent", "version": "0.1.0" }
  }
}
```

The object form fails if the registered manifest version differs. The legacy
form resolves the locally registered version and exists only for backward
compatibility; portable employee bundles should use the pinned form.
