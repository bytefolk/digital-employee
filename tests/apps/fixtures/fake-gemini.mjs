#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises"

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

if (args.includes("--version")) {
  process.stdout.write("gemini 0.fixture\n")
  process.exit(0)
}

const mode = option("--fixture-mode") || "success"
const capture = option("--capture")
if (mode === "hang") setInterval(() => {}, 1_000)
if (capture) {
  const policy = option("--admin-policy")
  await writeFile(capture, JSON.stringify({
    args,
    cwd: process.cwd(),
    home: process.env.HOME,
    apiKey: process.env.GEMINI_API_KEY,
    secretPresent: Boolean(process.env.SECRET_SHOULD_NOT_PASS),
    policy: policy ? await readFile(`${policy}/digital-employee.toml`, "utf8") : undefined,
  }))
}
if (mode === "invalid-json") process.stdout.write("not-json")
else if (mode === "error") process.stdout.write(JSON.stringify({ error: { message: "fixture error" } }))
else if (mode === "bad-schema") process.stdout.write(JSON.stringify({ response: "not json" }))
else process.stdout.write(JSON.stringify({ response: '{"status":"answered","answer":"fixture answer","citations":[]}', stats: {} }))
