# Committed employee teams

A **team** is a committed, versioned organization of digital employees: one
directory holding a workspace declaration, an organization declaration, and one
portable package per position. Unlike a workspace that one operator builds in a
local checkout, a team lives in `main`, so it survives a reinstall and can be
reviewed like any other asset.

## Why this is not another existing directory

| Directory | Holds | Why a team does not fit there |
|---|---|---|
| `profiles/` | A single published profile, expressed with the legacy `employee-profile.v1` model. | One profile is one employee. A team is several employees plus their reporting lines. |
| `recipes/` | One installable single-employee template for `digital-employee init --recipe`, pinned to upstream evidence (component matrix, scenarios). | A recipe installs one employee. A team is opened as a workspace, not installed. |
| `examples/` | Bounded examples that the governance fixtures enumerate and validate. | Adding a team there would put it under the governance fixture contract, which is about requirement-record examples, not employee assets. |
| `workspaces/` | Operator-local runtime state, generated and git-ignored. | Nothing there reaches `main`. |

A team therefore gets its own top-level directory rather than being squeezed
into a directory whose contract means something else.

## Layout

```
teams/<team-id>/
  workspace.json                 # workspace.v1alpha1
  organization.v1alpha1.json     # workspace-org.v1: positions and reporting lines
  grant.template.json            # capability-grant.v1 template, outside the packages
  context/                       # shared context for the team
  positions/<owner>/             # the owner position is a package itself
    employee.json  SKILL.md  permissions.json  budget.json
    schemas/  knowledge/  evals/
    positions/<report>/          # nested directory mirrors the reporting line
  README.md                      # what the team does and what it is not allowed to do
```

## Rules for anything added here

- **Use the existing contracts.** `workspace.v1alpha1` and `workspace-org.v1`,
  not a new manifest format. A new top-level directory is not a licence to
  invent one.
- **Grant templates live outside the package directories.** `capability-grant.v1`
  rejects a package that grants to itself.
- **No credentials, no tokens, no personal identifiers.** A team declares what
  it needs; the operator grants it. `scripts/security-check.js` scans every
  file in this repository.
- **No hard-coded target.** A team is pointed at a repository or workspace at
  run time. Norms are fetched, never embedded, so a copy cannot go stale.
- **State the boundary honestly.** An employee package's `policy.network`,
  `policy.filesystem` and `policy.mode` are recorded but not enforced at spawn
  time today. What is enforced is the `permissions.json` tool allowlist and,
  above all, the credential the operator grants.

## Teams

- [`github-ops/`](./github-ops/) — triage issues, author, review and merge pull
  requests, with authoring, reviewing and merging held by separate positions.
