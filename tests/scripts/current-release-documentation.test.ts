import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

test("current-facing release documentation follows the root package version", async () => {
  const manifest = JSON.parse(
    await readRepositoryFile("package.json")
  ) as { version?: unknown };
  const version = manifest.version;
  assert.ok(typeof version === "string");
  assert.match(version, /^\d+\.\d+\.\d+$/);

  const requiredMarkers: Record<string, string[]> = {
    "AGENTS.md": [
      `Quick start (public npm ${version})`,
      `@fullstack-ai-infra/digital-employee@${version}`,
      `current public npm version is \`${version}\``
    ],
    "INSTALL.md": [
      `current public npm release is \`${version}\``,
      `@fullstack-ai-infra/digital-employee@${version}`
    ],
    "README.md": [
      `The tagged \`${version}\` release is public`,
      `@fullstack-ai-infra/digital-employee@${version}`,
      `@fullstack-ai-infra/digital-employee-core@${version}`,
      `ghcr.io/fullstack-ai-infra/digital-employee:${version}`,
      `releases/tag/v${version}`
    ],
    "README.zh-CN.md": [
      `标签版本 \`${version}\` 已通过`,
      `@fullstack-ai-infra/digital-employee@${version}`,
      `@fullstack-ai-infra/digital-employee-core@${version}`,
      `ghcr.io/fullstack-ai-infra/digital-employee:${version}`,
      `releases/tag/v${version}`
    ],
    "docs/verification.md": [
      `\`${version}\` is the current tagged release`
    ],
    "docs/strategy.md": [
      `install the public \`${version}\` release`
    ],
    "docs/strategy.zh-CN.md": [
      `安装公开的 \`${version}\` 版本`
    ],
    "docs/roadmap.md": [
      `current public \`${version}\``
    ],
    "docs/roadmap.zh-CN.md": [
      `当前公开 \`${version}\``
    ],
    "docs/delegation.md": [
      `current public npm \`${version}\` package`
    ],
    "docs/employee-package.md": [
      `current published \`${version}\` npm package`
    ],
    "docs/memory-port.md": [
      `current public \`${version}\` engine preview`,
      `public \`${version}\` engine preview`
    ],
    "packages/core/README.md": [
      `current public \`${version}\` engine preview`,
      "`EngineMemoryOptions` / `TurnExecutorOptions.memory`",
      "`enabled` is exactly `true`",
      "remains disabled by default"
    ]
  };

  for (const [relativePath, markers] of Object.entries(requiredMarkers)) {
    const content = await readRepositoryFile(relativePath);
    const normalizedContent = content.replace(/\s+/g, " ");
    for (const marker of markers) {
      const normalizedMarker = marker.replace(/\s+/g, " ");
      assert.ok(
        normalizedContent.includes(normalizedMarker),
        `${relativePath} is missing: ${normalizedMarker}`
      );
    }
  }

  const currentClaimPatterns: Record<string, RegExp[]> = {
    "AGENTS.md": [
      /Quick start \(public npm (\d+\.\d+\.\d+)\)/g,
      /current public npm version is `(\d+\.\d+\.\d+)`/g
    ],
    "INSTALL.md": [
      /current public npm release is `(\d+\.\d+\.\d+)`/g
    ],
    "README.md": [
      /(?:the )?current(?: public(?: npm)?)? `(\d+\.\d+\.\d+)`/gi,
      /The tagged `(\d+\.\d+\.\d+)` release is public/g
    ],
    "README.zh-CN.md": [
      /当前(?:公开 )?`(\d+\.\d+\.\d+)`/g,
      /标签版本 `(\d+\.\d+\.\d+)` 已通过/g
    ],
    "docs/verification.md": [
      /Public\s+`(\d+\.\d+\.\d+)` is the current tagged release/g
    ],
    "docs/strategy.md": [
      /install the public `(\d+\.\d+\.\d+)` release/g,
      /(?:the )?current(?: public(?: npm)?)? `(\d+\.\d+\.\d+)`/gi
    ],
    "docs/strategy.zh-CN.md": [
      /安装公开的 `(\d+\.\d+\.\d+)` 版本/g,
      /当前(?:公开 |根包 )?`(\d+\.\d+\.\d+)`/g
    ],
    "docs/roadmap.md": [
      /(?:the )?current(?: public(?: npm)?)? `(\d+\.\d+\.\d+)`/gi
    ],
    "docs/roadmap.zh-CN.md": [
      /当前(?:公开 )?`(\d+\.\d+\.\d+)`/g
    ],
    "docs/delegation.md": [
      /current public npm `(\d+\.\d+\.\d+)` package/g
    ],
    "docs/employee-package.md": [
      /current published `(\d+\.\d+\.\d+)` npm package/g
    ],
    "docs/memory-port.md": [
      /current public `(\d+\.\d+\.\d+)`\s+engine preview/g,
      /public `(\d+\.\d+\.\d+)`\s+engine preview/g
    ],
    "packages/core/README.md": [
      /current public `(\d+\.\d+\.\d+)`\s+engine preview/g
    ]
  };

  for (const [relativePath, patterns] of Object.entries(currentClaimPatterns)) {
    const content = await readRepositoryFile(relativePath);
    for (const pattern of patterns) {
      const claims = [...content.matchAll(pattern)];
      assert.ok(claims.length > 0, `${relativePath} has no claim matching ${pattern}`);
      for (const claim of claims) {
        assert.equal(
          claim[1],
          version,
          `${relativePath} has stale current-version claim: ${claim[0]}`
        );
      }
    }
  }

  const forbiddenStaleMarkers: Record<string, string[]> = {
    "README.zh-CN.md": [
      "该切片尚未接入执行引擎"
    ],
    "docs/memory-port.md": [
      "This slice does **not** enable memory in the execution engine",
      "this release deliberately leaves it unattached to the execution engine"
    ],
    "packages/core/README.md": [
      "engine-detached `MemoryPort`",
      "is not enabled by constructing the execution engine"
    ]
  };

  for (const [relativePath, markers] of Object.entries(forbiddenStaleMarkers)) {
    const content = (await readRepositoryFile(relativePath)).replace(/\s+/g, " ");
    for (const marker of markers) {
      assert.ok(
        !content.includes(marker),
        `${relativePath} retains stale release guidance: ${marker}`
      );
    }
  }
});

test("current-version alignment preserves named historical release evidence", async () => {
  const requiredHistoricalMarkers: Record<string, string[]> = {
    "CHANGELOG.md": [
      "## [0.5.0] - 2026-08-26",
      "## [0.4.0] - 2026-08-16"
    ],
    "docs/community/install-notes.md": [
      "2026-08-21 — WSL2 Ubuntu 26.04, npm 0.4.0",
      "@fullstack-ai-infra/digital-employee@0.4.0"
    ],
    "docs/deploy.md": [
      "first shipped in\nthe tagged `0.4.0` release"
    ],
    "docs/employee-package.md": [
      "Packages without an `identity` segment validate exactly as in\n0.4.0."
    ],
    "README.zh-CN.md": [
      "最初随 `0.4.0` 发布"
    ]
  };

  for (const [relativePath, markers] of Object.entries(requiredHistoricalMarkers)) {
    const content = (await readRepositoryFile(relativePath)).replace(/\s+/g, " ");
    for (const marker of markers) {
      const normalizedMarker = marker.replace(/\s+/g, " ");
      assert.ok(
        content.includes(normalizedMarker),
        `${relativePath} lost historical evidence: ${normalizedMarker}`
      );
    }
  }
});
