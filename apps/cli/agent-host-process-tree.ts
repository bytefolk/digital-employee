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

/** Signals the detached POSIX process group even after its leader exits. */
export function signalAgentHostProcessTree(
  child: ProcessTreeChild,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal)
    } else if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ESRCH" && process.platform === "win32") child.kill(signal)
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
