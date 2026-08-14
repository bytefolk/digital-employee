#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  readFile,
  realpath,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@fullstack-ai-infra/digital-employee";
const SECRET_SENTINEL = `release-consumer-secret-${randomBytes(16).toString("hex")}`;
const HOST_SECRET_SENTINEL = `${SECRET_SENTINEL}-host`;
const HTTP_SECRET_SENTINEL = `${SECRET_SENTINEL}-http`;
const MAX_SCANNED_FILE_BYTES = 5 * 1024 * 1024;
const RUNTIME_DRAIN_BUDGET_MS = 15_000;
const SNAPSHOT_CLEANUP_BUDGET_MS = 5_000;
const STOP_VERIFICATION_MARGIN_MS = 10_000;
export const RUNTIME_STOP_TIMEOUT_MS =
  RUNTIME_DRAIN_BUDGET_MS +
  SNAPSHOT_CLEANUP_BUDGET_MS +
  STOP_VERIFICATION_MARGIN_MS;

function fail(message) {
  throw new Error(message);
}

function redactConsumerSecret(value) {
  return String(value || "").replaceAll(SECRET_SENTINEL, "[REDACTED]");
}

function run(command, args, { cwd, environment, timeout = 30_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      `${path.basename(command)} ${args[0] || ""} failed with exit ${String(result.status)}\n` +
        `${redactConsumerSecret(result.stdout)}${redactConsumerSecret(result.stderr)}`
    );
  }
  return result;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") fail("release consumer port unavailable");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function httpJson({
  port,
  requestPath,
  method = "GET",
  body,
  authorizationToken
}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method,
        timeout: 10_000,
        headers: {
          ...(body
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body)
              }
            : {}),
          ...(authorizationToken
            ? { authorization: `Bearer ${authorizationToken}` }
            : {})
        }
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.once("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.once("timeout", () => request.destroy(new Error("http_timeout")));
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function pathIsWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function scanTreeForSecret(
  root,
  secretSentinel,
  scanRoot = path.resolve(root)
) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) {
      const linkTarget = await readlink(target);
      if (Buffer.from(linkTarget).includes(Buffer.from(secretSentinel))) {
        fail("release consumer secret sentinel remained in a symlink target");
      }
      if (!pathIsWithin(scanRoot, path.resolve(path.dirname(target), linkTarget))) {
        fail("release consumer observed a symlink outside the scanned tree");
      }
      continue;
    }
    if (metadata.isDirectory()) {
      await scanTreeForSecret(target, secretSentinel, scanRoot);
      continue;
    }
    if (!metadata.isFile() || metadata.size > MAX_SCANNED_FILE_BYTES) {
      fail("release consumer observed an unscannable runtime-owned artifact");
    }
    if ((await readFile(target)).includes(Buffer.from(secretSentinel))) {
      fail("release consumer secret sentinel remained in a runtime-owned artifact");
    }
  }
}

export async function stopRuntimeAndRemoveConsumerTree({
  temporary,
  stopRuntime
}) {
  await stopRuntime();
  await rm(temporary, { recursive: true, force: true });
}

async function assertPathAbsent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail("release consumer left an installation temporary directory");
}

export async function assertConsumerArtifactsClean({
  observedArtifacts,
  secretSentinel,
  scanRoots,
  emptyRuntimeDirectory,
  absentTemporaryDirectories
}) {
  if (
    observedArtifacts.some((artifact) =>
      String(artifact).includes(secretSentinel)
    )
  ) {
    fail("release consumer secret sentinel escaped through observable output");
  }
  const runtimeResidue = await readdir(emptyRuntimeDirectory);
  if (runtimeResidue.length > 0) {
    fail("release consumer left authentication, snapshot, or temporary residue");
  }
  for (const root of scanRoots) {
    await scanTreeForSecret(root, secretSentinel);
  }
  for (const target of absentTemporaryDirectories) {
    await assertPathAbsent(target);
  }
}

async function stopVerifiedRuntime(state, authorizationToken) {
  if (!state) return;
  const pid = state.process?.pid;
  const port = state.endpoint?.port;
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(port)) {
    fail("release consumer deploy state has no valid runtime identity");
  }
  if (!processExists(pid)) return;
  const health = await httpJson({
    port,
    requestPath: "/health",
    authorizationToken
  });
  if (
    health.status !== 200 ||
    health.body?.pid !== pid ||
    health.body?.launchId !== state.process?.launchId
  ) {
    fail("release consumer refused to signal an unverified process");
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + RUNTIME_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await delay(50);
  }
  fail("release consumer runtime did not exit after SIGTERM");
}

export async function verifyRootPackageConsumer({ archivePath, qoderFixturePath }) {
  if (process.platform === "win32") {
    fail("release consumer check requires the POSIX deploy runtime");
  }
  for (const [label, filePath] of [
    ["root package archive", archivePath],
    ["Qoder fixture", qoderFixturePath]
  ]) {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail(`${label} must be a regular file`);
    }
  }

  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "digital-employee-release-consumer-")
  );
  const consumer = path.join(temporary, "consumer");
  const home = path.join(temporary, "home");
  const fixtureBin = path.join(temporary, "fixture-bin");
  const workspace = path.join(temporary, "workspace");
  const installationTemporary = path.join(temporary, "install-tmp");
  const installationCache = path.join(temporary, "install-cache");
  const runtimeTemporary = path.join(temporary, "runtime-tmp");
  const employee = path.join(workspace, "my-employee");
  const statePath = path.join(home, ".digital-employee", "config.json");
  const observedArtifacts = [];
  const runObserved = (...args) => {
    const result = run(...args);
    observedArtifacts.push(result.stdout, result.stderr);
    return result;
  };
  let state;
  let runtimeStopped = false;

  try {
    await Promise.all([
      mkdir(consumer),
      mkdir(home),
      mkdir(fixtureBin),
      mkdir(workspace),
      mkdir(installationTemporary),
      mkdir(installationCache),
      mkdir(runtimeTemporary)
    ]);
    const fixtureCommand = path.join(fixtureBin, "qodercli");
    await copyFile(qoderFixturePath, fixtureCommand);
    await chmod(fixtureCommand, 0o755);

    const installationEnvironment = {
      ...process.env,
      TMPDIR: installationTemporary,
      TEMP: installationTemporary,
      TMP: installationTemporary,
      npm_config_cache: installationCache
    };
    runObserved(
      process.env.npm_execpath ? process.execPath : "npm",
      process.env.npm_execpath
        ? [process.env.npm_execpath, "install", "--prefix", consumer, "--ignore-scripts", "--no-audit", "--no-fund", archivePath]
        : ["install", "--prefix", consumer, "--ignore-scripts", "--no-audit", "--no-fund", archivePath],
      { environment: installationEnvironment, timeout: 120_000 }
    );

    const installedRoot = path.join(
      consumer,
      "node_modules",
      "@fullstack-ai-infra",
      "digital-employee"
    );
    const installedManifest = JSON.parse(
      await readFile(path.join(installedRoot, "package.json"), "utf8")
    );
    if (installedManifest.name !== PACKAGE_NAME || !installedManifest.version) {
      fail("release consumer installed unexpected package identity");
    }
    runObserved(
      process.execPath,
      ["--input-type=module", "-e", `await import('${PACKAGE_NAME}/core')`],
      {
        cwd: consumer,
        environment: {
          HOME: home,
          PATH: process.env.PATH || "",
          TMPDIR: installationTemporary,
          TEMP: installationTemporary,
          TMP: installationTemporary,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8"
        }
      }
    );
    await Promise.all([
      scanTreeForSecret(installationTemporary, SECRET_SENTINEL),
      scanTreeForSecret(installationCache, SECRET_SENTINEL)
    ]);
    await Promise.all([
      rm(installationTemporary, { recursive: true }),
      rm(installationCache, { recursive: true })
    ]);
    await Promise.all([
      assertPathAbsent(installationTemporary),
      assertPathAbsent(installationCache)
    ]);

    const cliCommand = path.join(
      consumer,
      "node_modules",
      ".bin",
      "digital-employee"
    );
    await lstat(cliCommand);
    const authoringEnvironment = {
      HOME: home,
      PATH: [fixtureBin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
        path.delimiter
      ),
      TMPDIR: runtimeTemporary,
      TEMP: runtimeTemporary,
      TMP: runtimeTemporary,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8"
    };
    const runtimeEnvironment = {
      ...authoringEnvironment,
      QODER_PERSONAL_ACCESS_TOKEN: HOST_SECRET_SENTINEL,
      DIGITAL_EMPLOYEE_HTTP_TOKEN: HTTP_SECRET_SENTINEL
    };
    const setup = runObserved(
      cliCommand,
      ["setup", "--json"],
      { cwd: workspace, environment: authoringEnvironment }
    );
    const setupResult = JSON.parse(setup.stdout);
    const setupDirectoryMatches =
      setupResult.employee?.directory &&
      (await realpath(setupResult.employee.directory)) === (await realpath(employee));
    if (
      setupResult.environment?.packageVersion !== installedManifest.version ||
      setupResult.environment?.packageVersion === "unknown" ||
      setupResult.employee?.found !== true ||
      setupResult.employee?.scaffolded !== true ||
      setupDirectoryMatches !== true
    ) {
      fail(
        "release consumer setup did not report the installed package: " +
          JSON.stringify({
            packageVersion: setupResult.environment?.packageVersion,
            expectedVersion: installedManifest.version,
            found: setupResult.employee?.found,
            scaffolded: setupResult.employee?.scaffolded,
            directoryMatches: setupDirectoryMatches
          })
      );
    }

    const doctor = JSON.parse(runObserved(
      cliCommand,
      ["doctor", "--json"],
      { cwd: employee, environment: authoringEnvironment }
    ).stdout);
    if (
      doctor.status !== "installed" ||
      !doctor.hosts?.some((host) =>
        host.hostId === "qoder" &&
        host.available === true &&
        host.status === "not_ready" &&
        host.issues?.some((issue) =>
          issue.code === "qoder_service_token_not_configured" &&
          issue.blocking === true
        )
      )
    ) {
      fail(
        "release consumer doctor did not find the fixture Agent Host: " +
          JSON.stringify({ status: doctor.status, hosts: doctor.hosts })
      );
    }

    const validated = JSON.parse(runObserved(
      cliCommand,
      ["validate", "--json"],
      { cwd: employee, environment: authoringEnvironment }
    ).stdout);
    if (validated.status !== "valid") {
      fail("release consumer validate did not accept the scaffolded package");
    }
    const evaluated = JSON.parse(runObserved(
      cliCommand,
      ["eval", "--json"],
      { cwd: employee, environment: authoringEnvironment }
    ).stdout);
    if (
      evaluated.status !== "passed" ||
      evaluated.summary?.total < 1 ||
      evaluated.summary?.failed !== 0
    ) {
      fail("release consumer eval did not pass the scaffolded fixtures");
    }

    const port = await freePort();
    const deployed = runObserved(
      cliCommand,
      [
        "deploy",
        "--channel",
        "http",
        "--engine",
        "qoder",
        "--runtime",
        "agent-native",
        "--locale",
        "en",
        "--port",
        String(port),
        "--yes"
      ],
      { cwd: employee, environment: runtimeEnvironment }
    );
    if (!deployed.stdout.includes("Ready:")) {
      fail("release consumer deploy did not report Ready");
    }

    const stateText = await readFile(statePath, "utf8");
    state = JSON.parse(stateText);
    if (
      state.outcome !== "ready" ||
      state.package?.name !== "my-employee" ||
      state.endpoint?.port !== port ||
      state.engine !== "qoder"
    ) {
      fail("release consumer deploy state did not bind the installed package runtime");
    }
    observedArtifacts.push(stateText);

    const health = await httpJson({
      port,
      requestPath: "/health"
    });
    if (
      health.status !== 200 ||
      health.body?.pid !== state.process?.pid ||
      health.body?.package?.name !== "my-employee" ||
      health.body?.inputContract !== "message.v1"
    ) {
      fail("release consumer health readback did not match deploy state");
    }
    const askBody = JSON.stringify({ message: "release package consumer check" });
    const missingAuthorization = await httpJson({
      port,
      requestPath: "/v1/ask",
      method: "POST",
      body: askBody
    });
    if (missingAuthorization.status !== 401) {
      fail("release consumer ask accepted a missing bearer token");
    }
    const wrongAuthorization = await httpJson({
      port,
      requestPath: "/v1/ask",
      method: "POST",
      body: askBody,
      authorizationToken: "wrong-release-consumer-token"
    });
    if (wrongAuthorization.status !== 401) {
      fail("release consumer ask accepted an incorrect bearer token");
    }
    const answer = await httpJson({
      port,
      requestPath: "/v1/ask",
      method: "POST",
      body: askBody,
      authorizationToken: HTTP_SECRET_SENTINEL
    });
    if (
      answer.status !== 200 ||
      answer.body?.status !== "answered" ||
      answer.body?.output?.answer !== "fixture answer"
    ) {
      fail("release consumer ask did not return the fixture answer");
    }
    observedArtifacts.push(
      JSON.stringify(health.body),
      JSON.stringify(missingAuthorization.body),
      JSON.stringify(wrongAuthorization.body),
      JSON.stringify(answer.body)
    );

    await stopVerifiedRuntime(state, HTTP_SECRET_SENTINEL);
    runtimeStopped = true;
    if (processExists(state.process.pid)) {
      fail("release consumer runtime PID survived cleanup");
    }
    await assertConsumerArtifactsClean({
      observedArtifacts,
      secretSentinel: SECRET_SENTINEL,
      scanRoots: [home, workspace, consumer],
      emptyRuntimeDirectory: runtimeTemporary,
      absentTemporaryDirectories: [installationTemporary, installationCache]
    });
  } finally {
    await stopRuntimeAndRemoveConsumerTree({
      temporary,
      stopRuntime: async () => {
        if (!runtimeStopped && !state) {
          try {
            state = JSON.parse(await readFile(statePath, "utf8"));
          } catch {
            // No durable runtime identity was published.
          }
        }
        if (!runtimeStopped && state) {
          await stopVerifiedRuntime(state, HTTP_SECRET_SENTINEL);
        }
      }
    });
  }
}

async function main() {
  const [archivePathValue, qoderFixturePathValue] = process.argv.slice(2);
  if (!archivePathValue || !qoderFixturePathValue) {
    throw new TypeError(
      "usage: release-consumer-check.js <root-package.tgz> <fake-qoder.mjs>"
    );
  }
  await verifyRootPackageConsumer({
    archivePath: path.resolve(archivePathValue),
    qoderFixturePath: path.resolve(qoderFixturePathValue)
  });
  process.stdout.write(
    "release consumer check passed: clean install, credential-free setup/doctor/validate/eval, public health, bearer-protected ask, secret/residue audit, and PID cleanup\n"
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `release-consumer-check: ${error?.message || "unexpected_error"}\n`
    );
    process.exitCode = 1;
  });
}
