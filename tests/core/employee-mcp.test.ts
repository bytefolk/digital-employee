import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Ajv2020 } from "ajv/dist/2020.js"

import { validateEmployeeMcpManifest } from "../../packages/core/index.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

test("public MCP Schema compiles and accepts the portable transport shape", async () => {
  const schema = JSON.parse(
    await readFile(path.join(root, "configs", "employee-mcp.schema.json"), "utf8"),
  )
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
  const input = {
    schemaVersion: "employee-mcp.v1alpha1",
    servers: [
      {
        name: "documents",
        transport: {
          type: "stdio",
          command: "document-mcp",
          environment: ["DOCUMENT_MCP_TOKEN"],
        },
      },
    ],
  }
  assert.equal(validate(input), true, JSON.stringify(validate.errors))
  assert.doesNotThrow(() => validateEmployeeMcpManifest(input))
})

test("portable MCP declaration supports stdio and HTTPS without secret values", () => {
  const result = validateEmployeeMcpManifest({
    schemaVersion: "employee-mcp.v1alpha1",
    servers: [
      {
        name: "documents",
        transport: {
          type: "stdio",
          command: "document-mcp",
          args: ["serve"],
          environment: ["DOCUMENT_MCP_TOKEN"],
        },
      },
      {
        name: "drive",
        transport: {
          type: "http",
          url: "https://mcp.example.test/v1",
          headers: [
            { name: "Authorization", valueFromEnv: "DRIVE_MCP_AUTH" },
          ],
        },
      },
    ],
  })
  assert.equal(result.servers.length, 2)
  assert.equal(result.servers[1]?.transport.type, "http")
})

test("portable MCP declaration rejects inline auth and insecure HTTP", () => {
  assert.throws(
    () =>
      validateEmployeeMcpManifest({
        schemaVersion: "employee-mcp.v1alpha1",
        servers: [
          {
            name: "drive",
            transport: {
              type: "http",
              url: "http://example.test",
              headers: [{ name: "Authorization", value: "inline" }],
            },
          },
        ],
      }),
    /employee_mcp_unknown_field|employee_mcp_invalid_field/,
  )
})

test("portable MCP declaration rejects duplicate server identities", () => {
  assert.throws(
    () =>
      validateEmployeeMcpManifest({
        schemaVersion: "employee-mcp.v1alpha1",
        servers: [
          { name: "docs", transport: { type: "stdio", command: "one" } },
          { name: "docs", transport: { type: "stdio", command: "two" } },
        ],
      }),
    /employee_mcp_duplicate_server_name/,
  )
})
