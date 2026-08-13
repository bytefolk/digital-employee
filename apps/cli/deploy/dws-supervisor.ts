/** Parent-coupled DWS process supervisor used by deploy reconciliation. */

import { spawn } from "node:child_process"

const TERMINATION_GRACE_MS = 1_000

const child = spawn("dws", process.argv.slice(2), {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
  windowsHide: true,
})

child.stdout.pipe(process.stdout, { end: false })
child.stderr.pipe(process.stderr, { end: false })

let forceTimer: ReturnType<typeof setTimeout> | undefined
let stopping = false

function stop(): void {
  if (stopping) return
  stopping = true
  try {
    child.kill("SIGTERM")
  } catch {
    // The exact child has already exited.
  }
  forceTimer = setTimeout(() => {
    try {
      child.kill("SIGKILL")
    } catch {
      // The exact child has already exited.
    }
  }, TERMINATION_GRACE_MS)
  forceTimer.unref()
}

process.once("disconnect", stop)
process.once("SIGINT", stop)
process.once("SIGTERM", stop)

child.once("error", (error) => {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN"
  if (process.connected) {
    process.send?.({ type: "dws-supervisor-spawn-error", code })
  }
})

child.once("close", (code, signal) => {
  if (forceTimer) clearTimeout(forceTimer)
  process.exitCode = signal ? 1 : code ?? 1
  if (process.connected) process.disconnect?.()
})
