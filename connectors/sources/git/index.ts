import { createHash, randomBytes } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { FileSystemSource } from "../filesystem/index.js";

export type GitSourcePolicy = "require_fresh" | "prefer_last_known_good";
export type GitSourceStatus = "fresh" | "degraded" | "unavailable";

/** Inclusive bounds for the opt-in last-known-good service age (ms). */
export const LKG_MAX_STALE_MS_BOUNDS = Object.freeze([1_000, 604_800_000] as const);

const MANIFEST_SCHEMA_VERSION = 1;
const ACTIVE_SCHEMA_VERSION = 1;
const ACTIVE_FILE = "active.json";
const GENERATIONS_DIR = "generations";
const MANIFEST_FILE = "manifest.json";
const CONTENT_DIR = "content";
const MAX_MANIFEST_BYTES = 16_384;
const MAX_ACTIVE_BYTES = 4_096;
const GENERATION_ID_PATTERN = /^[0-9a-f]{12}-\d{13}-[0-9a-f]{8}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

const DEFAULT_EXTENSIONS = [".md", ".mdx", ".txt", ".json"];
const SENSITIVE_NAMES = [
  /^\.env(?:\.|$)/i,
  /(?:^|[._-])(secrets?|tokens?|credentials?|passwords?)(?:[._-]|$)/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /(?:^|[._-])private[._-]?key(?:[._-]|$)/i
];

interface GenerationManifest {
  schemaVersion: number
  policy: GitSourcePolicy
  remote: string
  ref: string
  commit: string
  subdirectory: string
  include: string[] | null
  contentSha256: string
  refreshedAt: string
}

interface SelectionOptions {
  extensions: Set<string>
  maxDepth: number
  maxFiles: number
  maxFileBytes: number
}

interface PublishedGeneration {
  id: string
  manifest: GenerationManifest
}

function cacheKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function validateRef(ref: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref)) {
    throw new TypeError("git_source_invalid_ref");
  }
  return ref;
}

function validateRemote(remote: string): string {
  const url = new URL(remote);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("git_source_requires_public_https_url_without_credentials");
  }
  return url.toString();
}

function validatePolicy(value: unknown): GitSourcePolicy {
  if (value === undefined) return "require_fresh";
  if (value === "require_fresh" || value === "prefer_last_known_good") return value;
  throw new TypeError(`git_source_invalid_policy:${String(value)}`);
}

function validateMaxStaleMs(value: unknown, policy: GitSourcePolicy): number | undefined {
  if (policy === "require_fresh") {
    if (value !== undefined) {
      throw new TypeError("git_source_max_stale_ms_requires_lkg_policy");
    }
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < LKG_MAX_STALE_MS_BOUNDS[0] ||
    value > LKG_MAX_STALE_MS_BOUNDS[1]
  ) {
    throw new TypeError(
      `git_source_lkg_max_stale_ms_out_of_bounds:${value === undefined ? "missing" : String(value)}`
    );
  }
  return value;
}

/** True when `now - refreshedAt <= maxStaleMs` and the timestamp is not future-dated. */
export function ageWithinBound(refreshedAtMs: number, nowMs: number, maxStaleMs: number): boolean {
  return (
    Number.isFinite(refreshedAtMs) &&
    Number.isFinite(nowMs) &&
    refreshedAtMs <= nowMs &&
    nowMs - refreshedAtMs <= maxStaleMs
  );
}

/** Typed remote acquisition failures originate from the git subprocess itself. */
export function isRemoteAcquisitionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /^git_source_(?:command_failed|process_failed|process_timed_out)(?::|$)/.test(
    error.message
  );
}

function normalizeInclude(include?: unknown[]): string[] {
  const source = Array.isArray(include) && include.length ? include : DEFAULT_EXTENSIONS;
  const normalized = source.map((value) => {
    const extension = String(value).toLowerCase();
    return extension.startsWith(".") ? extension : `.${extension}`;
  });
  return [...new Set(normalized)].sort();
}

function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAMES.some((pattern) => pattern.test(name));
}

function isHiddenSegment(relativePath: string): boolean {
  return relativePath.split(path.sep).some((segment) => segment.startsWith("."));
}

function selectionOptions(include?: unknown[]): SelectionOptions {
  return {
    extensions: new Set(normalizeInclude(include)),
    maxDepth: 8,
    maxFiles: 2_000,
    maxFileBytes: 2 * 1024 * 1024
  };
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (
      name === "GIT_CONFIG_PARAMETERS" ||
      /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name)
    ) {
      delete env[name];
    }
  }
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null"
  };
}

function runGit(
  args: string[],
  { cwd, timeoutMs = 60_000, maxOutputBytes = 64 * 1024 }:
    { cwd?: string; timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "credential.helper=", "-c", "core.askPass=", ...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: isolatedGitEnvironment()
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;

    const capture = (kind: "stdout" | "stderr") => (chunk: Buffer) => {
      if (bytes >= maxOutputBytes) return;
      const remaining = maxOutputBytes - bytes;
      const value = chunk.toString("utf8", 0, remaining);
      bytes += Buffer.byteLength(value);
      if (kind === "stdout") stdout += value;
      else stderr += value;
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, timeoutMs);
    timer.unref();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("git_source_process_failed", { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) {
        reject(new Error("git_source_process_timed_out"));
      } else if (code !== 0) {
        reject(new Error(`git_source_command_failed:${code}:${stderr.trim().slice(0, 240)}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rejects symlinks on every path segment below `root`. Pointer files and
 * generation directories must never be reachable through a symlink. A missing
 * segment fails closed with the supplied typed code instead of a raw path.
 */
async function assertNoSymlinkSegments(
  root: string,
  relative: string,
  missingCode: string
): Promise<void> {
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment || segment === ".") continue;
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TypeError(missingCode);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new TypeError("git_source_generation_pointer_symlink");
    }
  }
}

/**
 * Deterministically walks the selected content tree, mirroring the
 * FileSystemSource collection rules (hidden, sensitive, extension, depth,
 * count, and size filters). Any symlink inside the selected tree is rejected
 * so a generation can never smuggle content outside its root.
 */
async function collectSelectedFiles(
  root: string,
  options: SelectionOptions,
  directory = root,
  depth = 0,
  output: string[] = []
): Promise<string[]> {
  if (depth > options.maxDepth || output.length >= options.maxFiles) return output;
  const entries = await readdir(directory, { withFileTypes: true });
  // Byte-order sorting keeps the digest stable across processes and locales.
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  for (const entry of entries) {
    if (output.length >= options.maxFiles) break;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute);

    if (!relative || isHiddenSegment(relative) || isSensitiveName(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      throw new TypeError(
        `git_source_generation_symlink_rejected:${relative.split(path.sep).join("/")}`
      );
    }
    if (entry.isDirectory()) {
      await collectSelectedFiles(root, options, absolute, depth + 1, output);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!options.extensions.has(path.extname(entry.name).toLowerCase())) continue;
    output.push(relative);
  }
  return output;
}

async function computeContentDigest(
  root: string,
  files: string[],
  options: SelectionOptions
): Promise<string> {
  const hash = createHash("sha256");
  for (const relative of files) {
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    if (!stat.isFile()) {
      throw new TypeError(
        `git_source_generation_invalid_entry:${relative.split(path.sep).join("/")}`
      );
    }
    if (stat.size > options.maxFileBytes) continue;
    const content = await readFile(absolute, "utf8");
    hash.update(relative.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function parseGenerationManifest(raw: string): GenerationManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("git_source_generation_invalid_manifest");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("git_source_generation_invalid_manifest");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new TypeError("git_source_generation_unknown_schema");
  }
  for (const key of ["remote", "ref", "commit", "subdirectory", "contentSha256", "refreshedAt"]) {
    if (typeof manifest[key] !== "string") {
      throw new TypeError("git_source_generation_invalid_manifest");
    }
  }
  if (manifest.policy !== "require_fresh" && manifest.policy !== "prefer_last_known_good") {
    throw new TypeError("git_source_generation_invalid_manifest");
  }
  if (
    !Array.isArray(manifest.include) ||
    !manifest.include.every((entry) => typeof entry === "string")
  ) {
    throw new TypeError("git_source_generation_invalid_manifest");
  }
  if (!COMMIT_PATTERN.test(String(manifest.commit))) {
    throw new TypeError("git_source_generation_invalid_commit");
  }
  if (!Number.isFinite(Date.parse(String(manifest.refreshedAt)))) {
    throw new TypeError("git_source_generation_invalid_timestamp");
  }
  return manifest as unknown as GenerationManifest;
}

export class GitSource {
  id: string
  remote: string
  ref: string
  cacheDir: string
  /** Legacy in-place checkout path, retained for compatibility; never auto-promoted. */
  checkout: string
  subdirectory: string
  include?: unknown[]
  publicBaseUrl?: string
  timeoutMs?: number
  policy: GitSourcePolicy
  maxStaleMs?: number
  /** Truthful read status: fresh, degraded, or unavailable. */
  status: GitSourceStatus = "unavailable"
  #selection: SelectionOptions
  #activeGeneration: PublishedGeneration | null = null

  constructor({
    id,
    remote,
    ref = "main",
    cacheDir = ".cache/git",
    subdirectory = ".",
    include,
    publicBaseUrl,
    timeoutMs,
    policy,
    maxStaleMs
  }: {
    id: string
    remote: string
    ref?: string
    cacheDir?: string
    subdirectory?: string
    include?: unknown[]
    publicBaseUrl?: string
    timeoutMs?: number
    policy?: GitSourcePolicy
    maxStaleMs?: number
  }) {
    if (!id || !remote) throw new TypeError("git_source_requires_id_and_remote");
    this.id = String(id);
    this.remote = validateRemote(remote);
    this.ref = validateRef(ref);
    this.cacheDir = path.resolve(cacheDir);
    this.checkout = path.join(this.cacheDir, cacheKey(`${this.remote}\0${this.ref}`));
    this.subdirectory = subdirectory;
    this.include = include;
    this.publicBaseUrl = publicBaseUrl;
    this.timeoutMs = timeoutMs;
    this.policy = validatePolicy(policy);
    this.maxStaleMs = validateMaxStaleMs(maxStaleMs, this.policy);
    this.#selection = selectionOptions(include);
  }

  /**
   * Acquires the latest checkout strictly inside a unique staging directory
   * and atomically publishes a validated immutable generation. A failure
   * never mutates the active state and always throws; it is never relabeled
   * as success. Legacy in-place checkouts are never auto-promoted.
   */
  async sync(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const stagingRoot = await mkdtemp(path.join(this.cacheDir, ".staging-"));
    try {
      const stagedCheckout = path.join(stagingRoot, "checkout");
      await runGit(
        ["clone", "--depth", "1", "--branch", this.ref, "--single-branch", "--", this.remote, stagedCheckout],
        { timeoutMs: this.timeoutMs }
      );
      const commit = (await runGit(["rev-parse", "HEAD"], {
        cwd: stagedCheckout,
        timeoutMs: this.timeoutMs
      })).trim();
      if (!COMMIT_PATTERN.test(commit)) {
        throw new TypeError("git_source_generation_invalid_commit");
      }
      const { manifest, files } = await this.#buildCandidate(stagedCheckout, commit);
      const generation = await this.#publishGeneration(stagingRoot, manifest, files);
      this.#activeGeneration = generation;
      this.status = "fresh";
    } catch (error) {
      this.status = "unavailable";
      throw error;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  /**
   * Loads approved documents. With the default strict policy any acquisition
   * failure throws. With opt-in `prefer_last_known_good` a typed remote
   * acquisition failure may serve exactly one revalidated active generation,
   * reported as `degraded`. Missing, legacy, corrupt, mismatched, symlinked,
   * traversing, future-dated, or over-age state always fails closed.
   */
  async load(): Promise<unknown[]> {
    this.status = "unavailable";
    try {
      await this.sync();
    } catch (error) {
      if (this.policy !== "prefer_last_known_good" || !isRemoteAcquisitionFailure(error)) {
        throw error;
      }
      let generation: PublishedGeneration;
      try {
        generation = await this.#revalidateActiveGeneration();
      } catch (validationError) {
        const reason =
          validationError instanceof Error ? validationError.message : "unknown";
        throw new Error(`git_source_lkg_unavailable:${reason}`, { cause: error });
      }
      this.#activeGeneration = generation;
      this.status = "degraded";
    }
    const active = this.#activeGeneration;
    if (!active) {
      throw new Error("git_source_lkg_unavailable:missing_active");
    }
    return this.#documentsFromGeneration(active);
  }

  async #buildCandidate(
    stagedCheckout: string,
    commit: string
  ): Promise<{ manifest: GenerationManifest; files: string[] }> {
    const requested = path.resolve(stagedCheckout, this.subdirectory);
    const relative = path.relative(stagedCheckout, requested);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new TypeError("git_source_subdirectory_outside_checkout");
    }
    const rootStat = await lstat(requested).catch((error: NodeJS.ErrnoException) => {
      if (error && error.code === "ENOENT") {
        throw new TypeError("git_source_generation_selection_missing");
      }
      throw error;
    });
    if (!rootStat.isDirectory()) {
      throw new TypeError("git_source_generation_selection_missing");
    }
    const files = await collectSelectedFiles(requested, this.#selection);
    const contentSha256 = await computeContentDigest(requested, files, this.#selection);
    return {
      manifest: {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        policy: this.policy,
        remote: this.remote,
        ref: this.ref,
        commit,
        subdirectory: this.subdirectory,
        include: normalizeInclude(this.include),
        contentSha256,
        refreshedAt: new Date().toISOString()
      },
      files
    };
  }

  /**
   * Assembles the immutable generation next to the staged checkout, then
   * atomically renames it into place and atomically points `active.json` at
   * it. Readers observe either a complete old generation or a complete new
   * generation, never a partial or mixed state.
   */
  async #publishGeneration(
    stagingRoot: string,
    manifest: GenerationManifest,
    files: string[]
  ): Promise<PublishedGeneration> {
    const generationsDir = path.join(this.cacheDir, GENERATIONS_DIR);
    await mkdir(generationsDir, { recursive: true, mode: 0o700 });

    const id = `${manifest.commit.slice(0, 12)}-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const built = path.join(stagingRoot, "generation");
    const contentRoot = path.join(built, CONTENT_DIR);
    const requested = path.resolve(stagingRoot, "checkout", this.subdirectory);

    for (const relative of files) {
      const source = path.join(requested, relative);
      const target = path.join(contentRoot, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
    }
    await writeFile(
      path.join(built, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 }
    );

    const finalPath = path.join(generationsDir, id);
    await rename(built, finalPath);

    const activePayload = JSON.stringify({ schemaVersion: ACTIVE_SCHEMA_VERSION, generation: id });
    const activeTmp = path.join(this.cacheDir, `.${ACTIVE_FILE}.tmp-${id}`);
    await writeFile(activeTmp, activePayload, { mode: 0o600 });
    await rename(activeTmp, path.join(this.cacheDir, ACTIVE_FILE));

    return { id, manifest };
  }

  /**
   * Full evidence revalidation before every degraded read: pointer path
   * safety, manifest schema, provenance binding (remote, ref, selection,
   * policy), commit, timestamp, age, and selected-content digest.
   */
  async #revalidateActiveGeneration(): Promise<PublishedGeneration> {
    if (this.maxStaleMs === undefined) {
      throw new TypeError("git_source_lkg_missing_bound");
    }
    const activePath = path.join(this.cacheDir, ACTIVE_FILE);
    await assertNoSymlinkSegments(
      this.cacheDir,
      ACTIVE_FILE,
      "git_source_generation_missing_active"
    );
    let rawActive: string;
    try {
      rawActive = await readFile(activePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TypeError("git_source_generation_missing_active");
      }
      throw error;
    }
    if (Buffer.byteLength(rawActive, "utf8") > MAX_ACTIVE_BYTES) {
      throw new TypeError("git_source_generation_invalid_active");
    }
    let activeValue: unknown;
    try {
      activeValue = JSON.parse(rawActive);
    } catch {
      throw new TypeError("git_source_generation_invalid_active");
    }
    if (!activeValue || typeof activeValue !== "object" || Array.isArray(activeValue)) {
      throw new TypeError("git_source_generation_invalid_active");
    }
    const active = activeValue as Record<string, unknown>;
    if (
      active.schemaVersion !== ACTIVE_SCHEMA_VERSION ||
      typeof active.generation !== "string" ||
      !GENERATION_ID_PATTERN.test(active.generation)
    ) {
      throw new TypeError("git_source_generation_invalid_id");
    }

    const generationDir = path.join(this.cacheDir, GENERATIONS_DIR, active.generation);
    const relativeToGenerations = path.relative(
      path.join(this.cacheDir, GENERATIONS_DIR),
      generationDir
    );
    if (
      relativeToGenerations === ".." ||
      relativeToGenerations.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToGenerations)
    ) {
      throw new TypeError("git_source_generation_invalid_id");
    }
    await assertNoSymlinkSegments(
      this.cacheDir,
      path.join(GENERATIONS_DIR, active.generation),
      "git_source_generation_missing"
    );

    const manifestPath = path.join(generationDir, MANIFEST_FILE);
    let rawManifest: string;
    try {
      rawManifest = await readFile(manifestPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TypeError("git_source_generation_missing_manifest");
      }
      throw error;
    }
    if (Buffer.byteLength(rawManifest, "utf8") > MAX_MANIFEST_BYTES) {
      throw new TypeError("git_source_generation_invalid_manifest");
    }
    const manifest = parseGenerationManifest(rawManifest);

    if (manifest.remote !== this.remote) {
      throw new TypeError("git_source_generation_provenance_mismatch:remote");
    }
    if (manifest.ref !== this.ref) {
      throw new TypeError("git_source_generation_provenance_mismatch:ref");
    }
    if (manifest.subdirectory !== this.subdirectory) {
      throw new TypeError("git_source_generation_provenance_mismatch:subdirectory");
    }
    if (JSON.stringify(manifest.include) !== JSON.stringify(normalizeInclude(this.include))) {
      throw new TypeError("git_source_generation_provenance_mismatch:include");
    }
    if (manifest.policy !== this.policy) {
      throw new TypeError("git_source_generation_provenance_mismatch:policy");
    }

    const refreshedAtMs = Date.parse(manifest.refreshedAt);
    const nowMs = Date.now();
    if (!ageWithinBound(refreshedAtMs, nowMs, this.maxStaleMs)) {
      if (refreshedAtMs > nowMs) {
        throw new TypeError("git_source_generation_future_timestamp");
      }
      throw new TypeError("git_source_generation_over_age");
    }

    const contentRoot = path.join(generationDir, CONTENT_DIR);
    const contentStat = await lstat(contentRoot).catch((error: NodeJS.ErrnoException) => {
      if (error && error.code === "ENOENT") {
        throw new TypeError("git_source_generation_selection_missing");
      }
      throw error;
    });
    if (!contentStat.isDirectory() || contentStat.isSymbolicLink()) {
      throw new TypeError("git_source_generation_selection_missing");
    }
    const files = await collectSelectedFiles(contentRoot, this.#selection);
    const contentSha256 = await computeContentDigest(contentRoot, files, this.#selection);
    if (contentSha256 !== manifest.contentSha256) {
      throw new TypeError("git_source_generation_digest_mismatch");
    }
    return { id: active.generation, manifest };
  }

  async #documentsFromGeneration(generation: PublishedGeneration): Promise<unknown[]> {
    const contentRoot = path.join(this.cacheDir, GENERATIONS_DIR, generation.id, CONTENT_DIR);
    const source = new FileSystemSource({
      id: this.id,
      root: contentRoot,
      include: generation.manifest.include ?? undefined,
      publicBaseUrl: this.publicBaseUrl
    });
    const documents = await source.load();
    return documents.map((rawDocument) => {
      const document = rawDocument as Record<string, unknown> & {
        source: Record<string, unknown>
      };
      return {
        ...document,
        source: {
          ...document.source,
          type: "git",
          repository: generation.manifest.remote,
          ref: generation.manifest.ref,
          commit: generation.manifest.commit
        }
      };
    });
  }
}
