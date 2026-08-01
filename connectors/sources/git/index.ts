import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { FileSystemSource } from "../filesystem/index.js";

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

export class GitSource {
  id: string
  remote: string
  ref: string
  cacheDir: string
  checkout: string
  subdirectory: string
  include?: unknown[]
  publicBaseUrl?: string
  timeoutMs?: number

  constructor({
    id,
    remote,
    ref = "main",
    cacheDir = ".cache/git",
    subdirectory = ".",
    include,
    publicBaseUrl,
    timeoutMs
  }: {
    id: string
    remote: string
    ref?: string
    cacheDir?: string
    subdirectory?: string
    include?: unknown[]
    publicBaseUrl?: string
    timeoutMs?: number
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
  }

  async sync(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const gitDirectory = path.join(this.checkout, ".git");
    if (!(await exists(gitDirectory))) {
      await runGit(
        ["clone", "--depth", "1", "--branch", this.ref, "--single-branch", "--", this.remote, this.checkout],
        { timeoutMs: this.timeoutMs }
      );
      return;
    }

    await runGit(["fetch", "--depth", "1", "origin", this.ref], {
      cwd: this.checkout,
      timeoutMs: this.timeoutMs
    });
    await runGit(["checkout", "--detach", "--force", "FETCH_HEAD"], {
      cwd: this.checkout,
      timeoutMs: this.timeoutMs
    });
  }

  async load(): Promise<unknown[]> {
    await this.sync();
    const requested = path.resolve(this.checkout, this.subdirectory);
    const relative = path.relative(this.checkout, requested);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new TypeError("git_source_subdirectory_outside_checkout");
    }
    const source = new FileSystemSource({
      id: this.id,
      root: requested,
      include: this.include,
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
        repository: this.remote,
        ref: this.ref
      }
      };
    });
  }
}
