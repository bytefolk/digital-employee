/** Parent-coupled DWS process supervisor used by deploy reconciliation. */

import { spawn } from "node:child_process"

const TERMINATION_GRACE_MS = 1_000

const child = spawn("dws", process.argv.slice(2), {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
  // The supervisor is already the leader of the detached process group that
  // runDwsJson created. Keep DWS and its descendants in that same group so the
  // outer and inner shutdown paths cannot race across two independent groups.
  detached: false,
  windowsHide: true,
})

child.stdout.pipe(process.stdout, { end: false })
child.stderr.pipe(process.stderr, { end: false })

let forceTimer: ReturnType<typeof setTimeout> | undefined
let stopping = false

function cancelForceTimer(): void {
  if (!forceTimer) return
  clearTimeout(forceTimer)
  forceTimer = undefined
}

function killSharedGroup(signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-process.pid, signal)
    } else {
      child.kill(signal)
    }
  } catch {
    // The inherited process group has already exited.
  }
}

function stop(): void {
  if (stopping) return
  stopping = true
  child.stdout.unpipe(process.stdout)
  child.stderr.unpipe(process.stderr)
  child.stdout.resume()
  child.stderr.resume()
  killSharedGroup("SIGTERM")
  forceTimer = setTimeout(() => {
    killSharedGroup("SIGKILL")
  }, TERMINATION_GRACE_MS)
}

process.once("disconnect", stop)
// Keep signal handlers installed while stopping: a group-wide TERM also
// reaches this supervisor, and it must remain alive until the direct child
// closes or the group-wide KILL timer fires.
process.on("SIGINT", stop)
process.on("SIGTERM", stop)

child.once("error", (error) => {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN"
  if (process.connected) {
    process.send?.({ type: "dws-supervisor-spawn-error", code })
  }
})

child.once("close", async (code, signal) => {
  if (stopping || !process.connected) {
    // A TERM-responsive direct child may exit while one of its descendants
    // ignores TERM. Kill the inherited group before this supervisor can exit.
    killSharedGroup("SIGKILL")
    cancelForceTimer()
    return
  }
  cancelForceTimer()
  // Keep this process-group leader alive until the outer parent acknowledges
  // completion by killing the group. Empty writes serialize all preceding DWS
  // output into the parent pipes before the completion message is delivered.
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      process.stdout.write("", (error) => error ? reject(error) : resolve())
    }),
    new Promise<void>((resolve, reject) => {
      process.stderr.write("", (error) => error ? reject(error) : resolve())
    }),
  ])
  if (!process.connected) {
    stop()
    return
  }
  process.send?.({
    type: "dws-supervisor-command-complete",
    code,
    signal,
  })
})
