#!/usr/bin/env node

/** Fixture dws CLI for deploy channel tests. Serves a single fixed profile. */

const args = process.argv.slice(2)

const identity = {
  success: true,
  currentProfile: "corp-a:user-a",
  profiles: [
    {
      profile: "corp-a:user-a",
      corpId: "corp-a",
      userId: "user-a",
      clientId: "profile-client-a",
      isCurrent: true,
    },
  ],
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

if (args[0] === "profile" && args[1] === "list") {
  emit(identity)
  process.exit(0)
}

const scopedCommand = args[0] === "--profile" ? args[3] : undefined
if (scopedCommand === "+list") {
  emit({ apps: [], hasMore: false })
  process.exit(0)
}
if (scopedCommand === "+create") {
  emit({ unifiedAppId: "app-created-1" })
  process.exit(0)
}
if (scopedCommand === "+get") {
  const index = args.indexOf("--unified-app-id")
  const appId = index >= 0 ? args[index + 1] : "app-1"
  emit({ unifiedAppId: appId, name: "test-bot" })
  process.exit(0)
}
process.stderr.write(`unexpected fixture dws args: ${JSON.stringify(args)}\n`)
process.exit(2)
