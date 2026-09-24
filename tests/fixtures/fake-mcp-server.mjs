#!/usr/bin/env node
import { createInterface } from "node:readline"

const tools = (process.env.FAKE_MCP_TOOLS ?? "Read")
  .split(",")
  .filter(Boolean)
  .map((name) => ({ name }))

const rl = createInterface({ input: process.stdin })
rl.on("line", (line) => {
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  if (parsed.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "0" } } })}\n`,
    )
  }
  if (parsed.method === "tools/list") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { tools } })}\n`,
    )
  }
})
