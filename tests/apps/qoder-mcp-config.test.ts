import assert from "node:assert/strict"
import test from "node:test"

import { buildQoderMcpConfig, QoderMcpConfigError } from "../../apps/cli/qoder-mcp-config.js"
import type { AgentHostMcpServer } from "../../packages/core/index.js"

test("empty server list yields an empty qoder mcp-config payload", () => {
  const result = buildQoderMcpConfig(undefined)
  assert.equal(result.json, '{"mcpServers":{}}\n')
  assert.deepEqual(result.serverNames, [])
})

test("stdio servers are translated with args and env references, not secrets", () => {
  const servers: AgentHostMcpServer[] = [
    {
      name: "playwright",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
    },
    {
      name: "search",
      transport: "stdio",
      command: "search-mcp",
      environment: ["SEARCH_API_KEY"],
    },
  ]
  const result = buildQoderMcpConfig(servers)
  const parsed = JSON.parse(result.json)
  assert.deepEqual(result.serverNames, ["playwright", "search"])
  assert.deepEqual(parsed.mcpServers.playwright, {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
  })
  assert.deepEqual(parsed.mcpServers.search, {
    command: "search-mcp",
    env: { SEARCH_API_KEY: "${SEARCH_API_KEY}" },
  })
  // The literal secret value must never appear inside the emitted payload.
  assert.equal(result.json.includes("SEARCH_API_KEY") === false, false)
  assert.equal(JSON.stringify(parsed).includes("not-a-secret"), false)
})

test("control characters and empty strings are rejected in commands and args", () => {
  for (const servers of [
    [{ name: "bad", transport: "stdio", command: "a\tb" }],
    [{ name: "bad", transport: "stdio", command: "ok", args: ["a\nb"] }],
    [{ name: "bad", transport: "stdio", command: "ok", args: ["\x00"] }],
    [{ name: "bad", transport: "stdio", command: "ok", args: [""] }],
  ] as unknown as AgentHostMcpServer[][]) {
    assert.throws(
      () => buildQoderMcpConfig(servers),
      (error) =>
        error instanceof QoderMcpConfigError &&
        /qoder_mcp_invalid_field/.test(error.code),
    )
  }
})

test("scoped package names are accepted as args", () => {
  const result = buildQoderMcpConfig([
    {
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    },
  ])
  const parsed = JSON.parse(result.json)
  assert.deepEqual(parsed.mcpServers.filesystem, {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
  })
})

test("high-sensitivity environment names are denied", () => {
  for (const name of [
    "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN",
    "QODER_PERSONAL_ACCESS_TOKEN",
  ]) {
    assert.throws(
      () =>
        buildQoderMcpConfig([
          {
            name: "bad",
            transport: "stdio",
            command: "x",
            environment: [name],
          },
        ]),
      (error) =>
        error instanceof QoderMcpConfigError &&
        error.code === "qoder_mcp_invalid_field:servers[0].environment",
    )
  }
})

test("duplicate server names fail closed", () => {
  const servers: AgentHostMcpServer[] = [
    { name: "dup", transport: "stdio", command: "a" },
    { name: "dup", transport: "stdio", command: "b" },
  ]
  assert.throws(
    () => buildQoderMcpConfig(servers),
    (error) =>
      error instanceof QoderMcpConfigError &&
      error.code === "qoder_mcp_duplicate_server_name:dup",
  )
})

test("http transport is rejected until network policy is decided", () => {
  const servers: AgentHostMcpServer[] = [
    { name: "remote", transport: "http", url: "https://mcp.example.test" },
  ]
  assert.throws(
    () => buildQoderMcpConfig(servers),
    (error) =>
      error instanceof QoderMcpConfigError &&
      error.code === "qoder_mcp_http_transport_unsupported:remote",
  )
})

test("malformed names and commands fail closed", () => {
  for (const servers of [
    [{ name: "Bad Name", transport: "stdio", command: "a" }],
    [{ name: "ok", transport: "stdio", command: "" }],
    [{ name: "ok", transport: "stdio", command: "ok", args: [""] }],
  ] as unknown as AgentHostMcpServer[][]) {
    assert.throws(
      () => buildQoderMcpConfig(servers),
      (error) => error instanceof QoderMcpConfigError,
    )
  }
})

test("oversized server lists fail closed", () => {
  const servers: AgentHostMcpServer[] = Array.from({ length: 17 }, (_, i) => ({
    name: `s${i}`,
    transport: "stdio",
    command: "a",
  }))
  assert.throws(
    () => buildQoderMcpConfig(servers),
    (error) =>
      error instanceof QoderMcpConfigError &&
      error.code === "qoder_mcp_too_many_servers",
  )
})