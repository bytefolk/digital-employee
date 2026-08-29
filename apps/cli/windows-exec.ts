import fs from "node:fs"
import path from "node:path"
import process from "node:process"

export interface WindowsSpawnSpec {
  command: string;
  /** True when the resolved target is a .cmd/.bat shim that must run via cmd.exe. */
  needsShell: boolean;
}

const CMD_EXTS = new Set([".cmd", ".bat"])

function pathExtCandidates(): string[] {
  const raw = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD"
  return raw
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean)
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve a bare command (eg `qodercli`) to a runnable Windows target.
 *
 * Node `spawn(cmd, { shell: false })` on Windows only auto-appends `.exe`;
 * `.cmd`/`.bat` shims (how npm-global CLIs install on Windows) return ENOENT.
 * This mirrors the openclaw/cross-spawn approach without adding a dependency:
 * walk PATH × PATHEXT; if the hit is a `.cmd`/`.bat`, flag `needsShell` so the
 * caller runs it through `cmd.exe /c` (or shell:true) with proper quoting.
 * Returns null when nothing resolves (caller keeps its ENOENT fail-closed path).
 */
export function resolveWindowsExecutable(command: string): WindowsSpawnSpec | null {
  if (process.platform !== "win32") return null
  // Already an explicit path with an extension -> classify directly.
  const ext = path.extname(command).toLowerCase()
  if (ext) {
    return { command, needsShell: CMD_EXTS.has(ext) }
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const candidateExt of [".exe", ...pathExtCandidates()]) {
      const candidate = path.join(dir, `${command}${candidateExt}`)
      if (isFile(candidate)) {
        return { command: candidate, needsShell: CMD_EXTS.has(candidateExt) }
      }
    }
  }
  return null
}
