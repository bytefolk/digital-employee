#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const BLOCKED = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  {
    name: "GitHub token",
    pattern:
      /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/
  },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    name: "Alibaba Cloud access key",
    pattern: /\bLTAI[0-9A-Za-z]{12,30}\b/
  },
  {
    name: "signed object-storage URL",
    pattern: /[?&](?:OSSAccessKeyId|X-Amz-Credential|X-Amz-Signature|x-oss-signature)=/i
  },
  {
    name: "OpenAI or Anthropic API key",
    pattern: /\bsk-(?:(?:proj|ant)-)?[A-Za-z0-9_-]{20,}\b/
  },
  {
    name: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/
  },
  {
    name: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/
  },
  {
    name: "live service API key",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/
  },
  {
    name: "common service access token",
    pattern: /\b(?:glpat-|npm_|hf_)[A-Za-z0-9_-]{20,}\b/
  },
  {
    name: "assigned secret value",
    pattern:
      /["'`]?\b(?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|secret[-_]?key|aws[-_]?secret[-_]?access[-_]?key)\b["'`]?\s*[:=]\s*["'`]?[A-Za-z0-9._~+/=-]{20,}["'`]?/i
  },
  { name: "absolute macOS user path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { name: "absolute Linux home path", pattern: /\/home\/[A-Za-z0-9._-]+\// },
  {
    name: "internal domain",
    pattern: /\b[a-z0-9.-]+\.(?:corp|internal|intranet)\b/i
  },
  {
    name: "enterprise-internal URL",
    pattern:
      /https?:\/\/[^\s"'`]*(?:alibaba-inc\.com|alibaba\.net|taobao\.net|aliyun-inc\.com|dingtalk\.net)\b/i
  },
  { name: "private chat-derived knowledge", pattern: /\bcommunity-kb(?:\.json)?\b/i }
];

const PUBLIC_BINARY_ALLOWLIST = new Set([
  "docs/assets/demo-answer.png",
  "docs/assets/demo-knowledge-cases.png",
  "docs/assets/dws-community-qr.png",
  "docs/assets/test-results.png"
]);

const PUBLIC_BINARY_PATTERN =
  /^docs\/assets\/.+\.(?:avif|gif|jpe?g|png|webp)$/i;

const filesResult = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" }
);
if (filesResult.status !== 0) {
  process.stderr.write("security-check: unable to enumerate repository files\n");
  process.exit(2);
}

const findings = [];
for (const file of filesResult.stdout.split("\0").filter(Boolean)) {
  if (file === "package-lock.json" || file === "scripts/security-check.js") continue;
  if (PUBLIC_BINARY_PATTERN.test(file) && !PUBLIC_BINARY_ALLOWLIST.has(file)) {
    findings.push(`${file}: blocked unreviewed public binary asset`);
    continue;
  }
  let buffer;
  try {
    buffer = await readFile(file);
  } catch {
    continue;
  }
  if (buffer.length > 5 * 1024 * 1024) {
    findings.push(`${file}: file exceeds the 5 MiB public-source limit`);
    continue;
  }
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  for (const rule of BLOCKED) {
    if (rule.pattern.test(text)) findings.push(`${file}: blocked ${rule.name}`);
  }
}

if (findings.length) {
  process.stderr.write(`security-check failed:\n${findings.map((item) => `- ${item}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("security-check passed\n");
