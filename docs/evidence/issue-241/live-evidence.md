# #241 E4 live evidence (credential-view consistency)

Environment: macOS arm64 (darwin 24.5.0), Node v24.13.0, checkout `feat/i-241-credential-view`
(base `42babcf`), Qoder CLI on PATH (1.1.x conformance family).

Credential handling: the real `QODER_PERSONAL_ACCESS_TOKEN` was supplied only via a
`chmod 600` local file read into the child environment at run time. It is masked
below as `pt-HM…8f0` and never appears in this document, the repo, or diagnostics.

## 1. doctor reads the operator view (token present → ready)

```
$ QODER_PERSONAL_ACCESS_TOKEN=<pt-HM…8f0> digital-employee doctor --engine qoder --json
hosts[qoder].status = "ready"
issues = [ (authentication_not_verified, blocking=false),
           (qoder_handshake_verified_by_conformance_only, blocking=false) ]
```

## 2. run agrees and completes a real turn (token present)

```
$ QODER_PERSONAL_ACCESS_TOKEN=<pt-HM…8f0> digital-employee run ./emp --engine qoder \
    --question "Reply with exactly: E241-LIVE-OK"
E241-LIVE-OK
exit=0
```

A live Qoder turn executed end-to-end; the credential gate passed and the isolated
host delivered the model answer. This is the E4 live-path proof for qoder.

## 3. fail-closed consistency (token absent → both commands agree)

Black-box test (`tests/apps/credential-view.test.ts`):
- `doctor --engine qoder --json` → `hosts[qoder].status = "not_ready"` with
  `qoder_service_token_not_configured`.
- `run --engine qoder` → exit 1, `- blocked: qoder_service_token_not_configured`,
  plus a localized `recovery:` line (en/zh-CN/ja).

doctor and run evaluate the same operator credential view in both directions.

## 4. Idempotent init conformance (live qoder re-announces system/init)

The live Qoder CLI re-announces an identical `system/init`; the adapter now
tolerates a byte-equal re-init and fails closed on any divergence
(`qoder_duplicate_init`). Unit coverage:
- `duplicate-init-identical` → `run.completed`
- `duplicate-init-divergent` → `run.failed qoder_duplicate_init`

## 5. claude-code live turn

Pending operator-supplied `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` (custom,
non-official endpoint). The credential-view fix applies identically to the
claude adapter; a live claude turn will be appended once credentials are provided
via a `chmod 600` file. Not blocking the qoder E4 evidence above.
