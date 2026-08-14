#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const AUDITED_CODEX_VERSION = "0.147.0";
export const AUDIT_SCHEMA = "codex-host-research-record.v1";
export const MAX_LOOPBACK_REQUEST_BYTES = 4 * 1024 * 1024;

function parseArgs(argv) {
  const index = argv.indexOf("--codex-bin");
  if (index === -1 || !argv[index + 1]) {
    throw new TypeError("usage: audit-codex-host.js --codex-bin <path>");
  }
  return { codexBin: path.resolve(argv[index + 1]) };
}

export function toolName(tool) {
  if (!tool || typeof tool !== "object") return "unknown";
  if (typeof tool.name === "string") return tool.name;
  if (typeof tool.function?.name === "string") return tool.function.name;
  return typeof tool.type === "string" ? tool.type : "unknown";
}

export function buildRecord({ version, request, exitCode, eventTypes }) {
  const tools = Array.isArray(request?.tools) ? request.tools.map(toolName).sort() : [];
  const blocker = tools.includes("apply_patch")
    ? "model_visible_disallowed_tool:apply_patch"
    : "tool_removal_not_proven";
  return {
    schema: AUDIT_SCHEMA,
    auditedHost: "codex-cli",
    auditedVersion: version,
    policy: "digital-employee-default-deny.v1",
    transport: "loopback-responses-fixture",
    realProviderConfigured: false,
    loopbackRequestObserved: true,
    modelVisibleTools: tools,
    eventTypes: [...new Set(eventTypes)].sort(),
    processExitCode: exitCode,
    axes: {
      implemented: false,
      fixtureConformant: false,
      liveQualified: false
    },
    vectors: {
      modelVisibleToolRemoval: "FAIL_E3",
      nativeEventValidation: "OBSERVED_NOT_QUALIFIED",
      singleTerminalOutcome: "NOT_VERIFIED",
      deadlineAndCancel: "NOT_VERIFIED",
      processTreeCleanup: "NOT_VERIFIED",
      credentialBoundary: "NOT_VERIFIED",
      filesystemEnforcement: "NOT_VERIFIED",
      networkEnforcement: "NOT_VERIFIED",
      mcpIsolation: "NOT_VERIFIED",
      skillPluginIsolation: "NOT_VERIFIED",
      outputSchema: "NOT_VERIFIED"
    },
    verdict: tools.includes("apply_patch") ? "NO_GO" : "INCONCLUSIVE",
    blocker
  };
}

function isolatedEnv(root) {
  const home = path.join(root, "home");
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    CODEX_HOME: path.join(root, "codex-home"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    TMPDIR: path.join(root, "tmp"),
    LANG: "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    CODEX_AUDIT_FAKE_KEY: "offline-placeholder"
  };
}

async function runProcess(command, args, options, timeoutMs = 20_000) {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const processId = child.pid;
  const signalProcessGroup = (signal) => {
    if (!Number.isInteger(processId) || processId <= 0) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-processId, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    signalProcessGroup("SIGKILL");
  }, timeoutMs);
  try {
    const [exitCode, signal] = await new Promise((resolve, reject) => {
      let spawnError;
      child.once("error", (error) => { spawnError = error; });
      child.once("close", (code, closeSignal) => {
        if (spawnError) reject(spawnError);
        else resolve([code, closeSignal]);
      });
    });
    if (timedOut) throw new Error(`process timed out after ${timeoutMs}ms`);
    return { exitCode, signal, stdout, stderr };
  } finally {
    clearTimeout(timer);
    signalProcessGroup("SIGKILL");
  }
}

function requireSuccessfulProcess(result, label) {
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new Error(
      `${label} failed: exit=${result.exitCode ?? "none"} signal=${result.signal ?? "none"}`
    );
  }
}

function completedResponse(responseId) {
  const events = [
    { type: "response.created", response: { id: responseId } },
    { type: "response.completed", response: { id: responseId, output: [] } }
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

export async function auditCodex(codexBin) {
  const root = await mkdtemp(path.join(os.tmpdir(), "digital-employee-codex-audit-"));
  const env = isolatedEnv(root);
  await Promise.all([
    mkdir(env.HOME, { recursive: true }),
    mkdir(env.CODEX_HOME, { recursive: true }),
    mkdir(env.XDG_CONFIG_HOME, { recursive: true }),
    mkdir(env.XDG_CACHE_HOME, { recursive: true }),
    mkdir(env.TMPDIR, { recursive: true }),
    mkdir(path.join(root, "workspace"), { recursive: true })
  ]);

  const requests = [];
  const routeViolations = [];
  const sockets = new Set();
  const server = http.createServer((incoming, response) => {
    const contentType = incoming.headers["content-type"]?.split(";", 1)[0].trim();
    if (
      incoming.method !== "POST" ||
      incoming.url !== "/v1/responses" ||
      contentType !== "application/json"
    ) {
      routeViolations.push(`${incoming.method || "UNKNOWN"} ${incoming.url || ""}`);
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    const declaredLength = incoming.headers["content-length"];
    if (declaredLength !== undefined) {
      if (!/^\d+$/.test(declaredLength)) {
        routeViolations.push("invalid Content-Length");
        incoming.resume();
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("invalid content length");
        return;
      }
      if (Number(declaredLength) > MAX_LOOPBACK_REQUEST_BYTES) {
        routeViolations.push("loopback request body exceeds 4 MiB");
        incoming.resume();
        response.writeHead(413, { "content-type": "text/plain" });
        response.end("request body too large");
        return;
      }
    }
    const chunks = [];
    let receivedBytes = 0;
    let bodyTooLarge = false;
    incoming.on("data", (chunk) => {
      if (bodyTooLarge) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_LOOPBACK_REQUEST_BYTES) {
        bodyTooLarge = true;
        chunks.length = 0;
        routeViolations.push("loopback request body exceeds 4 MiB");
        response.writeHead(413, { "content-type": "text/plain" });
        response.end("request body too large");
        incoming.removeAllListeners("data");
        incoming.resume();
        return;
      }
      chunks.push(chunk);
    });
    incoming.on("end", () => {
      if (bodyTooLarge) return;
      let request;
      try {
        request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        routeViolations.push("invalid JSON request body");
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("invalid json");
        return;
      }
      if (!request || typeof request !== "object" || !Array.isArray(request.tools)) {
        routeViolations.push("request body missing tools array");
        response.writeHead(422, { "content-type": "text/plain" });
        response.end("missing tools");
        return;
      }
      requests.push(request);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      });
      response.end(completedResponse("offline-audit-response"));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback bind failed");
    const versionResult = await runProcess(codexBin, ["--version"], { env, cwd: root });
    requireSuccessfulProcess(versionResult, "Codex version probe");
    const versionMatch = /codex-cli (\d+\.\d+\.\d+)/.exec(versionResult.stdout);
    const version = versionMatch?.[1];
    if (version !== AUDITED_CODEX_VERSION) {
      throw new Error(`expected codex-cli ${AUDITED_CODEX_VERSION}`);
    }

    const provider = `{ name = "Offline audit fixture", base_url = "http://127.0.0.1:${address.port}/v1", env_key = "CODEX_AUDIT_FAKE_KEY", wire_api = "responses", supports_websockets = false }`;
    const args = [
      "exec",
      "--strict-config",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--json",
      "--model", "gpt-5.2",
      "--disable", "shell_tool",
      "--disable", "unified_exec",
      "--disable", "apps",
      "--disable", "plugins",
      "--disable", "skill_search",
      "--disable", "multi_agent",
      "--disable", "view_image",
      "--disable", "workspace_dependencies",
      "-c", "model_provider=\"offline_audit\"",
      "-c", `model_providers.offline_audit=${provider}`,
      "-c", "analytics.enabled=false",
      "-c", "web_search=\"disabled\"",
      "-c", "tools.experimental_request_user_input.enabled=false",
      "-c", "tools.update_plan.enabled=false",
      "Return OFFLINE_AUDIT_COMPLETE without calling tools."
    ];
    const result = await runProcess(codexBin, args, {
      env,
      cwd: path.join(root, "workspace")
    });
    requireSuccessfulProcess(result, "Codex tool inventory probe");
    const eventTypes = result.stdout
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const event = JSON.parse(line);
          return typeof event.type === "string" ? [event.type] : [];
        } catch {
          return [];
        }
      });
    if (routeViolations.length > 0) {
      throw new Error(`unexpected loopback route: ${routeViolations[0]}`);
    }
    if (requests.length !== 1) {
      throw new Error(`Codex did not reach the loopback fixture (exit ${result.exitCode})`);
    }
    return buildRecord({
      version,
      request: requests[0],
      exitCode: result.exitCode,
      eventTypes
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const { codexBin } = parseArgs(process.argv.slice(2));
  const record = await auditCodex(codexBin);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`codex audit failed: ${error?.message || "unexpected_error"}\n`);
    process.exitCode = 2;
  });
}
