import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { test } from "node:test"
import { resolveWindowsExecutable } from "../../apps/cli/windows-exec.js"
import {
  signalAgentHostProcessTree,
  taskkillProcessTree,
} from "../../apps/cli/agent-host-process-tree.js"

// Windows-native enablement primitives. These only exercise real Windows
// semantics on win32; on POSIX CI they are skipped (the POSIX path is covered
// by existing adapter tests).

test("windows-exec: resolves bare .exe and flags .cmd for shell (win32 only)", () => {
  if (process.platform !== "win32") return // POSIX CI: skip
  const node = resolveWindowsExecutable("node")
  assert.ok(node, "node should resolve on Windows")
  assert.equal(node!.needsShell, false) // node.exe is a real exe
})

test("process-tree: taskkill /T does not throw for dead/invalid pid (win32 only)", () => {
  if (process.platform !== "win32") return
  assert.doesNotThrow(() => taskkillProcessTree(0, false))
  assert.doesNotThrow(() => taskkillProcessTree(4_000_000, true)) // unlikely pid
})

test("process-tree: kill tree terminates a child that spawned a grandchild (win32 only)", () => {
  if (process.platform !== "win32") return
  // Parent spawns a long-lived grandchild; killing only the parent would orphan it.
  const child = spawn("cmd.exe", ["/c", "ping 127.0.0.1 -n 30 > nul"], {
    windowsHide: true,
  })
  assert.ok(child.pid)
  signalAgentHostProcessTree(child, "SIGKILL")
  // After a tree kill the direct child should be reaped promptly.
  const deadline = Date.now() + 3000
  let alive = true
  while (Date.now() < deadline && alive) {
    alive = child.exitCode === null && child.signalCode === null
  }
  assert.equal(alive, false, "child should be terminated by tree kill")
  child.kill("SIGKILL") // best-effort cleanup
})
