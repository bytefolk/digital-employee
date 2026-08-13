"use strict"

const { fstatSync, writeFileSync } = require("node:fs")

const originalSend = process.send?.bind(process)
if (originalSend) {
  process.send = (message, ...args) => {
    if (
      message &&
      typeof message === "object" &&
      message.type === "deploy-http-runtime-activation-ack" &&
      message.phase === "released"
    ) {
      let closed = false
      try {
        fstatSync(4)
      } catch (error) {
        closed = Boolean(error && error.code === "EBADF")
      }
      if (!closed) process.exit(97)
      const marker = process.env.DEPLOY_RELEASE_FD_MARKER
      if (marker) writeFileSync(marker, `${process.pid}:fd4-closed-before-ack\n`)
    }
    return originalSend(message, ...args)
  }
}
