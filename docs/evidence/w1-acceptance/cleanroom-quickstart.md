# #288 W1 clean-machine reproduction of the oss-maintainer quickstart

Environment: **clean Linux container** `node:22-bookworm-slim` (pulled image
digest `sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`;
Debian GNU/Linux 12 bookworm), Node v22.23.2, npm 10.9.8, user `root`, empty
`/root` HOME, no cached dependencies, no maintainer credentials, no side
artefacts. Network egress limited to the public npm registry. Run window
2026-09-17 01:31–01:35 (+08:00).

Pinned artifact: **public npm release `@fullstack-ai-infra/digital-employee@0.6.0`**
(`dist.shasum 50790a6e68b5ca022b95a8f9f2a67461c1be0477`). This is the newest
publicly installable release; `0.6.1` exists only in source and is the subject
of the pending release Issue (#237/#247, execution #290). The version gap is
the source of every divergence recorded below.

## 1. Install (clean prefix)

```
$ npm install -g @fullstack-ai-infra/digital-employee@0.6.0
installed version: 0.6.0
$ which digital-employee   # /usr/local/bin/digital-employee
```

Install succeeded with zero friction on the clean image.

## 2. W1 shell path — all green

```
$ digital-employee workspace init /tmp/oss --template oss-maintainer --json
  status: created   positions: [repo-owner, issue-researcher, release-engineer, community-operator]
$ digital-employee org apply /tmp/oss --json
  status: applied   bootstrapped: true   positions: 4
$ digital-employee org tree /tmp/oss --json
  owner: repo-owner   positionCount: 4   depth: 2
```

## 3. validate + eval — four for four

```
repo-owner                       | "status": "valid" | "code": "EVAL_PASSED"
repo-owner/issue-researcher      | "status": "valid" | "code": "EVAL_PASSED"
repo-owner/release-engineer      | "status": "valid" | "code": "EVAL_PASSED"
repo-owner/community-operator    | "status": "valid" | "code": "EVAL_PASSED"
```

## 4. Deterministic turns — four for four, zero credentials

`0.6.0` has no `--question` sugar (added post-tag), so each turn uses a sealed
`turn-envelope.v1alpha2` built with the **installed package's own** envelope
module (digest computed in-container) and fed via `--stdin`:

```
$ DIGITAL_EMPLOYEE_ENGINE_MODEL=deterministic \
  DIGITAL_EMPLOYEE_ENGINE_MODEL_SCRIPT='["<position>: cleanroom acceptance reply"]' \
  digital-employee turn run /tmp/oss --position <id> --stdin < envelope.json
```

| position | runId | terminal |
|---|---|---|
| repo-owner | `4a29f34b-0ef4-40ec-bf07-47497c63a7a5` | `run.completed` / `goal_met` |
| issue-researcher | `48c72d14-23cb-4337-9c70-a0a241d46d29` | `run.completed` / `goal_met` |
| release-engineer | `9cc826aa-974e-4c4e-bafe-3d5c4d781c59` | `run.completed` / `goal_met` |
| community-operator | `2951de1b-ad1a-4557-b52d-f381a7e4c017` | `run.completed` / `goal_met` |

The NDJSON event shape (`run.started` → `model.delta` → exactly one trusted
`run.completed`) matches the maintainer-side AC-001 harness run byte-for-byte
at the event-schema level.

## 5. Divergences found (public 0.6.0 vs the W1 acceptance surface)

These are the honest friction items the clean-room exists to surface:

1. **No per-turn evidence on disk in public 0.6.0.** All four turns completed,
   but `.digital-employee/evidence/` is never created. The CLI file evidence
   sink (`createFileEvidenceSink` wiring in `turn-run`) landed with the v0.6.1
   release line (merge #277, 2026-09-13) and is **not in the 0.6.0 tag**
   (verified by ancestry check against `17ff634`). Consequence: the W1 door
   claim "every turn carries a #140 evidence record" **cannot be reproduced
   from any publicly installable release today** — it requires the #290
   release of 0.6.1 under `@bytefolk`. This clean-room run is the direct
   external evidence that #290 is W1-critical, not cosmetic.
2. **No `--question` sugar in 0.6.0.** The usability path
   (`turn run --question "…"`, PR #230) is post-tag; a quickstart written
   against current `main` fails on public 0.6.0 with
   `turn_run_accepts_one_input_source`. Quickstart docs must pin the
   `--stdin` envelope form until 0.6.1 ships (or ship 0.6.1 first).
3. **Cosmetic CLI bug: unhandled EPIPE on `workspace init --json` when the
   stdout pipe closes early** (observed with `--json | head`-style consumers;
   `workspaceInit` writes to stdout without an EPIPE guard,
   `dist/apps/cli/workspace/index.js:377` in the 0.6.0 tarball). Non-blocking
   for the acceptance path; worth a small fix so JSON output composes with
   standard pipeline tools.

## 6. Verdict

- **Reproducible**: an outside user on a clean machine can install the public
  release and run the full W1 shell loop (init → org → validate/eval →
  four deterministic engine turns) with zero credentials and zero friction
  beyond the `--stdin` envelope form.
- **Not yet complete**: the evidence-recording leg of the W1 door (AC-004b /
  #140) is absent from every public release; re-run this clean-room against
  `@bytefolk/digital-employee@0.6.1` once #290 lands, and archive the digest
  comparison against the maintainer-side AC-001 manifest at that time
  (cross-version digest equality is not claimed here).

Reproduction: `docker run --rm -i node:22-bookworm-slim bash -s < <run script>`;
the full console transcript of the passing run is summarized above and was
captured verbatim during the acceptance window (no credentials, no private
paths — the container filesystem was discarded with `--rm`).

Cross-references: #163 (quickstart form), #141 (clean-machine notes — this
document is the W1-cycle installment), #290 (release execution that closes
gap 1), #281–#285 (maintainer-side AC evidence this run externally
corroborates at the event-schema level).
