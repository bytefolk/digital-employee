import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface ChannelMessage {
  id: string
  threadId: string
  actorId?: string
  text: string
  channel: string
}
interface ChannelResult {
  answer?: string | null
  escalation?: { message?: string } | null
  citations?: unknown[]
}

export class ConsoleChannel {
  input: Readable & { isTTY?: boolean }
  output: Writable
  prompt: string
  interface: Interface | null

  constructor({
    input = process.stdin,
    output = process.stdout,
    prompt = "> "
  }: {
    input?: Readable & { isTTY?: boolean }
    output?: Writable
    prompt?: string
  } = {}) {
    this.input = input;
    this.output = output;
    this.prompt = prompt;
    this.interface = null;
  }

  async start(handler: (message: ChannelMessage) => unknown | Promise<unknown>) {
    if (typeof handler !== "function") throw new TypeError("console_channel_requires_handler");
    this.interface = createInterface({
      input: this.input,
      output: this.output,
      terminal: Boolean(this.input.isTTY)
    });

    this.output.write("Digital employee is ready. Type a question or /quit.\n");
    if (this.input.isTTY) this.interface.setPrompt(this.prompt);
    this.interface.prompt();

    for await (const line of this.interface) {
      const question = String(line).trim();
      if (!question) {
        this.interface.prompt();
        continue;
      }
      if (question === "/quit" || question === "/exit") break;

      const rawResult = await handler({
        id: `console-${Date.now()}`,
        threadId: "console",
        text: question,
        channel: "console"
      });
      const result = rawResult && typeof rawResult === "object" && !Array.isArray(rawResult)
        ? rawResult as ChannelResult
        : {};
      const answer = typeof result.answer === "string" ? result.answer : null;
      const escalationMessage =
        result.escalation && typeof result.escalation.message === "string"
          ? result.escalation.message
          : null;
      this.output.write(`${answer || escalationMessage || "No answer"}\n`);
      for (const citation of result.citations || []) {
        if (!citation || typeof citation !== "object" || Array.isArray(citation)) continue;
        const value = citation as Record<string, unknown>;
        const label = typeof value.title === "string"
          ? value.title
          : typeof value.id === "string"
            ? value.id
            : "approved source";
        const uri = typeof value.uri === "string" ? value.uri : "approved source";
        this.output.write(`- ${label}: ${uri}\n`);
      }
      this.interface.prompt();
    }
    await this.stop();
  }

  async stop() {
    this.interface?.close();
    this.interface = null;
  }
}
