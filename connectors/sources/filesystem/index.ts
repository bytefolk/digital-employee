import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const DEFAULT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".json"]);
const SENSITIVE_NAMES = [
  /^\.env(?:\.|$)/i,
  /(?:^|[._-])(secrets?|tokens?|credentials?|passwords?)(?:[._-]|$)/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /(?:^|[._-])private[._-]?key(?:[._-]|$)/i
];

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
}

function normalizeExtensions(values?: unknown[]): Set<string> {
  const source = Array.isArray(values) && values.length ? values : [...DEFAULT_EXTENSIONS];
  return new Set(
    source.map((value) => {
      const extension = String(value).toLowerCase();
      return extension.startsWith(".") ? extension : `.${extension}`;
    })
  );
}

function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAMES.some((pattern) => pattern.test(name));
}

function isHiddenSegment(relativePath: string): boolean {
  return relativePath.split(path.sep).some((segment) => segment.startsWith("."));
}

function titleFromText(text: string, fallback: string): string {
  const heading = text.match(/^\s*#\s+(.+?)\s*$/m);
  return heading?.[1]?.trim() || fallback;
}

export function chunkText(
  text: unknown,
  { maxChars = 1800, overlapChars = 180 }: { maxChars?: number; overlapChars?: number } = {},
): string[] {
  const normalized = String(text).replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const chunks = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    let end = Math.min(normalized.length, cursor + maxChars);
    if (end < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf("\n\n", end);
      const lineBreak = normalized.lastIndexOf("\n", end);
      const candidate = Math.max(paragraphBreak, lineBreak);
      if (candidate > cursor + Math.floor(maxChars * 0.55)) end = candidate;
    }

    const chunk = normalized.slice(cursor, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    cursor = Math.max(cursor + 1, end - overlapChars);
  }
  return chunks;
}

interface CollectedFile { absolute: string; relative: string }
interface CollectionOptions { maxDepth: number; maxFiles: number; extensions: Set<string> }
async function collectFiles(
  root: string,
  options: CollectionOptions,
  directory = root,
  depth = 0,
  output: CollectedFile[] = [],
): Promise<CollectedFile[]> {
  if (depth > options.maxDepth || output.length >= options.maxFiles) return output;
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (output.length >= options.maxFiles) break;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute);

    if (!relative || isHiddenSegment(relative) || isSensitiveName(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await collectFiles(root, options, absolute, depth + 1, output);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!options.extensions.has(path.extname(entry.name).toLowerCase())) continue;
    output.push({ absolute, relative });
  }
  return output;
}

function sourceUri(sourceId: string, relativePath: string, publicBaseUrl?: string): string {
  const normalized = relativePath.split(path.sep).join("/");
  if (publicBaseUrl) {
    const base = new URL(publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`);
    return new URL(normalized.split("/").map(encodeURIComponent).join("/"), base).toString();
  }
  return `source://${encodeURIComponent(sourceId)}/${normalized
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export class FileSystemSource {
  id: string
  root: string
  publicBaseUrl?: string
  options: CollectionOptions & {
    maxFileBytes: number
    chunkChars: number
    overlapChars: number
  }

  constructor({
    id,
    root,
    include,
    publicBaseUrl,
    maxDepth = 8,
    maxFiles = 2_000,
    maxFileBytes = 2 * 1024 * 1024,
    chunkChars = 1_800,
    overlapChars = 180
  }: {
    id: string
    root: string
    include?: unknown[]
    publicBaseUrl?: string
    maxDepth?: number
    maxFiles?: number
    maxFileBytes?: number
    chunkChars?: number
    overlapChars?: number
  }) {
    if (!id || !root) throw new TypeError("filesystem_source_requires_id_and_root");
    this.id = String(id);
    this.root = path.resolve(root);
    this.publicBaseUrl = publicBaseUrl;
    this.options = {
      extensions: normalizeExtensions(include),
      maxDepth,
      maxFiles,
      maxFileBytes,
      chunkChars,
      overlapChars
    };
  }

  async load(): Promise<unknown[]> {
    const root = await realpath(this.root);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) throw new TypeError("filesystem_source_root_must_be_directory");

    const files = await collectFiles(root, this.options);
    const documents: unknown[] = [];

    for (const file of files) {
      const stat = await lstat(file.absolute);
      if (!stat.isFile() || stat.size > this.options.maxFileBytes) continue;

      const resolved = await realpath(file.absolute);
      const relativeResolved = path.relative(root, resolved);
      if (
        relativeResolved.startsWith(`..${path.sep}`) ||
        relativeResolved === ".." ||
        path.isAbsolute(relativeResolved)
      ) {
        continue;
      }

      const content = await readFile(resolved, "utf8");
      const title = titleFromText(content, path.basename(file.relative));
      const chunks = chunkText(content, {
        maxChars: this.options.chunkChars,
        overlapChars: this.options.overlapChars
      });

      chunks.forEach((text, index) => {
        const uri = sourceUri(this.id, file.relative, this.publicBaseUrl);
        documents.push({
          id: stableId(this.id, file.relative, String(index), text),
          title,
          text,
          source: {
            type: "filesystem",
            id: this.id,
            uri,
            updatedAt: stat.mtime.toISOString()
          },
          metadata: {
            path: file.relative.split(path.sep).join("/"),
            chunk: index + 1,
            chunks: chunks.length
          }
        });
      });
    }
    return documents;
  }
}
