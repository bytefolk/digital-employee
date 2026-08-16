import { deploy } from "../../../apps/cli/deploy/index.js"

const rawOptions = JSON.parse(process.argv[2] ?? "{}")
const options = {
  ...rawOptions,
  ...(Array.isArray(rawOptions.providedOptions)
    ? { providedOptions: new Set(rawOptions.providedOptions) }
    : {}),
}
await deploy(options)
