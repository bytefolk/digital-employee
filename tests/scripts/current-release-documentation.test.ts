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

test("release documentation separates static artifacts from verified availability", async () => {
  const manifest = JSON.parse(
    await readRepositoryFile("package.json")
  ) as { version?: unknown };
  const sourceVersion = manifest.version;
  assert.ok(typeof sourceVersion === "string");
  assert.match(sourceVersion, /^\d+\.\d+\.\d+$/);

  const recordedPublicVersion = "0.6.0";
  const currentFacingSurfaces = [
    "AGENTS.md",
    "INSTALL.md",
    "README.md",
    "README.zh-CN.md",
    "docs/verification.md",
    "docs/strategy.md",
    "docs/strategy.zh-CN.md",
    "docs/roadmap.md",
    "docs/roadmap.zh-CN.md",
    "docs/delegation.md",
    "docs/employee-package.md",
    "docs/memory-port.md",
    "packages/core/README.md"
  ];
  const releaseEvidenceMarkers: Record<string, string[]> = Object.fromEntries(
    currentFacingSurfaces.map((relativePath) => [relativePath, ["release receipt"]])
  );
  const installGuidance: Record<
    string,
    {
      sourceInstall: string;
      receiptCondition: string;
      fallbackInstall: string;
      fallbackCondition: string;
    }
  > = {
    "AGENTS.md": {
      sourceInstall: `npm install @fullstack-ai-infra/digital-employee@${sourceVersion}`,
      receiptCondition: `If the release receipt verifies \`${sourceVersion}\` on npm`,
      fallbackInstall: `npm install @fullstack-ai-infra/digital-employee@${recordedPublicVersion}`,
      fallbackCondition: `Otherwise, use the recorded public \`${recordedPublicVersion}\` fallback`
    },
    "INSTALL.md": {
      sourceInstall: `npm install @fullstack-ai-infra/digital-employee@${sourceVersion}`,
      receiptCondition: `If the release receipt verifies \`${sourceVersion}\` on npm`,
      fallbackInstall: `npm install @fullstack-ai-infra/digital-employee@${recordedPublicVersion}`,
      fallbackCondition: `Otherwise, use the recorded public \`${recordedPublicVersion}\` fallback`
    },
    "README.md": {
      sourceInstall: `npm install @fullstack-ai-infra/digital-employee@${sourceVersion}`,
      receiptCondition: `If the release receipt verifies \`${sourceVersion}\` on npm`,
      fallbackInstall: `npm install @fullstack-ai-infra/digital-employee@${recordedPublicVersion}`,
      fallbackCondition: `Otherwise, use the recorded public \`${recordedPublicVersion}\` fallback`
    },
    "README.zh-CN.md": {
      sourceInstall: `npm install @fullstack-ai-infra/digital-employee@${sourceVersion}`,
      receiptCondition: `如果 release receipt 验证 npm 中的 \`${sourceVersion}\``,
      fallbackInstall: `npm install @fullstack-ai-infra/digital-employee@${recordedPublicVersion}`,
      fallbackCondition: `否则使用已记录公开的 \`${recordedPublicVersion}\` fallback`
    },
    "packages/core/README.md": {
      sourceInstall: `npm install @fullstack-ai-infra/digital-employee-core@${sourceVersion}`,
      receiptCondition: `If the release receipt verifies \`${sourceVersion}\` on npm`,
      fallbackInstall: `npm install @fullstack-ai-infra/digital-employee-core@${recordedPublicVersion}`,
      fallbackCondition: `Otherwise, use the recorded public \`${recordedPublicVersion}\` fallback`
    }
  };
  const sourceInstallCommands = [
    `npm install @fullstack-ai-infra/digital-employee@${sourceVersion}`,
    `npm install @fullstack-ai-infra/digital-employee-core@${sourceVersion}`
  ];
  const forbiddenArtifactMarkers = [
    `ghcr.io/bytefolk/digital-employee:${sourceVersion}`,
    `releases/tag/v${sourceVersion}`,
    `current public npm version is \`${sourceVersion}\``,
    `current public npm release is \`${sourceVersion}\``,
    `The tagged \`${sourceVersion}\` release is public`,
    `标签版本 \`${sourceVersion}\` 已通过`,
    `current published \`${sourceVersion}\` npm package`
  ];

  for (const relativePath of currentFacingSurfaces) {
    const content = await readRepositoryFile(relativePath);
    const normalizedContent = content.replace(/\s+/g, " ");
    assert.ok(
      normalizedContent.includes(recordedPublicVersion),
      `${relativePath} must retain recorded public ${recordedPublicVersion} evidence`
    );
    assert.ok(
      normalizedContent.includes(sourceVersion),
      `${relativePath} must name source package version ${sourceVersion}`
    );
    for (const marker of releaseEvidenceMarkers[relativePath]) {
      const normalizedMarker = marker.replace(/\s+/g, " ");
      assert.ok(
        normalizedContent.includes(normalizedMarker),
        `${relativePath} is missing release-evidence boundary: ${normalizedMarker}`
      );
    }
    const guidance = installGuidance[relativePath];
    for (const sourceInstall of sourceInstallCommands) {
      assert.equal(
        content.includes(sourceInstall),
        guidance?.sourceInstall === sourceInstall,
        `${relativePath} must only contain its receipt-conditioned source install command`
      );
    }
    if (guidance) {
      const receiptCondition = guidance.receiptCondition.replace(/\s+/g, " ");
      const fallbackCondition = guidance.fallbackCondition.replace(/\s+/g, " ");
      assert.ok(
        normalizedContent.includes(receiptCondition),
        `${relativePath} is missing its receipt condition for the source install`
      );
      assert.ok(
        normalizedContent.includes(guidance.sourceInstall),
        `${relativePath} is missing its source-version install command`
      );
      assert.ok(
        normalizedContent.includes(fallbackCondition),
        `${relativePath} is missing its recorded-public fallback condition`
      );
      assert.ok(
        normalizedContent.includes(guidance.fallbackInstall),
        `${relativePath} is missing its recorded-public fallback install command`
      );
      assert.ok(
        normalizedContent.indexOf(receiptCondition) < normalizedContent.indexOf(guidance.sourceInstall),
        `${relativePath} must condition the source install on the receipt`
      );
      assert.ok(
        normalizedContent.indexOf(fallbackCondition) < normalizedContent.indexOf(guidance.fallbackInstall),
        `${relativePath} must condition the fallback install on the absence of that receipt`
      );
    }
    for (const forbiddenMarker of forbiddenArtifactMarkers) {
      assert.ok(
        !content.includes(forbiddenMarker),
        `${relativePath} falsely advertises unverified artifact: ${forbiddenMarker}`
      );
    }
    assert.doesNotMatch(
      content,
      /(?:current public(?: npm)?|current published)\s+`?0\.6\.0`?|当前(?:公开 )?`0\.6\.0`/i,
      `${relativePath} conflates the recorded public release with current source`
    );
    assert.doesNotMatch(
      content,
      /release-preparation candidate|发布前候选|源码候选/i,
      `${relativePath} has a time-bound claim that would stale after publication`
    );
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

test("release documentation preserves named historical release evidence", async () => {
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
