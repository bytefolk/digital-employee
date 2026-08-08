import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  classifyPublishFailure,
  loadReleaseArtifact,
  parseArguments,
  publishWithFallback,
  readRegistryState,
  runNpmPublish,
  writeGitHubReport
} from "../../scripts/npm-publish-resilient.js";

const packageName = "@fullstack-ai-infra/digital-employee-core";
const version = "0.3.0";
const localIntegrity = "sha512-bG9jYWw=";

const absentPackage = {
  packageExists: false,
  versionExists: false,
  integrity: null,
  shasum: null,
  latestVersion: null,
  latestVersionExists: false
};
const absentVersion = {
  packageExists: true,
  versionExists: false,
  integrity: null,
  shasum: null,
  latestVersion: null,
  latestVersionExists: false
};

function registryVersion(
  integrity = localIntegrity,
  latestVersion = version,
  latestVersionExists = true
) {
  return {
    packageExists: true,
    versionExists: true,
    integrity,
    shasum: "a".repeat(40),
    latestVersion,
    latestVersionExists
  };
}

function artifact() {
  return {
    name: packageName,
    version,
    integrity: localIntegrity,
    shasum: "a".repeat(40),
    filename: "digital-employee-core-0.3.0.tgz",
    tarballPath: "/tmp/digital-employee-core-0.3.0.tgz",
    manifestPath: "/tmp/package.json",
    packJsonPath: "/tmp/core-pack.json",
    packageUrl: `https://www.npmjs.com/package/${packageName}/v/${version}`
  };
}

function publishableArtifact() {
  const archive = Buffer.from("immutable verified publish bytes");
  return {
    ...artifact(),
    archive,
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    shasum: createHash("sha1").update(archive).digest("hex")
  };
}

function publishFailure(code: string, status: number, phrase: string) {
  return {
    exitCode: 1,
    signal: null,
    errorCode: null,
    timedOut: false,
    stdout: "",
    stderr: `npm error code ${code}\nnpm error ${status} ${phrase}\n`
  };
}

function publishSuccess() {
  return {
    exitCode: 0,
    signal: null,
    errorCode: null,
    timedOut: false,
    stdout: JSON.stringify({ id: `${packageName}@${version}` }),
    stderr: ""
  };
}

function sequence<T>(values: T[]) {
  let index = 0;
  return async () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

const immediate = async () => {};

class NonClosingChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  unrefCalled = false;

  kill(signal: string) {
    this.signals.push(signal);
    return true;
  }

  unref() {
    this.unrefCalled = true;
  }
}

test("loads the exact packed tarball and verifies its digests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "npm-publish-resilient-"));
  try {
    const archive = Buffer.from("verified release archive");
    const filename = "digital-employee-core-0.3.0.tgz";
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    const shasum = createHash("sha1").update(archive).digest("hex");
    const manifestPath = path.join(root, "package.json");
    const packJsonPath = path.join(root, "core-pack.json");
    await Promise.all([
      writeFile(manifestPath, JSON.stringify({
        name: packageName,
        version,
        publishConfig: { access: "public" }
      })),
      writeFile(path.join(root, filename), archive),
      writeFile(packJsonPath, JSON.stringify([{
        name: packageName,
        version,
        filename,
        size: archive.length,
        integrity,
        shasum
      }]))
    ]);

    const loaded = await loadReleaseArtifact({
      manifestPath,
      packJsonPath,
      expectedName: packageName,
      releaseTag: `v${version}`
    });
    assert.equal(loaded.integrity, integrity);
    assert.equal(loaded.shasum, shasum);
    assert.equal(loaded.tarballPath, path.join(root, filename));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a tarball whose bytes no longer match pack JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "npm-publish-resilient-"));
  try {
    const filename = "digital-employee-core-0.3.0.tgz";
    const manifestPath = path.join(root, "package.json");
    const packJsonPath = path.join(root, "core-pack.json");
    await Promise.all([
      writeFile(manifestPath, JSON.stringify({
        name: packageName,
        version,
        publishConfig: { access: "public" }
      })),
      writeFile(path.join(root, filename), "tampered"),
      writeFile(packJsonPath, JSON.stringify([{
        name: packageName,
        version,
        filename,
        integrity: "sha512-ZXhwZWN0ZWQ=",
        shasum: "a".repeat(40)
      }]))
    ]);
    await assert.rejects(
      loadReleaseArtifact({
        manifestPath,
        packJsonPath,
        expectedName: packageName,
        releaseTag: `v${version}`
      }),
      /integrity does not match/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a symlinked packed tarball", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "npm-publish-resilient-"));
  try {
    const archive = Buffer.from("verified release archive");
    const filename = "digital-employee-core-0.3.0.tgz";
    const target = path.join(root, "archive-target.tgz");
    const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    const manifestPath = path.join(root, "package.json");
    const packJsonPath = path.join(root, "core-pack.json");
    await Promise.all([
      writeFile(manifestPath, JSON.stringify({
        name: packageName,
        version,
        publishConfig: { access: "public" }
      })),
      writeFile(target, archive),
      writeFile(packJsonPath, JSON.stringify([{
        name: packageName,
        version,
        filename,
        integrity,
        shasum: createHash("sha1").update(archive).digest("hex")
      }]))
    ]);
    await symlink(target, path.join(root, filename));
    await assert.rejects(
      loadReleaseArtifact({
        manifestPath,
        packJsonPath,
        expectedName: packageName,
        releaseTag: `v${version}`
      }),
      /non-empty regular file/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses only the canonical official npm registry for reads", async () => {
  let requestedUrl = "";
  let redirectMode = "";
  const state = await readRegistryState({
    name: packageName,
    version,
    registryUrl: "https://registry.npmjs.org",
    retryDelays: [0],
    fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      redirectMode = String(init?.redirect);
      return new Response(JSON.stringify({
        name: packageName,
        versions: {
          [version]: {
            dist: {
              integrity: localIntegrity,
              shasum: "a".repeat(40)
            }
          }
        },
        "dist-tags": { latest: version }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  assert.equal(
    requestedUrl,
    "https://registry.npmjs.org/@fullstack-ai-infra%2Fdigital-employee-core"
  );
  assert.equal(redirectMode, "manual");
  assert.equal(state.integrity, localIntegrity);

  await assert.rejects(
    readRegistryState({
      name: packageName,
      version,
      registryUrl: "https://registry.example.test/",
      retryDelays: [0]
    }),
    /must be https:\/\/registry\.npmjs\.org\//
  );
});

test("requires repeated official-registry 404s before declaring a package absent", async () => {
  let recoveredCalls = 0;
  const recovered = await readRegistryState({
    name: packageName,
    version,
    retryDelays: [0, 0],
    sleep: immediate,
    fetchImpl: async () => {
      recoveredCalls += 1;
      if (recoveredCalls === 1) return new Response(null, { status: 404 });
      return new Response(JSON.stringify({
        name: packageName,
        versions: {},
        "dist-tags": { latest: "0.2.0" }
      }), { status: 200 });
    }
  });
  assert.equal(recovered.packageExists, true);
  assert.equal(recoveredCalls, 2);

  let absentCalls = 0;
  const absent = await readRegistryState({
    name: packageName,
    version,
    retryDelays: [0, 0, 0],
    sleep: immediate,
    fetchImpl: async () => {
      absentCalls += 1;
      return new Response(null, { status: 404 });
    }
  });
  assert.equal(absent.packageExists, false);
  assert.equal(absentCalls, 3);
});

test("retries malformed package documents and requires the expected identity", async () => {
  let calls = 0;
  const state = await readRegistryState({
    name: packageName,
    version,
    retryDelays: [0, 0],
    sleep: immediate,
    fetchImpl: async () => {
      calls += 1;
      return new Response(calls === 1
        ? "not-json"
        : JSON.stringify({
          name: packageName,
          versions: {},
          "dist-tags": {}
        }), { status: 200 });
    }
  });
  assert.equal(state.packageExists, true);
  assert.equal(calls, 2);
});

test("rejects registry redirects to a different origin", async () => {
  await assert.rejects(
    readRegistryState({
      name: packageName,
      version,
      retryDelays: [0],
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: "https://registry.example.test/package" }
      })
    }),
    /redirected to a different origin/
  );
});

test("publishes through the canonical registry and force-settles a stuck child", async () => {
  const child = new NonClosingChild();
  let publishArguments: string[] = [];
  let publishedBytes = Buffer.alloc(0);
  const fakeSpawn = ((_command: string, args: string[]) => {
    publishArguments = args;
    publishedBytes = readFileSync(args[1]);
    return child;
  }) as unknown as typeof spawn;
  const verifiedArtifact = publishableArtifact();
  const result = await runNpmPublish(verifiedArtifact, {
    distTag: "latest",
    registryUrl: "https://registry.npmjs.org",
    timeoutMs: 5,
    killGraceMs: 5,
    spawnImpl: fakeSpawn
  });

  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.unrefCalled, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.errorCode, "ETIMEDOUT");
  assert.equal(result.signal, "SIGKILL");
  const registryFlag = publishArguments.indexOf("--registry");
  assert.notEqual(registryFlag, -1);
  assert.equal(
    publishArguments[registryFlag + 1],
    "https://registry.npmjs.org/"
  );
  assert.ok(publishArguments.includes("--provenance"));
  assert.notEqual(publishArguments[1], verifiedArtifact.tarballPath);
  assert.deepEqual(publishedBytes, verifiedArtifact.archive);
  await assert.rejects(readFile(publishArguments[1]), /ENOENT/);
});

test("treats an identical existing version as an idempotent success", async () => {
  let publishCalls = 0;
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "latest" },
    {
      readRegistry: async () => registryVersion(),
      runPublish: async () => {
        publishCalls += 1;
        return publishSuccess();
      },
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "already_published");
  assert.equal(result.complete, true);
  assert.equal(result.verified, true);
  assert.equal(publishCalls, 0);
});

test("fails when an immutable version has different registry integrity", async () => {
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "latest" },
    {
      readRegistry: async () => registryVersion("sha512-ZGlmZmVyZW50"),
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "version_conflict");
  assert.equal(result.exitCode, 1);
});

test("fails closed when an existing version has an older latest tag", async () => {
  let publishCalls = 0;
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "latest" },
    {
      readRegistry: async () => registryVersion(
        localIntegrity,
        "0.2.0",
        true
      ),
      runPublish: async () => {
        publishCalls += 1;
        return publishSuccess();
      },
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "dist_tag_verification_failed");
  assert.equal(result.reason, "registry_latest_is_older");
  assert.equal(result.exitCode, 1);
  assert.equal(publishCalls, 0);
});

test("accepts an identical version when latest already points newer", async () => {
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "latest" },
    {
      readRegistry: async () => registryVersion(
        localIntegrity,
        "0.4.0",
        true
      ),
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "already_published");
  assert.equal(result.complete, true);
});

test("hard-fails a wholly missing package under the fail policy", async () => {
  let publishCalls = 0;
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "latest" },
    {
      readRegistry: async () => absentPackage,
      runPublish: async () => {
        publishCalls += 1;
        return publishSuccess();
      },
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "package_missing");
  assert.equal(result.exitCode, 1);
  assert.equal(publishCalls, 0);
});

test("hard-fails bootstrap-soft when its explicit marker is absent", async () => {
  let publishCalls = 0;
  const result = await publishWithFallback(
    artifact(),
    {
      missingPackage: "bootstrap-soft",
      distTag: "latest"
    },
    {
      readRegistry: async () => absentPackage,
      runPublish: async () => {
        publishCalls += 1;
        return publishFailure("E404", 404, "Not Found");
      },
      markerExists: async () => false,
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "package_missing");
  assert.equal(result.reason, "bootstrap_marker_missing");
  assert.equal(result.exitCode, 1);
  assert.equal(publishCalls, 0);
});

test("returns bootstrap-required without publishing when marker-backed package is absent", async () => {
  let publishCalls = 0;
  const result = await publishWithFallback(
    artifact(),
    {
      missingPackage: "bootstrap-soft",
      bootstrapMarkerPath: "/tmp/bootstrap-marker",
      distTag: "latest"
    },
    {
      readRegistry: async () => absentPackage,
      runPublish: async () => {
        publishCalls += 1;
        return publishFailure("E404", 404, "Not Found");
      },
      markerExists: async () => true,
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "bootstrap_required");
  assert.equal(result.exitCode, 0);
  assert.equal(result.complete, false);
  assert.equal(result.bootstrapRequired, true);
  assert.equal(result.publishAttempts, 0);
  assert.equal(publishCalls, 0);
});

test("converges when bootstrap published the exact verified version but marker cleanup remains", async () => {
  let publishCalls = 0;
  const result = await publishWithFallback(
    artifact(),
    {
      missingPackage: "bootstrap-soft",
      bootstrapMarkerPath: "/tmp/bootstrap-marker",
      distTag: "latest"
    },
    {
      readRegistry: async () => registryVersion(),
      runPublish: async () => {
        publishCalls += 1;
        return publishSuccess();
      },
      markerExists: async () => true,
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "bootstrap_verified_marker_cleanup_required");
  assert.equal(result.exitCode, 0);
  assert.equal(result.complete, true);
  assert.equal(result.verified, true);
  assert.equal(result.markerCleanupRequired, true);
  assert.equal(publishCalls, 0);
});

test("fails closed before a future version while a bootstrap marker remains", async () => {
  let publishCalls = 0;
  const result = await publishWithFallback(
    artifact(),
    {
      missingPackage: "bootstrap-soft",
      bootstrapMarkerPath: "/tmp/bootstrap-marker",
      distTag: "latest"
    },
    {
      readRegistry: async () => absentVersion,
      runPublish: async () => {
        publishCalls += 1;
        return publishSuccess();
      },
      markerExists: async () => true,
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "stale_bootstrap_marker");
  assert.equal(result.exitCode, 1);
  assert.equal(publishCalls, 0);
});

test("keeps E404 hard when the package already exists", async () => {
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "bootstrap-soft", distTag: "latest" },
    {
      readRegistry: sequence([absentVersion, absentVersion]),
      runPublish: async () => publishFailure("E404", 404, "Not Found"),
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "publisher_misconfigured");
  assert.equal(result.exitCode, 1);
});

test("accepts a matching readback after an ambiguous publish error", async () => {
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "latest" },
    {
      readRegistry: sequence([absentVersion, registryVersion()]),
      runPublish: async () => ({
        ...publishFailure("ETIMEDOUT", 504, "Gateway Timeout"),
        timedOut: true
      }),
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "published_after_ambiguous_error");
  assert.equal(result.exitCode, 0);
  assert.equal(result.verified, true);
});

test("publishes once and completes after a matching successful readback", async () => {
  let publishCalls = 0;
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "latest" },
    {
      readRegistry: sequence([absentVersion, registryVersion()]),
      runPublish: async () => {
        publishCalls += 1;
        return publishSuccess();
      },
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "published");
  assert.equal(result.complete, true);
  assert.equal(result.verified, true);
  assert.equal(result.publishAttempts, 1);
  assert.equal(publishCalls, 1);
});

test("repair publishes a missing historical version without moving latest", async () => {
  const newerLatest = {
    ...absentVersion,
    latestVersion: "0.4.0",
    latestVersionExists: true
  };
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "repair" },
    {
      readRegistry: sequence([
        newerLatest,
        registryVersion(localIntegrity, "0.4.0", true)
      ]),
      runPublish: async () => publishSuccess(),
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "published");
  assert.equal(result.complete, true);
  assert.equal(result.distTag, "repair");
});

test("waits for latest readback and fails if it remains older after publish", async () => {
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "latest" },
    {
      readRegistry: sequence([
        absentVersion,
        registryVersion(localIntegrity, "0.2.0", true),
        registryVersion(localIntegrity, "0.2.0", true)
      ]),
      runPublish: async () => publishSuccess(),
      sleep: immediate,
      verifyDelays: [0, 0]
    }
  );
  assert.equal(result.outcome, "dist_tag_verification_failed");
  assert.equal(result.reason, "registry_latest_is_older");
  assert.equal(result.publishAttempts, 1);
  assert.equal(result.exitCode, 1);
});

test("does not blindly retry a transient publish after an absent readback", async () => {
  let publishCalls = 0;
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "latest" },
    {
      readRegistry: sequence([absentVersion, absentVersion]),
      runPublish: async () => {
        publishCalls += 1;
        return publishFailure("E503", 503, "Service Unavailable");
      },
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "transient_failure");
  assert.equal(result.publishAttempts, 1);
  assert.equal(publishCalls, 1);
});

test("blocks a historical version from moving the latest dist-tag backwards", async () => {
  let publishCalls = 0;
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "latest" },
    {
      readRegistry: async () => ({
        ...absentVersion,
        latestVersion: "0.4.0",
        latestVersionExists: true
      }),
      runPublish: async () => {
        publishCalls += 1;
        return publishSuccess();
      },
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "backfill_latest_blocked");
  assert.equal(result.exitCode, 1);
  assert.equal(publishCalls, 0);
});

test("blocks a non-stable latest tag before publishing a stable version", async () => {
  let publishCalls = 0;
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "latest" },
    {
      readRegistry: async () => ({
        ...absentVersion,
        latestVersion: "1.0.0-beta.1",
        latestVersionExists: true
      }),
      runPublish: async () => {
        publishCalls += 1;
        return publishSuccess();
      },
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "dist_tag_preflight_failed");
  assert.equal(result.reason, "registry_latest_is_invalid_or_non_stable");
  assert.equal(result.exitCode, 1);
  assert.equal(publishCalls, 0);
});

test("blocks a dangling latest tag before publishing a stable version", async () => {
  let publishCalls = 0;
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "latest" },
    {
      readRegistry: async () => ({
        ...absentVersion,
        latestVersion: "0.2.0",
        latestVersionExists: false
      }),
      runPublish: async () => {
        publishCalls += 1;
        return publishSuccess();
      },
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "dist_tag_preflight_failed");
  assert.equal(result.reason, "registry_latest_is_invalid_or_non_stable");
  assert.equal(result.exitCode, 1);
  assert.equal(publishCalls, 0);
});

test("parses an explicit repair tag and bootstrap marker", () => {
  const parsed = parseArguments([
    "--manifest", "packages/core/package.json",
    "--pack-json", "/tmp/core-pack.json",
    "--expected-name", packageName,
    "--release-tag", "v0.3.0",
    "--dist-tag", "repair",
    "--missing-package", "bootstrap-soft",
    "--bootstrap-marker", "packages/core/.npm-bootstrap-pending"
  ]);
  assert.equal(parsed.distTag, "repair");
  assert.equal(parsed.bootstrapMarkerPath, "packages/core/.npm-bootstrap-pending");
});

test("does not retry an authentication failure", async () => {
  let publishCalls = 0;
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "latest" },
    {
      readRegistry: sequence([absentVersion, absentVersion]),
      runPublish: async () => {
        publishCalls += 1;
        return publishFailure("ENEEDAUTH", 401, "Unauthorized");
      },
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "authentication_failed");
  assert.equal(result.exitCode, 1);
  assert.equal(publishCalls, 1);
});

test("structured npm authentication codes outrank incidental status text", () => {
  const failure = classifyPublishFailure({
    exitCode: 1,
    signal: null,
    errorCode: null,
    timedOut: false,
    stdout: "",
    stderr: "npm error code E401\nnpm error 404 Not Found"
  });
  assert.deepEqual(failure, { kind: "authentication", code: "E401" });
});

test("fails verification when npm exits successfully but the version stays absent", async () => {
  const result = await publishWithFallback(
    artifact(),
    { missingPackage: "fail", distTag: "latest" },
    {
      readRegistry: sequence([absentVersion, absentVersion]),
      runPublish: async () => publishSuccess(),
      sleep: immediate,
      verifyDelays: [0]
    }
  );
  assert.equal(result.outcome, "verification_failed");
  assert.equal(result.exitCode, 1);
});

test("writes machine outputs and a conspicuous bootstrap summary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "npm-publish-resilient-"));
  try {
    const outputPath = path.join(root, "github-output.txt");
    const summaryPath = path.join(root, "github-summary.md");
    const result = {
      outcome: "bootstrap_required",
      complete: false,
      published: false,
      verified: false,
      bootstrapRequired: true,
      markerCleanupRequired: false,
      distTag: "latest",
      packageName,
      packageVersion: version,
      packageUrl: `https://www.npmjs.com/package/${packageName}/v/${version}`,
      tarballPath: `/tmp/${packageName.split("/").at(-1)}-${version}.tgz`,
      publishAttempts: 1,
      reason: "package_bootstrap_or_scope_access_required",
      exitCode: 0
    };
    await writeGitHubReport(result, {
      outputPath,
      summaryPath,
      annotate: false
    });
    const [outputs, summary] = await Promise.all([
      readFile(outputPath, "utf8"),
      readFile(summaryPath, "utf8")
    ]);
    assert.match(outputs, /^outcome=bootstrap_required$/m);
    assert.match(outputs, /^complete=false$/m);
    assert.match(outputs, /^bootstrap_required=true$/m);
    assert.match(outputs, /^marker_cleanup_required=false$/m);
    assert.match(outputs, /^dist_tag=latest$/m);
    assert.match(outputs, /^tarball_path=/m);
    assert.match(summary, /\[!WARNING\]/);
    assert.match(summary, /Trusted Publishing/);
    assert.match(summary, /Verified tarball/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
