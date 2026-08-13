#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@fullstack-ai-infra/digital-employee";

function fail(message) {
  throw new Error(message);
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
        `${result.stdout || ""}${result.stderr || ""}`
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

async function httpJson({ port, requestPath, method = "GET", body }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method,
        timeout: 10_000,
        headers: body
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body)
            }
          : undefined
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

async function stopVerifiedRuntime(state) {
  if (!state) return;
  const pid = state.process?.pid;
  const port = state.endpoint?.port;
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(port)) {
    fail("release consumer deploy state has no valid runtime identity");
  }
  if (!processExists(pid)) return;
  const health = await httpJson({ port, requestPath: "/health" });
  if (
    health.status !== 200 ||
    health.body?.pid !== pid ||
    health.body?.launchId !== state.process?.launchId
  ) {
    fail("release consumer refused to signal an unverified process");
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
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
  const employee = path.join(workspace, "release-consumer");
  const statePath = path.join(home, ".digital-employee", "config.json");
  let state;
  let runtimeStopped = false;

  try {
    await Promise.all([
      mkdir(consumer),
      mkdir(home),
      mkdir(fixtureBin),
      mkdir(workspace)
    ]);
    const fixtureCommand = path.join(fixtureBin, "qodercli");
    await copyFile(qoderFixturePath, fixtureCommand);
    await chmod(fixtureCommand, 0o755);

    run(
      process.env.npm_execpath ? process.execPath : "npm",
      process.env.npm_execpath
        ? [process.env.npm_execpath, "install", "--prefix", consumer, "--ignore-scripts", "--no-audit", "--no-fund", "--offline", archivePath]
        : ["install", "--prefix", consumer, "--ignore-scripts", "--no-audit", "--no-fund", "--offline", archivePath],
      { environment: process.env, timeout: 120_000 }
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
    run(
      process.execPath,
      ["--input-type=module", "-e", `await import('${PACKAGE_NAME}/core')`],
      { cwd: consumer, environment: process.env }
    );

    const cliCommand = path.join(
      consumer,
      "node_modules",
      ".bin",
      "digital-employee"
    );
    await lstat(cliCommand);
    const runtimeEnvironment = {
      HOME: home,
      PATH: [fixtureBin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
        path.delimiter
      ),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      QODER_PERSONAL_ACCESS_TOKEN: "fixture-service-token"
    };
    run(
      cliCommand,
      ["init", employee, "--recipe", "minimal-answer.v1", "--name", "release-consumer"],
      { cwd: workspace, environment: runtimeEnvironment }
    );

    const setup = run(
      cliCommand,
      ["setup", employee, "--json"],
      { cwd: workspace, environment: runtimeEnvironment }
    );
    const setupResult = JSON.parse(setup.stdout);
    if (
      setupResult.environment?.packageVersion !== installedManifest.version ||
      setupResult.environment?.packageVersion === "unknown" ||
      setupResult.employee?.found !== true
    ) {
      fail("release consumer setup did not report the installed package");
    }

    const port = await freePort();
    const deployed = run(
      cliCommand,
      [
        "deploy",
        employee,
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
      { cwd: workspace, environment: runtimeEnvironment }
    );
    if (!deployed.stdout.includes("Ready:")) {
      fail("release consumer deploy did not report Ready");
    }

    const stateText = await readFile(statePath, "utf8");
    state = JSON.parse(stateText);
    if (
      state.outcome !== "ready" ||
      state.package?.name !== "release-consumer" ||
      state.endpoint?.port !== port ||
      state.engine !== "qoder"
    ) {
      fail("release consumer deploy state did not bind the installed package runtime");
    }
    if (stateText.includes(runtimeEnvironment.QODER_PERSONAL_ACCESS_TOKEN)) {
      fail("release consumer deploy state persisted the fixture credential");
    }

    const health = await httpJson({ port, requestPath: "/health" });
    if (
      health.status !== 200 ||
      health.body?.pid !== state.process?.pid ||
      health.body?.package?.name !== "release-consumer"
    ) {
      fail("release consumer health readback did not match deploy state");
    }
    const answer = await httpJson({
      port,
      requestPath: "/v1/ask",
      method: "POST",
      body: JSON.stringify({ message: "release package consumer check" })
    });
    if (answer.status !== 200 || answer.body?.answer !== "fixture answer") {
      fail("release consumer ask did not return the fixture answer");
    }

    await stopVerifiedRuntime(state);
    runtimeStopped = true;
    if (processExists(state.process.pid)) {
      fail("release consumer runtime PID survived cleanup");
    }
  } finally {
    if (!runtimeStopped && !state) {
      try {
        state = JSON.parse(await readFile(statePath, "utf8"));
      } catch {
        // No durable runtime identity was published.
      }
    }
    if (!runtimeStopped && state) await stopVerifiedRuntime(state);
    await rm(temporary, { recursive: true, force: true });
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
    "release consumer check passed: clean install, init, setup version, HTTP health/ask, and PID cleanup\n"
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
