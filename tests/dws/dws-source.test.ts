import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DwsConnectorError,
  DwsKnowledgeSource
} from "../../connectors/sources/dws/index.js";

const FIXTURE = new URL("./fixtures/fake-dws.mjs", import.meta.url).pathname;
const PROFILE = "corp-id:user-id";

function query(name, command, args) {
  return { name, command, args };
}

function source(options = {}) {
  return new DwsKnowledgeSource({
    profile: PROFILE,
    executable: FIXTURE,
    approvedQueries: [
      query("handbook", ["doc", "read"], ["--node", "doc-42"])
    ],
    env: { ...process.env, FAKE_DWS_MODE: "ok" },
    ...options
  });
}

test("loads multiple explicitly approved DWS knowledge queries with provenance", async () => {
  const dws = source({
    approvedQueries: [
      query("handbook", ["doc", "read"], ["--node", "doc-42"]),
      query(
        "release-minutes",
        "minutes get transcription",
        ["--id", "minutes-7"]
      ),
      query(
        "support-chat",
        ["chat", "message", "list"],
        [
          "--group",
          "group-1",
          "--time",
          "2026-07-01 00:00:00",
          "--direction",
          "newer",
          "--limit",
          "50"
        ]
      ),
      query(
        "on-call-wiki",
        ["wiki", "node", "search"],
        ["--workspace", "workspace-1", "--query", "on-call"]
      ),
      query(
        "architecture-drive",
        ["drive", "search"],
        ["--query", "architecture", "--target", "file"]
      )
    ]
  });

  const documents = await dws.load();

  assert.equal(documents.length, 5);
  assert.deepEqual(
    new Set(documents.map((document) => document.metadata.service)),
    new Set(["doc", "minutes", "chat", "wiki", "drive"])
  );
  assert.ok(
    documents.every(
      (document) =>
        document.id &&
        document.title &&
        document.text &&
        document.source.type === "dws" &&
        document.source.id
    )
  );
  const doc = documents.find((document) => document.source.id === "doc-42");
  assert.equal(doc.source.uri, "https://example.test/docs/doc-42");
  assert.equal(doc.source.updatedAt, "2026-07-30T08:30:00.000Z");
  assert.match(doc.text, /staged rollout/);
});

test("always passes the explicit profile and machine-readable JSON format", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dws-capture-"));
  const capture = path.join(directory, "argv.json");
  const dws = source({
    env: {
      ...process.env,
      FAKE_DWS_MODE: "ok",
      FAKE_DWS_CAPTURE: capture
    }
  });

  await dws.load();
  const args = JSON.parse(await readFile(capture, "utf8"));
  assert.deepEqual(args, [
    "doc",
    "read",
    "--node",
    "doc-42",
    "--profile",
    PROFILE,
    "--format",
    "json"
  ]);
});

test("uses spawn without a shell and keeps argument metacharacters literal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dws-no-shell-"));
  const capture = path.join(directory, "argv.json");
  const unexpected = path.join(directory, "unexpected");
  const literal = `doc-42; touch ${unexpected}`;
  const dws = source({
    approvedQueries: [
      query("literal-node", ["doc", "read"], ["--node", literal])
    ],
    env: {
      ...process.env,
      FAKE_DWS_MODE: "ok",
      FAKE_DWS_CAPTURE: capture
    }
  });

  await dws.load();
  const args = JSON.parse(await readFile(capture, "utf8"));
  assert.equal(args[3], literal);
  await assert.rejects(readFile(unexpected), { code: "ENOENT" });
});

test("requires an explicit profile and approved query list", () => {
  assert.throws(
    () =>
      new DwsKnowledgeSource({
        approvedQueries: [
          query("handbook", ["doc", "read"], ["--node", "doc-42"])
        ]
      }),
    (error) =>
      error instanceof DwsConnectorError &&
      error.code === "dws_explicit_profile_required"
  );
  assert.throws(
    () => new DwsKnowledgeSource({ profile: PROFILE, approvedQueries: [] }),
    (error) =>
      error instanceof DwsConnectorError &&
      error.code === "dws_requires_approved_queries"
  );
});

test("rejects non-allowlisted commands and unsafe argument overrides", () => {
  assert.throws(
    () =>
      source({
        approvedQueries: [
          query("write", ["doc", "update"], ["--node", "doc-42"])
        ]
      }),
    (error) => error.code === "dws_query_command_not_allowlisted"
  );
  assert.throws(
    () =>
      source({
        approvedQueries: [
          query(
            "override-profile",
            ["doc", "read"],
            ["--node", "doc-42", "--profile", "another:user"]
          )
        ]
      }),
    (error) => error.code === "dws_query_reserved_global_flag"
  );
  assert.throws(
    () =>
      source({
        approvedQueries: [
          query(
            "override-format",
            ["doc", "read"],
            ["--node", "doc-42", "--format", "table"]
          )
        ]
      }),
    (error) => error.code === "dws_query_reserved_global_flag"
  );
  assert.throws(
    () =>
      source({
        approvedQueries: [
          query("shortcut", ["doc", "+search"], ["--query", "handbook"])
        ]
      }),
    (error) => error.code === "dws_query_invalid_command_path"
  );
});

test("requires an explicit scope instead of falling back to account-wide scans", () => {
  assert.throws(
    () =>
      source({
        approvedQueries: [
          query("recent-docs", ["doc", "search"], [])
        ]
      }),
    (error) => error.code === "dws_query_missing_required_flag"
  );
  assert.throws(
    () =>
      source({
        approvedQueries: [
          query(
            "all-chats",
            ["chat", "message", "search"],
            [
              "--query",
              "release",
              "--start",
              "2026-07-01T00:00:00+08:00",
              "--end",
              "2026-08-01T00:00:00+08:00"
            ]
          )
        ]
      }),
    (error) => error.code === "dws_query_missing_required_flag"
  );
  assert.throws(
    () =>
      source({
        approvedQueries: [
          query("my-drive-root", ["drive", "list"], [])
        ]
      }),
    (error) => error.code === "dws_query_missing_required_scope"
  );
});

test("terminates timed-out DWS processes", async () => {
  const dws = source({
    timeoutMs: 25,
    env: { ...process.env, FAKE_DWS_MODE: "sleep" }
  });
  await assert.rejects(
    dws.load(),
    (error) =>
      error instanceof DwsConnectorError &&
      error.code === "dws_process_timed_out"
  );
});

test("rejects failed, non-JSON, and oversized DWS output", async (t) => {
  await t.test("non-zero exit", async () => {
    await assert.rejects(
      source({
        env: { ...process.env, FAKE_DWS_MODE: "fail" }
      }).load(),
      (error) =>
        error instanceof DwsConnectorError &&
        error.code === "dws_command_failed" &&
        error.details.exitCode === 7
    );
  });
  await t.test("non-JSON stdout", async () => {
    await assert.rejects(
      source({
        env: { ...process.env, FAKE_DWS_MODE: "non-json" }
      }).load(),
      (error) => error.code === "dws_command_returned_non_json"
    );
  });
  await t.test("output cap", async () => {
    await assert.rejects(
      source({
        maxOutputBytes: 1_024,
        env: { ...process.env, FAKE_DWS_MODE: "oversize" }
      }).load(),
      (error) => error.code === "dws_process_output_too_large"
    );
  });
});

test("does not copy profile, arguments, stdout, or stderr into errors and logs", async () => {
  const secret = "TOP-SECRET-VALUE";
  const logs = [];
  const dws = source({
    profile: `corp:${secret}`,
    approvedQueries: [
      query("safe-label", ["doc", "read"], ["--node", secret])
    ],
    env: {
      ...process.env,
      FAKE_DWS_MODE: "fail",
      FAKE_DWS_SECRET: secret
    },
    logger(event) {
      logs.push(event);
    }
  });

  let failure;
  try {
    await dws.load();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof DwsConnectorError);
  assert.doesNotMatch(JSON.stringify(failure), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(secret));
  assert.deepEqual(
    logs.map((event) => event.event),
    ["dws.query.started", "dws.query.failed"]
  );
});
