import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AUDITED_CODEX_VERSION,
  MAX_LOOPBACK_REQUEST_BYTES,
  auditCodex,
  buildRecord,
  toolName
} from "../../scripts/audit-codex-host.js";

const expectedFixture = new URL(
  "../fixtures/agent-hosts/codex-cli-0.148.0-no-go.json",
  import.meta.url
);

function fakeCodexSource(
  version = AUDITED_CODEX_VERSION,
  responsePath = "/responses",
  versionExitCode = 0,
  probeExitCode = 0,
  declaredLength: number | undefined = undefined,
  streamPastLimit = false
): string {
  return `#!${process.execPath}
const http = require("node:http");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli ${version}\\n");
  process.exit(${versionExitCode});
}
const provider = args.find((arg) => arg.startsWith("model_providers.offline_audit="));
const match = /base_url = "([^"]+)"/.exec(provider || "");
if (!match) process.exit(4);
const required = [
  "--strict-config",
  "web_search=\\\"disabled\\\"",
  "tools.experimental_request_user_input.enabled=false",
  "tools.update_plan.enabled=false"
];
if (required.some((value) => !args.includes(value))) process.exit(6);
const target = new URL(match[1] + ${JSON.stringify(responsePath)});
const payload = JSON.stringify({ tools: [
  { type: "custom", name: "apply_patch" }
] });
const headers = { "content-type": "application/json" };
if (!${streamPastLimit}) {
  headers["content-length"] = ${declaredLength ?? "Buffer.byteLength(payload)"};
}
const request = http.request(target, { method: "POST", headers }, (response) => {
  response.resume();
  response.on("end", () => {
    for (const type of ["thread.started", "turn.started", "turn.completed"]) {
      process.stdout.write(JSON.stringify({ type }) + "\\n");
    }
    process.exitCode = ${probeExitCode};
  });
});
request.on("error", () => process.exit(${streamPastLimit ? 0 : 5}));
if (${streamPastLimit}) {
  const chunk = Buffer.alloc(1024 * 1024, "x");
  for (let index = 0; index < 5; index += 1) request.write(chunk);
  request.end();
} else {
  request.end(payload);
}
`;
}

test("tool inventory normalizes custom, function, and hosted tool names", () => {
  assert.equal(toolName({ type: "custom", name: "apply_patch" }), "apply_patch");
  assert.equal(toolName({ type: "function", function: { name: "read" } }), "read");
  assert.equal(toolName({ type: "web_search" }), "web_search");
  assert.equal(toolName(null), "unknown");
});

test("a model-visible apply_patch produces a fail-closed three-axis NO-GO", () => {
  const record = buildRecord({
    version: AUDITED_CODEX_VERSION,
    request: { tools: [{ type: "custom", name: "apply_patch" }] },
    exitCode: 0,
    eventTypes: ["turn.completed", "turn.completed"]
  });
  assert.equal(record.verdict, "NO_GO");
  assert.deepEqual(record.axes, {
    implemented: false,
    fixtureConformant: false,
    liveQualified: false
  });
  assert.equal(record.vectors.filesystemEnforcement, "NOT_VERIFIED");
  assert.deepEqual(record.eventTypes, ["turn.completed"]);
});

test("the executable probe reproduces the checked-in sanitized fixture", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-audit-test-"));
  const binary = path.join(directory, "fake-codex");
  try {
    await writeFile(binary, fakeCodexSource(), { mode: 0o755 });
    await chmod(binary, 0o755);
    const actual = await auditCodex(binary);
    const expected = JSON.parse(await readFile(expectedFixture, "utf8"));
    assert.deepEqual(actual, expected);
    const serialized = JSON.stringify(actual);
    assert.doesNotMatch(serialized, /prompt|authorization|\/Users\/|\/home\//i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the probe refuses a binary outside the audited version", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-audit-version-test-"));
  const binary = path.join(directory, "fake-codex");
  try {
    await writeFile(binary, fakeCodexSource("0.146.0"), { mode: 0o755 });
    await chmod(binary, 0o755);
    await assert.rejects(auditCodex(binary), /expected codex-cli 0\.148\.0/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the probe rejects any loopback route other than POST /v1/responses", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-audit-route-test-"));
  const binary = path.join(directory, "fake-codex");
  try {
    await writeFile(binary, fakeCodexSource(AUDITED_CODEX_VERSION, "/unexpected"), {
      mode: 0o755
    });
    await chmod(binary, 0o755);
    await assert.rejects(auditCodex(binary), /unexpected loopback route/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the probe reports a spawn error without hanging or leaking its server", async () => {
  const missing = path.join(os.tmpdir(), "digital-employee-missing-codex-binary");
  await assert.rejects(auditCodex(missing), /ENOENT|spawn/i);
});

test("the probe rejects a non-zero version command before accepting evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-audit-version-exit-"));
  const binary = path.join(directory, "fake-codex");
  try {
    await writeFile(binary, fakeCodexSource(AUDITED_CODEX_VERSION, "/responses", 7), {
      mode: 0o755
    });
    await chmod(binary, 0o755);
    await assert.rejects(
      auditCodex(binary),
      /Codex version probe failed: exit=7 signal=none/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the probe rejects a non-zero inventory command even after loopback evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-audit-probe-exit-"));
  const binary = path.join(directory, "fake-codex");
  try {
    await writeFile(
      binary,
      fakeCodexSource(AUDITED_CODEX_VERSION, "/responses", 0, 9),
      { mode: 0o755 }
    );
    await chmod(binary, 0o755);
    await assert.rejects(
      auditCodex(binary),
      /Codex tool inventory probe failed: exit=9 signal=none/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the loopback fixture rejects a declared body larger than 4 MiB", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-audit-body-limit-"));
  const binary = path.join(directory, "fake-codex");
  try {
    await writeFile(
      binary,
      fakeCodexSource(
        AUDITED_CODEX_VERSION,
        "/responses",
        0,
        0,
        MAX_LOOPBACK_REQUEST_BYTES + 1
      ),
      { mode: 0o755 }
    );
    await chmod(binary, 0o755);
    await assert.rejects(auditCodex(binary), /loopback request body exceeds 4 MiB/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the loopback fixture stops buffering a chunked body past 4 MiB", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-audit-stream-limit-"));
  const binary = path.join(directory, "fake-codex");
  try {
    await writeFile(
      binary,
      fakeCodexSource(
        AUDITED_CODEX_VERSION,
        "/responses",
        0,
        0,
        undefined,
        true
      ),
      { mode: 0o755 }
    );
    await chmod(binary, 0o755);
    await assert.rejects(auditCodex(binary), /loopback request body exceeds 4 MiB/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
