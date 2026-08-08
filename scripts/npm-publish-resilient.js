#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_SEMVER = /^\d+\.\d+\.\d+$/;
const ALLOWED_MISSING_POLICIES = new Set(["fail", "bootstrap-soft"]);
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
  "E408",
  "E425",
  "E429",
  "E500",
  "E502",
  "E503",
  "E504",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "FETCH_ERROR",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);
const AUTH_CODES = new Set(["E401", "E403", "ENEEDAUTH", "EOTP"]);
const CONFLICT_CODES = new Set(["E409", "EPUBLISHCONFLICT"]);
const DEFAULT_VERIFY_DELAYS_MS = [0, 1_000, 3_000, 8_000, 18_000];
const DEFAULT_REGISTRY_RETRY_DELAYS_MS = [0, 500, 1_500, 4_000];
const MAX_CAPTURED_OUTPUT = 1024 * 1024;
const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";

const USAGE = `usage: npm-publish-resilient.js \\
  --manifest <package.json> \\
  --pack-json <npm-pack-output.json> \\
  --expected-name <package-name> \\
  --release-tag <vX.Y.Z> \\
  --dist-tag <npm-dist-tag> \\
  --missing-package <fail|bootstrap-soft> \\
  [--bootstrap-marker <path>]\n`;

export class ReleaseInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseInputError";
  }
}

export class RegistryReadError extends Error {
  constructor(message, { status, transient = false } = {}) {
    super(message);
    this.name = "RegistryReadError";
    this.status = status;
    this.transient = transient;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha(buffer, algorithm, encoding) {
  return createHash(algorithm).update(buffer).digest(encoding);
}

function stablePackageUrl(name, version) {
  return name && version
    ? `https://www.npmjs.com/package/${name}/v/${version}`
    : "";
}

async function readJson(filename, label) {
  let text;
  try {
    text = await readFile(filename, "utf8");
  } catch (error) {
    throw new ReleaseInputError(
      `${label} cannot be read: ${error?.code || "read_error"}`
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ReleaseInputError(`${label} must contain valid JSON`);
  }
}

export async function loadReleaseArtifact({
  manifestPath,
  packJsonPath,
  expectedName,
  releaseTag
}) {
  const resolvedManifest = path.resolve(manifestPath);
  const resolvedPackJson = path.resolve(packJsonPath);
  const [manifest, packOutput] = await Promise.all([
    readJson(resolvedManifest, "manifest"),
    readJson(resolvedPackJson, "pack JSON")
  ]);

  if (!expectedName || manifest.name !== expectedName) {
    throw new ReleaseInputError("manifest name does not match --expected-name");
  }
  if (!STABLE_SEMVER.test(String(manifest.version || ""))) {
    throw new ReleaseInputError("manifest version must be a stable x.y.z version");
  }
  if (releaseTag !== `v${manifest.version}`) {
    throw new ReleaseInputError(
      `release tag ${releaseTag || "<missing>"} does not match v${manifest.version}`
    );
  }
  if (manifest.private === true) {
    throw new ReleaseInputError("manifest must not be private");
  }
  if (manifest.publishConfig?.access !== "public") {
    throw new ReleaseInputError("manifest publishConfig.access must be public");
  }
  if (!Array.isArray(packOutput) || packOutput.length !== 1) {
    throw new ReleaseInputError("pack JSON must contain exactly one package");
  }

  const [pack] = packOutput;
  if (pack?.name !== manifest.name || pack?.version !== manifest.version) {
    throw new ReleaseInputError("pack JSON name and version must match manifest");
  }
  if (typeof pack.filename !== "string" || !pack.filename.endsWith(".tgz")) {
    throw new ReleaseInputError("pack JSON must contain a .tgz filename");
  }
  if (path.isAbsolute(pack.filename)) {
    throw new ReleaseInputError("pack filename must be relative to the pack JSON");
  }
  if (path.basename(pack.filename) !== pack.filename) {
    throw new ReleaseInputError(
      "relative pack filename must be next to the pack JSON"
    );
  }
  if (
    typeof pack.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(pack.integrity)
  ) {
    throw new ReleaseInputError("pack JSON must contain a sha512 integrity digest");
  }
  if (pack.shasum !== undefined && !/^[a-f\d]{40}$/i.test(pack.shasum)) {
    throw new ReleaseInputError("pack JSON shasum must be a SHA-1 hex digest");
  }

  const tarballPath = path.resolve(path.dirname(resolvedPackJson), pack.filename);
  let archive;
  let archiveStat;
  try {
    [archive, archiveStat] = await Promise.all([
      readFile(tarballPath),
      lstat(tarballPath)
    ]);
  } catch (error) {
    throw new ReleaseInputError(
      `packed tarball cannot be read: ${error?.code || "read_error"}`
    );
  }
  if (archiveStat.isSymbolicLink() || !archiveStat.isFile() || archive.length === 0) {
    throw new ReleaseInputError("packed tarball must be a non-empty regular file");
  }
  if (Number.isFinite(pack.size) && pack.size !== archive.length) {
    throw new ReleaseInputError("packed tarball size does not match pack JSON");
  }

  const integrity = `sha512-${sha(archive, "sha512", "base64")}`;
  const shasum = sha(archive, "sha1", "hex");
  if (integrity !== pack.integrity) {
    throw new ReleaseInputError("packed tarball integrity does not match pack JSON");
  }
  if (pack.shasum !== undefined && shasum !== pack.shasum.toLowerCase()) {
    throw new ReleaseInputError("packed tarball shasum does not match pack JSON");
  }

  return {
    name: manifest.name,
    version: manifest.version,
    integrity,
    shasum,
    filename: path.basename(tarballPath),
    tarballPath,
    manifestPath: resolvedManifest,
    packJsonPath: resolvedPackJson,
    archive,
    packageUrl: stablePackageUrl(manifest.name, manifest.version)
  };
}

function encodedPackageName(name) {
  return encodeURIComponent(name).replace(/^%40/i, "@");
}

function configuredRegistryUrl() {
  return process.env.NPM_CONFIG_REGISTRY ||
    process.env.npm_config_registry ||
    OFFICIAL_NPM_REGISTRY;
}

function officialRegistryUrl(registryUrl) {
  let candidate;
  try {
    candidate = new URL(registryUrl);
  } catch {
    throw new RegistryReadError("npm registry URL is invalid");
  }
  if (
    candidate.protocol !== "https:" ||
    candidate.hostname !== "registry.npmjs.org" ||
    candidate.port !== "" ||
    candidate.username !== "" ||
    candidate.password !== "" ||
    candidate.pathname !== "/" ||
    candidate.search !== "" ||
    candidate.hash !== ""
  ) {
    throw new RegistryReadError(
      `npm registry must be ${OFFICIAL_NPM_REGISTRY}`
    );
  }
  return OFFICIAL_NPM_REGISTRY;
}

function isTransientFetchFailure(error) {
  const code = error?.code || error?.cause?.code;
  return error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    TRANSIENT_CODES.has(code) ||
    error instanceof TypeError;
}

export async function readRegistryState({
  name,
  version,
  registryUrl = configuredRegistryUrl(),
  fetchImpl = globalThis.fetch,
  sleep = delay,
  retryDelays = DEFAULT_REGISTRY_RETRY_DELAYS_MS
}) {
  const baseUrl = officialRegistryUrl(registryUrl);
  const registryOrigin = new URL(baseUrl).origin;
  let url;
  try {
    url = new URL(encodedPackageName(name), baseUrl);
  } catch {
    throw new RegistryReadError("npm registry URL is invalid");
  }

  let lastError;
  for (const [index, wait] of retryDelays.entries()) {
    if (wait > 0) await sleep(wait);
    try {
      const response = await fetchImpl(url, {
        cache: "no-store",
        redirect: "manual",
        headers: {
          accept: "application/json",
          "cache-control": "no-cache"
        },
        signal: AbortSignal.timeout(15_000)
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.("location");
        if (location) {
          let redirectUrl;
          try {
            redirectUrl = new URL(location, url);
          } catch {
            throw new RegistryReadError(
              "npm registry returned an invalid redirect URL",
              { status: response.status }
            );
          }
          if (redirectUrl.origin !== registryOrigin) {
            throw new RegistryReadError(
              "npm registry redirected to a different origin",
              { status: response.status }
            );
          }
        }
        throw new RegistryReadError("npm registry redirects are not allowed", {
          status: response.status
        });
      }
      if (response.status === 404) {
        if (index < retryDelays.length - 1) continue;
        return {
          packageExists: false,
          versionExists: false,
          integrity: null,
          shasum: null,
          latestVersion: null,
          latestVersionExists: false
        };
      }
      if (!response.ok) {
        const transient = TRANSIENT_HTTP_STATUSES.has(response.status);
        lastError = new RegistryReadError(
          `npm registry returned HTTP ${response.status}`,
          { status: response.status, transient }
        );
        if (transient && index < retryDelays.length - 1) continue;
        throw lastError;
      }

      let packument;
      try {
        packument = await response.json();
      } catch {
        throw new RegistryReadError("npm registry returned invalid JSON", {
          transient: true
        });
      }
      if (
        !packument ||
        typeof packument !== "object" ||
        Array.isArray(packument) ||
        packument.name !== name ||
        !packument.versions ||
        typeof packument.versions !== "object" ||
        Array.isArray(packument.versions) ||
        !packument["dist-tags"] ||
        typeof packument["dist-tags"] !== "object" ||
        Array.isArray(packument["dist-tags"])
      ) {
        throw new RegistryReadError(
          "npm registry returned an invalid package document",
          { transient: true }
        );
      }
      const versionMetadata = packument?.versions?.[version];
      const latestVersion = packument?.["dist-tags"]?.latest || null;
      return {
        packageExists: true,
        versionExists: Boolean(versionMetadata),
        integrity: versionMetadata?.dist?.integrity || null,
        shasum: versionMetadata?.dist?.shasum || null,
        latestVersion,
        latestVersionExists: typeof latestVersion === "string" &&
          Boolean(packument.versions[latestVersion])
      };
    } catch (error) {
      if (error instanceof RegistryReadError) {
        lastError = error;
        if (error.transient && index < retryDelays.length - 1) continue;
        throw error;
      }
      const transient = isTransientFetchFailure(error);
      lastError = new RegistryReadError(
        `npm registry request failed: ${error?.code || error?.cause?.code || error?.name || "network_error"}`,
        { transient }
      );
      if (transient && index < retryDelays.length - 1) continue;
      throw lastError;
    }
  }
  throw lastError || new RegistryReadError("npm registry request failed");
}

function appendCaptured(current, chunk) {
  const combined = `${current}${chunk}`;
  return combined.length > MAX_CAPTURED_OUTPUT
    ? combined.slice(combined.length - MAX_CAPTURED_OUTPUT)
    : combined;
}

async function createVerifiedPublishCopy(artifact) {
  if (!Buffer.isBuffer(artifact.archive) || artifact.archive.length === 0) {
    throw new ReleaseInputError("verified packed tarball bytes are unavailable");
  }
  if (
    `sha512-${sha(artifact.archive, "sha512", "base64")}` !== artifact.integrity ||
    sha(artifact.archive, "sha1", "hex") !== artifact.shasum
  ) {
    throw new ReleaseInputError("verified packed tarball bytes changed in memory");
  }
  if (
    typeof artifact.filename !== "string" ||
    path.basename(artifact.filename) !== artifact.filename ||
    !artifact.filename.endsWith(".tgz")
  ) {
    throw new ReleaseInputError("verified packed tarball filename is invalid");
  }

  const directory = await mkdtemp(
    path.join(os.tmpdir(), "npm-publish-resilient-")
  );
  const filename = path.join(directory, artifact.filename);
  try {
    await writeFile(filename, artifact.archive, {
      flag: "wx",
      mode: 0o600
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { directory, filename };
}

export async function runNpmPublish(
  artifact,
  {
    distTag = "latest",
    registryUrl = configuredRegistryUrl(),
    spawnImpl = spawn,
    timeoutMs = 180_000,
    killGraceMs = 10_000
  } = {}
) {
  const normalizedRegistryUrl = officialRegistryUrl(registryUrl);
  const publishCopy = await createVerifiedPublishCopy(artifact);
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = [
    "publish",
    publishCopy.filename,
    "--access",
    "public",
    "--tag",
    distTag,
    "--registry",
    normalizedRegistryUrl,
    "--provenance",
    "--json"
  ];
  const publishEnvironment = { ...process.env };
  // Trusted Publishing must use GitHub's short-lived OIDC identity. Do not let
  // an accidentally inherited legacy token silently replace that identity.
  delete publishEnvironment.NODE_AUTH_TOKEN;
  delete publishEnvironment.NPM_TOKEN;
  delete publishEnvironment.npm_config_token;
  delete publishEnvironment.NPM_CONFIG_TOKEN;

  try {
    return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let child;
    let timeoutTimer;
    let killTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      resolve({ stdout, stderr, timedOut, ...result });
    };

    try {
      child = spawnImpl(npmExecutable, args, {
        cwd: path.dirname(artifact.manifestPath),
        env: publishEnvironment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        errorCode: error?.code || "SPAWN_ERROR",
        stdout,
        stderr,
        timedOut
      });
      return;
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Continue to the forced timeout settlement below.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child may already be gone without having emitted close.
        }
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        child.unref?.();
        finish({
          exitCode: null,
          signal: "SIGKILL",
          errorCode: "ETIMEDOUT"
        });
      }, killGraceMs);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = appendCaptured(stdout, chunk.toString());
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendCaptured(stderr, chunk.toString());
    });
    child.on("error", (error) => {
      finish({
        exitCode: null,
        signal: null,
        errorCode: error?.code || "SPAWN_ERROR"
      });
    });
    child.on("close", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        errorCode: timedOut ? "ETIMEDOUT" : null
      });
    });
    });
  } finally {
    await rm(publishCopy.directory, { recursive: true, force: true }).catch(
      () => {}
    );
  }
}

function parseJsonErrorCode(output) {
  for (const candidate of [output.stdout, output.stderr]) {
    try {
      const parsed = JSON.parse(candidate);
      const code = parsed?.error?.code || parsed?.code;
      if (typeof code === "string") return code.toUpperCase();
    } catch {
      // npm does not guarantee JSON-formatted failures on every version.
    }
  }
  return null;
}

export function classifyPublishFailure(output) {
  if (output.timedOut) return { kind: "transient", code: "ETIMEDOUT" };
  const text = `${output.stdout || ""}\n${output.stderr || ""}`;
  const codeMatch = text.match(/npm (?:error|ERR!) code ([A-Z][A-Z0-9_]*)/i);
  const code = String(
    output.errorCode || parseJsonErrorCode(output) || codeMatch?.[1] || ""
  ).toUpperCase() || null;
  const statusMatch = text.match(
    /\b(401|403|404|408|409|425|429|500|502|503|504)\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Request Timeout|Conflict|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)/i
  );
  const status = statusMatch ? Number(statusMatch[1]) : null;

  if (AUTH_CODES.has(code)) {
    return { kind: "authentication", code };
  }
  if (code === "E404") return { kind: "not-found", code };
  if (CONFLICT_CODES.has(code)) {
    return { kind: "conflict", code };
  }
  if (TRANSIENT_CODES.has(code)) {
    return { kind: "transient", code };
  }
  if (status === 401 || status === 403) {
    return { kind: "authentication", code: `HTTP_${status}` };
  }
  if (status === 404) return { kind: "not-found", code: "E404" };
  if (status === 409) return { kind: "conflict", code: "HTTP_409" };
  if (TRANSIENT_HTTP_STATUSES.has(status)) {
    return { kind: "transient", code: `HTTP_${status}` };
  }
  return { kind: "unknown", code: code || "UNKNOWN" };
}

function makeResult(
  artifact,
  outcome,
  {
    complete = false,
    published = false,
    verified = false,
    bootstrapRequired = false,
    markerCleanupRequired = false,
    distTag = artifact.distTag || "",
    publishAttempts = 0,
    reason = outcome,
    exitCode = 1
  } = {}
) {
  return {
    outcome,
    complete,
    published,
    verified,
    bootstrapRequired,
    markerCleanupRequired,
    distTag,
    packageName: artifact.name,
    packageVersion: artifact.version,
    packageUrl: artifact.packageUrl || stablePackageUrl(artifact.name, artifact.version),
    tarballPath: artifact.tarballPath || "",
    publishAttempts,
    reason,
    exitCode
  };
}

function compareObservedVersion(state, artifact) {
  if (!state.versionExists) return "absent";
  return state.integrity === artifact.integrity ? "match" : "mismatch";
}

function inspectLatestState(state, artifact, distTag) {
  if (distTag !== "latest") return { acceptable: true, reason: "not_requested" };
  if (!state.latestVersionExists) {
    return { acceptable: false, reason: "registry_latest_missing_or_invalid" };
  }
  const order = compareStableVersions(state.latestVersion, artifact.version);
  if (order === null) {
    return { acceptable: false, reason: "registry_latest_missing_or_invalid" };
  }
  if (order < 0) {
    return { acceptable: false, reason: "registry_latest_is_older" };
  }
  return {
    acceptable: true,
    reason: order === 0 ? "registry_latest_matches" : "registry_latest_is_newer"
  };
}

async function observePublishedVersion(
  readRegistry,
  sleep,
  verifyDelays,
  artifact,
  distTag
) {
  let state;
  for (const wait of verifyDelays) {
    if (wait > 0) await sleep(wait);
    state = await readRegistry();
    const comparison = compareObservedVersion(state, artifact);
    if (comparison === "mismatch") break;
    if (
      comparison === "match" &&
      inspectLatestState(state, artifact, distTag).acceptable
    ) break;
  }
  return state;
}

function compareStableVersions(left, right) {
  if (!STABLE_SEMVER.test(String(left || "")) || !STABLE_SEMVER.test(String(right || ""))) {
    return null;
  }
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

async function existingBootstrapMarker(markerPath) {
  if (!markerPath) return false;
  try {
    const marker = await stat(path.resolve(markerPath));
    return marker.isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function publishWithFallback(
  artifact,
  options,
  dependencies = {}
) {
  const { missingPackage, bootstrapMarkerPath, distTag } = options;
  if (!ALLOWED_MISSING_POLICIES.has(missingPackage)) {
    throw new ReleaseInputError(
      "--missing-package must be fail or bootstrap-soft"
    );
  }
  if (!/^[a-z][a-z0-9._-]*$/i.test(String(distTag || ""))) {
    throw new ReleaseInputError("--dist-tag must be a non-empty npm tag");
  }

  const sleep = dependencies.sleep || delay;
  const verifyDelays = dependencies.verifyDelays || DEFAULT_VERIFY_DELAYS_MS;
  const markerExists = dependencies.markerExists || existingBootstrapMarker;
  const registryUrl = dependencies.readRegistry && dependencies.runPublish
    ? OFFICIAL_NPM_REGISTRY
    : officialRegistryUrl(
      dependencies.registryUrl || configuredRegistryUrl()
    );
  const readRegistry = dependencies.readRegistry || (() => readRegistryState({
    name: artifact.name,
    version: artifact.version,
    registryUrl,
    sleep
  }));
  const runPublish = dependencies.runPublish || (() => runNpmPublish(artifact, {
    distTag,
    registryUrl
  }));

  const initialState = await readRegistry();
  const bootstrapMarkerExists = missingPackage === "bootstrap-soft" &&
    await markerExists(bootstrapMarkerPath);
  const initialComparison = compareObservedVersion(initialState, artifact);
  if (initialComparison === "match") {
    const latestState = inspectLatestState(initialState, artifact, distTag);
    if (!latestState.acceptable) {
      return makeResult(artifact, "dist_tag_verification_failed", {
        distTag,
        reason: latestState.reason
      });
    }
    return makeResult(
      artifact,
      bootstrapMarkerExists
        ? "bootstrap_verified_marker_cleanup_required"
        : "already_published",
      {
        complete: true,
        published: true,
        verified: true,
        markerCleanupRequired: bootstrapMarkerExists,
        distTag,
        reason: bootstrapMarkerExists
          ? "registry_integrity_matches_remove_bootstrap_marker"
          : "registry_integrity_matches",
        exitCode: 0
      }
    );
  }
  if (initialComparison === "mismatch") {
    return makeResult(artifact, "version_conflict", {
      distTag,
      reason: "registry_integrity_mismatch"
    });
  }
  if (initialState.packageExists && bootstrapMarkerExists) {
    return makeResult(artifact, "stale_bootstrap_marker", {
      distTag,
      reason: "remove_bootstrap_marker_after_trusted_publisher_setup"
    });
  }
  if (!initialState.packageExists) {
    if (bootstrapMarkerExists) {
      return makeResult(artifact, "bootstrap_required", {
        bootstrapRequired: true,
        distTag,
        reason: "package_bootstrap_or_scope_access_required",
        exitCode: 0
      });
    }
    return makeResult(artifact, "package_missing", {
      distTag,
      reason: missingPackage === "bootstrap-soft"
        ? "bootstrap_marker_missing"
        : "package_does_not_exist"
    });
  }

  if (distTag === "latest" && initialState.latestVersion !== null) {
    const latestOrder = compareStableVersions(
      artifact.version,
      initialState.latestVersion
    );
    if (!initialState.latestVersionExists || latestOrder === null) {
      return makeResult(artifact, "dist_tag_preflight_failed", {
        distTag,
        reason: "registry_latest_is_invalid_or_non_stable"
      });
    }
    if (latestOrder === -1) {
      return makeResult(artifact, "backfill_latest_blocked", {
        distTag,
        reason: "target_version_is_older_than_registry_latest"
      });
    }
  }

  const publishAttempts = 1;
  const publishOutput = await runPublish();
  const observation = await observePublishedVersion(
    readRegistry,
    sleep,
    verifyDelays,
    artifact,
    distTag
  );
  const comparison = compareObservedVersion(observation, artifact);
  if (comparison === "match") {
    const latestState = inspectLatestState(observation, artifact, distTag);
    if (!latestState.acceptable) {
      return makeResult(artifact, "dist_tag_verification_failed", {
        distTag,
        publishAttempts,
        reason: latestState.reason
      });
    }
    const outcome = publishOutput.exitCode === 0
      ? "published"
      : "published_after_ambiguous_error";
    return makeResult(artifact, outcome, {
      complete: true,
      published: true,
      verified: true,
      distTag,
      publishAttempts,
      reason: "registry_integrity_matches",
      exitCode: 0
    });
  }
  if (comparison === "mismatch") {
    return makeResult(artifact, "version_conflict", {
      distTag,
      publishAttempts,
      reason: "registry_integrity_mismatch"
    });
  }
  if (publishOutput.exitCode === 0) {
    return makeResult(artifact, "verification_failed", {
      distTag,
      publishAttempts,
      reason: "published_version_not_observed"
    });
  }

  const failure = classifyPublishFailure(publishOutput);
  if (failure.kind === "not-found") {
    return makeResult(artifact, "publisher_misconfigured", {
      distTag,
      publishAttempts,
      reason: "trusted_publisher_or_package_permission_mismatch"
    });
  }
  if (failure.kind === "authentication") {
    return makeResult(artifact, "authentication_failed", {
      distTag,
      publishAttempts,
      reason: failure.code.toLowerCase()
    });
  }
  if (failure.kind === "conflict") {
    return makeResult(artifact, "version_conflict", {
      distTag,
      publishAttempts,
      reason: "publish_conflict_without_matching_registry_version"
    });
  }
  if (failure.kind === "transient") {
    return makeResult(artifact, "transient_failure", {
      distTag,
      publishAttempts,
      reason: `${failure.code.toLowerCase()}_readback_absent`
    });
  }
  return makeResult(artifact, "publish_failed", {
    distTag,
    publishAttempts,
    reason: failure.code.toLowerCase()
  });
}

function singleLine(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ");
}

function markdownCell(value) {
  return singleLine(value).replaceAll("|", "\\|");
}

function annotationValue(value, property = false) {
  let encoded = String(value ?? "")
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  if (property) {
    encoded = encoded.replaceAll(":", "%3A").replaceAll(",", "%2C");
  }
  return encoded;
}

export function renderGitHubSummary(result) {
  const lines = [
    `### npm publish: \`${markdownCell(result.packageName)}@${markdownCell(result.packageVersion)}\``,
    "",
    "| Outcome | Dist tag | Complete | Registry verified | Publish attempts |",
    "| --- | --- | --- | --- | ---: |",
    `| \`${markdownCell(result.outcome)}\` | \`${markdownCell(result.distTag)}\` | ${result.complete ? "yes" : "no"} | ${result.verified ? "yes" : "no"} | ${result.publishAttempts} |`,
    "",
    `[View package version](${result.packageUrl})`
  ];
  if (result.bootstrapRequired) {
    lines.push(
      "",
      "> [!WARNING]",
      "> This package does not yet exist in the public registry. An npm scope owner must publish the verified tarball once, then configure Trusted Publishing for this workflow.",
      `> Verified tarball: \`${markdownCell(path.basename(result.tarballPath))}\``,
      "> Until bootstrap completes, use `@fullstack-ai-infra/digital-employee/core` or install the matching root/core `.tgz` asset from the GitHub Release."
    );
  } else if (result.markerCleanupRequired) {
    lines.push(
      "",
      "> [!WARNING]",
      "> The exact package version is present and verified, so this rerun has converged.",
      "> Confirm Trusted Publishing is configured, then remove the bootstrap marker before the next release."
    );
  } else if (result.exitCode !== 0) {
    lines.push(
      "",
      "> [!CAUTION]",
      `> npm publication is incomplete: \`${markdownCell(result.reason)}\`.`
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function writeGitHubReport(
  result,
  {
    outputPath = process.env.GITHUB_OUTPUT,
    summaryPath = process.env.GITHUB_STEP_SUMMARY,
    annotate = process.env.GITHUB_ACTIONS === "true"
  } = {}
) {
  const outputs = {
    outcome: result.outcome,
    complete: result.complete,
    published: result.published,
    verified: result.verified,
    bootstrap_required: result.bootstrapRequired,
    marker_cleanup_required: result.markerCleanupRequired,
    dist_tag: result.distTag,
    package_name: result.packageName,
    package_version: result.packageVersion,
    package_url: result.packageUrl,
    tarball_path: result.tarballPath,
    publish_attempts: result.publishAttempts,
    reason: result.reason
  };
  if (outputPath) {
    const serialized = Object.entries(outputs)
      .map(([key, value]) => `${key}=${singleLine(value)}`)
      .join("\n");
    await appendFile(outputPath, `${serialized}\n`, "utf8");
  }
  if (summaryPath) {
    await appendFile(summaryPath, renderGitHubSummary(result), "utf8");
  }
  if (annotate && result.bootstrapRequired) {
    process.stdout.write(
      `::warning title=${annotationValue("npm bootstrap required", true)}::${annotationValue(`${result.packageName}@${result.packageVersion} requires one-time npm owner publication`)}\n`
    );
  } else if (annotate && result.markerCleanupRequired) {
    process.stdout.write(
      `::warning title=${annotationValue("npm bootstrap marker cleanup required", true)}::${annotationValue(`${result.packageName}@${result.packageVersion} is verified; confirm Trusted Publishing and remove the marker before the next release`)}\n`
    );
  } else if (annotate && result.exitCode !== 0) {
    process.stdout.write(
      `::error title=${annotationValue("npm publish incomplete", true)}::${annotationValue(result.reason)}\n`
    );
  }
}

export function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const allowed = new Set([
    "--manifest",
    "--pack-json",
    "--expected-name",
    "--release-tag",
    "--dist-tag",
    "--missing-package",
    "--bootstrap-marker"
  ]);
  const required = new Set([
    "--manifest",
    "--pack-json",
    "--expected-name",
    "--release-tag",
    "--dist-tag",
    "--missing-package"
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag)) {
      throw new ReleaseInputError(`unknown argument ${flag || "<missing>"}`);
    }
    if (!value || value.startsWith("--")) {
      throw new ReleaseInputError(`${flag} requires a value`);
    }
    if (values[flag] !== undefined) {
      throw new ReleaseInputError(`${flag} may only be specified once`);
    }
    values[flag] = value;
  }
  for (const flag of required) {
    if (values[flag] === undefined) {
      throw new ReleaseInputError(`${flag} is required`);
    }
  }
  if (!ALLOWED_MISSING_POLICIES.has(values["--missing-package"])) {
    throw new ReleaseInputError(
      "--missing-package must be fail or bootstrap-soft"
    );
  }
  if (!/^[a-z][a-z0-9._-]*$/i.test(values["--dist-tag"])) {
    throw new ReleaseInputError("--dist-tag must be a non-empty npm tag");
  }
  return {
    manifestPath: values["--manifest"],
    packJsonPath: values["--pack-json"],
    expectedName: values["--expected-name"],
    releaseTag: values["--release-tag"],
    distTag: values["--dist-tag"],
    missingPackage: values["--missing-package"],
    bootstrapMarkerPath: values["--bootstrap-marker"]
  };
}

function fallbackArtifact(options = {}) {
  const version = String(options.releaseTag || "").replace(/^v/, "");
  return {
    name: options.expectedName || "unknown-package",
    version,
    packageUrl: stablePackageUrl(options.expectedName, version),
    tarballPath: "",
    distTag: options.distTag || ""
  };
}

export async function runCli(argv = process.argv.slice(2)) {
  let options;
  let artifact;
  let result;
  try {
    options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    artifact = await loadReleaseArtifact(options);
    result = await publishWithFallback(artifact, {
      missingPackage: options.missingPackage,
      bootstrapMarkerPath: options.bootstrapMarkerPath,
      distTag: options.distTag
    });
  } catch (error) {
    const inputFailure = error instanceof ReleaseInputError;
    artifact ||= fallbackArtifact(options);
    result = makeResult(
      artifact,
      inputFailure ? "input_invalid" : "registry_or_internal_failure",
      {
        reason: inputFailure
          ? "release_input_invalid"
          : error instanceof RegistryReadError
            ? "registry_read_failed"
            : "unexpected_error",
        exitCode: inputFailure ? 2 : 1
      }
    );
    process.stderr.write(`npm-publish-resilient: ${error?.message || "unexpected error"}\n`);
  }

  await writeGitHubReport(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(
      `npm-publish-resilient: ${error?.message || "unexpected error"}\n`
    );
    process.exitCode = 1;
  });
}
