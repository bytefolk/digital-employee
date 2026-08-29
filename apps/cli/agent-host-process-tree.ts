import { spawnSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"

type ProcessTreeChild = Pick<
  ChildProcess,
  "pid" | "exitCode" | "signalCode" | "kill"
>

function processTreeAlive(child: ProcessTreeChild): boolean {
  if (!child.pid) return false
  if (process.platform === "win32") {
    return child.exitCode === null && child.signalCode === null
  }
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/**
 * Windows process-tree termination via `taskkill /pid <pid> /T`.
 *
 * Node's `child.kill()` on Windows only terminates the direct child and leaves
 * grandchildren as orphans (the root cause of the historical Windows
 * fail-close). `taskkill /T` walks the child process tree and terminates every
 * descendant, preserving the same safety boundary the POSIX process-group kill
 * provides. Graceful (no /F) first; `/F` only when force is requested or the
 * graceful pass refuses. Best-effort: missing pids (exit code 128/288) are
 * treated as already-dead, never an error.
 */
export function taskkillProcessTree(pid: number, force: boolean): void {
  if (!Number.isFinite(pid) || pid <= 0) return
  const base = ["taskkill", "/pid", String(pid), "/T"]
  const args = force ? [...base, "/F"] : base
  const result = spawnSync(args[0], args.slice(1), {
    stdio: "ignore",
    windowsHide: true,
  })
  // Graceful pass refused and not already forced -> escalate to /F.
  if (!force && (result.status === null || result.status >= 2)) {
    spawnSync("taskkill", [...base, "/F"], { stdio: "ignore", windowsHide: true })
  }
}

/** Signals the process tree on both platforms. POSIX uses the detached process
 * group; Windows uses taskkill /T so descendants are never orphaned. */
export function signalAgentHostProcessTree(
  child: ProcessTreeChild,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return
  if (process.platform === "win32") {
    // SIGKILL semantics -> force; anything else -> graceful then escalate.
    taskkillProcessTree(child.pid, signal === "SIGKILL")
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ESRCH") child.kill(signal)
  }
}

export async function waitForAgentHostProcessTreeExit(
  child: ProcessTreeChild,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processTreeAlive(child)) {
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  return true
}
