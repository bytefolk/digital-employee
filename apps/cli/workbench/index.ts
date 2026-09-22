import path from "node:path"

import { loadOrgModel } from "../org/model.js"
import { createWorkbenchServer } from "./server.js"

export interface WorkbenchOptions {
  workspace?: string
  extraWorkspaces?: string[]
  host?: string
  port?: string
  help?: boolean
  openBrowser?: boolean
}

export const WORKBENCH_DEFAULT_HOST = "127.0.0.1"
export const WORKBENCH_DEFAULT_PORT = 4317
const WORKBENCH_LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1"])

export function workbenchUsage(): string {
  return `digital-employee workbench [workspace] [--host 127.0.0.1] [--port ${WORKBENCH_DEFAULT_PORT}]

Start the local Digital Employee Workbench. The server binds to loopback only,
serves its own browser client, and runs turns through the existing sealed
turn-envelope.v1alpha2 / runTurn backend. No second session store is created.
`
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return WORKBENCH_DEFAULT_PORT
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new TypeError("workbench_port_invalid")
  }
  return value
}

export async function workbench(options: WorkbenchOptions): Promise<void> {
  if (options.help) {
    process.stdout.write(workbenchUsage())
    return
  }
  if ((options.extraWorkspaces?.length ?? 0) > 0) {
    throw new TypeError("workbench_accepts_one_workspace")
  }
  const host = options.host ?? WORKBENCH_DEFAULT_HOST
  if (!WORKBENCH_LOOPBACK_BIND_HOSTS.has(host)) {
    throw new TypeError("workbench_loopback_required")
  }
  const workspace = path.resolve(options.workspace ?? process.cwd())
  const loaded = await loadOrgModel(workspace)
  const positions = loaded.model.roles.map((role) => ({
    id: role.id,
    name: role.name ?? role.id,
    reportTo: role.reportTo,
  }))
  const port = parsePort(options.port)
  const server = createWorkbenchServer({ workspace, positions, host })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })
  const address = server.address()
  const actualPort = typeof address === "object" && address ? address.port : port
  process.stdout.write(`Digital Employee Workbench: http://${host}:${actualPort}/\n`)
  const stop = () => server.close(() => process.exit(0))
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}
