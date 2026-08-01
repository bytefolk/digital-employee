#!/usr/bin/env node

import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConsoleChannel } from "../../connectors/channels/console/index.js";
import { createHttpServer } from "../server/server.js";
import { createRuntime } from "./runtime.js";

type Runtime = Awaited<ReturnType<typeof createRuntime>>;
type EmployeeResult = Awaited<ReturnType<Runtime["employee"]["answer"]>>;

interface CommandValues {
  config: string;
  question?: string;
  json: boolean;
  channel?: string;
  host: string;
  port: string;
  help: boolean;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultConfig = path.join(packageRoot, "configs", "demo.json");

function usage() {
  return `Digital Employee

Usage:
  digital-employee ask --question "..." [--config path] [--json]
  digital-employee sync [--config path] [--json]
  digital-employee start [--config path] [--channel console|dingtalk]
  digital-employee serve [--config path] [--host 127.0.0.1] [--port 3000]

The default demo uses approved local files and requires no credentials.
`;
}

function parseCommand(argv: string[]) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help";
  const rest = command === "help" ? argv.slice(command === argv[0] ? 1 : 0) : argv.slice(1);
  const parsed = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string", short: "c", default: defaultConfig },
      question: { type: "string", short: "q" },
      json: { type: "boolean", default: false },
      channel: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "3000" },
      help: { type: "boolean", short: "h", default: false }
    }
  });
  return { command, values: parsed.values as CommandValues, positionals: parsed.positionals };
}

function printResult(result: EmployeeResult, json: boolean) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.answer || result.escalation?.message || "No answer"}\n`);
  if (result.citations?.length) {
    process.stdout.write("\nSources:\n");
    for (const citation of result.citations) {
      if (!citation || typeof citation !== "object" || Array.isArray(citation)) continue;
      const label = typeof citation.label === "string"
        ? citation.label
        : typeof citation.id === "string"
          ? citation.id
          : "approved source";
      const uri = typeof citation.uri === "string" ? citation.uri : "approved source";
      process.stdout.write(`- ${label}: ${uri}\n`);
    }
  }
  if (result.escalation) {
    process.stdout.write(`\nHuman review: ${result.escalation.target} (${result.escalation.reason})\n`);
  }
}

async function ask(values: CommandValues, positionals: string[]) {
  const question = values.question || positionals.join(" ").trim();
  if (!question) throw new TypeError("ask_requires_question");
  const runtime = await createRuntime(values.config);
  const result = await runtime.employee.answer({
    requestId: `cli-${Date.now()}`,
    sessionId: "cli",
    actorId: "cli",
    message: question,
    metadata: { channel: "cli" }
  });
  printResult(result, values.json);
}

async function sync(values: CommandValues) {
  const runtime = await createRuntime(values.config);
  const result = {
    status: "ready",
    employee: runtime.profile.id,
    sourceCount: runtime.sources.length,
    documentCount: runtime.documents.length
  };
  if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(
      `Ready: ${result.documentCount} approved chunks from ${result.sourceCount} source(s).\n`
    );
  }
}

async function startConsole(runtime: Runtime) {
  const channel = new ConsoleChannel();
  await channel.start((message) =>
    runtime.employee.answer({
      requestId: message.id,
      sessionId: message.threadId,
      actorId: "console",
      message: message.text,
      metadata: { channel: message.channel }
    })
  );
}

async function startDingTalk(runtime: Runtime) {
  const { DingTalkChannel } = await import("../../connectors/channels/dingtalk/index.js");
  const channelConfig = runtime.config.channel || {};
  const clientId = process.env[channelConfig.clientIdEnv || "DINGTALK_CLIENT_ID"];
  const clientSecret = process.env[channelConfig.clientSecretEnv || "DINGTALK_CLIENT_SECRET"];
  if (!clientId || !clientSecret) throw new Error("missing_dingtalk_credentials");

  const channel = new DingTalkChannel({ clientId, clientSecret });
  await channel.start(async (message: {
    id: string;
    threadId: string;
    actorId: string;
    text: string;
  }) => {
    const result = await runtime.employee.answer({
      requestId: message.id,
      sessionId: message.threadId,
      actorId: message.actorId,
      message: message.text,
      metadata: { channel: "dingtalk" }
    });
    await channel.reply(message, result);
  });
}

async function start(values: CommandValues) {
  const runtime = await createRuntime(values.config);
  const channel = values.channel || runtime.config.channel?.type || "console";
  if (channel === "console") return startConsole(runtime);
  if (channel === "dingtalk") return startDingTalk(runtime);
  throw new TypeError(`unsupported_channel:${channel}`);
}

async function serve(values: CommandValues) {
  const runtime = await createRuntime(values.config);
  const port = Number.parseInt(values.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("invalid_port");
  const tokenEnv = runtime.config.server?.apiTokenEnv;
  const token = tokenEnv ? process.env[tokenEnv] : undefined;
  if (tokenEnv && !token) throw new Error(`missing_server_token:${tokenEnv}`);
  const server = createHttpServer({
    employee: runtime.employee,
    token,
    health: () => ({
      status: "ok",
      employee: runtime.profile.id,
      documents: runtime.documents.length
    })
  });
  server.listen(port, values.host, () => {
    process.stdout.write(`Digital employee listening on http://${values.host}:${port}\n`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function main() {
  const { command, values, positionals } = parseCommand(process.argv.slice(2));
  if (values.help || command === "help") {
    process.stdout.write(usage());
    return;
  }
  if (command === "ask") return ask(values, positionals);
  if (command === "sync") return sync(values);
  if (command === "start") return start(values);
  if (command === "serve") return serve(values);
  throw new TypeError(`unknown_command:${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unexpected_error";
  process.stderr.write(`digital-employee: ${message}\n`);
  process.exitCode = 1;
});
